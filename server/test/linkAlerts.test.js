import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused';
process.env.JWT_SECRET ||= 'test-secret';
process.env.BASE_URL ||= 'http://localhost:4000';

const { detectTriggeredAlerts, triggerLinkAlerts } = await import('../src/services/linkAlerts.js');

test('detectTriggeredAlerts catches one-time and milestone thresholds', () => {
  const link = { maxClicks: 10, notifyOnClicks: [5, 10] };
  assert.deepEqual(detectTriggeredAlerts(link, 4, 5), ['milestone_5']);
  assert.deepEqual(detectTriggeredAlerts(link, 9, 10), ['milestone_10']);
  assert.deepEqual(detectTriggeredAlerts({ maxClicks: 1 }, 0, 1), ['one_time_used']);
  assert.deepEqual(detectTriggeredAlerts(link, 5, 5), []);
});

test('triggerLinkAlerts sends webhook payloads when configured', async () => {
  const calls = [];
  const sendWebhook = async (url, body) => {
    calls.push({ url, body: JSON.parse(body) });
    return { status: 200 };
  };

  const link = {
    slug: 'promo',
    shortUrl: 'http://localhost:4000/promo',
    targetUrl: 'https://example.com',
    maxClicks: 5,
    notifyOnClicks: [3],
    webhookUrl: 'https://example.com/hook',
    notificationEmail: 'ops@example.com',
  };

  await triggerLinkAlerts(link, ['milestone_3'], { usedClicksBefore: 2, usedClicksAfter: 3, sendWebhook });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/hook');
  assert.equal(calls[0].body.event, 'milestone_3');
  assert.equal(calls[0].body.usedClicksAfter, 3);
});

test('triggerLinkAlerts swallows a blocked webhook and still returns', async () => {
  const sendWebhook = async () => {
    throw new Error('blocked url');
  };
  await triggerLinkAlerts({ slug: 'x', webhookUrl: 'http://127.0.0.1/x' }, ['milestone_1'], { sendWebhook });
});
