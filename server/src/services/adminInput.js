// Input parsing for the admin routes.

// Positive integer id from a URL segment, or null
export const parseId = (v) => (/^\d{1,15}$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);

// A moderator's reason or note. Required for takedowns (it ends up in the audit trail and, for links, is shown to the owner).
export function parseReason(input, required = true) {
  const text = typeof input === 'string' ? input.trim() : '';
  if (!text) return required ? { error: 'A reason is required' } : { value: null };
  if (text.length > 500) return { error: 'The reason can be at most 500 characters' };
  return { value: text };
}

// ILIKE pattern for a "contains" search, with %, _ and \ in the input taken literally. null = no filter.
export function likePattern(q) {
  const text = typeof q === 'string' ? q.trim().slice(0, 200) : '';
  return text ? `%${text.replace(/[\\%_]/g, '\\$&')}%` : null;
}
