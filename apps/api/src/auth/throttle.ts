/**
 * Shared login throttle. Keys are `ip:` and `user:` in loginAttempts,
 * the same collection and limits the PHP site uses (20 failures / 15 min).
 * A successful login clears only the username counter.
 */
import type {Collection, Db} from 'mongodb';

const LIMIT = 20;
const WINDOW_SEC = 900;

interface AttemptDoc {
  _id: string;
  n: number;
  until: Date;
}

export interface ThrottleState {
  keys: string[];
  wait: number;
}

export function attemptKeys(ip: string | undefined, username: string): string[] {
  const keys: string[] = [];
  if (ip) keys.push('ip:' + ip);
  if (username) keys.push('user:' + username.slice(0, 64).toUpperCase());
  return keys;
}

export async function throttleState(db: Db, ip: string | undefined, username: string): Promise<ThrottleState> {
  const keys = attemptKeys(ip, username);
  const now = new Date();
  let wait = 0;
  if (keys.length) {
    const docs = await attempts(db).find({_id: {$in: keys}, until: {$gt: now}}).toArray();
    for (const doc of docs) {
      if ((doc.n ?? 0) >= LIMIT && doc.until) {
        const remaining = Math.ceil((doc.until.getTime() - now.getTime()) / 1000);
        if (remaining > wait) wait = remaining;
      }
    }
  }
  return {keys, wait};
}

export async function noteFailure(db: Db, keys: string[]): Promise<void> {
  const now = new Date();
  const until = new Date(now.getTime() + WINDOW_SEC * 1000);
  for (const key of keys) {
    const existing = await attempts(db).findOne({_id: key, until: {$gt: now}});
    if (existing) {
      await attempts(db).updateOne({_id: key}, {$inc: {n: 1}});
    } else {
      await attempts(db).updateOne({_id: key}, {$set: {n: 1, until}}, {upsert: true});
    }
  }
}

/** A successful login clears the username counter only, matching the PHP site. */
export async function clearUserFailures(db: Db, username: string): Promise<void> {
  if (!username) return;
  await attempts(db).deleteOne({_id: 'user:' + username.slice(0, 64).toUpperCase()});
}

function attempts(db: Db): Collection<AttemptDoc> {
  return db.collection<AttemptDoc>('loginAttempts');
}
