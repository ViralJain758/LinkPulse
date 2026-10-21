import { config } from '../config.js';

const normalizeMilestones = (value) => {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const seen = new Set();
  return raw
    .filter((n) => n !== null && n !== undefined && n !== '')
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n > 0)
    .filter((n) => {
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    })
    .sort((a, b) => a - b);
};

export function detectTriggeredAlerts(link, previousUsedClicks, nextUsedClicks) {
  const alerts = [];
  const milestones = normalizeMilestones(link?.notifyOnClicks ?? link?.notify_on_clicks);
  const maxClicks = link?.maxClicks ?? link?.max_clicks ?? null;

  if (maxClicks === 1 && previousUsedClicks < nextUsedClicks) {
    alerts.push('one_time_used');
  }

  for (const milestone of milestones) {
    if (previousUsedClicks < milestone && nextUsedClicks >= milestone) {
      alerts.push(`milestone_${milestone}`);
    }
  }

  return [...new Set(alerts)];
}

function pickWebhookUrl(link) {
  return link?.webhookUrl ?? link?.webhook_url ?? null;
}

function pickNotificationEmail(link) {
  return link?.notificationEmail ?? link?.notification_email ?? null;
}

async function notificationTransport() {
  if (!config.smtpHost || !config.notificationFromEmail) return null;
  const nodemailer = await import('nodemailer');
  return nodemailer.default.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth:
      config.smtpUser && config.smtpPass ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
  });
}

export async function triggerLinkAlerts(link, events, { usedClicksBefore, usedClicksAfter } = {}) {
  const eventList = Array.isArray(events) ? events : [events];
  if (eventList.length === 0) return;

  const payloadBase = {
    slug: link?.slug,
    shortUrl: link?.shortUrl ?? link?.short_url ?? null,
    targetUrl: link?.targetUrl ?? link?.target_url ?? null,
    usedClicksBefore: usedClicksBefore ?? 0,
    usedClicksAfter: usedClicksAfter ?? 0,
    maxClicks: link?.maxClicks ?? link?.max_clicks ?? null,
    occurredAt: new Date().toISOString(),
  };

  const webhookUrl = pickWebhookUrl(link);
  if (webhookUrl) {
    for (const eventName of eventList) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'LinkPulse/1.0' },
          body: JSON.stringify({ ...payloadBase, event: eventName }),
        });
      } catch (err) {
        console.error('Webhook alert failed:', err.message);
      }
    }
  }

  const emailAddress = pickNotificationEmail(link);
  if (emailAddress) {
    const transport = await notificationTransport();
    if (transport) {
      for (const eventName of eventList) {
        try {
          await transport.sendMail({
            from: config.notificationFromEmail,
            to: emailAddress,
            subject: `LinkPulse alert: ${eventName}`,
            text: `Link: ${payloadBase.shortUrl || payloadBase.slug}\nEvent: ${eventName}\nUsed clicks: ${payloadBase.usedClicksAfter}`,
          });
        } catch (err) {
          console.error('Email alert failed:', err.message);
        }
      }
    }
  }
}
