import { ownHostname } from './domainDns.js';
import { resolveDomainId } from './domainLookup.js';

export const REPORT_REASONS = {
  phishing: 'Phishing or scam',
  malware: 'Malware or harmful download',
  spam: 'Spam',
  illegal: 'Illegal content',
  copyright: 'Copyright or trademark infringement',
  other: 'Something else',
};

export const MAX_DETAILS = 2000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_LIKE = /^[A-Za-z0-9_-]{1,64}$/;

// Turns what a reporter typed into { slug, host } (host is null when the input was a bare slug).
// Accepts "https://go.example.com/sale?x=1", "go.example.com/sale", "/sale" or "sale".
export function parseLinkRef(input) {
  const raw = String(input ?? '').trim();
  if (!raw || raw.length > 500) return null;
  if (SLUG_LIKE.test(raw.replace(/^\//, ''))) return { slug: raw.replace(/^\//, ''), host: null };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  const slug = decodeURIComponent(url.pathname.split('/')[1] ?? '');
  // Hosts are checked against the ones this service serves later (resolveLinkRef), which also covers localhost in development
  if (!url.hostname || !SLUG_LIKE.test(slug)) return null;
  return { slug, host: url.hostname.toLowerCase() };
}

// Resolves a parsed reference to { slug, domainId }, or null when the host is not one this service serves.
// A bare slug means "on the host the form was opened on" (so /report/sale on a custom domain is that domain's /sale).
export async function resolveLinkRef(ref, requestHost) {
  if (!ref) return null;
  const host = ref.host ?? requestHost?.toLowerCase() ?? ownHostname;
  if (host === ownHostname) return { slug: ref.slug, domainId: null };
  const domainId = await resolveDomainId(host);
  if (domainId != null) return { slug: ref.slug, domainId };
  // An unknown host typed into the form is not ours. An unknown host the page was opened on is treated like
  // the redirect treats it: the service's own namespace.
  return ref.host ? null : { slug: ref.slug, domainId: null };
}

// Validates the submitted form. Returns { value } or { error }.
export function validateReport(body) {
  const reason = String(body?.reason ?? '');
  if (!Object.hasOwn(REPORT_REASONS, reason)) return { error: 'Choose a reason.' };
  const details = String(body?.details ?? '').trim();
  if (details.length > MAX_DETAILS) return { error: `Details can be at most ${MAX_DETAILS} characters.` };
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (email && (email.length > 254 || !EMAIL_REGEX.test(email))) return { error: 'That email address does not look right. Leave it empty if you prefer.' };
  return { value: { reason, details: details || null, email: email || null } };
}
