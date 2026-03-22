require('dotenv').config();
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

resend.emails.send({
  from: 'onboarding@resend.dev',
  to: 'hendrickpolanco2003@gmail.com',
  subject: 'Test RETO.GG 🎮',
  html: '<p>If you see this, Resend is working!</p>'
}).then(data => {
  console.log('✅ Email sent:', data);
}).catch(err => {
  console.error('❌ Error:', err);
});

// lsof -ti:8080 | xargs kill -9