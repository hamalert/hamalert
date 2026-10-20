import assert from 'node:assert/strict';
import test from 'node:test';
import {captchaReady, captchaWidget, verifyCaptcha} from '../src/captcha';
import {loadConfig} from '../src/config';

function configured() {
  return loadConfig({
    NODE_ENV: 'production',
    CAPTCHA_SITE_KEY: 'site-key',
    CAPTCHA_SECRET: 'site-secret',
    CAPTCHA_INSTANCE_URL: 'https://cap.test',
  });
}

test('verification posts the token to the Cap siteverify URL', async () => {
  let target = '';
  let payload = '';
  const passed = await verifyCaptcha(configured(), 'human-token', async (url, init) => {
    target = String(url);
    payload = String(init?.body || '');
    assert.equal(init?.redirect, 'error');
    return new Response(JSON.stringify({success: true}), {status: 200});
  });
  assert.equal(passed, true);
  assert.equal(target, 'https://cap.test/site-key/siteverify');
  assert.deepEqual(JSON.parse(payload), {secret: 'site-secret', response: 'human-token'});
});

test('a rejected token and a provider outage both fail closed', async () => {
  const rejected = await verifyCaptcha(configured(), 'bot-token', async () => {
    return new Response(JSON.stringify({success: false}), {status: 200});
  });
  assert.equal(rejected, false);
  const offline = await verifyCaptcha(configured(), 'human-token', async () => {
    throw new Error('offline');
  });
  assert.equal(offline, false);
});

test('the widget and its WASM are served by the Cap asset server', () => {
  assert.equal(captchaReady(configured()), true);
  const onHamalert = loadConfig({
    NODE_ENV: 'production',
    CAPTCHA_SITE_KEY: 'site-key',
    CAPTCHA_SECRET: 'site-secret',
  });
  assert.equal(captchaReady(onHamalert), true);
  assert.equal(captchaWidget(onHamalert).scriptUrl, 'https://captcha.hamalert.org/assets/widget.js');
  assert.equal(captchaWidget(onHamalert).wasmUrl, 'https://captcha.hamalert.org/assets/cap_wasm_bg.wasm');
  assert.equal(captchaWidget(onHamalert).hashwxUrl, 'https://captcha.hamalert.org/assets/hashwx.wasm');
  assert.equal(captchaReady(loadConfig({
    NODE_ENV: 'production',
    CAPTCHA_SITE_KEY: '../etc',
    CAPTCHA_SECRET: 'site-secret',
    CAPTCHA_INSTANCE_URL: 'https://cap.test',
  })), false);
});
