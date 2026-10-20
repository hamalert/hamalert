import assert from 'node:assert/strict';
import test from 'node:test';
import {expand, legacyToBraces, legacyToMatchedSpot, legacyToSpot, mhzToHz} from '../src/map/spot';
import {renderMyspotPng} from '../src/png';

test('legacy megahertz spots become integer hertz', () => {
  assert.equal(mhzToHz(14.074), 14074000);
  const spot = legacyToSpot({
    fullCallsign: 'DL/HB9DQM/P',
    callsign: 'HB9DQM',
    frequency: 14.074,
    band: '20m',
    mode: 'CW',
    source: 'sotawatch',
    spotter: 'HB9FVF',
    summitRef: 'HB/ZH-015',
    summitName: 'Uetliberg',
    receivedDate: new Date('2026-10-18T12:00:00Z'),
    time: '12:00',
    dxcc: {dxcc: 287, country: 'Switzerland', continent: 'EU'},
    bandIsGuessed: false,
    wwffRef: 'HBFF-0001',
  }, 'abc');
  assert.equal(spot.frequency, 14074000);
  assert.equal(spot.baseCallsign, 'HB9DQM');
  assert.equal(spot.mode, 'cw');
  assert.equal((spot.summit as any).region, 'ZH');
  assert.equal((spot.entity as any).name, 'Switzerland');
  assert.equal((spot.parks as any)[0].ref, 'HBFF-0001');
  assert.equal(spot.bandSlot, '287_20m');
});

test('guessed band is the only provenance recorded today', () => {
  const spot = legacyToSpot({
    fullCallsign: 'N0CALL',
    callsign: 'N0CALL',
    source: 'quadnet',
    mode: 'dstar',
    band: '2m',
    bandIsGuessed: true,
    dvNode: 'N0CALL-C',
    receivedDate: new Date('2026-10-18T12:00:00Z'),
  }, '1');
  assert.deepEqual(spot.provenance, {band: 'module-letter'});
  assert.equal((spot.dstar as any).node, 'N0CALL-C');
});

test('matched spots keep the trigger comment and render templates', () => {
  const matched = legacyToMatchedSpot({
    fullCallsign: 'N0CALL',
    callsign: 'N0CALL',
    source: 'cluster',
    frequency: 7.05,
    band: '40m',
    mode: 'cw',
    rawText: 'DX de N0CALL',
    actions: ['app', 'telnet'],
    triggerComment: ['Home'],
    receivedDate: new Date('2026-10-18T12:00:00Z'),
  }, 'spot1', {titleTemplate: '{{callsign}} {{band}}', bodyTemplate: '{rawText}'});
  assert.equal((matched.display as any).title, 'N0CALL 40m');
  assert.equal((matched.display as any).body, 'DX de N0CALL');
  assert.equal((matched.triggers as any)[0].id, 'unrecorded');
  assert.equal((matched.triggers as any)[0].comment, 'Home');
  assert.equal(legacyToBraces('{title}'), '{{title}}');
  assert.equal(expand('{{callsign}}', {callsign: 'N0CALL'}), 'N0CALL');
});

test('myspot png starts with the PNG signature', () => {
  const png = renderMyspotPng(['N0CALL', '40M CW'], false, 1);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});
