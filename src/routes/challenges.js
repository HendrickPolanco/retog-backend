// src/routes/challenges.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/prisma');
const { authenticate } = require('../middleware/auth');
const {
  sendChallengeCompletedEmail,
  sendDuelWonEmail,
  sendDuelAcceptedEmail,
} = require('../services/email');

const router = express.Router();

const POINTS = {
  COMPLETE_INDIVIDUAL: 100,
  WIN_DUEL:            200,
  RIVAL_SURRENDERS:    150,
  UPLOAD_PROGRESS:     10,
  PROGRESS_APPROVED:   25,
  STREAK_7:            50,
  STREAK_30:           200,
};

const awardPoints = async (tx, userId, points, reason, challengeId = null) => {
  await tx.pointsHistory.create({
    data: { userId, points, reason, challengeId },
  });
  await tx.user.update({
    where: { id: userId },
    data: { totalPoints: { increment: points } },
  });
};

// ── GET /api/challenges ───────────────────────────────────────
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
        _count: { select: { participants: true, progress: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip:  (parseInt(page) - 1) * parseInt(limit),
      take:  parseInt(limit),
    });
    res.json({ challenges, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error loading feed' });
  }
});

// ── GET /api/challenges/mine ──────────────────────────────────
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

    const challenges = participations.map(p => ({
      ...p.challenge,
      myRole:   p.role,
      myStatus: p.status,
      rival:    p.challenge.participants[0]?.user || null,
    }));

    const grouped = {
      active:     challenges.filter(c => c.status === 'ACTIVE' && c.type === 'INDIVIDUAL'),
      duels:      challenges.filter(c => c.status === 'ACTIVE' && c.type === 'DUEL'),
      won:        challenges.filter(c => c.winnerId === req.user.id),
      completed:  challenges.filter(c => c.status === 'COMPLETED' && c.winnerId !== req.user.id),
    };

    res.json({ challenges, grouped });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error loading my challenges' });
  }
});

// ── GET /api/challenges/invitations ──────────────────────────
router.get('/invitations', authenticate, async (req, res) => {
  try {
    const invitations = await prisma.duelInvitation.findMany({
      where: { toUserId: req.user.id, status: 'PENDING' },
      include: {
        challenge: {
          include: {
            creator: {
              select: { id: true, username: true, fullName: true, avatarUrl: true },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ invitations });
  } catch (err) {
    res.status(500).json({ error: 'Error loading invitations' });
  }
});

// ── GET /api/challenges/:id ───────────────────────────────────
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
      return res.status(404).json({ error: 'Challenge not found' });
    }

    const timeline = challenge.progress.map(entry => ({
      ...entry,
      myVote: entry.votes[0]?.voteType || null,
      votes:  undefined,
    }));

    res.json({ challenge: { ...challenge, progress: undefined }, timeline });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error loading challenge' });
  }
});

// ── POST /api/challenges ──────────────────────────────────────
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
    if (!errors.isEmpty()) {
      console.log('❌ Validation errors:', JSON.stringify(errors.array(), null, 2));
      console.log('📦 Body:', JSON.stringify(req.body, null, 2));
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      title, description, type, category,
      startDate, endDate, rewardText,
      rivalUsername, isPublic = true,
    } = req.body;

    if (new Date(endDate) <= new Date(startDate)) {
      return res.status(400).json({ error: 'End date must be after start date' });
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
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

        await tx.challengeParticipant.create({
          data: {
            challengeId: challenge.id,
            userId:      req.user.id,
            role:        'CREATOR',
            status:      'ACTIVE',
          },
        });

        let invitation = null;
        if (type === 'duel' && rivalUsername) {
          const rival = await tx.user.findUnique({
            where: { username: rivalUsername.toLowerCase().replace('@', '') },
            select: { id: true, username: true },
          });

          if (!rival) throw new Error(`User @${rivalUsername} not found`);
          if (rival.id === req.user.id) throw new Error('You cannot challenge yourself');

          invitation = await tx.duelInvitation.create({
            data: {
              challengeId: challenge.id,
              fromUserId:  req.user.id,
              toUserId:    rival.id,
            },
          });

          await tx.notification.create({
            data: {
              userId: rival.id,
              type:   'duel_invite',
              title:  `⚔️ @${req.user.username} challenged you!`,
              body:   `"${title}" — Reward: ${rewardText || 'honor'}`,
              data:   { challenge_id: challenge.id, from_username: req.user.username },
            },
          });
        }

        return { challenge, invitation };
      });

      res.status(201).json({
        message: type === 'duel'
          ? `⚔️ Duel created! Invitation sent to @${rivalUsername}`
          : '🎯 Challenge created! Time to prove yourself.',
        ...result,
      });
    } catch (err) {
      if (err.message.includes('not found') || err.message.includes('yourself')) {
        return res.status(400).json({ error: err.message });
      }
      console.error(err);
      res.status(500).json({ error: 'Error creating challenge' });
    }
  }
);

// ── POST /api/challenges/:id/accept ──────────────────────────
router.post('/:id/accept', authenticate, async (req, res) => {
  try {
    let creatorEmail, creatorUsername, challengeTitle, rivalUsername;

    await prisma.$transaction(async (tx) => {
      const invitation = await tx.duelInvitation.findFirst({
        where: {
          challengeId: req.params.id,
          toUserId:    req.user.id,
          status:      'PENDING',
        },
      });

      if (!invitation) throw new Error('You have no pending invitation for this challenge');

      await tx.duelInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', respondedAt: new Date() },
      });

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

      const challenge = await tx.challenge.update({
        where: { id: req.params.id },
        data:  { status: 'ACTIVE' },
        include: {
          creator: { select: { email: true, username: true } },
        },
      });

      await tx.notification.create({
        data: {
          userId: challenge.creatorId,
          type:   'duel_accepted',
          title:  `⚔️ @${req.user.username} accepted your challenge!`,
          body:   `"${challenge.title}" — The duel has begun 🔥`,
          data:   { challenge_id: req.params.id },
        },
      });

      creatorEmail    = challenge.creator.email;
      creatorUsername = challenge.creator.username;
      challengeTitle  = challenge.title;
      rivalUsername   = req.user.username;
    });

    await sendDuelAcceptedEmail(
      { email: creatorEmail, username: creatorUsername },
      { username: rivalUsername },
      { title: challengeTitle }
    ).catch(err => console.error('Email error (duel accepted):', err));

    res.json({ message: '⚔️ Duel accepted! Let the competition begin 🔥' });
  } catch (err) {
    if (err.message.includes('invitation')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Error accepting duel' });
  }
});

// ── POST /api/challenges/:id/surrender ───────────────────────
router.post('/:id/surrender', authenticate, async (req, res) => {
  try {
    let winnerEmail, winnerUsername, loserUsername, challengeTitle, pointsEarned;

    await prisma.$transaction(async (tx) => {
      const myParticipation = await tx.challengeParticipant.findUnique({
        where: {
          challengeId_userId: { challengeId: req.params.id, userId: req.user.id },
        },
        include: { challenge: { select: { type: true, rewardText: true, title: true } } },
      });

      if (!myParticipation || myParticipation.status !== 'ACTIVE') {
        throw new Error('You are not participating in this challenge');
      }

      await tx.challengeParticipant.update({
        where: { challengeId_userId: { challengeId: req.params.id, userId: req.user.id } },
        data:  { status: 'SURRENDERED' },
      });

      if (myParticipation.challenge.type === 'DUEL') {
        const rivalParticipation = await tx.challengeParticipant.findFirst({
          where: {
            challengeId: req.params.id,
            userId:      { not: req.user.id },
          },
          include: {
            user: { select: { id: true, email: true, username: true } },
          },
        });

        if (rivalParticipation) {
          const winner   = rivalParticipation.user;
          pointsEarned   = POINTS.RIVAL_SURRENDERS;
          challengeTitle = myParticipation.challenge.title;

          await tx.challenge.update({
            where: { id: req.params.id },
            data:  { status: 'COMPLETED', winnerId: winner.id },
          });

          await awardPoints(tx, winner.id, pointsEarned, 'rival_surrenders', req.params.id);

          await tx.notification.create({
            data: {
              userId: winner.id,
              type:   'duel_won',
              title:  '🏆 You won the duel!',
              body:   `@${req.user.username} surrendered. +${pointsEarned} points`,
              data:   { challenge_id: req.params.id },
            },
          });

          if (myParticipation.challenge.rewardText) {
            await tx.prize.create({
              data: {
                winnerId:    winner.id,
                loserId:     req.user.id,
                challengeId: req.params.id,
                prizeText:   myParticipation.challenge.rewardText,
              },
            });
          }

          winnerEmail    = winner.email;
          winnerUsername = winner.username;
          loserUsername  = req.user.username;
        }
      }
    });

    if (winnerEmail) {
      await sendDuelWonEmail(
        { email: winnerEmail, username: winnerUsername },
        { username: loserUsername },
        { title: challengeTitle, points: pointsEarned }
      ).catch(err => console.error('Email error (duel won):', err));
    }

    res.json({ message: "You surrendered. Keep going, you'll win the next one 💪" });
  } catch (err) {
    if (err.message.includes('participating')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Error processing surrender' });
  }
});

// ── POST /api/challenges/:id/complete ────────────────────────
router.post('/:id/complete', authenticate, async (req, res) => {
  try {
    let challengeTitle;

    await prisma.$transaction(async (tx) => {
      const challenge = await tx.challenge.findFirst({
        where: {
          id:        req.params.id,
          creatorId: req.user.id,
          type:      'INDIVIDUAL',
          status:    'ACTIVE',
        },
      });

      if (!challenge) throw new Error('Challenge not found or you do not have permission');

      await tx.challenge.update({
        where: { id: req.params.id },
        data:  { status: 'COMPLETED', winnerId: req.user.id },
      });

      await awardPoints(tx, req.user.id, POINTS.COMPLETE_INDIVIDUAL, 'complete_individual', req.params.id);

      challengeTitle = challenge.title;
    });

    await sendChallengeCompletedEmail(
      { email: req.user.email, username: req.user.username },
      { title: challengeTitle, points: POINTS.COMPLETE_INDIVIDUAL }
    ).catch(err => console.error('Email error (challenge completed):', err));

    res.json({
      message: `🎯 Challenge completed! +${POINTS.COMPLETE_INDIVIDUAL} points`,
      pointsEarned: POINTS.COMPLETE_INDIVIDUAL,
    });
  } catch (err) {
    if (err.message.includes('permission')) return res.status(403).json({ error: err.message });
    res.status(500).json({ error: 'Error completing challenge' });
  }
});

module.exports = router;