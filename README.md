# RETO.GG Backend v2 — con Prisma ORM

## ¿Por qué Prisma vs SQL directo?

| | SQL directo (v1) | Prisma (v2) |
|---|---|---|
| Seguridad | ✅ Seguro con parámetros | ✅ Seguro por diseño |
| Legibilidad | ⚠️ JOINs complejos difíciles | ✅ Autocompletado + tipado |
| Migraciones | ❌ SQL manual | ✅ Versionadas automáticamente |
| Mantenimiento | ⚠️ Requiere conocer SQL profundo | ✅ Cualquier dev lo entiende |
| Queries complejas | ✅ Control total | ⚠️ Usa `$queryRaw` para rankings |

**Decisión tomada: Prisma para el 80%, `$queryRaw` para los leaderboards complejos.**

---

## Setup

### 1. Instalar dependencias
```bash
npm install
```

### 2. Variables de entorno
```bash
cp .env.example .env
# Edita con tus valores de Supabase y Cloudinary
```

### 3. Aplicar el schema a la base de datos
```bash
# Genera el cliente de Prisma + aplica el schema a Supabase
npx prisma migrate dev --name init

# O si solo quieres pushear sin historial de migraciones (prototipo):
npx prisma db push
```

### 4. Ver la DB visualmente (opcional pero útil)
```bash
npx prisma studio
# Abre http://localhost:5555 — interfaz visual de tus tablas
```

### 5. Correr el servidor
```bash
npm run dev    # desarrollo con auto-reload
npm start      # producción
```

---

## Estructura

```
retog-v2/
├── prisma/
│   └── schema.prisma        ← FUENTE DE VERDAD de la DB
├── src/
│   ├── config/
│   │   └── prisma.js        ← Cliente Prisma singleton
│   ├── middleware/
│   │   └── auth.js          ← Verificación JWT
│   ├── services/
│   │   └── cloudinary.js    ← Reglas de video/foto
│   └── routes/
│       ├── auth.js          ← Prisma puro
│       ├── challenges.js    ← Prisma + transactions
│       ├── progress.js      ← Prisma + Cloudinary
│       ├── ranking.js       ← Prisma + $queryRaw (leaderboards)
│       └── users.js         ← Prisma puro
└── server.js
```

---

## Comandos Prisma útiles

```bash
# Ver cambios pendientes sin aplicar
npx prisma migrate status

# Generar cliente después de cambiar schema.prisma
npx prisma generate

# Resetear DB (⚠️ borra todo — solo en desarrollo)
npx prisma migrate reset

# Abrir interfaz visual
npx prisma studio
```

---

## Cuándo usar `$queryRaw` vs Prisma normal

**Usa Prisma normal para:**
- CRUD básico (crear, leer, actualizar, eliminar)
- Relaciones simples con `include`
- Filtros, paginación, ordenamiento
- Contar registros con `_count`

**Usa `$queryRaw` para:**
- Window functions (`ROW_NUMBER`, `RANK`, `LAG`)
- CTEs (`WITH ...`)
- Múltiples `COUNT FILTER` en la misma query
- Queries analíticas de ranking/estadísticas

**Regla de seguridad con `$queryRaw`:**
```js
// ✅ CORRECTO — usa Prisma.sql para variables
const result = await prisma.$queryRaw`
  SELECT * FROM users WHERE id = ${userId}
`;

// ❌ NUNCA — interpolación directa = SQL injection
const result = await prisma.$queryRaw`
  SELECT * FROM users WHERE id = '${userId}'
`;
```
