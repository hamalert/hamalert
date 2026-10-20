/**
 * Spot history, the live stream, and the simulator. buildApp mounts these
 * under /v1. Stored spots stay in the legacy document shape; responses are
 * translated by legacyToMatchedSpot.
 *
 *   GET    /v1/spots
 *   DELETE /v1/spots
 *   PUT    /v1/spots/badge
 *   GET    /v1/spots/stream
 *   DELETE /v1/spots/:matchedSpotId
 *   POST   /v1/simulate
 */
import type {FastifyInstance} from 'fastify';
import {ObjectId} from 'mongodb';
import {badRequest, notFound} from '../errors';
import {oid, sendError, userOf} from '../http';
import {hzToMhz, legacyToMatchedSpot, legacyToSpot} from '../map/spot';
import {DEFAULT_TEMPLATES} from '../vocab';
import {destinationsView} from './settings';

/** History of spots already matched for this user. */
export function registerSpots(app: FastifyInstance) {
  // GET /v1/spots — page through the spots collection, newest first.
  app.get('/spots', {preHandler: app.authenticate}, async (req) => {
    const query = req.query as {limit?: string; maxAge?: string; cursor?: string; action?: string};
    const limit = clamp(Number(query.limit || 100), 1, 500);
    const maxAge = clamp(Number(query.maxAge || 86400), 60, 86400);
    const user = userOf(req);
    const filter: Record<string, unknown> = {
      user_id: user._id,
      receivedDate: {$gte: new Date(Date.now() - maxAge * 1000)},
    };
    if (query.action) filter.actions = query.action;
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      filter.$or = [
        {receivedDate: {$lt: cursor.date}},
        {receivedDate: cursor.date, _id: {$lt: cursor.id}},
      ];
    }
    const docs = await req.server.deps.db.collection('spots').find(filter)
      .sort({receivedDate: -1, _id: -1})
      .limit(limit + 1)
      .toArray();
    const page = docs.slice(0, limit);
    const templates = templatesOf(user);
    const items = page.map((doc) => legacyToMatchedSpot(doc, doc._id.toHexString(), templates));
    const last = page[page.length - 1];
    const body: Record<string, unknown> = {items};
    if (docs.length > limit && last) body.nextCursor = encodeCursor(last.receivedDate, last._id);
    if (items.length === 0) {
      const appTrigger = await req.server.deps.db.collection('triggers').findOne({user_id: user._id, actions: 'app'});
      body.hasAnyAppTrigger = Boolean(appTrigger);
    }
    return body;
  });

  // DELETE /v1/spots — delete every stored spot for this user.
  app.delete('/spots', {preHandler: app.authenticate}, async (req, reply) => {
    await req.server.deps.db.collection('spots').deleteMany({user_id: userOf(req)._id});
    return reply.code(204).send();
  });

  // PUT /v1/spots/badge — store the app icon badge count on the user.
  app.put('/spots/badge', {preHandler: app.authenticate}, async (req, reply) => {
    const count = (req.body as {count?: number})?.count;
    if (!Number.isInteger(count) || (count as number) < 0) return sendError(reply, badRequest([{field: '/count', message: 'Expected a count of 0 or more'}]));
    await req.server.deps.db.collection('users').updateOne({_id: userOf(req)._id}, {$set: {badgeCount: count}});
    return reply.code(204).send();
  });

  // GET /v1/spots/stream — SSE tail of Redis stream spots:{userId}.
  // Last-Event-ID and ?since= are Redis stream ids, not Mongo _ids.
  // ?access_token= is accepted here because EventSource cannot set headers.
  app.get('/spots/stream', {preHandler: app.authenticate}, async (req, reply) => {
    const redis = req.server.deps.redis;
    if (!redis) return sendError(reply, badRequest([{field: '/', message: 'Live stream is not available'}]));
    const query = req.query as {since?: string};
    const header = req.headers['last-event-id'];
    let lastId = String(query.since || (Array.isArray(header) ? header[0] : header) || '0-0');
    if (!/^\d+-\d+$/.test(lastId)) lastId = '0-0';
    const user = userOf(req);
    const templates = templatesOf(user);
    const key = 'spots:' + user._id.toHexString();
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    req.raw.on('close', () => { closed = true; });
    const ping = setInterval(() => {
      if (!closed) reply.raw.write('event: ping\ndata: ping\n\n');
    }, 30000);
    try {
      while (!closed) {
        const rows = await redis.xread('BLOCK', 15000, 'STREAMS', key, lastId) as Array<[string, Array<[string, string[]]>]> | null;
        if (!rows) continue;
        for (const [, entries] of rows) {
          for (const [id, fields] of entries) {
            lastId = id;
            const doc = pairs(fields);
            const payload = legacyToMatchedSpot(doc, id, templates);
            reply.raw.write(`id: ${id}\nevent: spot\ndata: ${JSON.stringify(payload)}\n\n`);
          }
        }
      }
    } finally {
      clearInterval(ping);
      reply.raw.end();
    }
  });

  // DELETE /v1/spots/:matchedSpotId — one stored spot. The id is the Mongo _id.
  app.delete('/spots/:matchedSpotId', {preHandler: app.authenticate}, async (req, reply) => {
    const id = oid((req.params as {matchedSpotId: string}).matchedSpotId);
    if (!id) return sendError(reply, notFound());
    const res = await req.server.deps.db.collection('spots').deleteOne({_id: id, user_id: userOf(req)._id});
    if (!res.deletedCount) return sendError(reply, notFound());
    return reply.code(204).send();
  });
}

/** Hand a spot to the matcher simulator. The current simulator does not report which triggers fired. */
export function registerSimulate(app: FastifyInstance) {
  // POST /v1/simulate — submit a legacy spot. The response always has matched: [].
  app.post('/simulate', {preHandler: app.authenticate}, async (req, reply) => {
    const body = req.body as any;
    const callsign = String(body?.callsign || '').toUpperCase();
    if (!/^[A-Z0-9/-]{2,20}$/.test(callsign)) return sendError(reply, badRequest([{field: '/callsign', message: 'Invalid callsign'}]));
    const spot: Record<string, unknown> = {
      user_id: userOf(req)._id.toHexString(),
      source: body.source || 'simulator',
      fullCallsign: callsign,
      mode: body.dstar ? 'dstar' : (body.mode || 'cw'),
    };
    if (body.spotter) spot.spotter = String(body.spotter).toUpperCase();
    if (body.frequency) spot.frequency = hzToMhz(Number(body.frequency));
    if (body.comment) spot.comment = String(body.comment);
    if (body.summitRef) spot.summitRef = String(body.summitRef).toUpperCase();
    if (Array.isArray(body.parkRefs) && body.parkRefs[0]) spot.wwffRef = String(body.parkRefs[0]).toUpperCase();
    if (body.iota) spot.iotaGroupRef = String(body.iota).toUpperCase();
    if (body.dstar) {
      spot.dvEvent = 'active';
      if (body.dstar.node) spot.dvNode = String(body.dstar.node).toUpperCase();
      if (body.dstar.reflector) spot.dvReflector = String(body.dstar.reflector).toUpperCase();
      if (body.dstar.group) spot.dvGroup = String(body.dstar.group).toUpperCase();
    }
    if (spot.mode === 'dstar' && !spot.dvNode) return sendError(reply, badRequest([{field: '/dstar/node', message: 'A D-STAR node is required'}]));
    if (spot.mode !== 'dstar' && !spot.frequency) return sendError(reply, badRequest([{field: '/frequency', message: 'Frequency is required'}]));
    const fetchImpl = req.server.deps.fetchImpl || fetch;
    const res = await fetchImpl(req.server.deps.config.simulatorUrl, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(spot),
    });
    if (!res.ok) return sendError(reply, badRequest([{field: '/', message: 'Could not send spot to the matcher'}]));
    return {
      spot: legacyToSpot({...spot, receivedDate: new Date()}, 'simulated'),
      matched: [],
    };
  });
}

function templatesOf(user: Record<string, any>) {
  const view = destinationsView(user);
  return {
    titleTemplate: view.app.titleTemplate || DEFAULT_TEMPLATES.titleTemplate,
    bodyTemplate: view.app.bodyTemplate || DEFAULT_TEMPLATES.bodyTemplate,
  };
}

/** Redis XREAD hands back field names and values as one flat list. */
function pairs(fields: string[]): Record<string, string> {
  const doc: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) doc[fields[i]] = fields[i + 1];
  return doc;
}

/** Opaque page cursor: receivedDate in millis, then the Mongo _id. */
function encodeCursor(date: Date, id: ObjectId): string {
  return Buffer.from(`${date.getTime()}_${id.toHexString()}`).toString('base64url');
}

function decodeCursor(cursor?: string): {date: Date; id: ObjectId} | undefined {
  if (!cursor) return undefined;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const [ms, id] = text.split('_');
  if (!/^\d+$/.test(ms) || !/^[a-f0-9]{24}$/i.test(id)) return undefined;
  return {date: new Date(Number(ms)), id: new ObjectId(id)};
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
