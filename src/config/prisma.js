// src/config/prisma.js
// Un solo cliente Prisma para toda la app
// (crear múltiples instancias rompe el pool de conexiones)

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development'
    ? ['query', 'warn', 'error']   // En dev: ver todas las queries generadas
    : ['warn', 'error'],           // En prod: solo errores importantes
  errorFormat: 'pretty',
});

// Manejar cierre limpio (importante en Railway/Vercel)
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

module.exports = prisma;
