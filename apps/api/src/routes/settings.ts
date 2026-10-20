/**
 * Notification destinations, push devices, rate limits, and blocked spotters.
 * buildApp mounts these under /v1. Values are fields on the shared users
 * document, in the shape the matcher and the PHP site already read.
 *
 *   GET    /v1/account/destinations
 *   PATCH  /v1/account/destinations
 *   POST   /v1/account/destinations/threema/verify
 *   GET    /v1/devices
 *   POST   /v1/devices
 *   PATCH  /v1/devices/:deviceId
 *   DELETE /v1/devices/:deviceId
 *   GET    /v1/account/limits
 *   PUT    /v1/account/limits
 *   POST   /v1/account/limits/exceeded/reset
 *   GET    /v1/account/blocked-spotters
 *   PUT    /v1/account/blocked-spotters
 */
import type {FastifyInstance} from 'fastify';
import {badRequest, notFound, tooMany} from '../errors';
import {reloadUser, sendError, userOf} from '../http';
import {bracesToLegacy, legacyToBraces} from '../map/spot';
import {DEFAULT_TEMPLATES} from '../vocab';
import {deviceIdForToken} from '../png';
import {claimThreemaSend, threemaCodeMatches, threemaValidationCode} from '../threema';

const THREEMA = /^[A-Z0-9]{8}$/;
const SOUNDS = new Set(['default', 'blip', 'morse']);

/** App templates, telnet, webhook URL, and Threema id. */
export function registerDestinations(app: FastifyInstance) {
  // GET /v1/account/destinations
  app.get('/account/destinations', {preHandler: app.authenticate}, async (req) => {
    return destinationsView(userOf(req));
  });

  // PATCH /v1/account/destinations — partial update. A new Threema id stays pending until verified.
  app.patch('/account/destinations', {preHandler: app.authenticate}, async (req, reply) => {
    const body = req.body as any;
    const user = userOf(req);
    const db = req.server.deps.db;
    const set: Record<string, unknown> = {};
    const unset: Record<string, string> = {};
    if (body?.app) {
      const appDoc: Record<string, string> = {...(user.app || {})};
      if (body.app.titleTemplate != null) appDoc.titleFormat = bracesToLegacy(String(body.app.titleTemplate));
      if (body.app.bodyTemplate != null) appDoc.bodyFormat = bracesToLegacy(String(body.app.bodyTemplate));
      if (appDoc.titleFormat || appDoc.bodyFormat) set.app = appDoc;
    }
    if (body?.telnet) {
      if (body.telnet.password === null || body.telnet.enabled === false) unset.telnetPassword = '';
      else if (typeof body.telnet.password === 'string') {
        if (body.telnet.password.length < 8) return sendError(reply, badRequest([{field: '/telnet/password', message: 'Password must be at least 8 characters'}]));
        set.telnetPassword = body.telnet.password;
      }
    }
    if (body?.url) {
      if (body.url.url === null || body.url.enabled === false) {
        unset.notificationUrl = '';
        unset.notificationMethod = '';
      } else if (typeof body.url.url === 'string') {
        let parsed: URL;
        try { parsed = new URL(body.url.url); } catch { return sendError(reply, badRequest([{field: '/url/url', message: 'Invalid URL'}])); }
        if (parsed.protocol !== 'https:') return sendError(reply, badRequest([{field: '/url/url', message: 'https only'}]));
        set.notificationUrl = body.url.url;
        set.notificationMethod = 'POST-JSON';
      }
      if (body.url.secret === null) unset.notificationSecret = '';
      else if (typeof body.url.secret === 'string') {
        if (body.url.secret.length < 16) return sendError(reply, badRequest([{field: '/url/secret', message: 'Secret must be at least 16 characters'}]));
        set.notificationSecret = body.url.secret;
      }
    }
    if (body?.threema) {
      if (body.threema.id === null || body.threema.enabled === false) {
        unset.threemaId = '';
        unset.threemaPending = '';
      } else if (typeof body.threema.id === 'string') {
        const id = body.threema.id.toUpperCase();
        if (!THREEMA.test(id)) return sendError(reply, badRequest([{field: '/threema/id', message: 'Threema id is 8 letters or digits'}]));
        if (id !== user.threemaId) {
          const hashKey = req.server.deps.config.threema.hashKey;
          if (!hashKey) return sendError(reply, badRequest([{field: '/threema/id', message: 'Could not send the verification code'}]));
          const code = threemaValidationCode(id, hashKey);
          const claim = await claimThreemaSend(db, String(user._id), id);
          if (!claim.ok) return sendError(reply, tooMany(claim.retryAfter, 'Too many Threema verification messages'));
          const sent = await sendThreemaCode(req.server.deps.config, id, code);
          if (!sent && !req.server.deps.config.devLogSecrets) {
            return sendError(reply, badRequest([{field: '/threema/id', message: 'Could not send the verification code'}]));
          }
          if (!sent && req.server.deps.config.devLogSecrets) console.log(`[threema] verification code for ${id}: ${code}`);
          set.threemaPending = {
            id,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
          };
        }
      }
    }
    const update: Record<string, unknown> = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    if (Object.keys(update).length) await db.collection('users').updateOne({_id: user._id}, update);
    return destinationsView((await reloadUser(db, user._id))!);
  });

  // POST /v1/account/destinations/threema/verify — promote threemaPending to users.threemaId.
  app.post('/account/destinations/threema/verify', {preHandler: app.authenticate}, async (req, reply) => {
    const code = String((req.body as {code?: string})?.code || '');
    const user = userOf(req);
    const pending = user.threemaPending;
    const hashKey = req.server.deps.config.threema.hashKey;
    const expired = !(pending?.expiresAt instanceof Date) || pending.expiresAt.getTime() < Date.now();
    if (!pending?.id || !hashKey || code.length > 64 || expired || !threemaCodeMatches(code, pending.id, hashKey)) {
      return sendError(reply, badRequest([{field: '/code', message: 'Code is invalid or expired'}]));
    }
    await req.server.deps.db.collection('users').updateOne({_id: user._id}, {
      $set: {threemaId: pending.id},
      $unset: {threemaPending: ''},
    });
    return reply.code(204).send();
  });
}

/** Destinations resource. App templates are shown with {{field}} braces. */
export function destinationsView(user: Record<string, any>) {
  const pending = user.threemaPending;
  const id = pending?.id || user.threemaId;
  return {
    app: {
      titleTemplate: user.app?.titleFormat ? legacyToBraces(user.app.titleFormat) : DEFAULT_TEMPLATES.titleTemplate,
      bodyTemplate: user.app?.bodyFormat ? legacyToBraces(user.app.bodyFormat) : DEFAULT_TEMPLATES.bodyTemplate,
    },
    telnet: {enabled: Boolean(user.telnetPassword), passwordSet: Boolean(user.telnetPassword)},
    url: {
      enabled: Boolean(user.notificationUrl),
      ...(user.notificationUrl ? {url: user.notificationUrl} : {}),
      secretSet: Boolean(user.notificationSecret),
      ...(user.notificationLastError ? {lastError: String(user.notificationLastError)} : {}),
    },
    threema: {
      enabled: Boolean(id),
      ...(id ? {id} : {}),
      verified: Boolean(user.threemaId) && !pending?.id,
    },
  };
}

/** POST the code to the Threema gateway. Returns false when credentials are missing. */
async function sendThreemaCode(config: {threema: {apiId?: string; apiSecret?: string}}, id: string, code: string): Promise<boolean> {
  if (!config.threema.apiId || !config.threema.apiSecret) return false;
  const body = new URLSearchParams({from: config.threema.apiId, to: id, text: `Your HamAlert verification code is: ${code}`});
  const auth = Buffer.from(`${config.threema.apiId}:${config.threema.apiSecret}`).toString('base64');
  try {
    const res = await fetch('https://msgapi.threema.ch/send_simple', {
      method: 'POST',
      headers: {'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${auth}`},
      body,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Push devices stored as users.appTokens. ios is type apns, android is gcm, web is web. */
export function registerDevices(app: FastifyInstance) {
  // GET /v1/devices
  app.get('/devices', {preHandler: app.authenticate}, async (req) => {
    return (userOf(req).appTokens || []).map(deviceView);
  });

  // POST /v1/devices — register or refresh a push token and remember it on this session.
  app.post('/devices', {preHandler: app.authenticate}, async (req, reply) => {
    const body = req.body as {platform?: string; pushToken?: string; name?: string; sound?: string};
    if (!body?.pushToken || !['ios', 'android', 'web'].includes(String(body.platform))) {
      return sendError(reply, badRequest([{field: '/pushToken', message: 'platform and pushToken are required'}]));
    }
    const user = userOf(req);
    const type = body.platform === 'ios' ? 'apns' : body.platform === 'android' ? 'gcm' : 'web';
    const sound = body.sound && SOUNDS.has(body.sound) ? body.sound : 'default';
    const tokens: any[] = user.appTokens || [];
    const existing = tokens.find((token) => token.token === body.pushToken);
    if (existing) {
      await req.server.deps.db.collection('users').updateOne(
        {_id: user._id, 'appTokens.token': body.pushToken},
        {$set: {
          'appTokens.$.deviceName': body.name || existing.deviceName || '',
          'appTokens.$.type': type,
          'appTokens.$.sound': sound,
          'appTokens.$.id': existing.id || deviceIdForToken(body.pushToken),
        }},
      );
    } else {
      await req.server.deps.db.collection('users').updateOne({_id: user._id}, {$push: {appTokens: {
        id: deviceIdForToken(body.pushToken),
        token: body.pushToken,
        deviceName: body.name || '',
        type,
        sound,
        addDate: new Date(),
      }}} as any);
    }
    await req.server.deps.db.collection('sessions').updateOne({_id: req.authSession!._id}, {$set: {pushToken: body.pushToken}});
    const fresh = (await reloadUser(req.server.deps.db, user._id))!;
    return deviceView((fresh.appTokens || []).find((token: any) => token.token === body.pushToken));
  });

  // PATCH /v1/devices/:deviceId — name, sound, or the pushEnabled switch (stored as disable).
  app.patch('/devices/:deviceId', {preHandler: app.authenticate}, async (req, reply) => {
    const id = (req.params as {deviceId: string}).deviceId;
    const body = req.body as {name?: string; pushEnabled?: boolean; sound?: string};
    const user = userOf(req);
    const token = findToken(user, id);
    if (!token) return sendError(reply, notFound());
    const set: Record<string, unknown> = {};
    if (body?.name != null) set['appTokens.$.deviceName'] = String(body.name).slice(0, 64);
    if (typeof body?.pushEnabled === 'boolean') set['appTokens.$.disable'] = !body.pushEnabled;
    if (body?.sound != null) {
      if (!SOUNDS.has(body.sound)) return sendError(reply, badRequest([{field: '/sound', message: 'Unknown sound'}]));
      set['appTokens.$.sound'] = body.sound;
    }
    if (Object.keys(set).length) {
      await req.server.deps.db.collection('users').updateOne({_id: user._id, 'appTokens.token': token.token}, {$set: set});
    }
    const fresh = (await reloadUser(req.server.deps.db, user._id))!;
    return deviceView(findToken(fresh, id));
  });

  // DELETE /v1/devices/:deviceId
  app.delete('/devices/:deviceId', {preHandler: app.authenticate}, async (req, reply) => {
    const id = (req.params as {deviceId: string}).deviceId;
    const user = userOf(req);
    const token = findToken(user, id);
    if (!token) return sendError(reply, notFound());
    await req.server.deps.db.collection('users').updateOne({_id: user._id}, {$pull: {appTokens: {token: token.token}}} as any);
    return reply.code(204).send();
  });
}

function findToken(user: Record<string, any>, id: string) {
  return (user.appTokens || []).find((token: any) => deviceIdForToken(token.token, token.id) === id);
}

function deviceView(token: any) {
  const platform = token.type === 'apns' ? 'ios' : token.type === 'web' ? 'web' : 'android';
  const created = token.addDate instanceof Date ? token.addDate : new Date();
  return {
    id: deviceIdForToken(token.token, token.id),
    platform,
    name: token.deviceName || '',
    pushEnabled: token.disable !== true,
    sound: SOUNDS.has(token.sound) ? token.sound : 'default',
    createdAt: created.toISOString(),
  };
}

/** Alert rate limits and the blocked-spotter list, both stored on the user. */
export function registerLimits(app: FastifyInstance) {
  // GET /v1/account/limits
  app.get('/account/limits', {preHandler: app.authenticate}, async (req) => limitsView(userOf(req)));

  // PUT /v1/account/limits — intervals are stored in seconds. Omitted per-callsign limits are removed.
  app.put('/account/limits', {preHandler: app.authenticate}, async (req, reply) => {
    const body = req.body as any;
    const total = body?.total;
    if (!total || !Number.isInteger(total.count) || !Number.isInteger(total.intervalSec)) {
      return sendError(reply, badRequest([{field: '/total', message: 'count and intervalSec are required'}]));
    }
    if (total.intervalSec < 60 || total.intervalSec > 86400) {
      return sendError(reply, badRequest([{field: '/total/intervalSec', message: 'Interval must be between 60 and 86400 seconds'}]));
    }
    if (total.count * 3600 / total.intervalSec > 100) {
      return sendError(reply, badRequest([{field: '/total', message: 'The overall limit must be at most 100 alerts per hour'}]));
    }
    const set: Record<string, unknown> = {
      limit: {count: total.count, interval: total.intervalSec},
      limitSeparateSotaWatch: body.separateSotawatch === true,
    };
    const unset: Record<string, string> = {};
    for (const [api, field] of [['perCallsign', 'limitPerCallsign'], ['perCallsignBandMode', 'limitPerCallsignBandMode'], ['perCallsignFrequencyMode', 'limitPerCallsignFreqMode']] as const) {
      const value = body[api];
      if (value == null) unset[field] = '';
      else {
        if (!Number.isInteger(value.count) || value.intervalSec < 60 || value.intervalSec > 86400) {
          return sendError(reply, badRequest([{field: `/${api}`, message: 'Invalid limit'}]));
        }
        set[field] = {count: value.count, interval: value.intervalSec};
      }
    }
    const update: Record<string, unknown> = {$set: set};
    if (Object.keys(unset).length) update.$unset = unset;
    await req.server.deps.db.collection('users').updateOne({_id: userOf(req)._id}, update);
    return limitsView((await reloadUser(req.server.deps.db, userOf(req)._id))!);
  });

  // POST /v1/account/limits/exceeded/reset — zero the exceeded counter.
  app.post('/account/limits/exceeded/reset', {preHandler: app.authenticate}, async (req, reply) => {
    await req.server.deps.db.collection('users').updateOne({_id: userOf(req)._id}, {$set: {
      limitExceededCount: 0,
      limitExceededCountSince: new Date(),
    }});
    return reply.code(204).send();
  });

  // GET /v1/account/blocked-spotters
  app.get('/account/blocked-spotters', {preHandler: app.authenticate}, async (req) => {
    return userOf(req).blockedSpotters || [];
  });

  // PUT /v1/account/blocked-spotters — replace the whole list.
  app.put('/account/blocked-spotters', {preHandler: app.authenticate}, async (req, reply) => {
    const list = req.body as unknown;
    if (!Array.isArray(list) || list.length > 5000 || list.some((item) => typeof item !== 'string')) {
      return sendError(reply, badRequest([{field: '/', message: 'Expected a list of at most 5000 callsigns'}]));
    }
    const callsigns = list.map((item) => String(item).toUpperCase());
    const update = callsigns.length
      ? {$set: {blockedSpotters: callsigns}}
      : {$unset: {blockedSpotters: ''}};
    await req.server.deps.db.collection('users').updateOne({_id: userOf(req)._id}, update);
    return callsigns;
  });
}

/** Limits resource. intervalSec in the API is users.limit.interval in seconds. */
function limitsView(user: Record<string, any>) {
  const one = (field: string) => user[field]?.count ? {count: user[field].count, intervalSec: user[field].interval} : null;
  const since = user.limitExceededCountSince instanceof Date ? user.limitExceededCountSince.toISOString() : undefined;
  return {
    total: user.limit?.count ? {count: user.limit.count, intervalSec: user.limit.interval} : {count: 100, intervalSec: 3600},
    perCallsign: one('limitPerCallsign'),
    perCallsignBandMode: one('limitPerCallsignBandMode'),
    perCallsignFrequencyMode: one('limitPerCallsignFreqMode'),
    separateSotawatch: user.limitSeparateSotaWatch === true,
    exceeded: {
      count: user.limitExceededCount || 0,
      ...(since ? {since} : {}),
    },
  };
}
