// src/routes/ranking.js
// ENFOQUE HÍBRIDO:
//   - Prisma para: premios, posición personal, queries simples
//   - prisma.$queryRaw para: leaderboards complejos con window functions
//     (ROW_NUMBER, CTEs, múltiples aggregations) — Prisma no genera SQL óptimo aquí

const express = require('express');
const { Prisma } = require('@prisma/client');
const prisma = require('../config/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/ranking/global ──────────────────────────────────
// SQL raw: necesita window function ROW_NUMBER y filtro de período dinámico
router.get('/global', authenticate, async (req, res) => {
  const { period = 'all' } = req.query;

  // Prisma.$queryRaw previene SQL injection con Prisma.sql template literal
  // NUNCA interpoler strings directamente — usar Prisma.sql
  const dateFilter = period === 'week'
    ? Prisma.sql`AND ph.created_at >= NOW() - INTERVAL '7 days'`
    : period === 'month'
    ? Prisma.sql`AND ph.created_at >= NOW() - INTERVAL '30 days'`
    : Prisma.sql``;

  try {
    const leaderboard = await prisma.$queryRaw`
      SELECT
        u.id,
        u.username,
        u.full_name    AS "fullName",
        u.avatar_url   AS "avatarUrl",
        u.streak_days  AS "streakDays",
        u.total_points AS "totalPoints",
        COALESCE(
          SUM(ph.points) FILTER (WHERE ph.points > 0 ${dateFilter}),
          0
        )::int AS "periodPoints",
        COUNT(DISTINCT c.id) FILTER (WHERE c.winner_id = u.id)::int AS "totalWins",
        ROW_NUMBER() OVER (
          ORDER BY COALESCE(SUM(ph.points) FILTER (WHERE ph.points > 0 ${dateFilter}), 0) DESC
        )::int AS "rankPosition"
      FROM users u
      LEFT JOIN points_history ph ON ph.user_id = u.id
      LEFT JOIN challenges c      ON c.winner_id = u.id
      GROUP BY u.id
      ORDER BY "periodPoints" DESC
      LIMIT 50
    `;

    const myPosition = leaderboard.findIndex(r => r.id === req.user.id) + 1;

    res.json({ leaderboard, myPosition: myPosition || null, period });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error cargando ranking global' });
  }
});

// ── GET /api/ranking/individual ──────────────────────────────
// SQL raw: múltiples COUNT con FILTER en diferentes tablas
router.get('/individual', authenticate, async (req, res) => {
  try {
    const leaderboard = await prisma.$queryRaw`
      SELECT
        u.id,
        u.username,
        u.full_name  AS "fullName",
        u.avatar_url AS "avatarUrl",
        COUNT(DISTINCT c.id) FILTER (
          WHERE c.status = 'COMPLETED' AND c.winner_id = u.id
        )::int AS "completedTotal",
        COUNT(DISTINCT c.id) FILTER (
          WHERE c.type = 'INDIVIDUAL' AND c.status = 'COMPLETED' AND c.winner_id = u.id
        )::int AS "individualCompleted",
        COUNT(DISTINCT c.id) FILTER (
          WHERE c.type = 'DUEL' AND c.winner_id = u.id
        )::int AS "duelsWon",
        COALESCE(SUM(ph.points) FILTER (WHERE ph.points > 0), 0)::int AS "totalPoints"
      FROM users u
      LEFT JOIN challenges c      ON c.winner_id = u.id
      LEFT JOIN points_history ph ON ph.user_id = u.id
      GROUP BY u.id
      HAVING COUNT(DISTINCT c.id) FILTER (
        WHERE c.status = 'COMPLETED' AND c.winner_id = u.id
      ) > 0
      ORDER BY "completedTotal" DESC, "totalPoints" DESC
      LIMIT 50
    `;

    res.json({ leaderboard });
  } catch (err) {
    res.status(500).json({ error: 'Error cargando ranking individual' });
  }
});

// ── GET /api/ranking/duels ───────────────────────────────────
// SQL raw: win rate calculado en DB con CASE + ROUND
router.get('/duels', authenticate, async (req, res) => {
  try {
    const leaderboard = await prisma.$queryRaw`
      SELECT
        u.id,
        u.username,
        u.full_name   AS "fullName",
        u.avatar_url  AS "avatarUrl",
        u.streak_days AS "streakDays",
        COUNT(DISTINCT c.id) FILTER (
          WHERE c.type = 'DUEL' AND c.winner_id = u.id
        )::int AS "duelsWon",
        COUNT(DISTINCT cp.challenge_id) FILTER (
          WHERE c2.type = 'DUEL' AND c2.status = 'COMPLETED'
        )::int AS "duelsTotal",
        CASE
          WHEN COUNT(DISTINCT cp.challenge_id) FILTER (
            WHERE c2.type = 'DUEL' AND c2.status = 'COMPLETED'
          ) = 0 THEN 0
          ELSE ROUND(
            COUNT(DISTINCT c.id) FILTER (WHERE c.type = 'DUEL' AND c.winner_id = u.id)::numeric /
            COUNT(DISTINCT cp.challenge_id) FILTER (WHERE c2.type = 'DUEL' AND c2.status = 'COMPLETED') * 100
          )::int
        END AS "winRatePct"
      FROM users u
      LEFT JOIN challenges c             ON c.winner_id = u.id AND c.type = 'DUEL'
      LEFT JOIN challenge_participants cp ON cp.user_id = u.id
      LEFT JOIN challenges c2            ON c2.id = cp.challenge_id
      GROUP BY u.id
      HAVING COUNT(DISTINCT c.id) FILTER (
        WHERE c.type = 'DUEL' AND c.winner_id = u.id
      ) > 0
      ORDER BY "duelsWon" DESC, "winRatePct" DESC
      LIMIT 50
    `;

    res.json({ leaderboard });
  } catch (err) {
    res.status(500).json({ error: 'Error cargando ranking de duelos' });
  }
});

// ── GET /api/ranking/prizes — PRISMA puro (query simple) ─────
router.get('/prizes', authenticate, async (req, res) => {
  try {
    // Esto es perfectamente legible con Prisma — no necesita SQL raw
    const [prizes, stats] = await Promise.all([
      prisma.prize.findMany({
        where: { winnerId: req.user.id },
        include: {
          challenge: { select: { title: true, type: true } },
          loser:     { select: { username: true, fullName: true, avatarUrl: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.prize.groupBy({
        by:    ['confirmed'],
        where: { winnerId: req.user.id },
        _count: { id: true },
      }),
    ]);

    const totalPrizes     = prizes.length;
    const confirmedPrizes = stats.find(s => s.confirmed)?._count.id  || 0;
    const pendingPrizes   = stats.find(s => !s.confirmed)?._count.id || 0;

    res.json({
      prizes,
      stats: { totalPrizes, confirmedPrizes, pendingPrizes },
    });
  } catch (err) {
    res.status(500).json({ error: 'Error cargando premios' });
  }
});

// ── POST /api/ranking/prizes/:id/confirm — PRISMA puro ───────
router.post('/prizes/:id/confirm', authenticate, async (req, res) => {
  try {
    const prize = await prisma.prize.updateMany({
      where: { id: req.params.id, winnerId: req.user.id },
      data:  { confirmed: true },
    });

    if (!prize.count) {
      return res.status(404).json({ error: 'Premio no encontrado' });
    }

    res.json({ message: '🏆 Premio confirmado! Bien merecido 💪' });
  } catch (err) {
    res.status(500).json({ error: 'Error confirmando premio' });
  }
});

module.exports = router;
