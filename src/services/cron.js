// src/services/cron.js
const cron   = require('node-cron')
const prisma = require('../config/prisma')
const { sendMembershipExpiringEmail } = require('./email')

const startCronJobs = () => {

  // Corre todos los días a las 9am
  cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Running membership expiring check...')

    try {
      const in3Days = new Date()
      in3Days.setDate(in3Days.getDate() + 3)
      in3Days.setHours(23, 59, 59, 999)

      const tomorrow = new Date()
      tomorrow.setDate(tomorrow.getDate() + 2)
      tomorrow.setHours(23, 59, 59, 999)

      // Usuarios cuya membresía vence en exactamente 3 días
      const expiringUsers = await prisma.user.findMany({
        where: {
          isPro: true,
          subscriptionEndsAt: {
            gte: tomorrow,
            lte: in3Days,
          },
        },
        select: { email: true, username: true, subscriptionEndsAt: true },
      })

      console.log(`📧 Found ${expiringUsers.length} memberships expiring in 3 days`)

      for (const user of expiringUsers) {
        await sendMembershipExpiringEmail(user, 3).catch(
          err => console.error(`Email error for ${user.email}:`, err)
        )
      }
    } catch (err) {
      console.error('Cron job error:', err)
    }
  })

  console.log('✅ Cron jobs started')
}

module.exports = { startCronJobs }