// bcrypt only reads the first 72 bytes, so a longer password would be silently truncated.
export function passwordError(password) {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters';
  if (Buffer.byteLength(password) > 72) return 'Password must be at most 72 bytes';
  return null;
}
