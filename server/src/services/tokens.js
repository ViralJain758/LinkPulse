import { createHash, randomBytes } from 'node:crypto';

// Opaque random secrets for refresh tokens and email links. Only the SHA-256 is stored, so a
// database leak does not hand out working tokens. (A fast hash is fine here: the input is 256
// random bits, not a guessable password.)
export const newToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
