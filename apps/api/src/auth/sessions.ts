/**
 * Bearer sessions in the sessions collection. Only the sha256 of each
 * token is stored. Refresh rotates both tokens. PHP cookies are a
 * separate session and are not read or written here.
 */
import {ObjectId, type Collection, type Db} from 'mongodb';
import type {Config} from '../config';
import {newToken, tokenHash} from '../crypto';

export interface DeviceDescriptor {
  platform: 'ios' | 'android' | 'web';
  name?: string;
  appVersion?: string;
}

export interface SessionDoc {
  _id: ObjectId;
  userId: ObjectId;
  accessTokenHash: string;
  refreshTokenHash: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
  device?: DeviceDescriptor;
  pushToken?: string;
  createdAt: Date;
  lastUsedAt: Date;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  sessionId: string;
}

/** Issue a new pair. The raw tokens are returned once; only their hashes are stored. */
export async function openSession(db: Db, config: Config, userId: ObjectId, device?: DeviceDescriptor): Promise<TokenPair> {
  const now = new Date();
  const _id = new ObjectId();
  const accessToken = newToken();
  const refreshToken = newToken();
  const doc: SessionDoc = {
    _id,
    userId,
    accessTokenHash: tokenHash(accessToken),
    refreshTokenHash: tokenHash(refreshToken),
    accessExpiresAt: new Date(now.getTime() + config.accessTtlSec * 1000),
    refreshExpiresAt: new Date(now.getTime() + config.refreshTtlSec * 1000),
    createdAt: now,
    lastUsedAt: now,
  };
  if (device) doc.device = device;
  await sessions(db).insertOne(doc);
  return pair(accessToken, refreshToken, config.accessTtlSec, _id.toHexString());
}

/** Replace both tokens. The refresh token just presented stops working. */
export async function rotateSession(db: Db, config: Config, session: SessionDoc): Promise<TokenPair> {
  const now = new Date();
  const accessToken = newToken();
  const refreshToken = newToken();
  await sessions(db).updateOne({_id: session._id}, {$set: {
    accessTokenHash: tokenHash(accessToken),
    refreshTokenHash: tokenHash(refreshToken),
    accessExpiresAt: new Date(now.getTime() + config.accessTtlSec * 1000),
    refreshExpiresAt: new Date(now.getTime() + config.refreshTtlSec * 1000),
    lastUsedAt: now,
  }});
  return pair(accessToken, refreshToken, config.accessTtlSec, session._id.toHexString());
}

export async function findByAccess(db: Db, token: string): Promise<SessionDoc | null> {
  const session = await sessions(db).findOne({accessTokenHash: tokenHash(token)});
  if (!session || session.accessExpiresAt.getTime() <= Date.now()) return null;
  return session;
}

export async function findByRefresh(db: Db, token: string): Promise<SessionDoc | null> {
  const session = await sessions(db).findOne({refreshTokenHash: tokenHash(token)});
  if (!session || session.refreshExpiresAt.getTime() <= Date.now()) return null;
  return session;
}

export async function touchSession(db: Db, session: SessionDoc): Promise<void> {
  await sessions(db).updateOne({_id: session._id}, {$set: {lastUsedAt: new Date()}});
}

export async function deleteSession(db: Db, id: ObjectId): Promise<boolean> {
  const res = await sessions(db).deleteOne({_id: id});
  return res.deletedCount === 1;
}

export async function deleteOtherSessions(db: Db, userId: ObjectId, keep: ObjectId): Promise<void> {
  await sessions(db).deleteMany({userId, _id: {$ne: keep}});
}

export async function deleteUserSessions(db: Db, userId: ObjectId): Promise<void> {
  await sessions(db).deleteMany({userId});
}

export function sessions(db: Db): Collection<SessionDoc> {
  return db.collection<SessionDoc>('sessions');
}

function pair(accessToken: string, refreshToken: string, expiresIn: number, sessionId: string): TokenPair {
  return {accessToken, refreshToken, expiresIn, sessionId};
}

export async function ensureSessionIndexes(db: Db): Promise<void> {
  await sessions(db).createIndex({accessTokenHash: 1}, {unique: true});
  await sessions(db).createIndex({refreshTokenHash: 1}, {unique: true});
  await sessions(db).createIndex({userId: 1});
}
