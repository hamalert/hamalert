/**
 * Triggers and mutes. buildApp mounts these under /v1.
 * Trigger bodies are translated to and from the matcher document shape
 * by triggerFromApi and triggerToApi. Mutes stay in the mutes collection.
 *
 *   GET    /v1/triggers
 *   POST   /v1/triggers
 *   GET    /v1/triggers/helpers/sota-complete-candidates
 *   POST   /v1/triggers/helpers/clublog-unworked-dxcc
 *   GET    /v1/triggers/:triggerId
 *   PUT    /v1/triggers/:triggerId
 *   DELETE /v1/triggers/:triggerId
 *   PUT    /v1/triggers/:triggerId/enabled
 *   GET    /v1/mutes
 *   POST   /v1/mutes
 *   DELETE /v1/mutes
 *   DELETE /v1/mutes/:muteId
 */
import type {FastifyInstance} from 'fastify';
import {badRequest, conflict, notFound} from '../errors';
import {oid, sendError, userOf} from '../http';
import {triggerFromApi, triggerToApi} from '../map/trigger';

/** Trigger CRUD and the two helper lookups used by the trigger editor. */
export function registerTriggers(app: FastifyInstance) {
  // GET /v1/triggers
  app.get('/triggers', {preHandler: app.authenticate}, async (req) => {
    const docs = await req.server.deps.db.collection('triggers').find({user_id: userOf(req)._id}).toArray();
    return docs.map((doc) => triggerToApi(doc));
  });

  // POST /v1/triggers — reject the write when the account is already at maxTriggers.
  app.post('/triggers', {preHandler: app.authenticate}, async (req, reply) => {
    const user = userOf(req);
    const db = req.server.deps.db;
    const count = await db.collection('triggers').countDocuments({user_id: user._id});
    if (count >= req.server.deps.config.maxTriggers) return sendError(reply, conflict('Trigger limit reached (100)'));
    const {doc, errors} = triggerFromApi(req.body);
    if (errors.length) return sendError(reply, badRequest(errors));
    const insert = {...doc, user_id: user._id, createdAt: new Date()};
    const res = await db.collection('triggers').insertOne(insert);
    const saved = await db.collection('triggers').findOne({_id: res.insertedId});
    return reply.code(201).send(triggerToApi(saved!));
  });

  // GET /v1/triggers/helpers/sota-complete-candidates — summits this callsign activated but has not chased.
  app.get('/triggers/helpers/sota-complete-candidates', {preHandler: app.authenticate}, async (req, reply) => {
    try {
      const summitRefs = await sotaCompleteCandidates(userOf(req).username);
      return {summitRefs};
    } catch (err) {
      return sendError(reply, badRequest([{field: '/', message: err instanceof Error ? err.message : 'SOTA lookup failed'}]));
    }
  });

  // POST /v1/triggers/helpers/clublog-unworked-dxcc — DXCC entities missing from the Club Log chart.
  app.post('/triggers/helpers/clublog-unworked-dxcc', {preHandler: app.authenticate}, async (req, reply) => {
    const user = userOf(req);
    if (!user.clublog?.email || !user.clublog?.password || user.clublog.invalid) {
      return sendError(reply, conflict('Club Log not linked or credentials invalid'));
    }
    const body = req.body as {callsign?: string; modes?: string; status?: string[]; dateFilter?: string};
    if (!body?.callsign) return sendError(reply, badRequest([{field: '/callsign', message: 'Required'}]));
    try {
      const dxcc = await unworkedDxcc(req.server.deps, user, body);
      return {dxcc};
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Club Log lookup failed';
      if (/password|auth/i.test(message)) {
        await req.server.deps.db.collection('users').updateOne({_id: user._id}, {$set: {'clublog.invalid': true}});
        return sendError(reply, conflict('Club Log not linked or credentials invalid'));
      }
      return sendError(reply, badRequest([{field: '/', message}]));
    }
  });

  // GET /v1/triggers/:triggerId
  app.get('/triggers/:triggerId', {preHandler: app.authenticate}, async (req, reply) => {
    const doc = await loadTrigger(req, reply);
    if (!doc) return;
    return triggerToApi(doc);
  });

  // PUT /v1/triggers/:triggerId — replace the trigger and clear the auto-disable (useless) flag.
  app.put('/triggers/:triggerId', {preHandler: app.authenticate}, async (req, reply) => {
    const existing = await loadTrigger(req, reply);
    if (!existing) return;
    const {doc, errors} = triggerFromApi(req.body, existing);
    if (errors.length) return sendError(reply, badRequest(errors));
    const update: Record<string, unknown> = {$set: doc, $unset: {useless: ''}};
    if (!doc.options) (update.$unset as Record<string, string>).options = '';
    await req.server.deps.db.collection('triggers').updateOne({_id: existing._id}, update);
    const saved = await req.server.deps.db.collection('triggers').findOne({_id: existing._id});
    return triggerToApi(saved!);
  });

  // DELETE /v1/triggers/:triggerId
  app.delete('/triggers/:triggerId', {preHandler: app.authenticate}, async (req, reply) => {
    const existing = await loadTrigger(req, reply);
    if (!existing) return;
    await req.server.deps.db.collection('triggers').deleteOne({_id: existing._id});
    return reply.code(204).send();
  });

  // PUT /v1/triggers/:triggerId/enabled — flip triggers.disabled. Does not clear useless.
  app.put('/triggers/:triggerId/enabled', {preHandler: app.authenticate}, async (req, reply) => {
    const existing = await loadTrigger(req, reply);
    if (!existing) return;
    const enabled = (req.body as {enabled?: boolean})?.enabled;
    if (typeof enabled !== 'boolean') return sendError(reply, badRequest([{field: '/enabled', message: 'Expected a boolean'}]));
    await req.server.deps.db.collection('triggers').updateOne({_id: existing._id}, {$set: {disabled: !enabled, updatedAt: new Date()}});
    const saved = await req.server.deps.db.collection('triggers').findOne({_id: existing._id});
    return triggerToApi(saved!);
  });
}

/** Load one trigger owned by the caller, or send 404 and return null. */
async function loadTrigger(req: any, reply: any) {
  const id = oid((req.params as {triggerId: string}).triggerId);
  if (!id) {
    sendError(reply, notFound());
    return null;
  }
  const doc = await req.server.deps.db.collection('triggers').findOne({_id: id, user_id: userOf(req)._id});
  if (!doc) sendError(reply, notFound());
  return doc;
}

const DATE_FILTER: Record<string, number> = {all: 0, last12months: 1, thisYear: 3, lastYear: 4};
const MODE: Record<string, number> = {all: 0, cw: 1, phone: 2, data: 3};
const STATUS: Record<string, number> = {confirmed: 1, worked: 2, verified: 3};

/** Club Log DXCC chart minus entities the caller has already worked. */
async function unworkedDxcc(deps: {db: any; config: {clublogApiKey?: string}; fetchImpl?: typeof fetch}, user: any, body: {callsign?: string; modes?: string; status?: string[]; dateFilter?: string}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const params = new URLSearchParams({
    call: String(body.callsign),
    mode: String(MODE[body.modes || 'all'] ?? 0),
    date: String(DATE_FILTER[body.dateFilter || 'all'] ?? 0),
    email: user.clublog.email,
    password: user.clublog.password,
    ...(deps.config.clublogApiKey ? {api: deps.config.clublogApiKey} : {}),
  });
  const res = await fetchImpl('https://clublog.org/json_dxccchart.php?' + params.toString());
  const text = await res.text();
  if (res.status === 403 || /password/i.test(text)) throw new Error('Unable to validate password or app password');
  const matrix = JSON.parse(text);
  if (!matrix || typeof matrix !== 'object') throw new Error('Club Log returned an unexpected response');
  const wanted = new Set((body.status?.length ? body.status : ['worked', 'confirmed', 'verified']).map((status) => STATUS[status]).filter(Boolean));
  const entities = await deps.db.collection('dxccs').find({}, {projection: {_id: 0, dxcc: 1}}).toArray();
  const unworked: number[] = [];
  for (const entity of entities) {
    const row = matrix[entity.dxcc] || matrix[String(entity.dxcc)];
    let worked = false;
    if (row && typeof row === 'object') {
      for (const status of Object.values(row)) {
        if (wanted.has(Number(status))) { worked = true; break; }
      }
    }
    if (!worked && entity.dxcc != null) unworked.push(Number(entity.dxcc));
  }
  unworked.sort((a, b) => a - b);
  return unworked;
}

let sotaUsers: Record<string, string> | undefined;

/** Activations minus chases, from the public SOTA database. The activator roll is cached. */
async function sotaCompleteCandidates(callsign: string): Promise<string[]> {
  if (!sotaUsers) {
    const roll = await (await fetch('https://api-db2.sota.org.uk/rolls/activator/-1/0/all/all')).json() as Array<{Callsign: string; UserID: string}>;
    sotaUsers = {};
    for (const row of roll) sotaUsers[String(row.Callsign).toUpperCase()] = String(row.UserID);
  }
  const userId = sotaUsers[callsign.toUpperCase()];
  if (!userId) return [];
  const activations = await (await fetch(`https://api-db2.sota.org.uk/logs/activator/${userId}/99999/1`)).json() as Array<{Summit: string}>;
  const chases = await (await fetch(`https://api-db2.sota.org.uk/logs/chaser/${userId}/99999/1`)).json() as Array<{SummitCode: string}>;
  const refs = new Set<string>();
  for (const activation of activations || []) {
    const match = /^(\S+)/.exec(activation.Summit || '');
    if (match) refs.add(match[1]);
  }
  for (const chase of chases || []) refs.delete(chase.SummitCode);
  return [...refs].sort();
}

/** Temporary mutes. The matcher treats a null band or summit as "any". */
export function registerMutes(app: FastifyInstance) {
  // GET /v1/mutes — mutes that have not expired yet.
  app.get('/mutes', {preHandler: app.authenticate}, async (req) => {
    const docs = await req.server.deps.db.collection('mutes').find({
      user_id: userOf(req)._id,
      expires: {$gte: new Date()},
    }).toArray();
    return docs.map(muteToApi);
  });

  // POST /v1/mutes — upsert on user, callsign, band, and summit.
  app.post('/mutes', {preHandler: app.authenticate}, async (req, reply) => {
    const body = req.body as {callsign?: string; band?: string; summitRef?: string; durationMin?: number};
    const callsign = String(body?.callsign || '').toUpperCase();
    const minutes = Number(body?.durationMin);
    if (!/^[A-Z0-9/-]{2,20}$/.test(callsign)) return sendError(reply, badRequest([{field: '/callsign', message: 'Invalid callsign'}]));
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 10080) {
      return sendError(reply, badRequest([{field: '/durationMin', message: 'Duration must be between 1 and 10080 minutes'}]));
    }
    const mute = {
      user_id: userOf(req)._id,
      callsign,
      band: body.band || null,
      mode: null,
      summitRef: body.summitRef || null,
    };
    const expires = new Date(Date.now() + minutes * 60 * 1000);
    const res = await req.server.deps.db.collection('mutes').findOneAndUpdate(
      mute,
      {$set: {...mute, expires, durationMin: minutes}},
      {upsert: true, returnDocument: 'after'},
    );
    const saved = unwrap(res);
    if (!saved) return sendError(reply, badRequest([{field: '/', message: 'Could not store the mute'}]));
    return reply.code(201).send(muteToApi(saved));
  });

  // DELETE /v1/mutes — every mute for this user.
  app.delete('/mutes', {preHandler: app.authenticate}, async (req, reply) => {
    await req.server.deps.db.collection('mutes').deleteMany({user_id: userOf(req)._id});
    return reply.code(204).send();
  });

  // DELETE /v1/mutes/:muteId
  app.delete('/mutes/:muteId', {preHandler: app.authenticate}, async (req, reply) => {
    const id = oid((req.params as {muteId: string}).muteId);
    if (!id) return sendError(reply, notFound());
    const res = await req.server.deps.db.collection('mutes').deleteOne({_id: id, user_id: userOf(req)._id});
    if (!res.deletedCount) return sendError(reply, notFound());
    return reply.code(204).send();
  });
}

/** Driver 6 returned {value}; driver 7 returns the document. Accept either. */
function unwrap(result: any) {
  if (!result) return null;
  return result.value !== undefined ? result.value : result;
}

/** Mute resource. durationMin is the requested length, not the time remaining. */
function muteToApi(doc: any) {
  return {
    id: doc._id.toHexString(),
    callsign: doc.callsign,
    ...(doc.band ? {band: doc.band} : {}),
    ...(doc.summitRef ? {summitRef: doc.summitRef} : {}),
    durationMin: typeof doc.durationMin === 'number'
      ? doc.durationMin
      : Math.max(1, Math.round(((doc.expires instanceof Date ? doc.expires.getTime() : Date.now()) - Date.now()) / 60000)),
    expiresAt: (doc.expires instanceof Date ? doc.expires : new Date()).toISOString(),
  };
}
