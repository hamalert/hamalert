import type {Config} from './config';

/** Cap (https://trycap.dev). The challenge server is one you run; this process only verifies tokens. */
export const CAPTCHA_PROVIDER = 'cap';
/** Default Cap Standalone host. Its asset server also serves the widget and the WASM solver. */
export const CAPTCHA_INSTANCE_URL = 'https://captcha.hamalert.org';

const SITE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

export interface CaptchaWidget {
  provider: typeof CAPTCHA_PROVIDER;
  siteKey: string;
  /** Value for the widget's data-cap-api-endpoint attribute. */
  apiEndpoint: string;
  scriptUrl: string;
  /** Set window.CAP_CUSTOM_WASM_URL to this before loading scriptUrl. */
  wasmUrl: string;
  /** Set window.CAP_CUSTOM_HASHWX_URL to this before loading scriptUrl. */
  hashwxUrl: string;
}

/** Site key, secret, and a public Cap Standalone URL are all set. */
export function captchaReady(config: Config): boolean {
  return widgetOf(config) !== null;
}

export function captchaWidget(config: Config): CaptchaWidget {
  const widget = widgetOf(config);
  if (!widget) throw new Error('CAPTCHA is not configured');
  return widget;
}

/**
 * POST the token to {instance}/{siteKey}/siteverify.
 * Cap returns {success: true} once. Redirects and network errors fail closed
 * so the secret is not followed to another host.
 */
export async function verifyCaptcha(config: Config, token: string, fetchImpl: typeof fetch): Promise<boolean> {
  const value = token.trim();
  const widget = widgetOf(config);
  if (!value || value.length > 20000 || !widget || !config.captcha.secret) return false;
  let response: Response;
  try {
    response = await fetchImpl(widget.apiEndpoint + 'siteverify', {
      method: 'POST',
      redirect: 'error',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({secret: config.captcha.secret, response: value}),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const body = await response.json().catch(() => null) as {success?: unknown} | null;
  return body?.success === true;
}

function widgetOf(config: Config): CaptchaWidget | null {
  const {siteKey, secret, instanceUrl, widgetUrl} = config.captcha;
  if (!siteKey || !SITE_KEY.test(siteKey) || !secret) return null;
  const endpoint = apiEndpoint(instanceUrl, siteKey);
  const assets = assetsBase(instanceUrl);
  const script = absoluteHttpUrl(widgetUrl || (assets ? assets + 'widget.js' : undefined));
  if (!endpoint || !assets || !script) return null;
  return {
    provider: CAPTCHA_PROVIDER,
    siteKey,
    apiEndpoint: endpoint,
    scriptUrl: script.toString(),
    wasmUrl: assets + 'cap_wasm_bg.wasm',
    hashwxUrl: assets + 'hashwx.wasm',
  };
}

function apiEndpoint(instanceUrl: string | undefined, siteKey: string): string | null {
  const base = absoluteHttpUrl(instanceUrl);
  if (!base) return null;
  const path = base.pathname.replace(/\/+$/, '');
  return `${base.origin}${path}/${siteKey}/`;
}

function assetsBase(instanceUrl: string | undefined): string | null {
  const base = absoluteHttpUrl(instanceUrl);
  if (!base) return null;
  return `${base.origin}/assets/`;
}

function absoluteHttpUrl(value: string | undefined): URL | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  return url;
}
