// server.js — RETO.GG Backend
// Node.js + Express + PostgreSQL (Supabase)
require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

// ── ROUTES ───────────────────────────────────────────────────
const authRoutes       = require('./src/routes/auth');
const challengeRoutes  = require('./src/routes/challenges');
const progressRoutes   = require('./src/routes/progress');
const rankingRoutes    = require('./src/routes/ranking');
const userRoutes       = require('./src/routes/users');
const paymentRoutes   = require('./src/routes/payments')
const adminRoutes = require('./src/routes/admin');
const { startCronJobs } = require('./src/services/cron')

const app = express();

// ── SECURITY MIDDLEWARE ──────────────────────────────────────
app.use(helmet());  // Headers de seguridad automáticos

// CORS: solo tu dominio puede usar la API
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || 'http://localhost:5173',
  // origin: [
  //   process.env.ALLOWED_ORIGIN,
  //   'http://localhost:5173',
  //   'http://localhost:5176',
  //   'https://retog.vercel.app'].filter(Boolean),
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── RATE LIMITING ────────────────────────────────────────────
// General: 100 requests por 15 minutos por IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Demasiadas peticiones, espera unos minutos' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Auth: más restrictivo para evitar fuerza bruta
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de login, espera 15 minutos' },
});

// Upload: limitar subidas de media
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,  // 1 hora
  max: 20,                    // máx 20 uploads por hora
  message: { error: 'Límite de subidas alcanzado por hora' },
});

app.use(generalLimiter);
//--admin 
// En los imports de routes
app.use('/api/admin', adminRoutes);
//--ROUTER PAYMENT-----------
app.use('/api/payments', paymentRoutes)
// ── BODY PARSING ─────────────────────────────────────────────
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }))
app.use(express.json({ limit: '10kb' }));      // JSON bodies (no para media)
app.use(express.urlencoded({ extended: true }));

// ── HEALTH CHECK ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'RETO.GG API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// ── API ROUTES ───────────────────────────────────────────────
app.use('/api/auth',       authLimiter,   authRoutes);
app.use('/api/challenges',                challengeRoutes);
app.use('/api/progress',   uploadLimiter, progressRoutes);
app.use('/api/ranking',                   rankingRoutes);
app.use('/api/users',                     userRoutes);

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Ruta ${req.method} ${req.path} no existe` });
});

// ── GLOBAL ERROR HANDLER ─────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('💥 Error no manejado:', err);

  // Error de multer (archivo muy grande, etc.)
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'El archivo es demasiado grande' });
  }

  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Error interno del servidor'
      : err.message,
  });
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`
  🔥 RETO.GG API corriendo
  ─────────────────────────────
  🌐 http://localhost:${PORT}
  💚 Health: http://localhost:${PORT}/health
  📦 Entorno: ${process.env.NODE_ENV || 'development'}
  `);
  startCronJobs()

});

module.exports = app;
