// src/routes/payments.js
// POST /api/payments/checkout     → Crear sesión de pago
// POST /api/payments/webhook      → Webhook de Stripe (eventos)
// POST /api/payments/portal       → Portal de cliente (cancelar, ver facturas)
// GET  /api/payments/status       → Ver si el usuario es Pro

const express = require('express')
const stripe  = require('stripe')(process.env.STRIPE_SECRET_KEY)
const prisma  = require('../config/prisma')
const { authenticate } = require('../middleware/auth')

const router = express.Router()

const PRICE_ID = process.env.STRIPE_PRICE_ID
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
// ── GET /api/payments/status ─────────────────────────────────
// Ver si el usuario actual es Pro
router.get('/status', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { isPro: true, stripeCustomerId: true },
    })
    res.json({ isPro: user.isPro, hasStripe: !!user.stripeCustomerId })
  } catch (err) {
    res.status(500).json({ error: 'Error verificando estado Pro' })
  }
})

// ── POST /api/payments/checkout ──────────────────────────────
// Crea una sesión de Stripe Checkout y devuelve la URL
router.post('/checkout', authenticate, async (req, res) => {
  try {
    // Verificar si ya es Pro
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { isPro: true, email: true, stripeCustomerId: true, fullName: true },
    })

    if (user.isPro) {
      return res.status(400).json({ error: 'Ya tienes el Plan Pro activo' })
    }

    // Crear o reusar cliente de Stripe
    let customerId = user.stripeCustomerId
    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    user.email,
        name:     user.fullName,
        metadata: { userId: req.user.id },
      })
      customerId = customer.id

      // Guardar el customerId en la DB
      await prisma.user.update({
        where: { id: req.user.id },
        data:  { stripeCustomerId: customerId },
      })
    }

    // Crear sesión de checkout
    const session = await stripe.checkout.sessions.create({
      customer:    customerId,
      mode:        'subscription',
      line_items:  [{ price: PRICE_ID, quantity: 1 }],
      success_url: `${FRONTEND_URL}/pro-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${FRONTEND_URL}/perfil`,
      metadata:    { userId: req.user.id },
      subscription_data: {
        metadata: { userId: req.user.id },
      },
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('Stripe checkout error:', err)
    res.status(500).json({ error: 'Error creando sesión de pago' })
  }
})

// ── POST /api/payments/portal ────────────────────────────────
// Portal del cliente para gestionar suscripción (cancelar, ver facturas)
router.post('/portal', authenticate, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { stripeCustomerId: true },
    })

    if (!user.stripeCustomerId) {
      return res.status(400).json({ error: 'No tienes una suscripción activa' })
    }

    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: `${FRONTEND_URL}/perfil`,
    })

    res.json({ url: session.url })
  } catch (err) {
    console.error('Stripe portal error:', err)
    res.status(500).json({ error: 'Error abriendo portal de pagos' })
  }
})

// ── POST /api/payments/webhook ───────────────────────────────
// Stripe llama a este endpoint cuando ocurre un evento
// IMPORTANTE: debe ir ANTES del middleware express.json()
// porque necesita el body raw para verificar la firma
router.post('/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig     = req.headers['stripe-signature']
    const secret  = process.env.STRIPE_WEBHOOK_SECRET

    let event
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret)
    } catch (err) {
      console.error('Webhook signature error:', err.message)
      return res.status(400).json({ error: `Webhook error: ${err.message}` })
    }

    try {
      switch (event.type) {

        // Suscripción activada o renovada
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const sub    = event.data.object
          const userId = sub.metadata?.userId
          if (!userId) break

          const isActive = sub.status === 'active' || sub.status === 'trialing'
          await prisma.user.update({
            where: { id: userId },
            data:  { isPro: isActive },
          })
          console.log(`✅ Usuario ${userId} Pro: ${isActive}`)
          break
        }

        // Suscripción cancelada
        case 'customer.subscription.deleted': {
          const sub    = event.data.object
          const userId = sub.metadata?.userId
          if (!userId) break

          await prisma.user.update({
            where: { id: userId },
            data:  { isPro: false },
          })

          // Notificar al usuario
          await prisma.notification.create({
            data: {
              userId,
              type:  'subscription_cancelled',
              title: '😔 Tu Plan Pro ha sido cancelado',
              body:  'Vuelve cuando quieras para reactivarlo.',
            },
          })
          console.log(`❌ Usuario ${userId} dejó de ser Pro`)
          break
        }

        // Pago fallido
        case 'invoice.payment_failed': {
          const invoice  = event.data.object
          const customer = await stripe.customers.retrieve(invoice.customer)
          const userId   = customer.metadata?.userId
          if (!userId) break

          await prisma.notification.create({
            data: {
              userId,
              type:  'payment_failed',
              title: '⚠️ Pago fallido',
              body:  'No pudimos procesar tu pago. Actualiza tu método de pago para mantener el Plan Pro.',
            },
          })
          break
        }
      }
    } catch (err) {
      console.error('Webhook handler error:', err)
    }

    res.json({ received: true })
  }
)

module.exports = router
