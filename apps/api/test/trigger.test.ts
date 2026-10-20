import assert from 'node:assert/strict';
import test from 'node:test';
import {triggerFromApi, triggerToApi} from '../src/map/trigger';

test('trigger conditions round-trip onto matcher fields', () => {
  const {doc, errors} = triggerFromApi({
    comment: 'Home call',
    actions: ['app', 'telnet'],
    enabled: true,
    conditions: {
      callsign: ['HB9DQM'],
      band: ['20m', 'hf'],
      homeDxcc: [287],
      summitRegion: ['ZH'],
      parkRef: ['K-1234'],
      iota: ['EU-001'],
      dstarNode: ['W4HFH'],
      timeOfDay: {from: '12:00', to: '14:00'},
      snr: {from: -10},
    },
    options: {
      clublogUnworked: {callsign: 'HB9DQM', modes: 'cw', dateFilter: 'last12months'},
      sotaCompleteAuto: true,
    },
  });
  assert.deepEqual(errors, []);
  const conditions = doc.conditions as Record<string, unknown>;
  assert.deepEqual(conditions.callsign, ['HB9DQM']);
  assert.deepEqual(conditions.band, ['20m', 'hf']);
  assert.deepEqual(conditions.callsignDxcc, [287]);
  assert.deepEqual(conditions.summitRegion, ['ZH']);
  assert.deepEqual(conditions.wwffRef, ['K-1234']);
  assert.deepEqual(conditions.iotaGroupRef, ['EU-001']);
  assert.deepEqual(conditions.dvNode, ['W4HFH']);
  assert.equal(conditions.timeFrom, '12:00');
  assert.equal(conditions.snrFrom, -10);
  assert.equal(conditions.snrTo, 1_000_000);
  assert.equal((doc.options as any).clublog.date, 1);
  assert.equal((doc.options as any).autoUpdateSotaCompleteCandidates, true);

  const api = triggerToApi({
    _id: '587924b0e2cb05b4f70291b2',
    ...doc,
    disabled: false,
    matchCount: 3,
  });
  const back = api.conditions as Record<string, unknown>;
  assert.deepEqual(back.homeDxcc, [287]);
  assert.deepEqual(back.parkRef, ['K-1234']);
  assert.deepEqual(back.dstarNode, ['W4HFH']);
  assert.equal((api.options as any).clublogUnworked.dateFilter, 'last12months');
  assert.equal((api.options as any).sotaCompleteAuto, true);
  assert.equal(api.enabled, true);
});

test('rejects conditions the matcher would ignore', () => {
  const onlyActivity = triggerFromApi({actions: ['app'], conditions: {activity: ['qrt']}});
  assert.ok(onlyActivity.errors.length > 0);
  const openEnded = triggerFromApi({actions: ['app'], conditions: {timeOfDay: {from: '00:00', to: '23:59'}}});
  assert.ok(openEnded.errors.some((error) => /time, speed/.test(error.message)));
});

test('useless flag becomes autoDisabled and a save clears it', () => {
  const api = triggerToApi({
    _id: '587924b0e2cb05b4f70291b2',
    conditions: {callsign: 'HB9DQM'},
    actions: ['app'],
    comment: '',
    disabled: true,
    useless: true,
    matchCount: 10000,
  });
  assert.equal(api.enabled, false);
  assert.equal((api.autoDisabled as any).reason, 'Exceeded the match limit');
});
