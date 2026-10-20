// Maps a referrer hostname to the name a person would recognise.
// Anything not listed falls back to the hostname itself; no referrer means "Direct".
const RULES = [
  [/^(t\.co|(.+\.)?twitter\.com|(.+\.)?x\.com)$/, 'Twitter / X'],
  [/^((l|m|lm|web)\.)?facebook\.com$|^fb\.com$/, 'Facebook'],
  [/^(l\.)?instagram\.com$/, 'Instagram'],
  [/^(lnkd\.in|(.+\.)?linkedin\.com)$/, 'LinkedIn'],
  [/^(youtu\.be|(.+\.)?youtube\.com)$/, 'YouTube'],
  [/^(old\.|out\.)?reddit\.com$|^redd\.it$/, 'Reddit'],
  [/^(.+\.)?google\.[a-z.]+$/, 'Google'],
  [/^(.+\.)?bing\.com$/, 'Bing'],
  [/^(.+\.)?duckduckgo\.com$/, 'DuckDuckGo'],
  [/^(web\.)?whatsapp\.com$|^wa\.me$/, 'WhatsApp'],
  [/^(web\.)?telegram\.org$|^t\.me$/, 'Telegram'],
  [/^(.+\.)?(github\.com)$/, 'GitHub'],
  [/^news\.ycombinator\.com$/, 'Hacker News'],
];

export function labelReferrer(host) {
  if (!host) return 'Direct';
  for (const [regex, label] of RULES) if (regex.test(host)) return label;
  return host;
}
