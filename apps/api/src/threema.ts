import {createHmac, timingSafeEqual} from 'crypto';
import type {Collection, Db} from 'mongodb';

/** Verification messages an account, and a destination id, may cause per hour. */
const SEND_LIMIT = 5;
const SEND_WINDOW_SEC = 3600;

/** Crockford base32, the same alphabet destinations.php uses. I, L, O, and U are omitted. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 10-character code (50 bits) from HMAC-SHA256(threema id, shared hash key),
 * grouped as XXXXX-XXXXX. Matches calcThreemaValidationCode() on the PHP site,
 * so a code sent by either one verifies on the other.
 */
export function threemaValidationCode(threemaId: string, hashKey: string): string {
  const hash = createHmac('sha256', hashKey).update(threemaId).digest();
  let code = '';
  let value = 0;
  let bits = 0;
  let offset = 0;
  while (code.length < 10) {
    value = ((value & ((1 << bits) - 1)) << 8) | hash[offset];
    bits += 8;
    offset++;
    while (bits >= 5 && code.length < 10) {
      bits -= 5;
      code += ALPHABET[(value >> bits) & 31];
    }
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Strip spaces and hyphens, and accept O/I/L as the digits the alphabet leaves out. */
export function normalizeThreemaValidationCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]+/g, '').replace(/[OIL]/g, (char) => (char === 'O' ? '0' : '1'));
}

/**
 * Count a verification send against the account and the destination id.
 * Returns how many seconds to wait when either side is already at the limit.
 */
export async function claimThreemaSend(db: Db, userId: string, threemaId: string): Promise<{ok: true} | {ok: false; retryAfter: number}> {
  const keys = [`user:${userId}`, `to:${threemaId}`];
  const now = new Date();
  const open = await sends(db).find({_id: {$in: keys}, until: {$gt: now}}).toArray();
  let wait = 0;
  for (const doc of open) {
    if ((doc.n ?? 0) >= SEND_LIMIT && doc.until) {
      const remaining = Math.ceil((doc.until.getTime() - now.getTime()) / 1000);
      if (remaining > wait) wait = remaining;
    }
  }
  if (wait > 0) return {ok: false, retryAfter: wait};
  const until = new Date(now.getTime() + SEND_WINDOW_SEC * 1000);
  for (const key of keys) {
    const existing = open.find((doc) => doc._id === key);
    if (existing) await sends(db).updateOne({_id: key}, {$inc: {n: 1}});
    else await sends(db).updateOne({_id: key}, {$set: {n: 1, until}}, {upsert: true});
  }
  return {ok: true};
}

export function threemaCodeMatches(submitted: string, threemaId: string, hashKey: string): boolean {
  const expected = normalizeThreemaValidationCode(threemaValidationCode(threemaId, hashKey));
  const given = normalizeThreemaValidationCode(submitted);
  if (expected.length !== given.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
}

interface SendDoc {
  _id: string;
  n: number;
  until: Date;
}

function sends(db: Db): Collection<SendDoc> {
  return db.collection<SendDoc>('threemaSends');
}
