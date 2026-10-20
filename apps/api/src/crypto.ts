/**
 * Tokens and passwords. Session tokens are 32 random bytes; only their
 * sha256 is stored. Password hashes use the PHP $2y$ bcrypt prefix so
 * either side can change a password.
 */
import {createHash, createHmac, randomBytes, timingSafeEqual} from 'crypto';
import bcrypt from 'bcryptjs';

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** PHP password_hash(PASSWORD_DEFAULT) is bcrypt with a $2y$ prefix. */
export async function hashPassword(password: string): Promise<string> {
  const hash = await bcrypt.hash(password, 10);
  return hash.replace(/^\$2[ab]\$/, '$2y$');
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash).catch(() => false);
}

export function hmacHex(key: string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
