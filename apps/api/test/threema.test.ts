import assert from 'node:assert/strict';
import test from 'node:test';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {MongoClient} from 'mongodb';
import {claimThreemaSend, normalizeThreemaValidationCode, threemaCodeMatches, threemaValidationCode} from '../src/threema';

test('the verification code matches the PHP site for the same id and hash key', () => {
  assert.equal(threemaValidationCode('ABCD1234', 'test-hash-key'), 'PF10T-5SCJY');
  assert.equal(threemaValidationCode('ZZZZZZZZ', 'another-key'), 'WWQM1-8F2W8');
});

test('a code from the message verifies with the hyphen, spaces, or the usual misreadings', () => {
  assert.equal(threemaCodeMatches('pf10t-5scjy', 'ABCD1234', 'test-hash-key'), true);
  assert.equal(threemaCodeMatches('PF10T 5SCJY', 'ABCD1234', 'test-hash-key'), true);
  assert.equal(normalizeThreemaValidationCode('pfilo-oooi'), 'PF1100001');
  assert.equal(threemaCodeMatches('PF10T-5SCJX', 'ABCD1234', 'test-hash-key'), false);
  assert.equal(threemaCodeMatches('123456', 'ABCD1234', 'test-hash-key'), false);
});

test('an account and a destination id can each cause five verification messages an hour', async () => {
  const memory = await MongoMemoryServer.create({binary: {version: '8.0.16'}});
  const client = new MongoClient(memory.getUri());
  await client.connect();
  const db = client.db('hamalert');
  try {
    for (let i = 0; i < 5; i++) {
      const claim = await claimThreemaSend(db, `user-${i}`, 'SAMEID00');
      assert.equal(claim.ok, true);
    }
    const floodedId = await claimThreemaSend(db, 'user-5', 'SAMEID00');
    assert.equal(floodedId.ok, false);
    if (!floodedId.ok) assert.ok(floodedId.retryAfter > 0 && floodedId.retryAfter <= 3600);
    for (let i = 0; i < 5; i++) {
      const claim = await claimThreemaSend(db, 'solo', `ID00000${i}`);
      assert.equal(claim.ok, true);
    }
    const cappedAccount = await claimThreemaSend(db, 'solo', 'ID000009');
    assert.equal(cappedAccount.ok, false);
    const otherAccount = await claimThreemaSend(db, 'solo-2', 'ID000009');
    assert.equal(otherAccount.ok, true);
  } finally {
    await client.close();
    await memory.stop();
  }
});
