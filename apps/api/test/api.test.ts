import assert from 'node:assert/strict';
import test from 'node:test';
import {MongoMemoryServer} from 'mongodb-memory-server';
import {MongoClient, ObjectId} from 'mongodb';
import {buildApp} from '../src/app';
import {loadConfig} from '../src/config';
import {hashPassword} from '../src/crypto';
import type {Mailer} from '../src/mail';

test('login, triggers, spots and reference reads share the legacy collections', async () => {
  const memory = await MongoMemoryServer.create({binary: {version: '8.0.16'}});
  const client = new MongoClient(memory.getUri());
  await client.connect();
  const db = client.db('hamalert');
  const password = await hashPassword('testpass123');
  const user = await db.collection('users').insertOne({
    username: 'N0CALL',
    password,
    accountEmail: 'n0call@example.invalid',
    alerts: true,
    limit: {count: 100, interval: 3600},
    telnetPassword: 'clusterpw',
    app: {titleFormat: '{title}'},
    signupDate: new Date('2020-01-01T00:00:00Z'),
  });
  await db.collection('triggers').insertOne({
    user_id: user.insertedId,
    conditions: {callsign: 'HB9DQM', band: 'hf'},
    actions: ['app'],
    comment: 'existing',
    matchCount: 2,
  });
  await db.collection('spots').insertOne({
    user_id: user.insertedId,
    fullCallsign: 'HB9DQM',
    callsign: 'HB9DQM',
    frequency: 14.074,
    band: '20m',
    mode: 'cw',
    source: 'cluster',
    actions: ['app'],
    triggerComment: 'existing',
    receivedDate: new Date(),
  });
  await db.collection('dxccs').insertOne({dxcc: 291, country: 'United States', continent: 'NA', prefix: 'K'});

  const sent: string[] = [];
  const mailer: Mailer = {async send(_to, _subject, text) { sent.push(text); }};
  const app = await buildApp({
    config: {...loadConfig({
      NODE_ENV: 'test',
      MYSPOT_HASH_KEY: 'test-key',
      CAPTCHA_SITE_KEY: 'site-key',
      CAPTCHA_SECRET: 'site-secret',
      CAPTCHA_INSTANCE_URL: 'https://cap.test',
    }), devLogSecrets: false},
    db,
    redis: null,
    mailer,
    fetchImpl: async (url, init) => {
      if (String(url) === 'https://cap.test/site-key/siteverify') {
        const body = JSON.parse(String(init?.body || '{}')) as {response?: string; secret?: string};
        const success = body.secret === 'site-secret' && body.response === 'human-token';
        return new Response(JSON.stringify({success}), {status: 200});
      }
      return new Response('', {status: 200});
    },
  });

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: {username: 'n0call', password: 'testpass123', device: {platform: 'web', name: 'test'}},
  });
  assert.equal(login.statusCode, 200);
  const token = login.json().accessToken as string;
  const auth = {authorization: `Bearer ${token}`};

  const triggers = await app.inject({method: 'GET', url: '/v1/triggers', headers: auth});
  assert.equal(triggers.statusCode, 200);
  const listed = triggers.json() as Array<{conditions: {band: string[]}; comment: string}>;
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].conditions.band, ['hf']);

  const created = await app.inject({
    method: 'POST',
    url: '/v1/triggers',
    headers: auth,
    payload: {comment: 'new', actions: ['telnet'], conditions: {mode: ['cw'], summitRegion: ['ZH']}},
  });
  assert.equal(created.statusCode, 201);
  const stored = await db.collection('triggers').findOne({comment: 'new'});
  assert.deepEqual(stored?.conditions.mode, ['cw']);
  assert.equal(stored?.user_id.toString(), user.insertedId.toString());

  const spots = await app.inject({method: 'GET', url: '/v1/spots', headers: auth});
  assert.equal(spots.statusCode, 200);
  const page = spots.json();
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].spot.frequency, 14074000);
  assert.equal(page.items[0].display.title, '');

  const dxcc = await app.inject({method: 'GET', url: '/v1/reference/dxcc'});
  assert.equal(dxcc.statusCode, 200);
  assert.equal(dxcc.json()[0].name, 'United States');
  const again = await app.inject({method: 'GET', url: '/v1/reference/dxcc', headers: {'if-none-match': dxcc.headers.etag}});
  assert.equal(again.statusCode, 304);

  const vocab = await app.inject({method: 'GET', url: '/v1/reference/vocabularies'});
  assert.equal(vocab.json().registrationQuestion, undefined);
  assert.ok(vocab.json().bandGroups.some((group: {group: string}) => group.group === 'hf'));

  const captcha = await app.inject({method: 'GET', url: '/v1/auth/register/captcha'});
  assert.equal(captcha.statusCode, 200);
  const captchaBody = captcha.json() as {provider: string; siteKey: string; apiEndpoint: string; scriptUrl: string; wasmUrl: string; hashwxUrl: string};
  assert.equal(captchaBody.provider, 'cap');
  assert.equal(captchaBody.siteKey, 'site-key');
  assert.equal(captchaBody.apiEndpoint, 'https://cap.test/site-key/');
  assert.equal(captchaBody.scriptUrl, 'https://cap.test/assets/widget.js');
  assert.equal(captchaBody.wasmUrl, 'https://cap.test/assets/cap_wasm_bg.wasm');
  assert.equal(captchaBody.hashwxUrl, 'https://cap.test/assets/hashwx.wasm');
  const wrongCaptcha = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {email: 'new@example.invalid', username: 'N0NEW', password: 'testpass123', captchaToken: 'bot-token'},
  });
  assert.equal(wrongCaptcha.statusCode, 400);

  const registered = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: {email: 'new@example.invalid', username: 'N0NEW', password: 'testpass123', captchaToken: 'human-token'},
  });
  assert.equal(registered.statusCode, 202);
  assert.match(sent.at(-1) || '', /register\/confirm/);

  const beforeReset = sent.length;
  const resetDenied = await app.inject({
    method: 'POST',
    url: '/v1/auth/password/forgot',
    payload: {usernameOrEmail: 'N0CALL', captchaToken: 'bot-token'},
  });
  assert.equal(resetDenied.statusCode, 400);
  assert.equal(sent.length, beforeReset);
  const reset = await app.inject({
    method: 'POST',
    url: '/v1/auth/password/forgot',
    payload: {usernameOrEmail: 'N0CALL', captchaToken: 'human-token'},
  });
  assert.equal(reset.statusCode, 202);
  assert.match(sent.at(-1) || '', /password\/reset/);

  const health = await app.inject({method: 'GET', url: '/v1/health'});
  assert.equal(health.json().status, 'degraded');

  const simulated = await app.inject({
    method: 'POST',
    url: '/v1/simulate',
    headers: auth,
    payload: {callsign: 'N0CALL', frequency: 14074000, mode: 'cw', source: 'simulator'},
  });
  assert.equal(simulated.statusCode, 200);
  assert.deepEqual(simulated.json().matched, []);
  assert.equal(simulated.json().spot.frequency, 14074000);

  const wrong = await app.inject({method: 'POST', url: '/v1/auth/login', payload: {username: 'N0CALL', password: 'nope'}});
  assert.equal(wrong.statusCode, 401);

  await app.close();
  await client.close();
  await memory.stop();
  assert.ok(user.insertedId instanceof ObjectId);
  assert.equal(sent.length, 2);
});
