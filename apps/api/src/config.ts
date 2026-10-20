/** Process configuration. Defaults point at the hamalert-server local-dev ports. */
export interface Config {
  host: string;
  port: number;
  mongodbUri: string;
  redisUrl: string;
  simulatorUrl: string;
  corsOrigins: string[] | true;
  trustProxy: boolean;
  accessTtlSec: number;
  refreshTtlSec: number;
  maxTriggers: number;
  myspotHashKey: string;
  publicWebUrl: string;
  smtp: {
    host?: string;
    port: number;
    user?: string;
    pass?: string;
    from: string;
  };
  threema: {
    apiId?: string;
    apiSecret?: string;
    /** Shared with the PHP site's threema_validation_hashkey. */
    hashKey?: string;
  };
  clublogApiKey?: string;
  devLogSecrets: boolean;
  captcha: {
    siteKey?: string;
    secret?: string;
    /** Public origin of the Cap Standalone server, without the site key. Defaults to https://captcha.hamalert.org. */
    instanceUrl?: string;
    widgetUrl?: string;
  };
}

function list(value: string | undefined): string[] | true {
  if (!value || value === '*') return true;
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV || 'development';
  return {
    host: env.HOST || '0.0.0.0',
    port: int(env.PORT, 8082),
    mongodbUri: env.MONGODB_URI || 'mongodb://127.0.0.1:27117/hamalert',
    redisUrl: env.REDIS_URL || 'redis://127.0.0.1:6479',
    simulatorUrl: env.SIMULATOR_URL || 'http://127.0.0.1:1983/sendSpot',
    corsOrigins: list(env.CORS_ORIGINS),
    trustProxy: env.TRUST_PROXY === '1',
    accessTtlSec: int(env.ACCESS_TTL_SEC, 3600),
    refreshTtlSec: int(env.REFRESH_TTL_SEC, 60 * 60 * 24 * 90),
    maxTriggers: int(env.MAX_TRIGGERS, 100),
    myspotHashKey: env.MYSPOT_HASH_KEY || 'dev-myspot-key',
    publicWebUrl: (env.PUBLIC_WEB_URL || 'http://localhost:5173').replace(/\/$/, ''),
    smtp: {
      host: env.SMTP_HOST || undefined,
      port: int(env.SMTP_PORT, 587),
      user: env.SMTP_USER || undefined,
      pass: env.SMTP_PASS || undefined,
      from: env.MAIL_FROM || 'spot@hamalert.org',
    },
    threema: {
      apiId: env.THREEMA_API_ID || undefined,
      apiSecret: env.THREEMA_API_SECRET || undefined,
      hashKey: env.THREEMA_VALIDATION_HASHKEY || undefined,
    },
    clublogApiKey: env.CLUBLOG_API_KEY || undefined,
    devLogSecrets: env.DEV_LOG_SECRETS === '1' || nodeEnv !== 'production',
    captcha: {
      siteKey: env.CAPTCHA_SITE_KEY || undefined,
      secret: env.CAPTCHA_SECRET || undefined,
      instanceUrl: env.CAPTCHA_INSTANCE_URL || 'https://captcha.hamalert.org',
      widgetUrl: env.CAPTCHA_WIDGET_URL || undefined,
    },
  };
}

function int(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
