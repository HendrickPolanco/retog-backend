// src/services/email.js
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM   = 'onboarding@resend.dev'; // change to noreply@retog.gg when you have a domain

const sendWelcomeEmail = async (user) => {
    // console.log('📧 Sending welcome email to:', user.email);
    await resend.emails.send({
    from:    FROM,
    to:    'hendrickpolanco2003@gmail.com'  ,
    // user.email
    subject: 'Welcome to RETO.GG! 🎮',
    html: `
      <h1>Hey ${user.username}!</h1>
      <p>You're officially part of RETO.GG. Start accepting challenges and climb the leaderboard.</p>
      <a href="https://retog.gg" style="background:#6366f1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;">
        Go to RETO.GG
      </a>
    `,
  });
};

const sendChallengeCompletedEmail = async (user, challenge) => {
  await resend.emails.send({
    from:    FROM,
    to: 'hendrickpolanco2003@gmail.com'  ,
    // user.email
    subject: `You completed "${challenge.title}"! 🏆`,
    html: `
      <h1>Well done, ${user.username}!</h1>
      <p>You completed the challenge <strong>${challenge.title}</strong> and earned <strong>${challenge.points} points</strong>.</p>
      <p>Keep it up and rise through the ranks.</p>
    `,
  });
};

const sendDuelWonEmail = async (winner, loser, challenge) => {
    // console.log('📧 Sending won email to:', user.email);
    await resend.emails.send({
    from:    FROM,
    to:  'hendrickpolanco2003@gmail.com'  ,
    //    winner.email,
    subject: `You won the duel! ⚔️🏆`,
    html: `
      <h1>Victory, ${winner.username}!</h1>
      <p>@${loser.username} surrendered in <strong>${challenge.title}</strong>.</p>
      <p>You earned <strong>${challenge.points} points</strong>. Keep dominating! 🔥</p>
    `,
  });
};

const sendDuelAcceptedEmail = async (creator, rival, challenge) => {
    // console.log('📧 Sending  duel accepted email to:', user.email);

    await resend.emails.send({
    from:    FROM,
    to:       'hendrickpolanco2003@gmail.com'  ,
    // creator.email,
    subject: `@${rival.username} accepted your duel! ⚔️`,
    html: `
      <h1>The duel has begun, ${creator.username}!</h1>
      <p>@${rival.username} accepted your challenge <strong>${challenge.title}</strong>.</p>
      <p>Time to prove yourself. Good luck! 🔥</p>
    `,
  });
};

const sendMembershipActivatedEmail = async (user, plan) => {
  await resend.emails.send({
    from:    FROM,
    to:      user.email,
    subject: 'Your membership is now active! 💳',
    html: `
      <h1>Thanks, ${user.username}!</h1>
      <p>Your <strong>${plan}</strong> membership is active.</p>
      <p>You now have access to all exclusive challenges.</p>
    `,
  });
};

const sendMembershipExpiringEmail = async (user, daysLeft) => {
  await resend.emails.send({
    from:    FROM,
    to:      user.email,
    subject: `⚠️ Your membership expires in ${daysLeft} days`,
    html: `
      <h1>Hey ${user.username},</h1>
      <p>Your membership expires in <strong>${daysLeft} days</strong>.</p>
      <p>Renew it to keep access to all exclusive challenges.</p>
      <a href="https://retog.gg/pricing" style="background:#6366f1;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;">
        Renew membership
      </a>
    `,
  });
};

module.exports = {
  sendWelcomeEmail,
  sendChallengeCompletedEmail,
  sendDuelWonEmail,
  sendDuelAcceptedEmail,
  sendMembershipActivatedEmail,
  sendMembershipExpiringEmail,
};