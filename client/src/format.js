export const RANGES = [
  { key: '24h', label: '24 hours', phrase: 'the last 24 hours' },
  { key: '7d', label: '7 days', phrase: 'the last 7 days' },
  { key: '30d', label: '30 days', phrase: 'the last 30 days' },
  { key: '90d', label: '90 days', phrase: 'the last 90 days' },
];

export const fmt = (n) => new Intl.NumberFormat().format(n ?? 0);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Buckets arrive as "YYYY-MM-DDTHH:MM:SS" already in the viewer's time zone, so parse by hand
// instead of using Date (which would shift them into the browser zone a second time).
export function fmtBucket(bucket, range, long = false) {
  const month = MONTHS[Number(bucket.slice(5, 7)) - 1];
  const day = Number(bucket.slice(8, 10));
  const hour = bucket.slice(11, 13);
  if (range === '24h') return long ? `${month} ${day}, ${hour}:00` : `${hour}:00`;
  return `${month} ${day}`;
}

const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
export function countryName(code) {
  if (!code || code === 'Unknown') return 'Unknown';
  try {
    return regionNames?.of(code.toUpperCase()) || code;
  } catch {
    return code;
  }
}

export const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const fmtDate = (iso) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
