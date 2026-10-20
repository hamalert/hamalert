/**
 * Translate a trigger between the API body and the document the matcher
 * stores. The matcher never sees the API names: homeDxcc is stored as
 * callsignDxcc, parkRef as wwffRef, and so on (see RENAME). enabled is
 * the inverse of triggers.disabled. A save clears the useless flag;
 * reading a useless trigger reports autoDisabled and leaves enabled as stored.
 */
import type {FieldError} from '../errors';

const LIST_MAX = 5000;
const ACTIONS = new Set(['app', 'telnet', 'url', 'threema']);
const BAND_GROUP = new Set(['vlf', 'lf', 'mf', 'hf', 'vhf', 'uhf', 'shf', 'ehf']);
const BAND = /^[0-9.]+(m|cm|mm)(_[a-z0-9]+)?$/;
const CALLSIGN = /^[A-Z0-9/-]{2,20}$/;
const REGION = /^[A-Z]{2}$/;
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

/** API condition name → field stored for the current matcher. */
const RENAME: Record<string, string> = {
  homeDxcc: 'callsignDxcc',
  bandSlot: 'bandslot',
  parkRef: 'wwffRef',
  parkPrefix: 'wwffDivision',
  iota: 'iotaGroupRef',
  dstarNode: 'dvNode',
  dstarReflector: 'dvReflector',
  dstarGroup: 'dvGroup',
};

const LEGACY_RENAME: Record<string, string> = Object.fromEntries(
  Object.entries(RENAME).map(([api, legacy]) => [legacy, api]),
);

const LIST_FIELDS = new Set([
  'source', 'callsign', 'notCallsign', 'fullCallsign', 'notFullCallsign', 'prefix', 'notPrefix',
  'mode', 'band', 'bandSlot', 'spotter', 'notSpotter', 'spotterPrefix', 'dxcc', 'homeDxcc',
  'spotterDxcc', 'cq', 'spotterCq', 'continent', 'spotterContinent', 'state', 'spotterState',
  'qsl', 'summitAssociation', 'summitRegion', 'summitRef', 'parkPrefix', 'parkRef', 'iota',
  'daysOfWeek', 'dstarNode', 'dstarReflector', 'dstarGroup',
]);

const MATCHER_FIELDS = new Set([
  'source', 'callsign', 'notCallsign', 'fullCallsign', 'notFullCallsign', 'prefix', 'notPrefix',
  'summitAssociation', 'summitRegion', 'summitRef', 'wwffRef', 'mode', 'band', 'spotter',
  'notSpotter', 'spotterPrefix', 'daysOfWeek', 'dxcc', 'callsignDxcc', 'spotterDxcc', 'cq', 'itu',
  'continent', 'spotterContinent', 'spotterCq', 'wwffDivision', 'iotaGroupRef', 'bandslot', 'state',
  'spotterState', 'qsl', 'dvEvent', 'dvNode', 'dvReflector', 'dvGroup', 'timeFrom', 'timeTo',
  'speedFrom', 'speedTo', 'snrFrom', 'snrTo', 'summitPointsFrom', 'summitPointsTo',
  'summitActivationsFrom', 'summitActivationsTo',
]);

const WEAK_FIELDS = new Set([
  'timeFrom', 'timeTo', 'daysOfWeek', 'speedFrom', 'speedTo', 'snrFrom', 'snrTo',
  'summitPointsFrom', 'summitPointsTo', 'summitActivationsFrom', 'summitActivationsTo',
]);

const DATE_TO_LEGACY: Record<string, number> = {
  all: 0,
  last12months: 1,
  thisYear: 3,
  lastYear: 4,
};
const DATE_FROM_LEGACY: Record<number, string> = {
  0: 'all',
  1: 'last12months',
  3: 'thisYear',
  4: 'lastYear',
};

export interface TriggerWriteResult {
  doc: Record<string, unknown>;
  errors: FieldError[];
}

/** Matcher document → API trigger. */
export function triggerToApi(doc: Record<string, any>): Record<string, unknown> {
  const id = String(doc._id);
  const created = dateOf(doc.createdAt) || objectIdDate(id);
  const updated = dateOf(doc.updatedAt) || created;
  const conditions = conditionsToApi(doc.conditions || {});
  const out: Record<string, any> = {
    id,
    comment: typeof doc.comment === 'string' ? doc.comment : '',
    conditions,
    actions: asArray(doc.actions).filter((a) => ACTIONS.has(String(a))),
    enabled: doc.disabled !== true,
    createdAt: created.toISOString(),
    updatedAt: updated.toISOString(),
    matchCount: typeof doc.matchCount === 'number' ? doc.matchCount : 0,
  };
  const options = optionsToApi(doc.options, doc.conditions);
  if (options) out.options = options;
  if (doc.useless === true) {
    out.autoDisabled = {
      at: updated.toISOString(),
      reason: 'Exceeded the match limit',
    };
  }
  return out;
}

/** API trigger → matcher document. errors is empty when the write is acceptable. */
export function triggerFromApi(input: any, existing?: Record<string, any>): TriggerWriteResult {
  const errors: FieldError[] = [];
  if (!input || typeof input !== 'object') {
    return {doc: {}, errors: [{field: '/', message: 'Body must be an object'}]};
  }
  const comment = input.comment == null ? '' : String(input.comment);
  if (comment.length > 1000) errors.push({field: '/comment', message: 'Comment is longer than 1000 characters'});

  const actions = asArray(input.actions).map(String);
  if (actions.length < 1) errors.push({field: '/actions', message: 'At least one action is required'});
  if (new Set(actions).size !== actions.length) errors.push({field: '/actions', message: 'Actions must be unique'});
  actions.forEach((action, i) => {
    if (!ACTIONS.has(action)) errors.push({field: `/actions/${i}`, message: 'Unknown action'});
  });

  const {legacy, errors: conditionErrors} = conditionsFromApi(input.conditions);
  errors.push(...conditionErrors);

  const enabled = input.enabled !== false;
  const options = optionsFromApi(input.options, errors);
  if (options?.clublog && !legacy.band) {
    errors.push({field: '/options/clublogUnworked', message: 'conditions.band is required when Club Log sync is enabled'});
  }

  const doc: Record<string, unknown> = {
    conditions: legacy,
    actions,
    comment,
    disabled: !enabled,
    matchCount: 0,
    updatedAt: new Date(),
  };
  if (options) doc.options = options;
  if (existing?.options?.clublog?.lastUpdate && options?.clublog) {
    (doc.options as any).clublog.lastUpdate = existing.options.clublog.lastUpdate;
  }
  return {doc, errors};
}

/**
 * API conditions → matcher hash keys.
 * Activity other than on-air is rejected. At least one condition the
 * matcher actually evaluates is required; time, weekday, and range checks
 * alone are not enough. A missing range end is stored as ±1_000_000 so
 * the matcher, which applies a range only when both ends are set, still checks it.
 */
function conditionsFromApi(input: any): {legacy: Record<string, unknown>; errors: FieldError[]} {
  const errors: FieldError[] = [];
  const legacy: Record<string, unknown> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {legacy, errors: [{field: '/conditions', message: 'At least one condition must be specified'}]};
  }

  if (input.activity != null) {
    const activity = asArray(input.activity).map(String);
    const extra = activity.filter((a) => a !== 'on-air');
    if (extra.length) {
      errors.push({field: '/conditions/activity', message: 'Only on-air is matched by the current engine'});
    }
  }

  if (input.parkProgram != null) {
    const programs = asArray(input.parkProgram).map(String);
    const sources = new Set(asArray(input.source).map(String));
    for (const program of programs) {
      if (program !== 'pota' && program !== 'wwff') {
        errors.push({field: '/conditions/parkProgram', message: 'Program must be pota or wwff'});
      } else {
        sources.add(program);
      }
    }
    if (sources.size) legacy.source = [...sources];
  }

  if (input.parkLocation != null) {
    const states = new Set(asArray(legacy.state ?? input.state).map(String));
    for (const loc of asArray(input.parkLocation).map(String)) {
      const match = /^([A-Z]{2})-([A-Z0-9]{2,3})$/.exec(loc);
      if (!match) {
        errors.push({field: '/conditions/parkLocation', message: `Cannot match location ${loc} with the current engine`});
      } else {
        states.add(`${match[1]}_${match[2]}`);
      }
    }
    if (states.size) legacy.state = [...states];
  }

  for (const [key, value] of Object.entries(input)) {
    if (key === 'activity' || key === 'parkProgram' || key === 'parkLocation') continue;
    if (key === 'source' && legacy.source) continue;
    if (key === 'state' && legacy.state) continue;
    if (key === 'snr' || key === 'speed' || key === 'summitPoints' || key === 'summitActivations') {
      writeRange(legacy, key, value, errors);
      continue;
    }
    if (key === 'timeOfDay') {
      if (!value || typeof value !== 'object' || !TIME.test(String((value as any).from)) || !TIME.test(String((value as any).to))) {
        errors.push({field: '/conditions/timeOfDay', message: 'from and to must be HH:MM'});
      } else {
        legacy.timeFrom = (value as any).from;
        legacy.timeTo = (value as any).to;
      }
      continue;
    }
    if (!LIST_FIELDS.has(key)) {
      errors.push({field: `/conditions/${key}`, message: 'Unknown condition'});
      continue;
    }
    const list = asArray(value);
    if (list.length < 1) {
      errors.push({field: `/conditions/${key}`, message: 'Lists may not be empty'});
      continue;
    }
    if (list.length > LIST_MAX) {
      errors.push({field: `/conditions/${key}`, message: 'Lists may not have more than 5000 entries'});
      continue;
    }
    if (key === 'band') {
      list.forEach((item, i) => {
        const band = String(item);
        if (!BAND.test(band) && !BAND_GROUP.has(band)) {
          errors.push({field: `/conditions/band/${i}`, message: 'Unknown band'});
        }
      });
    }
    if (key === 'summitRegion') {
      list.forEach((item, i) => {
        if (!REGION.test(String(item))) errors.push({field: `/conditions/summitRegion/${i}`, message: 'Region is two letters'});
      });
    }
    if (key === 'callsign' || key === 'notCallsign' || key === 'fullCallsign' || key === 'notFullCallsign' || key === 'spotter' || key === 'notSpotter') {
      list.forEach((item, i) => {
        if (!CALLSIGN.test(String(item))) errors.push({field: `/conditions/${key}/${i}`, message: 'Invalid callsign'});
      });
    }
    const stored = RENAME[key] || key;
    legacy[stored] = list.map((item) => (typeof item === 'string' ? item : item));
  }

  if (Object.keys(legacy).length === 0) {
    errors.push({field: '/conditions', message: 'At least one condition must be specified'});
  } else if (!Object.keys(legacy).some((key) => MATCHER_FIELDS.has(key) && !WEAK_FIELDS.has(key))) {
    errors.push({field: '/conditions', message: 'At least one condition other than time, speed, SNR or summit points is required'});
  }
  return {legacy, errors};
}

function writeRange(legacy: Record<string, unknown>, key: string, value: any, errors: FieldError[]) {
  if (!value || typeof value !== 'object') {
    errors.push({field: `/conditions/${key}`, message: 'Expected a from/to range'});
    return;
  }
  const fromName = key === 'summitPoints' ? 'summitPointsFrom' : key === 'summitActivations' ? 'summitActivationsFrom' : `${key}From`;
  const toName = key === 'summitPoints' ? 'summitPointsTo' : key === 'summitActivations' ? 'summitActivationsTo' : `${key}To`;
  const from = value.from == null ? undefined : Number(value.from);
  const to = value.to == null ? undefined : Number(value.to);
  if (from == null && to == null) {
    errors.push({field: `/conditions/${key}`, message: 'A range needs from or to'});
    return;
  }
  // The matcher applies these only when both ends are set.
  legacy[fromName] = from ?? -1_000_000;
  legacy[toName] = to ?? 1_000_000;
}

/** Matcher hash keys → API conditions. Sentinel range ends (±1_000_000) are omitted. */
function conditionsToApi(legacy: Record<string, any>): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(legacy)) {
    if (key.endsWith('From') || key.endsWith('To') || key === 'timeFrom' || key === 'timeTo') continue;
    const name = LEGACY_RENAME[key] || key;
    if (name === 'itu') continue;
    api[name] = asArray(value);
  }
  copyRange(api, 'snr', legacy.snrFrom, legacy.snrTo);
  copyRange(api, 'speed', legacy.speedFrom, legacy.speedTo);
  copyRange(api, 'summitPoints', legacy.summitPointsFrom, legacy.summitPointsTo);
  copyRange(api, 'summitActivations', legacy.summitActivationsFrom, legacy.summitActivationsTo);
  if (legacy.timeFrom && legacy.timeTo) api.timeOfDay = {from: legacy.timeFrom, to: legacy.timeTo};
  return api;
}

function copyRange(api: Record<string, unknown>, name: string, from: unknown, to: unknown) {
  if (from == null && to == null) return;
  const range: Record<string, number> = {};
  if (typeof from === 'number' && from > -1_000_000) range.from = from;
  if (typeof to === 'number' && to < 1_000_000) range.to = to;
  if (range.from != null || range.to != null) api[name] = range;
}

/** API options.clublogUnworked / sotaCompleteAuto → the fields the matcher jobs read. */
function optionsFromApi(input: any, errors: FieldError[]): Record<string, unknown> | undefined {
  if (input == null) return undefined;
  if (typeof input !== 'object') {
    errors.push({field: '/options', message: 'Expected an object'});
    return undefined;
  }
  const options: Record<string, unknown> = {};
  if (input.clublogUnworked) {
    const club = input.clublogUnworked;
    if (!club.callsign || !CALLSIGN.test(String(club.callsign))) {
      errors.push({field: '/options/clublogUnworked/callsign', message: 'Invalid callsign'});
    }
    const dateFilter = club.dateFilter || 'all';
    if (DATE_TO_LEGACY[dateFilter] == null) {
      errors.push({field: '/options/clublogUnworked/dateFilter', message: 'Unknown date filter'});
    }
    options.clublog = {
      callsign: String(club.callsign || ''),
      modes: club.modes || 'all',
      status: asArray(club.status).length ? asArray(club.status) : ['worked', 'confirmed', 'verified'],
      date: DATE_TO_LEGACY[dateFilter] ?? 0,
      forceUpdate: true,
    };
  }
  if (input.sotaCompleteAuto === true) options.autoUpdateSotaCompleteCandidates = true;
  return Object.keys(options).length ? options : undefined;
}

/** Stored matcher options → API options. */
function optionsToApi(options: any, conditions: any): Record<string, unknown> | undefined {
  if (!options || typeof options !== 'object') return undefined;
  const api: Record<string, any> = {};
  if (options.clublog?.callsign) {
    const slots = asArray(conditions?.bandslot);
    api.clublogUnworked = {
      callsign: options.clublog.callsign,
      modes: options.clublog.modes || 'all',
      status: asArray(options.clublog.status),
      dateFilter: DATE_FROM_LEGACY[Number(options.clublog.date)] || 'all',
      ...(options.clublog.lastUpdate ? {lastUpdatedAt: dateOf(options.clublog.lastUpdate)?.toISOString()} : {}),
      slotCount: slots.length,
    };
  }
  if (options.autoUpdateSotaCompleteCandidates) api.sotaCompleteAuto = true;
  return Object.keys(api).length ? api : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function dateOf(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (value && typeof (value as any).toDate === 'function') return (value as any).toDate();
  return undefined;
}

function objectIdDate(id: string): Date {
  if (/^[a-f0-9]{24}$/i.test(id)) return new Date(parseInt(id.slice(0, 8), 16) * 1000);
  return new Date();
}
