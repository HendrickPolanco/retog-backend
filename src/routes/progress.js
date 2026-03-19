// src/routes/progress.js
const express = require('express');
const prisma  = require('../config/prisma');
const { authenticate } = require('../middleware/auth');
const {
  uploadPhoto, uploadVideo720p, uploadVideo480p,
  validateVideoDuration, deleteMedia,
} = require('../services/cloudinary');

const router = express.Router();
const POINTS_PROGRESS = 10;
const POINTS_APPROVED = 25;

// ── POST /api/progress/:challengeId ─────────────────────────
router.post('/:challengeId', authenticate, (req, res) => {
  const { media_type = 'text' } = req.query;

  const uploaderMap = {
    text:       null,
    photo:      uploadPhoto.single('media'),
    video_720p: uploadVideo720p.single('media'),
    video_480p: uploadVideo480p.single('media'),
  };

  if (!(media_type in uploaderMap)) {
    return res.status(400).json({
      error: 'media_type inválido',
      valid: ['text', 'photo', 'video_720p', 'video_480p'],
    });
  }

  if (media_type === 'text') return saveProgress(req, res, media_type);

  uploaderMap[media_type](req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });

    if (media_type === 'video_720p') {
      return validateVideoDuration('720p')(req, res, () => saveProgress(req, res, media_type));
    }
    if (media_type === 'video_480p') {
      return validateVideoDuration('480p')(req, res, () => saveProgress(req, res, media_type));
    }
    saveProgress(req, res, media_type);
  });
});

async function saveProgress(req, res, mediaType) {
  const { note } = req.body;
  const { challengeId } = req.params;

  if (!note && !req.file) {
    return res.status(400).json({ error: 'Incluye texto o media' });
  }

  try {
    await prisma.$transaction(async (tx) => {
      // Verificar participación activa
      const participation = await tx.challengeParticipant.findFirst({
        where: {
          challengeId,
          userId: req.user.id,
          status: 'ACTIVE',
          challenge: { status: 'ACTIVE' },
        },
      });

      if (!participation) throw new Error('No estás en este reto o ya terminó');

      // Preparar datos de media
      const mediaData = req.file ? {
        mediaUrl:     req.file.path,
        cloudinaryId: req.file.filename,
        mediaSizeKb:  Math.round(req.file.size / 1024),
        mediaType:    mediaType === 'photo' ? 'PHOTO' : 'VIDEO',
        mediaQuality: mediaType === 'video_720p' ? '720p' : mediaType === 'video_480p' ? '480p' : 'photo',
        mediaDuration: req.videoDuration || null,
      } : {};

      const entry = await tx.progressEntry.create({
        data: { challengeId, userId: req.user.id, note, ...mediaData },
      });

      // Puntos por subir avance
      await tx.pointsHistory.create({
        data: { userId: req.user.id, points: POINTS_PROGRESS, reason: 'upload_progress', challengeId },
      });
      await tx.user.update({
        where: { id: req.user.id },
        data:  { totalPoints: { increment: POINTS_PROGRESS } },
      });

      // Notificar al rival si es duelo
      const rival = await tx.challengeParticipant.findFirst({
        where: { challengeId, userId: { not: req.user.id } },
        include: { challenge: { select: { type: true, title: true } } },
      });

      if (rival?.challenge.type === 'DUEL') {
        await tx.notification.create({
          data: {
            userId: rival.userId,
            type:   'rival_progress',
            title:  `🔥 @${req.user.username} subió un avance`,
            body:   `En "${rival.challenge.title}" — Ve a votar`,
            data:   { challenge_id: challengeId, entry_id: entry.id },
          },
        });
      }
    });

    res.status(201).json({
      message: `✅ Avance registrado! +${POINTS_PROGRESS} puntos`,
      pointsEarned: POINTS_PROGRESS,
    });
  } catch (err) {
    if (req.file) {
      await deleteMedia(req.file.filename, mediaType.startsWith('video') ? 'video' : 'image').catch(console.error);
    }
    if (err.message.includes('reto')) return res.status(403).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Error guardando avance' });
  }
}

// ── GET /api/progress/:challengeId ──────────────────────────
router.get('/:challengeId', authenticate, async (req, res) => {
  try {
    const entries = await prisma.progressEntry.findMany({
      where: { challengeId: req.params.challengeId },
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
    });

    const timeline = entries.map(e => ({
      ...e,
      myVote: e.votes[0]?.voteType || null,
      votes: undefined,
    }));

    res.json({ timeline });
  } catch (err) {
    res.status(500).json({ error: 'Error cargando timeline' });
  }
});

// ── POST /api/progress/entry/:entryId/vote ──────────────────
router.post('/entry/:entryId/vote', authenticate, async (req, res) => {
  const { voteType } = req.body;
  if (!['UP', 'DOWN'].includes(voteType?.toUpperCase())) {
    return res.status(400).json({ error: 'voteType debe ser UP o DOWN' });
  }

  const normalizedVote = voteType.toUpperCase();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const entry = await tx.progressEntry.findUnique({
        where: { id: req.params.entryId },
        select: { userId: true, challengeId: true, votesUp: true },
      });

      if (!entry) throw new Error('Avance no encontrado');
      if (entry.userId === req.user.id) throw new Error('No puedes votar tu propio avance');

      const existing = await tx.vote.findUnique({
        where: { entryId_userId: { entryId: req.params.entryId, userId: req.user.id } },
      });

      if (existing) {
        if (existing.voteType === normalizedVote) {
          // Toggle: quitar voto
          await tx.vote.delete({ where: { id: existing.id } });
          await tx.progressEntry.update({
            where: { id: req.params.entryId },
            data: normalizedVote === 'UP'
              ? { votesUp:   { decrement: 1 } }
              : { votesDown: { decrement: 1 } },
          });
          return 'removed';
        } else {
          // Cambiar voto
          await tx.vote.update({
            where: { id: existing.id },
            data:  { voteType: normalizedVote },
          });
          await tx.progressEntry.update({
            where: { id: req.params.entryId },
            data: normalizedVote === 'UP'
              ? { votesUp: { increment: 1 }, votesDown: { decrement: 1 } }
              : { votesDown: { increment: 1 }, votesUp: { decrement: 1 } },
          });
          return 'changed';
        }
      }

      // Nuevo voto
      await tx.vote.create({
        data: { entryId: req.params.entryId, userId: req.user.id, voteType: normalizedVote },
      });

      const updated = await tx.progressEntry.update({
        where: { id: req.params.entryId },
        data: normalizedVote === 'UP'
          ? { votesUp: { increment: 1 } }
          : { votesDown: { increment: 1 } },
        select: { votesUp: true, userId: true },
      });

      // Al llegar a 3 votos positivos → puntos al autor
      if (normalizedVote === 'UP' && updated.votesUp === 3) {
        await tx.pointsHistory.create({
          data: { userId: updated.userId, points: POINTS_APPROVED, reason: 'progress_approved', challengeId: entry.challengeId },
        });
        await tx.user.update({
          where: { id: updated.userId },
          data:  { totalPoints: { increment: POINTS_APPROVED } },
        });
      }

      return 'added';
    });

    res.json({ message: normalizedVote === 'UP' ? '✅ Voto positivo' : '❌ Voto negativo', action: result });
  } catch (err) {
    if (err.message.includes('propio') || err.message.includes('encontrado')) {
      return res.status(400).json({ error: err.message });
    }
    res.status(500).json({ error: 'Error procesando voto' });
  }
});

// ── DELETE /api/progress/entry/:entryId ─────────────────────
router.delete('/entry/:entryId', authenticate, async (req, res) => {
  try {
    const entry = await prisma.progressEntry.findFirst({
      where: { id: req.params.entryId, userId: req.user.id },
    });

    if (!entry) return res.status(404).json({ error: 'Avance no encontrado' });

    if (entry.cloudinaryId) {
      await deleteMedia(entry.cloudinaryId, entry.mediaType === 'VIDEO' ? 'video' : 'image');
    }

    await prisma.progressEntry.delete({ where: { id: req.params.entryId } });
    res.json({ message: 'Avance eliminado' });
  } catch (err) {
    res.status(500).json({ error: 'Error eliminando avance' });
  }
});

module.exports = router;
