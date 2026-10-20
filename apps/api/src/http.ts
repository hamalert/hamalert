import type {FastifyReply, FastifyRequest} from 'fastify';
import {ObjectId, type Db} from 'mongodb';
import type {Config} from './config';
import {problemBody, unauthorized, type ApiError} from './errors';
import {findByAccess, touchSession, type SessionDoc} from './auth/sessions';
import type {Mailer} from './mail';
import type Redis from 'ioredis';

/** Shared clients handed to every route through app.deps. */
export interface AppDeps {
  config: Config;
  db: Db;
  redis: Redis | null;
  mailer: Mailer;
  fetchImpl?: typeof fetch;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: Record<string, any>;
    authSession?: SessionDoc;
  }
  interface FastifyInstance {
    deps: AppDeps;
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export function sendError(reply: FastifyReply, err: ApiError, instance?: string) {
  if (err.headers) {
    for (const [key, value] of Object.entries(err.headers)) reply.header(key, value);
  }
  return reply.code(err.status).type('application/problem+json').send(problemBody(err, instance));
}

/**
 * preHandler for routes that require a session.
 * Authorization: Bearer is the normal path. GET /v1/spots/stream also
 * accepts ?access_token= because EventSource cannot set headers.
 * Sets req.authUser and req.authSession.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers.authorization;
  const query = req.query as {access_token?: string};
  const onStream = req.routeOptions.url?.endsWith('/spots/stream') === true;
  const token = header?.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : (onStream ? query.access_token : undefined);
  if (!token) return sendError(reply, unauthorized());
  const session = await findByAccess(req.server.deps.db, token);
  if (!session) return sendError(reply, unauthorized());
  const user = await req.server.deps.db.collection('users').findOne({_id: session.userId});
  if (!user) return sendError(reply, unauthorized('Account no longer exists'));
  req.authSession = session;
  req.authUser = user;
  void touchSession(req.server.deps.db, session);
}

export function userOf(req: FastifyRequest): Record<string, any> {
  if (!req.authUser) throw unauthorized();
  return req.authUser;
}

export function oid(id: string): ObjectId | null {
  if (!/^[a-f0-9]{24}$/i.test(id)) return null;
  return new ObjectId(id);
}

export function clientIp(req: FastifyRequest): string | undefined {
  return req.ip || undefined;
}

export async function reloadUser(db: Db, id: ObjectId): Promise<Record<string, any> | null> {
  return db.collection('users').findOne({_id: id});
}

export function iso(value: unknown): string | undefined {
  const date = asDate(value);
  return date ? date.toISOString() : undefined;
}

export function asDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (value && typeof (value as {toDate?: () => Date}).toDate === 'function') return (value as {toDate: () => Date}).toDate();
  return undefined;
}
