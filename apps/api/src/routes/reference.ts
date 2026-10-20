/**
 * Public reference lists, public stats, the myspot image, and health.
 * buildApp mounts these under /v1. None of these routes require a session.
 * List responses that rarely change send an ETag.
 *
 *   GET /v1/reference/vocabularies
 *   GET /v1/reference/dxcc
 *   GET /v1/reference/sota/associations
 *   GET /v1/reference/sota/summits
 *   GET /v1/reference/parks/programs
 *   GET /v1/reference/parks
 *   GET /v1/reference/iota
 *   GET /v1/public/stats
 *   GET /v1/public/lastspot/:callsign
 *   GET /v1/public/myspot/:file
 *   GET /v1/health
 */
import {createHash} from 'crypto';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import {notFound} from '../errors';
import {hmacHex} from '../crypto';
import {sendError} from '../http';
import {legacyToSpot} from '../map/spot';
import {renderMyspotPng} from '../png';
import {vocabularies} from '../vocab';

/** Bands, modes, and the SOTA / WWFF / IOTA reference collections. */
export function registerReference(app: FastifyInstance) {
  // GET /v1/reference/vocabularies — static band, mode, and source lists.
  app.get('/reference/vocabularies', async (req, reply) => {
    return cached(req, reply, vocabularies());
  });

  // GET /v1/reference/dxcc — dxccs collection.
  app.get('/reference/dxcc', async (req, reply) => {
    const docs = await req.server.deps.db.collection('dxccs').find({}, {projection: {_id: 0}}).sort({country: 1}).toArray();
    const body = docs.map((doc) => ({
      dxcc: Number(doc.dxcc),
      name: String(doc.country || doc.name || ''),
      ...(firstContinent(doc.continent) ? {continent: firstContinent(doc.continent)} : {}),
      ...(firstInt(doc.cq ?? doc.cqZone) != null ? {cq: firstInt(doc.cq ?? doc.cqZone)} : {}),
      ...(doc.prefix ? {prefix: String(doc.prefix)} : {}),
      ...(doc.deleted ? {deleted: true} : {}),
    }));
    return cached(req, reply, body);
  });

  // GET /v1/reference/sota/associations — associations where Program is sota.
  app.get('/reference/sota/associations', async (req, reply) => {
    const docs = await req.server.deps.db.collection('associations').find({Program: 'sota'}).sort({Association: 1}).toArray();
    const body = docs.map((doc) => ({
      code: doc.Association,
      name: doc.Name || doc.Association,
      regions: (doc.Regions || []).map((region: any) => ({code: region.Region, name: region.Name || region.Region})),
    }));
    return cached(req, reply, body);
  });

  // GET /v1/reference/sota/summits — summits collection, at most 500 rows.
  app.get('/reference/sota/summits', async (req) => {
    const query = req.query as {association?: string; region?: string; q?: string; includeInvalid?: string};
    const filter: Record<string, unknown> = {Program: 'sota'};
    if (query.association) filter.SummitAssociation = query.association.toUpperCase();
    if (query.region) filter.SummitRegion = query.region.toUpperCase();
    if (query.includeInvalid !== 'true') filter.ValidTo = {$gte: new Date()};
    if (query.q && query.q.length >= 2) {
      const q = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{SummitCode: new RegExp('^' + q, 'i')}, {SummitName: new RegExp(q, 'i')}];
    }
    const docs = await req.server.deps.db.collection('summits').find(filter).sort({SummitCode: 1}).limit(500).toArray();
    return docs.map(summitView);
  });

  // GET /v1/reference/parks/programs — WWFF divisions. POTA is not loaded.
  app.get('/reference/parks/programs', async (req, reply) => {
    const divisions = await req.server.deps.db.collection('wwffDivisions').find({}).sort({division: 1}).toArray();
    const body = [{
      program: 'wwff',
      prefixes: divisions.map((doc) => ({prefix: doc.division, name: doc.name || doc.division})),
    }];
    return cached(req, reply, body);
  });

  // GET /v1/reference/parks — wwffParks. program=pota returns an empty list.
  app.get('/reference/parks', async (req) => {
    const query = req.query as {program?: string; prefix?: string; location?: string; q?: string; includeInactive?: string};
    if (query.program === 'pota') return [];
    const filter: Record<string, unknown> = {};
    if (query.prefix) filter.division = query.prefix.toUpperCase();
    if (query.includeInactive !== 'true') filter.status = 'active';
    if (query.q && query.q.length >= 2) {
      const q = query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [{reference: new RegExp('^' + q, 'i')}, {name: new RegExp(q, 'i')}];
    }
    const docs = await req.server.deps.db.collection('wwffParks').find(filter).sort({reference: 1}).limit(500).toArray();
    return docs.map((doc) => ({
      program: 'wwff',
      ref: doc.reference,
      prefix: doc.division || String(doc.reference || '').split('-')[0],
      ...(doc.name ? {name: doc.name} : {}),
      active: doc.status === 'active',
      ...(doc.grid ? {grid: doc.grid} : {}),
      ...(typeof doc.latitude === 'number' ? {latitude: doc.latitude} : {}),
      ...(typeof doc.longitude === 'number' ? {longitude: doc.longitude} : {}),
    }));
  });

  // GET /v1/reference/iota — iotaGroups collection.
  app.get('/reference/iota', async (req, reply) => {
    const docs = await req.server.deps.db.collection('iotaGroups').find({}).sort({grpRef: 1}).toArray();
    const body = docs.map((doc) => ({
      ref: doc.grpRef,
      ...(doc.grpName ? {name: doc.grpName} : {}),
      ...(doc.dxcc != null ? {dxcc: [Number(doc.dxcc)]} : {}),
    }));
    return cached(req, reply, body);
  });
}

/** Unauthenticated reads: daily stats, the last public spot, the myspot PNG, and health. */
export function registerPublic(app: FastifyInstance) {
  // GET /v1/public/stats — stats collection, one document per day.
  app.get('/public/stats', async (req) => {
    const days = clamp(Number((req.query as {days?: string}).days || 30), 1, 400);
    const from = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
    const docs = await req.server.deps.db.collection('stats').find({date: {$gte: from}}).sort({date: 1}).toArray();
    return {
      days: docs.map((doc) => ({
        date: doc.date,
        spots: doc.spots || {},
        alerts: doc.alerts || {},
      })),
    };
  });

  // GET /v1/public/lastspot/:callsign — newest myspots row within 7 days.
  app.get('/public/lastspot/:callsign', async (req, reply) => {
    const callsign = (req.params as {callsign: string}).callsign.toUpperCase();
    const doc = await req.server.deps.db.collection('myspots').findOne({
      callsign,
      receivedDate: {$gte: new Date(Date.now() - 7 * 86400 * 1000)},
    });
    if (!doc) return sendError(reply, notFound('No spot in the last 7 days'));
    return legacyToSpot(doc, doc._id?.toHexString?.() || callsign);
  });

  // GET /v1/public/myspot/:file — PNG. Query h must be the first 16 hex chars of HMAC(username).
  app.get('/public/myspot/:file', async (req, reply) => {
    const file = (req.params as {file: string}).file;
    const callsign = file.replace(/\.png$/i, '').toUpperCase();
    const query = req.query as {h?: string; hours?: string; dark?: string; scale?: string};
    const expected = hmacHex(req.server.deps.config.myspotHashKey, callsign).slice(0, 16);
    if (!query.h || query.h !== expected) return reply.code(403).send();
    const hours = clamp(Number(query.hours || 1), 1, 24 * 30);
    const doc = await req.server.deps.db.collection('myspots').findOne({
      callsign,
      receivedDate: {$gte: new Date(Date.now() - hours * 3600 * 1000)},
    });
    const line2 = doc
      ? `${doc.band || ''} ${String(doc.mode || '').toUpperCase()} ${doc.summitRef || doc.wwffRef || ''}`.trim()
      : `no spots within the last ${hours} hour${hours === 1 ? '' : 's'}`;
    const scale = query.scale === '2' ? 2 : 1;
    const png = renderMyspotPng([callsign, line2], query.dark === 'true', scale);
    return reply.type('image/png').send(png);
  });

  // GET /v1/health — mongo ping and redis ping. Missing Redis is degraded.
  app.get('/health', async (req) => {
    const sources: Record<string, unknown> = {};
    let mongoOk = false;
    let redisOk = false;
    try {
      await req.server.deps.db.command({ping: 1});
      mongoOk = true;
    } catch { /* degraded */ }
    if (req.server.deps.redis) {
      try {
        redisOk = (await req.server.deps.redis.ping()) === 'PONG';
      } catch { redisOk = false; }
    }
    return {status: mongoOk && redisOk ? 'ok' : 'degraded', sources};
  });
}

/** ETag the JSON body. A matching If-None-Match returns 304. */
function cached(req: FastifyRequest, reply: FastifyReply, body: unknown) {
  const tag = '"' + createHash('sha256').update(JSON.stringify(body)).digest('hex') + '"';
  reply.header('etag', tag);
  if (req.headers['if-none-match'] === tag) return reply.code(304).send();
  return body;
}

function summitView(doc: any) {
  const parts = /^([A-Z0-9]{1,8})\/([A-Z]{2})-/.exec(doc.SummitCode || '');
  return {
    program: 'sota',
    ref: doc.SummitCode,
    association: doc.SummitAssociation || parts?.[1] || '',
    region: doc.SummitRegion || parts?.[2] || '',
    ...(doc.SummitName ? {name: doc.SummitName} : {}),
    ...(Number.isFinite(Number(doc.AltM)) ? {altitude: Number(doc.AltM)} : {}),
    ...(Number.isFinite(Number(doc.Points)) ? {points: Number(doc.Points)} : {}),
    ...(Number.isFinite(Number(doc.ActivationCount)) ? {activationCount: Number(doc.ActivationCount)} : {}),
    ...(typeof doc.Latitude === 'number' ? {latitude: doc.Latitude} : {}),
    ...(typeof doc.Longitude === 'number' ? {longitude: doc.Longitude} : {}),
  };
}

function firstContinent(value: unknown): string | undefined {
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === 'string' && /^(AF|AN|AS|EU|NA|OC|SA)$/.test(text) ? text : undefined;
}

function firstInt(value: unknown): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
