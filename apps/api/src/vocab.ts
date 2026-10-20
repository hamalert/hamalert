/**
 * Static lists served by GET /v1/reference/vocabularies.
 * Band edges and groups match the matcher so a trigger band the API
 * accepts is a band the matcher can query.
 */
const BANDS_MHZ: Array<[string, number, number]> = [
  ['2200m', 0.135, 0.138],
  ['600m', 0.472, 0.479],
  ['160m', 1.8, 2],
  ['80m', 3.5, 4],
  ['60m', 5, 5.5],
  ['40m', 7, 7.3],
  ['30m', 10, 10.15],
  ['20m', 14, 14.35],
  ['17m', 18.068, 18.168],
  ['15m', 21, 21.45],
  ['12m', 24.89, 24.99],
  ['11m', 26, 28],
  ['10m', 28, 29.7],
  ['8m', 40, 45],
  ['6m', 50, 54],
  ['4m', 70, 71],
  ['2m', 144, 148],
  ['1.25m', 222, 225],
  ['70cm', 420, 450],
  ['33cm', 902, 928],
  ['23cm', 1240, 1300],
  ['13cm', 2300, 2450],
  ['9cm', 3300, 3500],
  ['6cm', 5650, 5925],
  ['3cm_qo100', 10489, 10490],
  ['3cm', 10000, 10500],
];

const GROUPS: Record<string, string[]> = {
  vlf: [],
  lf: ['2200m'],
  mf: ['600m', '160m'],
  hf: ['80m', '60m', '40m', '30m', '20m', '17m', '15m', '12m', '11m', '10m'],
  vhf: ['8m', '6m', '4m', '2m', '1.25m'],
  uhf: ['70cm', '33cm', '23cm', '13cm'],
  shf: ['9cm', '6cm', '3cm_qo100', '3cm'],
  ehf: [],
};

const MODES = ['cw', 'ssb', 'fm', 'am', 'rtty', 'psk', 'ft8', 'ft4', 'jt', 'msk', 'js8', 'sstv', 'dstar', 'dmr', 'c4fm', 'data'];

const SOURCES: Array<[string, string, string?]> = [
  ['sotawatch', 'SOTAwatch', 'https://sotawatch.sota.org.uk/'],
  ['pota', 'Parks on the Air', 'https://pota.app/'],
  ['wwff', 'WWFF', 'https://wwff.co/'],
  ['cluster', 'DX cluster'],
  ['rbn', 'Reverse Beacon Network', 'https://www.reversebeacon.net/'],
  ['pskreporter', 'PSK Reporter', 'https://pskreporter.info/'],
  ['quadnet', 'QuadNet'],
  ['ircddb', 'ircDDB'],
  ['dstarusers', 'dstarusers.org'],
  ['simulator', 'Simulator'],
];

export const DEFAULT_TEMPLATES = {
  titleTemplate: '{{callsign}} {{band}} {{mode}}',
  bodyTemplate: '{{rawText}}',
};

export function vocabularies() {
  return {
    bands: BANDS_MHZ.map(([band, from, to]) => ({
      band,
      fromHz: Math.round(from * 1_000_000),
      toHz: Math.round(to * 1_000_000),
    })),
    bandGroups: Object.entries(GROUPS).map(([group, bands]) => ({group, bands})),
    modes: MODES.map((mode) => ({mode, label: mode.toUpperCase()})),
    sources: SOURCES.map(([source, label, url]) => ({source, label, ...(url ? {url} : {})})),
    actions: ['app', 'telnet', 'url', 'threema'],
    continents: ['AF', 'AN', 'AS', 'EU', 'NA', 'OC', 'SA'],
    defaultAppTemplates: DEFAULT_TEMPLATES,
  };
}
