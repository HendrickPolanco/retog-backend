// src/routes/admin.js
const express = require('express');
const prisma  = require('../config/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── MIDDLEWARE: Solo admins ───────────────────────────────────
const requireAdmin = async (req, res, next) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { isAdmin: true },
  });
  if (!user?.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// ── GET /api/admin/stats ──────────────────────────────────────
router.get('/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const [totalUsers, proUsers, totalChallenges, activeChallenges, totalPrizes] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isPro: true } }),
      prisma.challenge.count(),
      prisma.challenge.count({ where: { status: 'ACTIVE' } }),
      prisma.prize.count(),
    ]);

    res.json({
      users:      { total: totalUsers, pro: proUsers },
      challenges: { total: totalChallenges, active: activeChallenges },
      prizes:     { total: totalPrizes },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching stats' });
  }
});

// ── GET /api/admin/users ──────────────────────────────────────
router.get('/users', authenticate, requireAdmin, async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  try {
    const where = search ? {
      OR: [
        { username: { contains: search, mode: 'insensitive' } },
        { email:    { contains: search, mode: 'insensitive' } },
        { fullName: { contains: search, mode: 'insensitive' } },
      ],
    } : {};

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          id: true, username: true, email: true, fullName: true,
          avatarUrl: true, isPro: true, isAdmin: true, totalPoints: true,
          createdAt: true, stripeCustomerId: true,
          _count: { select: { participations: true, wonChallenges: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip:  (parseInt(page) - 1) * parseInt(limit),
        take:  parseInt(limit),
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching users' });
  }
});

// ── PUT /api/admin/users/:id ──────────────────────────────────
router.put('/users/:id', authenticate, requireAdmin, async (req, res) => {
  const { isPro, isAdmin, banned } = req.body;
  try {
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: {
        ...(isPro    !== undefined && { isPro }),
        ...(isAdmin  !== undefined && { isAdmin }),
      },
      select: { id: true, username: true, isPro: true, isAdmin: true },
    });
    res.json({ user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error updating user' });
  }
});

// ── GET /api/admin/challenges ─────────────────────────────────
router.get('/challenges', authenticate, requireAdmin, async (req, res) => {
  const { page = 1, limit = 20, status } = req.query;
  try {
    const where = status ? { status: status.toUpperCase() } : {};

    const [challenges, total] = await Promise.all([
      prisma.challenge.findMany({
        where,
        include: {
          creator: { select: { id: true, username: true, email: true } },
          _count:  { select: { participants: true, progress: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip:  (parseInt(page) - 1) * parseInt(limit),
        take:  parseInt(limit),
      }),
      prisma.challenge.count({ where }),
    ]);

    res.json({ challenges, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching challenges' });
  }
});

// ── DELETE /api/admin/challenges/:id ─────────────────────────
router.delete('/challenges/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await prisma.challenge.delete({ where: { id: req.params.id } });
    res.json({ message: 'Challenge deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error deleting challenge' });
  }
});

// ── GET /api/admin/payments ───────────────────────────────────
router.get('/payments', authenticate, requireAdmin, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  try {
    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where:   { stripeCustomerId: { not: null } },
        select:  {
          id: true, username: true, email: true, fullName: true,
          isPro: true, stripeCustomerId: true, createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip:  (parseInt(page) - 1) * parseInt(limit),
        take:  parseInt(limit),
      }),
      prisma.user.count({ where: { stripeCustomerId: { not: null } } }),
    ]);

    res.json({ users, total, page: parseInt(page), limit: parseInt(limit) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error fetching payments' });
  }
});

module.exports = router;