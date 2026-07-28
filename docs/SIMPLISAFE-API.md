# SimpliSafe API — verified request/response shapes

Everything here was captured from **live requests against a real account on
2026-07-28**, not from documentation or inference. SimpliSafe publishes no public
API; this is the same surface the iOS app uses.

No captured cookies, tokens, authorization codes or PINs appear in this file.

## Hosts

| Host | Purpose |
| --- | --- |
| `auth.simplisafe.com` | Auth0 tenant — authorize + token endpoints |
| `api.simplisafe.com/v1` | The API itself |

Both are reachable **server-side**. There is no bot wall on either, so this
integration needs no browser bridge at runtime — plain `fetch`/`curl` works.

## Authentication — OAuth2 authorization code + PKCE

The mobile client is a **public PKCE client**: no client secret.

```
client_id     42aBZ5lYrVW12jfOuu3CQROitwxg9sN5
redirect_uri  com.simplisafe.mobile://auth.simplisafe.com/ios/com.simplisafe.mobile/callback
scope         offline_access email openid https://api.simplisafe.com/scopes/user:platform
audience      https://api.simplisafe.com/
```

Probe evidence that the client identity is still accepted (2026-07-28):

- `GET /authorize?...` → `302` to `/u/login/identifier` (a rejected client would
  answer `unauthorized_client` instead).
- `POST /oauth/token` with a deliberately bogus code → `403
  {"error":"invalid_grant","error_description":"Invalid authorization code"}` —
  it reached *code* validation, so the client was accepted.

### Authorization code exchange

```http
POST https://auth.simplisafe.com/oauth/token
Content-Type: application/json

{ "grant_type": "authorization_code",
  "client_id": "42aBZ5lYrVW12jfOuu3CQROitwxg9sN5",
  "code_verifier": "<verifier>",
  "code": "<code>",
  "redirect_uri": "com.simplisafe.mobile://auth.simplisafe.com/ios/com.simplisafe.mobile/callback" }
```

Response: `{ access_token, refresh_token, id_token, expires_in: 3600, token_type: "Bearer", scope }`

The redirect URI is a **custom scheme that no browser can follow**, which is the
point: the browser fails to navigate and the code sits in the failed URL for the
human to copy. There is no `http://localhost` alternative — the allowed callbacks
live in SimpliSafe's Auth0 tenant and cannot be changed.

### Refresh — and the rotation question

```http
POST https://auth.simplisafe.com/oauth/token
{ "grant_type": "refresh_token", "client_id": "<client_id>", "refresh_token": "<token>" }
```

**Verified: SimpliSafe does NOT rotate refresh tokens.** The response contains
`access_token, id_token, scope, expires_in, token_type` and **no `refresh_token`
field at all**, so the bootstrap token stays valid indefinitely.

This single fact decides the architecture:

- the browser login is a **one-time bootstrap**, never repeated;
- the server refreshes headlessly, with no MFA prompt and no human;
- a **hosted connector is viable**, because a stable refresh token can live in
  encrypted OAuth props (a rotating one would need writable per-user storage).

The client still adopts a `refresh_token` if one ever appears, so enabling
rotation upstream would not silently strand it.

Errors are `403 {"error":"invalid_grant", ...}` — note **403, not 401**.

## API endpoints

All take `Authorization: Bearer <access_token>`.

### `GET /v1/api/authCheck`

```json
{ "userId": 6973059, "isAdmin": false }
```

The only way to learn the user id, which the subscriptions route needs.

### `GET /v1/users/{userId}/subscriptions?activeOnly=true`

```json
{ "subscriptions": [ { "sid": 7858153, "planName": "...", "location": { ... } } ] }
```

System state is **nested three deep** at `location.system`:

| Field | Notes |
| --- | --- |
| `alarmState` | `OFF` / `HOME` / `AWAY` / `HOME_COUNT` / `AWAY_COUNT` / `ALARM` … |
| `version` | `3` for SS3. **This is the routing key**, and it is at `location.system.version` — the top-level `systemVersion` is a different number (`20` on the test account) and must not be used for routing. |
| `isAlarming`, `isOffline`, `powerOutage`, `connType`, `temperature`, `exitDelayRemaining`, `messages` | |

### `GET /v1/ss3/subscriptions/{sid}/sensors?forceUpdate=false`

`{ "sensors": [ ... ] }`. Each: `serial`, `type`, `name`, `flags{offline,lowBattery,…}`,
`status{}`, `rssi`, `firmwareVersion`.

`forceUpdate=true` makes the base station re-poll its devices — slower and
heavier on the hardware, so it stays opt-in.

Device type ids observed live: `1, 2, 5, 6, 13, 16, 20, 21, 23, 24, 253`.
**21, 23 and 24 are not in the reference client's enum**, so any consumer must
degrade gracefully rather than assume total coverage. (24 carries
`smokeTriggered` / `coTriggered` / `tamper` / `endOfLife`, so it is a smoke-CO
combo of some generation.)

### Lock records (`type: 16`)

```json
{ "status": { "lockState": 2, "lockJamState": 0, "lockLowBattery": false,
              "pinPadOffline": false, "pinPadState": 0 } }
```

**`lockState` 1 = LOCKED, 2 = UNLOCKED.** Counter-intuitive, and inverting it
would flip every lock reading. `lockJamState` takes precedence over both.

### `GET /v1/ss3/subscriptions/{sid}/settings/normal?forceUpdate=false`

```json
{ "settings": { "normal": { ... }, "pins": { ... } },
  "basestationStatus": { "wifiRssi": -52, "wallPower": 6464, "backupBattery": ..., "rfJamming": ... },
  "lastUpdated": "..." }
```

`settings.normal` holds `entryDelayHome/Away`, `exitDelayHome/Away`,
`alarmVolume`, `alarmDuration`, `doorChime`, `voicePrompts`, `wifiSSID`, …

> **`settings.pins` returns the alarm PINs in cleartext** — master, duress and
> every named user. It rides along in the same payload as the harmless settings,
> so any projection of this endpoint must deliberately exclude it. In this server
> `simplisafe_get_settings` projects `settings.normal` only, and the PIN block is
> reachable solely through the separately confirm-gated `simplisafe_get_pins`.

### `GET /v1/subscriptions/{sid}/events?numEvents=N&fromTimestamp=T`

**Not under the `ss3/` prefix** — the one system route that isn't. Returns
`{ "events": [...] }`, newest first, with `eventTimestamp` in **seconds**.

**`numEvents` has a hard ceiling of 50.** Established by bisection against the
live API on 2026-07-28: `50` returns 50 events, while `51`, `75`, `99`, `100`,
`101` and `200` all return
`400 {"errorType":"InvalidParameter","param":"numEvents"}`. This is not
documented anywhere; page with `fromTimestamp` to go further back.

## Writes

### Arm / disarm

```http
POST /v1/ss3/subscriptions/{sid}/state/{off|home|away}
```

No request body. Arming is **not instantaneous**: the system reports
`HOME_COUNT` / `AWAY_COUNT` while the exit delay runs (60 s away / 0 s home on
the test account), settling to `HOME` / `AWAY`. Treating the `_COUNT` state as a
failure would make every successful arm look broken.

### Lock / unlock

```http
POST /v1/doorlock/{sid}/{serial}/state
{ "state": "lock" | "unlock" }
```

Also **not under `ss3/`**, and the serial is a path segment.

### Arming AUTO-LOCKS the doors — and disarming does not undo it

Each lock carries a `setting` block that ties it to the alarm state:

```json
{ "home": 1, "away": 1, "homeToOff": 0, "awayToOff": 1, "autoLock": 0 }
```

- `home` / `away` — **lock this door when the system is armed to that mode**
- `homeToOff` / `awayToOff` — unlock it again when disarmed *from* that mode

On the test system all three locks had `home: 1, away: 1, homeToOff: 0`.
Observed live: arming to `home` locked all three doors, and disarming left them
locked, because `homeToOff` is `0`.

Two consequences worth designing around:

1. **Arming is a door-locking operation**, not only an alarm operation. Any
   warning shown before arming should say so.
2. **The round trip is not symmetric.** "Arm then disarm" does NOT restore the
   previous lock state, so it is not a safe way to test arming.

### Verifying a write

A `2xx` is not proof. Re-read and compare **`alarmState`** (arm/disarm) or
**`lockState`/`lockJamState`** (locks) — one field each, chosen because they
actually settle the question.

Do **not** diff whole objects: `alarmStateTimestamp`, `stateUpdated` and
`lastUpdated` advance on their own, so including them makes every call report
success no matter what happened.

**Re-read with `forceUpdate=true`.** The cached sensor payload lags by minutes.
During live testing a cached read reported a lock as cleanly `unlocked` while a
fresh poll of the same lock reported `lockJamState: 1` — so a verification built
on the cached read produced a confident "restored to baseline" for a lock that
had in fact jammed. Verifying against a cache is not verifying.

**Poll; don't sleep once.** A deadbolt takes time to travel. Live measurements
put a successful lock/unlock at **~5 s** to report, so a single 3 s delay
reported a *successful* unlock as unconfirmed. Poll every ~2.5 s up to ~15 s and
stop on either the expected state or a jam.

The alarm state settles much faster (confirmed at 2.5 s), but arming to `away`
sits at `AWAY_COUNT` for the 60 s exit delay first.

## Status of live verification

| Surface | Status |
| --- | --- |
| Auth: authorize, code exchange, refresh, rotation behaviour | **Verified live** |
| All read endpoints above | **Verified live** through the built client |
| `settings.pins` exclusion from `get_settings` | **Verified live** against the real payload |
| Confirm gates (no request without `confirm: true`) | **Verified live** |
| `POST .../state/{off,home,away}` | **Verified live** — `home` → `HOME`, `off` → `OFF`; returns `{"state":"HOME","stateUpdated":…,"exitDelay":0}` |
| `POST /doorlock/.../state` | **Verified live** — `lock` → `locked`, `unlock` → `unlocked`, each confirmed ~5 s later. Returns **HTTP 200 with an empty body** (`content-length: 0`), so there is nothing to parse |
| Arming auto-locks doors (`home`/`away` lock settings) | **Observed live** |
| `numEvents` ceiling of 50 | **Verified by bisection** |

Both write rows were exercised against a real system with the account owner's
explicit consent, sequenced to restore the prior state.

One field-report worth keeping: a lock that reports `lockJamState: 1` does not
respond to lock commands at all — the POST returns `200`, no event of success
follows, and the state never changes. On the test system this was a
**pre-existing hardware fault** on two of three locks, not something the API
caused. Any client must therefore treat "200 + state unchanged" as a plausible
hardware condition rather than a bug in its own request shape.
