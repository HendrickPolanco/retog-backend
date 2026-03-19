// src/routes/users.js
const express = require('express');
const { body, validationResult } = require('express-validator');
const prisma = require('../config/prisma');
const { authenticate } = require('../middleware/auth');
const { uploadAvatar } = require('../services/cloudinary');

const router = express.Router();

// ── GET /api/users/search ────────────────────────────────────
router.get('/search', authenticate, async (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Busca con al menos 2 caracteres' });
  }

  const search = q.replace('@', '').toLowerCase();

  try {
    const users = await prisma.user.findMany({
      where: {
        AND: [
          { id: { not: req.user.id } },
          {
            OR: [
              { username: { contains: search, mode: 'insensitive' } },
              { fullName: { contains: search, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: {
        id: true, username: true, fullName: true,
        avatarUrl: true, totalPoints: true, streakDays: true,
        // Verificar si ya lo sigo
        followers: {
          where: { followerId: req.user.id },
          select: { followerId: true },
        },
      },
      take: 20,
    });

    // Formatear resultado
    const formatted = users.map(u => ({
      ...u,
      iFollow: u.followers.length > 0,
      followers: undefined,
    }));

    res.json({ users: formatted });
  } catch (err) {
    res.status(500).json({ error: 'Error en búsqueda' });
  }
});

// ── GET /api/users/me/notifications ─────────────────────────
router.get('/me/notifications', authenticate, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where:   { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take:    50,
    });

    const unreadCount = notifications.filter(n => !n.isRead).length;

    // Marcar todas como leídas
    await prisma.notification.updateMany({
      where: { userId: req.user.id, isRead: false },
      data:  { isRead: true },
    });

    res.json({ notifications, unreadCount });
  } catch (err) {
    res.status(500).json({ error: 'Error cargando notificaciones' });
  }
});

// ── GET /api/users/:username ─────────────────────────────────
router.get('/:username', authenticate, async (req, res) => {
  const username = req.params.username.toLowerCase().replace('@', '');

  try {
    const user = await prisma.user.findUnique({
      where: { username },
      select: {
        id: true, username: true, fullName: true, avatarUrl: true,
        bio: true, totalPoints: true, streakDays: true, isPro: true,
        createdAt: true,
        _count: {
          select: {
            followers:     true,
            following:     true,
            wonChallenges: true,
            prizesWon:     true,
          },
        },
        // Verificar si lo sigo
        followers: {
          where: { followerId: req.user.id },
          select: { followerId: true },
        },
        // Sus retos públicos
        createdChallenges: {
          where: { isPublic: true },
          select: {
            id: true, type: true, title: true, status: true,
            startDate: true, endDate: true, winnerId: true,
            rewardText: true, category: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });

    res.json({
      user: {
        ...user,
        iFollow:           user.followers.length > 0,
        followers:         undefined,
        createdChallenges: undefined,
      },
      challenges: user.createdChallenges,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error cargando perfil' });
  }
});

// ── PUT /api/users/me ────────────────────────────────────────
router.put('/me', authenticate,
  [
    body('fullName').optional().trim().isLength({ min: 2, max: 100 }),
    body('bio').optional().trim().isLength({ max: 200 }),
    body('username').optional().trim()
      .isLength({ min: 3, max: 30 })
      .matches(/^[a-zA-Z0-9_]+$/),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { fullName, bio, username } = req.body;
    const data = {};

    if (fullName !== undefined) data.fullName = fullName;
    if (bio      !== undefined) data.bio      = bio;
    if (username !== undefined) {
      const existing = await prisma.user.findFirst({
        where: { username: username.toLowerCase(), id: { not: req.user.id } },
        select: { id: true },
      });
      if (existing) return res.status(409).json({ error: 'Ese username ya está en uso' });
      data.username = username.toLowerCase();
    }

    if (!Object.keys(data).length) {
      return res.status(400).json({ error: 'No hay nada que actualizar' });
    }

    try {
      const user = await prisma.user.update({
        where: { id: req.user.id },
        data,
        select: { id: true, username: true, fullName: true, bio: true, avatarUrl: true },
      });
      res.json({ message: 'Perfil actualizado', user });
    } catch (err) {
      res.status(500).json({ error: 'Error actualizando perfil' });
    }
  }
);

// ── POST /api/users/me/avatar ────────────────────────────────
router.post('/me/avatar', authenticate, (req, res) => {
  uploadAvatar.single('avatar')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió imagen' });

    try {
      await prisma.user.update({
        where: { id: req.user.id },
        data:  { avatarUrl: req.file.path },
      });
      res.json({ message: 'Avatar actualizado', avatarUrl: req.file.path });
    } catch (err) {
      res.status(500).json({ error: 'Error actualizando avatar' });
    }
  });
});

// ── POST /api/users/:id/follow ───────────────────────────────
router.post('/:id/follow', authenticate, async (req, res) => {
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'No puedes seguirte a ti mismo' });
  }

  try {
    const existing = await prisma.follow.findUnique({
      where: {
        followerId_followingId: {
          followerId:  req.user.id,
          followingId: req.params.id,
        },
      },
    });

    if (existing) {
      await prisma.follow.delete({
        where: {
          followerId_followingId: {
            followerId:  req.user.id,
            followingId: req.params.id,
          },
        },
      });
      return res.json({ following: false, message: 'Dejaste de seguir' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.follow.create({
        data: { followerId: req.user.id, followingId: req.params.id },
      });
      await tx.notification.create({
        data: {
          userId: req.params.id,
          type:   'new_follower',
          title:  `👤 @${req.user.username} te siguió`,
          body:   'Ahora verá tu progreso en su feed',
          data:   { fromUserId: req.user.id },
        },
      });
    });

    res.json({ following: true, message: 'Siguiendo' });
  } catch (err) {
    res.status(500).json({ error: 'Error procesando follow' });
  }
});

module.exports = router;
