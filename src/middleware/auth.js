// src/middleware/auth.js
const jwt    = require('jsonwebtoken');
const prisma = require('../config/prisma'); // ← Prisma, no db.js

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Token requerido' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true, username: true, email: true,
        fullName: true, isPro: true, totalPoints: true,
      },
    });

    if (!user) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expirado, inicia sesión nuevamente' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Token inválido' });
    }
    next(err);
  }
};

const requirePro = (req, res, next) => {
  if (!req.user.isPro) {
    return res.status(403).json({
      error: 'Esta función requiere Plan Pro',
      upgrade_url: '/pricing',
    });
  }
  next();
};

module.exports = { authenticate, requirePro };