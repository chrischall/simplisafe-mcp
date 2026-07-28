# Deploying the hosted SimpliSafe connector

The connector puts the same MCP tools behind a Cloudflare Worker with OAuth, so
they're reachable from claude.ai on the web, desktop and phone — not just from
Claude Code on the machine holding the credential.

Deployment is **manual, into your own Cloudflare account**. There is no CI
deploy (matching ofw / untappd / splitwise).

## Why this service can have a connector

A connector only works when the auth survives in a serverless runtime — no
browser bridge, no signed-in tab, no ephemeral cookie. SimpliSafe qualifies:

- auth is an OAuth2 refresh token, and **SimpliSafe does not rotate it**
  (verified live: the refresh response carries no new token), so there is no
  need for writable per-user token storage;
- the token lives encrypted in `OAUTH_KV`, and `buildClient` mints a per-user
  client from it, so concurrent sessions never share a credential.

## How the login page works

SimpliSafe has no API key, and its Auth0 tenant **disables the password grant**
(`unauthorized_client`, verified 2026-07-28), so the only way to get a
credential is authorization-code + PKCE — whose redirect URI is a custom scheme
in SimpliSafe's own tenant that we cannot change.

Rather than making you paste a token exported from a local install, the
connector runs that bootstrap itself, as **two submissions**:

1. Enter your SimpliSafe email, leave the second box blank, submit. The Worker
   mints a PKCE pair, stashes the *verifier* in `OAUTH_KV` under a random handle
   carried in the OAuth `state`, and renders "step 1 of 2" with an authorize URL.
2. Sign in at that URL. Your browser fails to open a `com.simplisafe.mobile://…`
   link — expected. Paste that URL into the second box and submit. The Worker
   matches it by `state`, **deletes the handle before exchanging** (so a captured
   URL can't be replayed), exchanges the code, and verifies the resulting token
   against the live API before storing anything.

The stash never holds a credential — only a per-attempt PKCE verifier, useless
on its own — and your password is only ever typed on SimpliSafe's own page.

## Prerequisites

- A Cloudflare account, with the `nullnet.app` zone in it if you want the custom
  domain (otherwise drop the `routes` entry in `wrangler.jsonc`).
- `wrangler login`, or an API token with **Workers Scripts:Edit + Workers KV
  Storage:Edit** (the "Edit Cloudflare Workers" template). A read-only or
  zone-only token fails KV creation and deploy with `code: 10000`.

## Deploy

```bash
npm install
npx wrangler login          # or: export CLOUDFLARE_API_TOKEN=...

# 1. Create THIS connector's own KV namespace. The distinct title matters —
#    sharing a namespace with another connector cross-wires OAuth grants.
npx wrangler kv namespace create simplisafe-connector-oauth

# 2. Paste the returned id into wrangler.jsonc's OAUTH_KV binding,
#    replacing REPLACE_WITH_YOUR_KV_NAMESPACE_ID. The binding NAME stays
#    OAUTH_KV; only the id differs per connector.

# 3. Deploy.
npm run worker:deploy
```

Then add `https://connector.simplisafe.nullnet.app/mcp` (or the `*.workers.dev`
URL) as a custom connector in claude.ai and complete the two-step login.

## Verifying

```bash
curl -s https://connector.simplisafe.nullnet.app/.well-known/oauth-authorization-server | jq
npx wrangler deployments list
```

Notes:

- The edge TLS certificate for a custom domain provisions a few minutes **after**
  deploy; connection-refused / TLS handshake failures in that window are normal.
  The `*.workers.dev` URL works immediately.
- Hitting `/authorize` with a bogus `client_id` returns a 500 — expected;
  claude.ai performs dynamic client registration first.

## Gotchas this repo already handles

These are invisible to `npm run worker:test` and to `wrangler deploy --dry-run`,
and only a real deploy or a real request exposes them:

- **`.env` load at module init.** `client.ts` wraps the dotenv load in
  `try/catch`; in the Worker `import.meta.url` is undefined and
  `fileURLToPath(undefined)` would throw during startup validation
  (`code: 10021`).
- **Pure constructor.** The module-level client singleton is constructed in
  global scope when the Worker loads, where workerd forbids I/O, timers and
  random-value generation. `SimpliSafeClient`'s constructor does none of those;
  the PKCE randomness lives inside `login()`.
- **No detached `globalThis.fetch`.** workerd requires `fetch` to be called with
  `this === globalThis`. A Workers-pool test asserts no request fails with
  "Illegal invocation".
- **`src/worker.ts` is excluded from `tsconfig.json`**, so the stdio `tsc` build
  never emits `dist/worker.js`, and from the node vitest run, which cannot load
  `cloudflare:workers`.

## Scope

The connector registers the **full** tool surface, including the two
physical-control writes. They keep their per-call `confirm: true` dry-run gate;
there is no path that bypasses it. If you'd rather expose a read-only connector,
omit `registerAlarmTools` and `registerLockTools` from the `tools` array in
`src/worker.ts` and redeploy.
