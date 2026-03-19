// src/routes/challenges.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── POINTS CONFIG ─────────────────────────────────────────────
const POINTS = {
  COMPLETE_INDIVIDUAL: 100,
  WIN_DUEL:            200,
  RIVAL_SURRENDERS:    150,
  UPLOAD_PROGRESS:     10,
  PROGRESS_APPROVED:   25,
  STREAK_7:            50,
  STREAK_30:           200,
};

// ── HELPER: Sumar puntos + actualizar total en una transacción ─
const awardPoints = async (tx, userId, points, reason, challengeId = null) => {
  // Crear registro en historial
  await tx.pointsHistory.create({
    data: { userId, points, reason, challengeId },
  });
  // Actualizar total del usuario
  await tx.user.update({
    where: { id: userId },
    data: { totalPoints: { increment: points } },
  });
};

// ── GET /api/challenges — Feed público ───────────────────────
router.get('/', authenticate, async (req, res) => {
  const { page = 1, limit = 20, type, category } = req.query;

  try {
    const challenges = await prisma.challenge.findMany({
      where: {
        isPublic: true,
        status:   'ACTIVE',
        ...(type     && { type:     type.toUpperCase() }),
        ...(category && { category }),
      },
      include: {
        creator: {
          select: { id: true, username: true, fullName: true, avatarUrl: true },
        },
        _count: {
          select: { participants: true, progress: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip:  (parseInt(page) - 1) * parseInt(limit),
      take:  parseInt(limit),
    });

    res.json({ challenges, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error cargando feed' });
  }
});

// ── GET /api/challenges/mine ─────────────────────────────────
router.get('/mine', authenticate, async (req, res) => {
  try {
    const participations = await prisma.challengeParticipant.findMany({
      where: { userId: req.user.id },
      include: {
        challenge: {
          include: {
            creator: {
              select: { id: true, username: true, fullName: true, avatarUrl: true },
            },
            // Traer los otros participantes (rival en duelos)
            participants: {
              where: { userId: { not: req.user.id } },
              include: {
                user: {
                  select: { id: true, username: true, fullName: true, avatarUrl: true },
                },
              },
            },
            _count: { select: { progress: true } },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    // Agrupar por tipo
    const challenges = participations.map(p => ({
      ...p.challenge,
      myRole:   p.role,
      myStatus: p.status,
      rival:    p.challenge.participants[0]?.user || null,
    }));

    const grouped = {
      activos:     challenges.filter(c => c.status === 'ACTIVE' && c.type === 'INDIVIDUAL'),
      duelos:      challenges.filter(c => c.status === 'ACTIVE' && c.type === 'DUEL'),
      ganados:     challenges.filter(c => c.winnerId === req.user.id),
      completados: challenges.filter(c => c.status === 'COMPLETED' && c.winnerId !== req.user.id),
    };

    res.json({ challenges, grouped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error cargando mis retos' });
  }
});

// ── GET invitations /api/challenges ─────────────────────────────────────
router.get('/invitations', authenticate, async (req, res) => {
  try {
    const invitations = await prisma.duelInvitation.findMany({
      where: { toUserId: req.user.id, status: 'PENDING' },
      include: {
        challenge: {
          include: {
            creator: {
              select: { id:true, username:true, fullName:true, avatarUrl:true }
            }
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    })
    res.json({ invitations })
  } catch (err) {
    res.status(500).json({ error: 'Error cargando invitaciones' })
  }
})

// ── GET /api/challenges/:id ──────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const challenge = await prisma.challenge.findUnique({
      where: { id: req.params.id },
      include: {
        creator: {
          select: { id: true, username: true, fullName: true, avatarUrl: true },
        },
        participants: {
          include: {
            user: {
              select: {
                id: true, username: true, fullName: true,
                avatarUrl: true, totalPoints: true,
              },
            },
          },
        },
        progress: {
          include: {
            user: {
              select: { id: true, username: true, fullName: true, avatarUrl: true },
            },
            // Solo traer el voto del usuario actual
            votes: {
              where: { userId: req.user.id },
              select: { voteType: true },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!challenge) {
      return res.status(404).json({ error: 'Reto no encontrado' });
    }

    // Formatear timeline con myVote
    const timeline = challenge.progress.map(entry => ({
      ...entry,
      myVote: entry.votes[0]?.voteType || null,
      votes:  undefined, // no exponer la lista completa de votos
    }));
    console.log('Timeline entries:', timeline.length) // ← agrega esto

    res.json({ challenge: { ...challenge, progress: undefined }, timeline });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error cargando reto' });
  }
});


// ── POST /api/challenges ─────────────────────────────────────
router.post('/',
  authenticate,
  [
    body('title').trim().isLength({ min: 5, max: 150 }),
    body('type').isIn(['individual', 'duel']),
    body('startDate').isDate(),
    body('endDate').isDate(),
    body('category').optional().isIn(['fitness','study','finance','cardio','other']),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const {
      title, description, type, category,
      startDate, endDate, rewardText,
      rivalUsername, isPublic = true,
    } = req.body;

    if (new Date(endDate) <= new Date(startDate)) {
      return res.status(400).json({ error: 'La fecha fin debe ser mayor al inicio' });
    }

    try {
      // Prisma transaction — todo o nada
      const result = await prisma.$transaction(async (tx) => {

        // Crear reto
        const challenge = await tx.challenge.create({
          data: {
            creatorId:   req.user.id,
            type:        type.toUpperCase(),
            title,
            description,
            category,
            startDate:   new Date(startDate),
            endDate:     new Date(endDate),
            rewardText,
            isPublic,
          },
        });

        // Agregar al creador como participante
        await tx.challengeParticipant.create({
          data: {
            challengeId: challenge.id,
            userId:      req.user.id,
            role:        'CREATOR',
            status:      'ACTIVE',
          },
        });

        // Si es duelo: buscar rival y crear invitación
        let invitation = null;
        if (type === 'duel' && rivalUsername) {
          const rival = await tx.user.findUnique({
            where: { username: rivalUsername.toLowerCase().replace('@', '') },
            select: { id: true, username: true },
          });

          if (!rival) {
            throw new Error(`Usuario @${rivalUsername} no encontrado`);
          }
          if (rival.id === req.user.id) {
            throw new Error('No puedes retarte a ti mismo');
          }

          invitation = await tx.duelInvitation.create({
            data: {
              challengeId: challenge.id,
              fromUserId:  req.user.id,
              toUserId:    rival.id,
            },
          });

          // Notificación al rival
          await tx.notification.create({
            data: {
              userId: rival.id,
              type:   'duel_invite',
              title:  `⚔️ @${req.user.username} te retó!`,
              body:   `"${title}" — Recompensa: ${rewardText || 'honor'}`,
              data:   { challenge_id: challenge.id, from_username: req.user.username },
            },
          });
        }

        return { challenge, invitation };
      });

      res.status(201).json({
        message: type === 'duel'
          ? `⚔️ Duelo creado! Invitación enviada a @${rivalUsername}`
          : '🎯 Reto creado! Empieza a demostrar.',
        ...result,
      });
    } catch (err) {
      if (err.message.includes('no encontrado') || err.message.includes('ti mismo')) {
        return res.status(400).json({ error: err.message });
      }
      console.error(err);
      res.status(500).json({ error: 'Error creando reto' });
    }
  }
);

// ── POST /api/challenges/:id/accept ─────────────────────────
router.post('/:id/accept', authenticate, async (req, res) => {
  try {
    await prisma.$transaction(async (tx) => {
      const invitation = await tx.duelInvitation.findFirst({
        where: {
          challengeId: req.params.id,
          toUserId:    req.user.id,
          status:      'PENDING',
        },
      });

      if (!invitation) throw new Error('No tienes una invitación pendiente para este reto');

      // Aceptar invitación
      await tx.duelInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });

      // Agregar al rival como participante
      await tx.challengeParticipant.upsert({
        where: {
          challengeId_userId: { challengeId: req.params.id, userId: req.user.id },
        },
        create: {
          challengeId: req.params.id,
          userId:      req.user.id,
          role:        'PARTICIPANT',
          status:      'ACTIVE',
        },
        update: { status: 'ACTIVE' },
      });

      // Activar reto
      const challenge = await tx.challenge.update({
        where: { id: req.params.id },
        data:  { status: 'ACTIVE' },
        select: { creatorId: true, title: true },
      });

      // Notificar al creador
      await tx.notification.create({
        data: {
          userId: challenge.creatorId,
          type:   'duel_accepted',
          title:  `⚔️ @${req.user.username} aceptó tu reto!`,
          body:   `"${challenge.title}" — El duelo ha comenzado 🔥`,
          data:   { challenge_id: req.params.id },
        },
      });
    });

    res.json({ message: '⚔️ Duelo aceptado! Que empiece la competencia 🔥' });
  } catch (err) {
    if (err.message.includes('invitación')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Error aceptando duelo' });
  }
});

// ── POST /api/challenges/:id/surrender ──────────────────────
router.post('/:id/surrender', authenticate, async (req, res) => {
  try {
    await prisma.$transaction(async (tx) => {
      const myParticipation = await tx.challengeParticipant.findUnique({
        where: {
          challengeId_userId: { challengeId: req.params.id, userId: req.user.id },
        },
        include: { challenge: { select: { type: true, rewardText: true, title: true } } },
      });

      if (!myParticipation || myParticipation.status !== 'ACTIVE') {
        throw new Error('No estás participando en este reto');
      }

      // Marcar rendición
      await tx.challengeParticipant.update({
        where: { challengeId_userId: { challengeId: req.params.id, userId: req.user.id } },
        data:  { status: 'SURRENDERED' },
      });

      // Si es duelo: el rival gana automáticamente
      if (myParticipation.challenge.type === 'DUEL') {
        const rivalParticipation = await tx.challengeParticipant.findFirst({
          where: {
            challengeId: req.params.id,
            userId:      { not: req.user.id },
          },
          select: { userId: true },
        });

        if (rivalParticipation) {
          const winnerId = rivalParticipation.userId;

          await tx.challenge.update({
            where: { id: req.params.id },
            data:  { status: 'COMPLETED', winnerId },
          });

          await awardPoints(tx, winnerId, POINTS.RIVAL_SURRENDERS, 'rival_surrenders', req.params.id);

          await tx.notification.create({
            data: {
              userId: winnerId,
              type:   'duel_won',
              title:  '🏆 ¡Ganaste el duelo!',
              body:   `@${req.user.username} se rindió. +${POINTS.RIVAL_SURRENDERS} puntos`,
              data:   { challenge_id: req.params.id },
            },
          });

          // Registrar premio si hay recompensa
          if (myParticipation.challenge.rewardText) {
            await tx.prize.create({
              data: {
                winnerId,
                loserId:     req.user.id,
                challengeId: req.params.id,
                prizeText:   myParticipation.challenge.rewardText,
              },
            });
          }
        }
      }
    });

    res.json({ message: 'Te has rendido. No pasa nada, el próximo lo ganas 💪' });
  } catch (err) {
    if (err.message.includes('participando')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Error procesando rendición' });
  }
});

// ── POST /api/challenges/:id/complete ───────────────────────
router.post('/:id/complete', authenticate, async (req, res) => {
  try {
    await prisma.$transaction(async (tx) => {
      const challenge = await tx.challenge.findFirst({
        where: {
          id:        req.params.id,
          creatorId: req.user.id,
          type:      'INDIVIDUAL',
          status:    'ACTIVE',
        },
      });

      if (!challenge) throw new Error('Reto no encontrado o no tienes permiso');

      await tx.challenge.update({
        where: { id: req.params.id },
        data:  { status: 'COMPLETED', winnerId: req.user.id },
      });

      await awardPoints(tx, req.user.id, POINTS.COMPLETE_INDIVIDUAL, 'complete_individual', req.params.id);
    });

    res.json({
      message: `🎯 ¡Reto completado! +${POINTS.COMPLETE_INDIVIDUAL} puntos`,
      pointsEarned: POINTS.COMPLETE_INDIVIDUAL,
    });
  } catch (err) {
    if (err.message.includes('permiso')) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: 'Error completando reto' });
  }
});

module.exports = router;
