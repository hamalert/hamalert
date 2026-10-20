/**
 * Translate a stored spot into the API spot and matched-spot shapes.
 * Frequency is stored in MHz and returned as integer Hz. The spotter is
 * stored as a callsign string and returned as an object. Summit, park, and
 * IOTA references are stored flat and returned as blocks. activity is
 * always on-air. The only provenance recorded today is a guessed band.
 */
const CALLSIGN = /^[A-Z0-9/-]{2,20}$/;
const STATE = /^[A-Z]{2}_[A-Z0-9]{2,3}$/;
const SUMMIT = /^[A-Z0-9]{1,8}\/[A-Z]{2}-[0-9]{3}$/;
const PARK = /^[A-Z0-9]{1,5}-[0-9]{4,5}$/;
const IOTA = /^(AF|AN|AS|EU|NA|OC|SA)-[0-9]{3}$/;
const BAND = /^[0-9.]+(m|cm|mm)(_[a-z0-9]+)?$/;

export interface SpotTemplates {
  titleTemplate: string;
  bodyTemplate: string;
}

/** Stored spot plus the triggers and rendered title/body the app shows. */
export function legacyToMatchedSpot(doc: Record<string, any>, id: string, templates: SpotTemplates): Record<string, unknown> {
  const spot = legacyToSpot(doc, id);
  const comments = stringList(doc.triggerComment);
  const ids = stringList(doc.trigger_ids);
  const triggers = (comments.length ? comments : ['']).map((comment, i) => ({
    id: ids[i] || 'unrecorded',
    ...(comment ? {comment} : {}),
  }));
  const actions = stringList(doc.actions).filter((action) => ['app', 'telnet', 'url', 'threema'].includes(action));
  const flat = templateValues(doc, spot, comments.join(', '));
  return {
    id,
    spot,
    triggers,
    actions,
    display: {
      title: expand(templates.titleTemplate, flat),
      body: expand(templates.bodyTemplate, flat),
    },
  };
}

/** Stored spot → API Spot. id is the Mongo _id, or the Redis stream id on the live stream. */
export function legacyToSpot(doc: Record<string, any>, id: string): Record<string, unknown> {
  const full = cleanCall(doc.fullCallsign || doc.callsign || '');
  const base = cleanCall(doc.callsign) || baseCallsign(full);
  const received = dateOf(doc.receivedDate) || redisTime(id) || new Date();
  const spot: Record<string, any> = {
    id,
    activity: 'on-air',
    source: String(doc.source || 'cluster'),
    callsign: full || base || 'UNKNOWN',
    baseCallsign: base || full || 'UNKNOWN',
    time: timeStamp(doc.time, received),
    receivedAt: received.toISOString(),
  };
  if (doc.sourceId) spot.sourceId = String(doc.sourceId);
  if (doc.client) spot.client = String(doc.client);

  const spotterCall = cleanCall(typeof doc.spotter === 'string' ? doc.spotter : doc.spotter?.callsign);
  if (spotterCall) {
    const spotter: Record<string, unknown> = {callsign: spotterCall};
    const instance = doc.spotterInstance || (typeof doc.spotter === 'object' ? doc.spotter.instance : undefined);
    if (instance) spotter.instance = String(instance);
    const entity = entityOf(doc.spotterDxcc, doc.spotterEntity);
    if (entity) spotter.entity = entity;
    const state = firstState(doc.spotterState);
    if (state) spotter.state = state;
    spot.spotter = spotter;
  }

  const hz = mhzToHz(doc.frequency);
  if (hz) spot.frequency = hz;
  if (typeof doc.band === 'string' && BAND.test(doc.band)) spot.band = doc.band;
  if (typeof doc.mode === 'string' && doc.mode) spot.mode = doc.mode.toLowerCase();
  if (typeof doc.modeDetail === 'string' && doc.modeDetail && doc.modeDetail !== spot.mode) spot.modeDetail = doc.modeDetail;
  if (typeof doc.comment === 'string' && doc.comment) spot.comment = doc.comment;
  if (typeof doc.rawText === 'string' && doc.rawText) spot.rawText = doc.rawText;

  const entity = entityOf(doc.dxcc, doc.entity);
  if (entity) spot.entity = entity;
  const home = entityOf(doc.callsignDxcc, doc.homeEntity);
  if (home) spot.homeEntity = home;

  const states = statesOf(doc.state);
  if (states.length) spot.states = states;
  const qsl = stringList(doc.qsl).filter((item) => item === 'lotw' || item === 'eqsl');
  if (qsl.length) spot.qsl = qsl;

  if (typeof doc.summitRef === 'string' && SUMMIT.test(doc.summitRef)) {
    const parts = /^([A-Z0-9]{1,8})\/([A-Z]{2})-/.exec(doc.summitRef);
    spot.summit = {
      program: 'sota',
      ref: doc.summitRef,
      association: doc.summitAssociation || parts?.[1] || '',
      region: doc.summitRegion || parts?.[2] || '',
      ...(doc.summitName ? {name: String(doc.summitName)} : {}),
      ...(num(doc.summitHeight) != null ? {altitude: num(doc.summitHeight)} : {}),
      ...(num(doc.summitPoints) != null ? {points: num(doc.summitPoints)} : {}),
      ...(num(doc.summitActivations) != null ? {activationCount: num(doc.summitActivations)} : {}),
    };
  }

  const parkRef = typeof doc.wwffRef === 'string' ? doc.wwffRef : '';
  if (PARK.test(parkRef)) {
    const prefix = parkRef.split('-')[0];
    spot.parks = [{
      program: doc.source === 'pota' || /^[A-Z]{1,2}$/.test(prefix) ? 'pota' : 'wwff',
      ref: parkRef,
      prefix: doc.wwffDivision || prefix,
      ...(doc.wwffName ? {name: String(doc.wwffName)} : {}),
    }];
  }

  const iota = typeof doc.iotaGroupRef === 'string' ? doc.iotaGroupRef : '';
  if (IOTA.test(iota)) {
    spot.iota = {ref: iota, ...(doc.iotaGroupName ? {name: String(doc.iotaGroupName)} : {})};
  }

  const snr = num(doc.snr);
  const speed = num(doc.speed);
  if (snr != null || speed != null) {
    spot.signal = {
      ...(snr != null ? {snr} : {}),
      ...(speed != null ? {speed} : {}),
    };
  }

  if (doc.dvNode || doc.dvReflector || doc.dvGroup) {
    spot.dstar = {
      ...(doc.dvNode ? {node: String(doc.dvNode)} : {}),
      ...(doc.dvReflector ? {reflector: String(doc.dvReflector)} : {}),
      ...(doc.dvGroup ? {group: String(doc.dvGroup)} : {}),
      ...(doc.dvGroupName ? {groupName: String(doc.dvGroupName)} : {}),
      ...(num(doc.dvDuration) != null ? {duration: num(doc.dvDuration)} : {}),
      ...(doc.dvSuffix ? {suffix: String(doc.dvSuffix)} : {}),
    };
  }

  if (doc.bandIsGuessed && spot.band) spot.provenance = {band: 'module-letter'};
  if (entity && spot.band) {
    const slot = `${entity.dxcc}_${spot.band}`;
    if (/^[0-9]{1,3}_[0-9.]+(m|cm)$/.test(slot)) spot.bandSlot = slot;
  }
  return spot;
}

/** Fill {{field}} (API) or {field} (stored app template). Unknown names become empty. */
export function expand(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z0-9_]+)\}\}|\{([A-Za-z0-9_]+)\}/g, (_match, doubled, single) => {
    return values[doubled || single] ?? '';
  });
}

/** {{field}} as stored by the API → {field} as read by the notifier. */
export function bracesToLegacy(template: string): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, '{$1}');
}

/** {field} as stored for the notifier → {{field}} as shown by the API. */
export function legacyToBraces(template: string): string {
  return template.replace(/(^|[^{])\{([A-Za-z0-9_]+)\}(?!\})/g, (_m, prefix, key) => `${prefix}{{${key}}}`);
}

export function mhzToHz(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n * 1_000_000);
}

export function hzToMhz(hz: number): number {
  return hz / 1_000_000;
}

export function baseCallsign(full: string): string {
  const parts = full.split('/');
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length === 2) return parts[0].length > parts[1].length ? parts[0] : parts[1];
  return parts[1];
}

function templateValues(doc: Record<string, any>, spot: Record<string, any>, triggerComment: string): Record<string, string> {
  const values: Record<string, string> = {};
  const put = (key: string, value: unknown) => {
    if (value == null || value === '') return;
    values[key] = String(value);
  };
  put('callsign', spot.callsign);
  put('baseCallsign', spot.baseCallsign);
  put('fullCallsign', spot.callsign);
  put('band', spot.band);
  put('mode', spot.mode);
  put('source', spot.source);
  put('comment', spot.comment);
  put('rawText', spot.rawText);
  put('frequency', spot.frequency);
  put('triggerComment', triggerComment);
  put('title', doc.title);
  put('spotter', spot.spotter?.callsign);
  put('summitRef', spot.summit?.ref);
  put('summitName', spot.summit?.name);
  return values;
}

function entityOf(dxcc: any, nameFallback?: unknown): {dxcc: number; name: string; continent?: string; cq?: number} | undefined {
  if (dxcc && typeof dxcc === 'object' && dxcc.dxcc != null) {
    const continent = firstString(dxcc.continent);
    const cq = firstNumber(dxcc.cq);
    return {
      dxcc: Number(dxcc.dxcc),
      name: String(dxcc.country || dxcc.name || nameFallback || ''),
      ...(continent && /^(AF|AN|AS|EU|NA|OC|SA)$/.test(continent) ? {continent} : {}),
      ...(cq != null ? {cq} : {}),
    };
  }
  const n = num(dxcc);
  if (n == null) return undefined;
  return {dxcc: n, name: nameFallback ? String(nameFallback) : ''};
}

function statesOf(value: unknown): string[] {
  return stringList(value).map((item) => item.replace('-', '_')).filter((item) => STATE.test(item));
}

function firstState(value: unknown): string | undefined {
  return statesOf(value)[0];
}

function stringList(value: unknown): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => stringList(item));
  return String(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) return value.length ? String(value[0]) : undefined;
  if (value == null || value === '') return undefined;
  const text = String(value).split(',')[0].trim();
  return text || undefined;
}

function firstNumber(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length ? num(value[0]) : undefined;
  if (typeof value === 'string' && value.includes(',')) return num(value.split(',')[0]);
  return num(value);
}

function num(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function cleanCall(value: unknown): string {
  if (typeof value !== 'string') return '';
  const call = value.replace(/\s+/g, '').toUpperCase();
  return CALLSIGN.test(call) ? call : call.replace(/[^A-Z0-9/-]/g, '').slice(0, 20);
}

function dateOf(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (value && typeof (value as any).toDate === 'function') return (value as any).toDate();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value);
  return undefined;
}

function redisTime(id: string): Date | undefined {
  const ms = Number(id.split('-')[0]);
  if (!Number.isFinite(ms) || ms < 1_000_000_000_000) return undefined;
  return new Date(ms);
}

function timeStamp(hhmm: unknown, received: Date): string {
  if (typeof hhmm === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(hhmm)) {
    return `${received.toISOString().slice(0, 10)}T${hhmm}:00Z`;
  }
  return received.toISOString();
}
