import { createHash, randomBytes } from 'node:crypto';

/** `prefix` + base64url of 32 random bytes (pairing and runner tokens, architecture §13.1). */
export function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/** Tokens are stored only as their SHA-256 hex digest. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
