# HamAlert

Repository for the HamAlert API and the clients that will share its contract. The matcher stays in [hamalert-server](https://github.com/hamalert/hamalert-server). The PHP site and the Cordova app stay in their own repositories until the Vue and Ionic replacements take over.

```
apps/api        HTTP API (api.hamalert.org)
packages/contract   OpenAPI files and the generated TypeScript types
```

`apps/web` and `apps/app` will be added here when those clients start.

## Run the API

From `hamalert-server`, `npm run local-dev` starts MongoDB on `127.0.0.1:27117`, Redis on `127.0.0.1:6479`, and the spot simulator on port `1983`.

Requires Node.js 24, the current LTS, and pnpm 12 (`corepack prepare pnpm@12.14.0 --activate`).

```sh
pnpm install
pnpm dev
```

The API listens on `http://127.0.0.1:8082/v1`. The seeded user is `N0CALL` / `testpass123`. Configuration and the rest of the service notes are in [apps/api/README.md](apps/api/README.md).

```sh
pnpm test
pnpm gen-types
```

`pnpm gen-types` rewrites `packages/contract/src/schema.ts` from `packages/contract/openapi.yaml`.
