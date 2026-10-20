/**
 * Authentication and account routes. buildApp mounts these under /v1.
 *
 * Sessions are opaque bearer tokens in `sessions`. PHP cookie sessions are
 * left alone. Signup tokens stay plaintext in `signups` so the PHP site can
 * still confirm them. Password-reset and email-change tokens are hashed.
 *
 *   POST   /v1/auth/login
 *   POST   /v1/auth/refresh
 *   POST   /v1/auth/logout
 *   GET    /v1/auth/sessions
 *   DELETE /v1/auth/sessions/:sessionId
 *   GET    /v1/auth/register/captcha
 *   POST   /v1/auth/register
 *   POST   /v1/auth/register/confirm
 *   POST   /v1/auth/password/forgot
 *   POST   /v1/auth/password/reset
 *   GET    /v1/account
 *   PATCH  /v1/account
 *   DELETE /v1/account
 *   PUT    /v1/account/password
 *   POST   /v1/account/email
 *   POST   /v1/account/email/confirm
 *   PUT    /v1/account/clublog
 *   DELETE /v1/account/clublog
 */
import type {FastifyInstance} from 'fastify';
import {ObjectId} from 'mongodb';
import {ApiError, badRequest, conflict, notFound, tooMany, unauthorized} from '../errors';
import {hashPassword, hmacHex, newToken, tokenHash, verifyPassword} from '../crypto';
import {clearUserFailures, noteFailure, throttleState} from '../auth/throttle';
import {deleteOtherSessions, deleteSession, deleteUserSessions, findByRefresh, openSession, rotateSession, sessions} from '../auth/sessions';
import {clientIp, reloadUser, sendError, userOf, type AppDeps} from '../http';
import {captchaReady, captchaWidget, verifyCaptcha} from '../captcha';

const USERNAME = /^[A-Za-z0-9-]{3,16}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Login, refresh, logout, session list, registration, and password reset. */
export function registerAuth(app: FastifyInstance) {
  // POST /v1/auth/login — shared loginAttempts throttle, then a new session.
  app.post('/auth/login', async (req, reply) => {
    const body = req.body as {username?: string; password?: string; device?: any};
    const username = String(body?.username || '').toUpperCase();
    const password = String(body?.password || '');
    if (!username || !password) return sendError(reply, badRequest([{field: '/username', message: 'Username and password are required'}]));
    const db = req.server.deps.db;
    const state = await throttleState(db, clientIp(req), username);
    if (state.wait > 0) return sendError(reply, tooMany(state.wait));
    const user = await db.collection('users').findOne({username});
    const ok = user && await verifyPassword(password, String(user.password || ''));
    if (!ok) {
      await noteFailure(db, state.keys);
      return sendError(reply, unauthorized('Wrong username or password'));
    }
    await clearUserFailures(db, username);
    await db.collection('users').updateOne({_id: user!._id}, {$set: {lastLogin: new Date()}});
    const device = normalizeDevice(body.device);
    return openSession(db, req.server.deps.config, user!._id, device);
  });

  // POST /v1/auth/refresh — rotate the refresh token and issue a new pair.
  app.post('/auth/refresh', async (req, reply) => {
    const token = String((req.body as {refreshToken?: string})?.refreshToken || '');
    if (!token) return sendError(reply, unauthorized());
    const session = await findByRefresh(req.server.deps.db, token);
    if (!session) return sendError(reply, unauthorized('Refresh token is invalid or expired'));
    return rotateSession(req.server.deps.db, req.server.deps.config, session);
  });

  // POST /v1/auth/logout — drop this session and the push token it registered.
  app.post('/auth/logout', {preHandler: app.authenticate}, async (req, reply) => {
    const session = req.authSession!;
    await deleteSession(req.server.deps.db, session._id);
    if (session.pushToken) {
      await req.server.deps.db.collection('users').updateOne(
        {_id: session.userId},
        {$pull: {appTokens: {token: session.pushToken}}} as any,
      );
    }
    return reply.code(204).send();
  });

  // GET /v1/auth/sessions — every session for this user, newest first.
  app.get('/auth/sessions', {preHandler: app.authenticate}, async (req) => {
    const docs = await sessions(req.server.deps.db).find({userId: req.authSession!.userId}).sort({createdAt: -1}).toArray();
    const current = req.authSession!._id.toHexString();
    return docs.map((doc) => ({
      id: doc._id.toHexString(),
      ...(doc.device ? {device: doc.device} : {}),
      createdAt: doc.createdAt.toISOString(),
      lastUsedAt: doc.lastUsedAt.toISOString(),
      current: doc._id.toHexString() === current,
    }));
  });

  // DELETE /v1/auth/sessions/:sessionId — revoke one session and its push token.
  app.delete('/auth/sessions/:sessionId', {preHandler: app.authenticate}, async (req, reply) => {
    const id = (req.params as {sessionId: string}).sessionId;
    if (!/^[a-f0-9]{24}$/i.test(id)) return sendError(reply, notFound());
    const doc = await sessions(req.server.deps.db).findOne({_id: new ObjectId(id), userId: req.authSession!.userId});
    if (!doc) return sendError(reply, notFound());
    await deleteSession(req.server.deps.db, doc._id);
    if (doc.pushToken) {
      await req.server.deps.db.collection('users').updateOne(
        {_id: doc.userId},
        {$pull: {appTokens: {token: doc.pushToken}}} as any,
      );
    }
    return reply.code(204).send();
  });

  // GET /v1/auth/register/captcha — widget config for registration and password reset.
  app.get('/auth/register/captcha', async (req, reply) => {
    if (!captchaReady(req.server.deps.config)) {
      return sendError(reply, new ApiError(503, 'Service Unavailable', {detail: 'CAPTCHA is not configured'}));
    }
    return captchaWidget(req.server.deps.config);
  });

  // POST /v1/auth/register — store a signup. An existing email returns 202 with no mail.
  // The Cap token is checked before the account lookup, so enumeration still costs a solve.
  app.post('/auth/register', async (req, reply) => {
    const body = req.body as {email?: string; username?: string; password?: string; captchaToken?: string};
    const email = String(body?.email || '').trim();
    const username = String(body?.username || '').toUpperCase();
    const password = String(body?.password || '');
    const errors = [];
    if (!EMAIL.test(email)) errors.push({field: '/email', message: 'Invalid email address'});
    if (!USERNAME.test(username)) errors.push({field: '/username', message: 'Username must be 3–16 characters: A–Z, 0–9 or -'});
    if (password.length < 8) errors.push({field: '/password', message: 'Password must be at least 8 characters'});
    if (!body?.captchaToken) errors.push({field: '/captchaToken', message: 'Complete the CAPTCHA'});
    if (errors.length) return sendError(reply, badRequest(errors));
    const db = req.server.deps.db;
    const passed = await verifyCaptcha(req.server.deps.config, String(body.captchaToken), req.server.deps.fetchImpl || fetch);
    if (!passed) return sendError(reply, badRequest([{field: '/captchaToken', message: 'CAPTCHA is invalid or expired'}]));
    if (await db.collection('users').findOne({username})) return sendError(reply, conflict('Username taken'));
    if (await db.collection('users').findOne({accountEmail: email})) return reply.code(202).send();
    const token = newToken();
    await db.collection('signups').insertOne({
      token,
      email,
      username,
      password: await hashPassword(password),
      signupDate: new Date(),
      signupIpAddr: clientIp(req) || '',
    });
    const link = `${req.server.deps.config.publicWebUrl}/register/confirm?token=${encodeURIComponent(token)}`;
    await req.server.deps.mailer.send(email, 'HamAlert account creation',
      `Hello,\n\nyou have requested an account on HamAlert. Confirm it within 24 hours:\n\n${link}\n\nOr submit this token to POST /v1/auth/register/confirm:\n${token}\n\n73,\nThe HamAlert team\n`);
    return reply.code(202).send();
  });

  // POST /v1/auth/register/confirm — create the user with the PHP default limits.
  app.post('/auth/register/confirm', async (req, reply) => {
    const token = String((req.body as {token?: string})?.token || '');
    if (!token) return sendError(reply, badRequest([{field: '/token', message: 'Token is required'}]));
    const db = req.server.deps.db;
    const signup = await db.collection('signups').findOne({token});
    const created = signup?.signupDate instanceof Date ? signup.signupDate : new Date(0);
    if (!signup || Date.now() - created.getTime() > 24 * 3600 * 1000) {
      return sendError(reply, badRequest([{field: '/token', message: 'Token is invalid or expired'}]));
    }
    if (await db.collection('users').findOne({username: signup.username})) {
      await db.collection('signups').deleteOne({token});
      return sendError(reply, conflict('Username taken'));
    }
    const inserted = await db.collection('users').insertOne({
      username: signup.username,
      password: signup.password,
      accountEmail: signup.email,
      alerts: true,
      limit: {count: 100, interval: 3600},
      limitPerCallsignFreqMode: {count: 1, interval: 600},
      limitSeparateSotaWatch: true,
      signupDate: new Date(),
      signupIpAddr: signup.signupIpAddr || clientIp(req) || '',
    });
    await db.collection('signups').deleteOne({token});
    const pair = await openSession(db, req.server.deps.config, inserted.insertedId);
    return reply.code(201).send(pair);
  });

  // POST /v1/auth/password/forgot — always 202; mail a reset link only when the account exists.
  // The Cap token is checked before the account lookup, so a reset mail costs a solve.
  app.post('/auth/password/forgot', async (req, reply) => {
    const body = req.body as {usernameOrEmail?: string; captchaToken?: string};
    const raw = String(body?.usernameOrEmail || '').trim();
    const errors = [];
    if (!raw) errors.push({field: '/usernameOrEmail', message: 'Required'});
    if (!body?.captchaToken) errors.push({field: '/captchaToken', message: 'Complete the CAPTCHA'});
    if (errors.length) return sendError(reply, badRequest(errors));
    const passed = await verifyCaptcha(req.server.deps.config, String(body.captchaToken), req.server.deps.fetchImpl || fetch);
    if (!passed) return sendError(reply, badRequest([{field: '/captchaToken', message: 'CAPTCHA is invalid or expired'}]));
    const db = req.server.deps.db;
    const user = raw.includes('@')
      ? await db.collection('users').findOne({accountEmail: raw})
      : await db.collection('users').findOne({username: raw.toUpperCase()});
    if (user?.accountEmail) {
      const token = newToken();
      await db.collection('passwordResets').insertOne({
        tokenHash: tokenHash(token),
        userId: user._id,
        expiresAt: new Date(Date.now() + 2 * 3600 * 1000),
      });
      const link = `${req.server.deps.config.publicWebUrl}/password/reset?token=${encodeURIComponent(token)}`;
      await req.server.deps.mailer.send(user.accountEmail, 'HamAlert password reset',
        `A password reset was requested for ${user.username}.\n\n${link}\n\nThis link expires in 2 hours. If you did not ask for it, ignore this message.\n`);
    }
    return reply.code(202).send();
  });

  // POST /v1/auth/password/reset — set the password and revoke every session.
  app.post('/auth/password/reset', async (req, reply) => {
    const body = req.body as {token?: string; password?: string};
    const token = String(body?.token || '');
    const password = String(body?.password || '');
    if (!token || password.length < 8) {
      return sendError(reply, badRequest([{field: '/password', message: 'Token and a password of at least 8 characters are required'}]));
    }
    const db = req.server.deps.db;
    const reset = await db.collection('passwordResets').findOne({tokenHash: tokenHash(token), expiresAt: {$gt: new Date()}});
    if (!reset) return sendError(reply, badRequest([{field: '/token', message: 'Token is invalid or expired'}]));
    await db.collection('users').updateOne({_id: reset.userId}, {$set: {password: await hashPassword(password)}});
    await db.collection('passwordResets').deleteMany({userId: reset.userId});
    await deleteUserSessions(db, reset.userId);
    return reply.code(204).send();
  });
}

/** Profile, password, email, and Club Log credentials on the users document. */
export function registerAccount(app: FastifyInstance) {
  // GET /v1/account
  app.get('/account', {preHandler: app.authenticate}, async (req) => {
    return accountView(req.server.deps, userOf(req));
  });

  // PATCH /v1/account — username and the alerts switch (users.alerts).
  app.patch('/account', {preHandler: app.authenticate}, async (req, reply) => {
    const body = req.body as {username?: string; alertsEnabled?: boolean};
    const user = userOf(req);
    const db = req.server.deps.db;
    const set: Record<string, unknown> = {};
    if (body?.username != null) {
      const username = String(body.username).toUpperCase();
      if (!USERNAME.test(username)) return sendError(reply, badRequest([{field: '/username', message: 'Invalid username'}]));
      const taken = await db.collection('users').findOne({username, _id: {$ne: user._id}});
      if (taken) return sendError(reply, conflict('Username taken'));
      set.username = username;
    }
    if (typeof body?.alertsEnabled === 'boolean') set.alerts = body.alertsEnabled;
    if (Object.keys(set).length) await db.collection('users').updateOne({_id: user._id}, {$set: set});
    const fresh = await reloadUser(db, user._id);
    return accountView(req.server.deps, fresh!);
  });

  // DELETE /v1/account — user, plus their triggers, mutes, spots, myspots, and sessions.
  app.delete('/account', {preHandler: app.authenticate}, async (req, reply) => {
    const user = userOf(req);
    const db = req.server.deps.db;
    await db.collection('triggers').deleteMany({user_id: user._id});
    await db.collection('mutes').deleteMany({user_id: user._id});
    await db.collection('spots').deleteMany({user_id: user._id});
    await db.collection('myspots').deleteMany({callsign: user.username});
    await deleteUserSessions(db, user._id);
    await db.collection('users').deleteOne({_id: user._id});
    return reply.code(204).send();
  });

  // PUT /v1/account/password — keep this session, revoke the others.
  app.put('/account/password', {preHandler: app.authenticate}, async (req, reply) => {
    const body = req.body as {currentPassword?: string; newPassword?: string};
    const user = userOf(req);
    if (!body?.newPassword || body.newPassword.length < 8) {
      return sendError(reply, badRequest([{field: '/newPassword', message: 'Password must be at least 8 characters'}]));
    }
    if (!await verifyPassword(String(body.currentPassword || ''), String(user.password || ''))) {
      return sendError(reply, unauthorized('Current password is wrong'));
    }
    const db = req.server.deps.db;
    await db.collection('users').updateOne({_id: user._id}, {$set: {password: await hashPassword(body.newPassword)}});
    await deleteOtherSessions(db, user._id, req.authSession!._id);
    return reply.code(204).send();
  });

  // POST /v1/account/email — mail a confirmation token; the address changes on confirm.
  app.post('/account/email', {preHandler: app.authenticate}, async (req, reply) => {
    const email = String((req.body as {email?: string})?.email || '').trim();
    if (!EMAIL.test(email)) return sendError(reply, badRequest([{field: '/email', message: 'Invalid email address'}]));
    const user = userOf(req);
    const token = newToken();
    await req.server.deps.db.collection('emailChanges').insertOne({
      tokenHash: tokenHash(token),
      userId: user._id,
      email,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });
    const link = `${req.server.deps.config.publicWebUrl}/account/email/confirm?token=${encodeURIComponent(token)}`;
    await req.server.deps.mailer.send(email, 'HamAlert email change',
      `Confirm ${email} as the address for ${user.username}:\n\n${link}\n\nToken: ${token}\n`);
    return reply.code(202).send();
  });

  // POST /v1/account/email/confirm
  app.post('/account/email/confirm', {preHandler: app.authenticate}, async (req, reply) => {
    const token = String((req.body as {token?: string})?.token || '');
    const db = req.server.deps.db;
    const change = await db.collection('emailChanges').findOne({
      tokenHash: tokenHash(token),
      userId: userOf(req)._id,
      expiresAt: {$gt: new Date()},
    });
    if (!change) return sendError(reply, badRequest([{field: '/token', message: 'Token is invalid or expired'}]));
    await db.collection('users').updateOne({_id: change.userId}, {$set: {accountEmail: change.email}});
    await db.collection('emailChanges').deleteMany({userId: change.userId});
    return reply.code(204).send();
  });

  // PUT /v1/account/clublog — replace users.clublog and clear any invalid flag.
  app.put('/account/clublog', {preHandler: app.authenticate}, async (req, reply) => {
    const body = req.body as {email?: string; appPassword?: string};
    if (!body?.email || !body.appPassword) {
      return sendError(reply, badRequest([{field: '/email', message: 'Email and application password are required'}]));
    }
    await req.server.deps.db.collection('users').updateOne({_id: userOf(req)._id}, {$set: {
      clublog: {email: body.email, password: body.appPassword},
    }});
    return reply.code(204).send();
  });

  // DELETE /v1/account/clublog
  app.delete('/account/clublog', {preHandler: app.authenticate}, async (req, reply) => {
    await req.server.deps.db.collection('users').updateOne({_id: userOf(req)._id}, {$unset: {clublog: ''}});
    return reply.code(204).send();
  });
}

/** Account resource returned by GET and PATCH /v1/account. */
export async function accountView(deps: AppDeps, user: Record<string, any>) {
  const triggerCount = await deps.db.collection('triggers').countDocuments({user_id: user._id});
  const created = user.signupDate instanceof Date ? user.signupDate : user._id.getTimestamp();
  const club = user.clublog;
  return {
    id: user._id.toHexString(),
    username: user.username,
    alertsEnabled: user.alerts !== false,
    email: user.accountEmail || '',
    createdAt: created.toISOString(),
    triggerCount,
    maxTriggers: deps.config.maxTriggers,
    clublog: {
      linked: Boolean(club?.email),
      ...(club?.email ? {email: club.email} : {}),
      ...(club?.invalid ? {invalid: true} : {}),
    },
    myspot: {
      hmac: hmacHex(deps.config.myspotHashKey, user.username).slice(0, 16),
    },
  };
}

function normalizeDevice(device: any) {
  if (!device || !['ios', 'android', 'web'].includes(device.platform)) return undefined;
  return {
    platform: device.platform as 'ios' | 'android' | 'web',
    ...(device.name ? {name: String(device.name).slice(0, 64)} : {}),
    ...(device.appVersion ? {appVersion: String(device.appVersion)} : {}),
  };
}
