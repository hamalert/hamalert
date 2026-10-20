# HamAlert API

HTTP API for the new Vue and Ionic clients, served at `api.hamalert.org`. It speaks [`packages/contract/openapi.yaml`](../../packages/contract/openapi.yaml) (version 0.4.4) and reads and writes the same MongoDB documents as the PHP site and the Node matcher. Those keep working unchanged.

The matcher reloads triggers about once a minute and caches user documents for about a minute, so changes made here show up on that schedule.

## Run against the local matcher stack

From `hamalert-server`, `npm run local-dev` starts MongoDB on `127.0.0.1:27117`, Redis on `127.0.0.1:6479`, and the spot simulator on port `1983`. This process uses those by default:

From the repository root:

```sh
pnpm install
pnpm dev
```

The API listens on `http://127.0.0.1:8082/v1`. The seeded user is `N0CALL` / `testpass123`. Without `SMTP_HOST`, confirmation and reset messages are printed to the log.

## Configuration

| Variable | Default |
| --- | --- |
| `PORT` | `8082` |
| `MONGODB_URI` | `mongodb://127.0.0.1:27117/hamalert` |
| `REDIS_URL` | `redis://127.0.0.1:6479` |
| `SIMULATOR_URL` | `http://127.0.0.1:1983/sendSpot` |
| `CORS_ORIGINS` | `*` |
| `MYSPOT_HASH_KEY` | dev key; set the PHP `myspot_hashkey` in production so existing image URLs keep working |
| `PUBLIC_WEB_URL` | `http://localhost:5173` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | mail is logged when unset |
| `THREEMA_API_ID`, `THREEMA_API_SECRET`, `THREEMA_VALIDATION_HASHKEY` | Same hash key as the PHP site (`threema_validation_hashkey`). Verification messages are limited to 5 per account and 5 per destination id each hour. The code is logged when the gateway is unset outside production |
| `CLUBLOG_API_KEY` | optional, for the unworked-DXCC helper |
| `CAPTCHA_INSTANCE_URL`, `CAPTCHA_SITE_KEY`, `CAPTCHA_SECRET` | Cap Standalone at `https://captcha.hamalert.org`. The widget and WASM come from that host's `/assets/` server. The secret is the site key's secret, not the dashboard admin key. `CAPTCHA_WIDGET_URL` overrides only the widget script |
| `TRUST_PROXY` | set to `1` behind the reverse proxy |

Passwords stay PHP `password_hash()` bcrypt (`$2y$`). Sessions are a new `sessions` collection of hashed bearer tokens. PHP cookie sessions and the Cordova app's HTTP Basic calls to `hamalert.org/api/*` are untouched.

Push devices are `users.appTokens` (`ios` stored as `apns`, `android` as `gcm`), so the existing notifier delivers them. Webhook URLs are stored as `notificationUrl` with method `POST-JSON`. The current notifier posts the legacy parameter object; the HMAC secret is stored as `notificationSecret` for a later matcher change.

`POST /simulate` forwards a legacy spot to the matcher simulator. The response contains the spot as submitted and an empty `matched` list. Which triggers matched, and near misses, wait until the matcher can answer synchronously. The live stream resumes with Redis stream ids, which are not Mongo ids.

## Checks

```sh
pnpm test
pnpm gen-types   # rewrites packages/contract/src/schema.ts
```

The image is built from the repository root: `docker build -f apps/api/Dockerfile .`
