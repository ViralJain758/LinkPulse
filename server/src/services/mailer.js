import { config } from '../config.js';

// Transactional email (verification, password reset). Uses the same SMTP settings as link alerts.
let transport; // undefined = not built yet, null = SMTP not configured

async function getTransport() {
  if (transport !== undefined) return transport;
  if (!config.smtpHost || !config.authFromEmail) return (transport = null);
  const nodemailer = await import('nodemailer');
  transport = nodemailer.default.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser && config.smtpPass ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
  return transport;
}

export async function sendMail({ to, subject, text }) {
  const t = await getTransport();
  if (!t) {
    // Without SMTP the links are printed so local development works. Never in production:
    // a reset link in a log file is a reset link for anyone who can read the log.
    if (config.nodeEnv === 'production') console.warn(`Email to ${to} not sent: SMTP is not configured`);
    else console.log(`[email not sent: SMTP not configured]\nTo: ${to}\nSubject: ${subject}\n\n${text}\n`);
    return;
  }
  await t.sendMail({ from: config.authFromEmail, to, subject, text });
}

const link = (param, token) => `${config.clientOrigin.replace(/\/$/, '')}/?${param}=${encodeURIComponent(token)}`;

export const verificationMail = (token) => ({
  subject: 'Confirm your LinkPulse email',
  text: `Confirm your email address to finish setting up LinkPulse:\n\n${link('verify', token)}\n\nThe link works once and expires in 24 hours. If you did not sign up, ignore this email.`,
});

export const resetMail = (token) => ({
  subject: 'Reset your LinkPulse password',
  text: `Someone asked to reset the password for this LinkPulse account. To choose a new one, open:\n\n${link('reset', token)}\n\nThe link works once and expires in 1 hour. Resetting signs you out everywhere. If this was not you, ignore this email: your password has not changed.`,
});

export const passwordChangedMail = () => ({
  subject: 'Your LinkPulse password was changed',
  text: 'The password for your LinkPulse account was just changed and all other devices were signed out. If this was not you, reset your password right away.',
});
