// src/routes/auth.js
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const prisma  = require('../config/prisma');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const signToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

// ── VALIDACIONES ─────────────────────────────────────────────
const registerRules = [
  body('username').trim()
    .isLength({ min: 3, max: 30 }).withMessage('Username: 3-30 caracteres')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username: solo letras, números y _'),
  body('email').isEmail().normalizeEmail().withMessage('Email inválido'),
  body('password')
    .isLength({ min: 8 }).withMessage('Contraseña: mínimo 8 caracteres')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/).withMessage('Contraseña: necesita mayúscula, minúscula y número'),
  body('fullName').trim()
    .isLength({ min: 2, max: 100 }).withMessage('Nombre completo requerido'),
];

// ── POST /api/auth/register ──────────────────────────────────
router.post('/register', registerRules, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  const { username, email, password, fullName } = req.body;

  try {
    // Prisma lanza error si username/email ya existen (unique constraint)
    // pero es mejor verificar primero para dar mensaje claro
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { username: username.toLowerCase() },
          { email },
        ],
      },
      select: { id: true, username: true, email: true },
    });

    if (existing) {
      const field = existing.username === username.toLowerCase() ? 'username' : 'email';
      return res.status(409).json({ error: `Ese ${field} ya está registrado` });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Prisma crea el usuario — si algo falla, lanza excepción tipada
    const user = await prisma.user.create({
      data: {
        username:     username.toLowerCase(),
        email,
        passwordHash,
        fullName,
      },
      select: {
        id: true, username: true, email: true,
        fullName: true, isPro: true, totalPoints: true,
      },
    });

    res.status(201).json({
      message: '¡Bienvenido a RETO.GG! 🔥',
      token: signToken(user.id),
      user,
    });
  } catch (err) {
    console.error('register error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login',
  [
    body('login').trim().notEmpty().withMessage('Usuario o email requerido'),
    body('password').notEmpty().withMessage('Contraseña requerida'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { login, password } = req.body;

    try {
      const user = await prisma.user.findFirst({
        where: {
          OR: [
            { username: login.toLowerCase() },
            { email: login.toLowerCase() },
          ],
        },
      });

      // Mismo mensaje para "no existe" y "contraseña incorrecta"
      // Esto evita que alguien descubra si un usuario existe o no
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      }

      // Actualizar último acceso (no await — no bloqueamos la respuesta)
      prisma.user.update({
        where: { id: user.id },
        data: { lastActive: new Date() },
      }).catch(console.error);

      res.json({
        message: `¡Bienvenido de vuelta, ${user.fullName}! 💪`,
        token: signToken(user.id),
        user: {
          id:          user.id,
          username:    user.username,
          email:       user.email,
          fullName:    user.fullName,
          avatarUrl:   user.avatarUrl,
          isPro:       user.isPro,
          totalPoints: user.totalPoints,
          streakDays:  user.streakDays,
        },
      });
    } catch (err) {
      console.error('login error:', err);
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

// ── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', authenticate, async (req, res) => {
  try {
    // Prisma hace los JOINs automáticamente con _count
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, username: true, email: true, fullName: true,
        avatarUrl: true, bio: true, isPro: true,
        totalPoints: true, streakDays: true, createdAt: true,
        _count: {
          select: {
            followers:         true,
            following:         true,
            wonChallenges:     true,
            prizesWon:         true,
            participations:    true,
          },
        },
      },
    });

    res.json({ user });
  } catch (err) {
    console.error('me error:', err);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ── POST /api/auth/change-password ───────────────────────────
router.post('/change-password', authenticate,
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { currentPassword, newPassword } = req.body;
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { passwordHash: true },
      });

      if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
        return res.status(401).json({ error: 'Contraseña actual incorrecta' });
      }

      await prisma.user.update({
        where: { id: req.user.id },
        data: { passwordHash: await bcrypt.hash(newPassword, 12) },
      });

      res.json({ message: 'Contraseña actualizada correctamente' });
    } catch (err) {
      res.status(500).json({ error: 'Error interno del servidor' });
    }
  }
);

module.exports = router;
