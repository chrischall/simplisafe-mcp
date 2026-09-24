# simplisafe-mcp

MCP server for [SimpliSafe](https://simplisafe.com) home security. Check whether
the system is armed, review sensors and events, arm/disarm, and control smart
locks — from Claude.

> **This server can disarm a home alarm and unlock doors.** Every tool that
> changes physical state, plus the tool that reads alarm PINs, asks you to confirm
> first — nothing is sent until you do, and you see a preview of exactly what
> would happen (see [Confirmations](#confirmations)). Install it only where you'd
> be comfortable with that capability.

Developed and maintained by AI (Claude Code).

## What you get

| Tool | |
| --- | --- |
| `simplisafe_list_systems` | Systems on the account with current alarm state |
| `simplisafe_get_system` | One system's state, connectivity, base-station messages |
| `simplisafe_list_sensors` | Sensors with battery / offline / triggered status, filterable |
| `simplisafe_list_locks` | Smart locks with locked / unlocked / jammed state |
| `simplisafe_get_events` | Recent base-station events (arm, disarm, opens, alarms) |
| `simplisafe_get_settings` | Entry/exit delays, volumes, base-station health |
| `simplisafe_get_pins` | Alarm PINs — **cleartext, asks you to confirm first** |
| `simplisafe_set_alarm_state` | Arm home / arm away / disarm — **asks you to confirm first** |
| `simplisafe_set_lock_state` | Lock / unlock a door — **asks you to confirm first** |
| `simplisafe_healthcheck` | Auth + API reachability |

Supports **SimpliSafe 3** systems. Legacy SS2 systems are rejected with an
explanation rather than an opaque upstream 404.

## Install

```bash
npm install -g simplisafe-mcp
```

Or add to `.mcp.json`:

```json
{
  "mcpServers": {
    "simplisafe": {
      "command": "npx",
      "args": ["-y", "simplisafe-mcp"],
      "env": { "SIMPLISAFE_REFRESH_TOKEN": "${SIMPLISAFE_REFRESH_TOKEN}" }
    }
  }
}
```

## Authentication — one browser login, once

SimpliSafe issues no API keys. The credential is an OAuth2 refresh token, minted
by a browser login you perform **one time**:

```bash
git clone https://github.com/chrischall/simplisafe-mcp && cd simplisafe-mcp
node scripts/bootstrap-auth.mjs             # prints an authorize URL
# sign in (MFA included), then copy the com.simplisafe.mobile:// URL
node scripts/bootstrap-auth.mjs "<that URL>"
```

The token is written to `.env` (mode 0600) after being verified against the live
API. **SimpliSafe does not rotate refresh tokens**, so it stays valid until you
sign out of all devices in the SimpliSafe app — which is how you revoke it.

Capturing the code: open DevTools → Network and tick **Preserve log** *before*
signing in; afterwards the browser fails to open a `com.simplisafe.mobile://…`
link, and that failed entry's link address is what you paste. The code is
single-use and expires in about two minutes.

Treat the resulting token like a house key: it grants full control of the alarm.

## Confirmations

Arming, disarming, locking, unlocking and reading the PINs all ask you to
confirm first. On a client that can show a confirmation prompt (Claude Code) you
get the prompt, with the details below. On one that cannot (claude.ai, Claude
Desktop) the first call sends **nothing** and returns a preview plus a
`confirmToken`; only a repeat call with that token acts, once. The preview
includes a plain statement of the physical consequence:

```json
{
  "status": "confirmation-required",
  "confirmed": false,
  "dispatched": false,
  "action": "alarm.set_state",
  "preview": {
    "action": "set alarm state to away",
    "method": "POST",
    "path": "/ss3/subscriptions/7858153/state/away",
    "sid": 7858153,
    "locationName": "Home",
    "currentState": "OFF",
    "requestedState": "AWAY",
    "warning": "Arms ALL sensors including interior motion. Starts an exit delay; anyone still moving inside when it expires can trigger the siren and a monitoring-center dispatch."
  },
  "confirmToken": "…",
  "expiresAt": "…",
  "ttlSeconds": 600,
  "instruction": "Show this preview to the user verbatim and proceed only after they explicitly approve in chat. Then call again with confirmToken."
}
```

The token is bound to that tool, target and preview. The system is re-read on
the second call, and if what would happen no longer matches what you approved —
different arguments, or the alarm or lock state moved in between — it is
refused (`DRAFT_CHANGED`) with a fresh preview. A token that was already used is
refused too (`TOKEN_REUSED`).

| variable | default | |
|---|---|---|
| `MCP_CONFIRM_MODE` | `ask-user` | What a write does on a client that cannot show a confirmation prompt (claude.ai, Claude Desktop). `ask-user`: two steps — the first call does nothing and returns a preview plus a token, and the model must get your approval in chat before calling again with it. `auto`: the same two steps, but the model may use the token after reviewing the preview itself. `refuse`: writes are refused on such clients. A client that can show prompts (Claude Code) always gets the real prompt. An unrecognised value is treated as `refuse`. |
| `MCP_CONFIRM_TTL_SECONDS` | `600` | How long a token stays valid. |
| `MCP_CONFIRM_SECRET` | random per process | Signing key; set it only if tokens must survive a server restart. |

### Writes are verified

Once confirmed, a write executes and then **re-reads the system** to check what
actually happened, reporting `confirmed`, `in_progress` (the exit delay is
counting down), or `unconfirmed`. A `2xx` is never treated as proof.

## Shell access without the server

For quick one-off queries there's a `curl`-based skill in
[`skills/simplisafe-api/`](skills/simplisafe-api/SKILL.md) — same API, no MCP
process, sharing the same refresh token.

## Development

```bash
npm install
npm run build
npm test
```

Verified endpoint shapes live in
[docs/SIMPLISAFE-API.md](docs/SIMPLISAFE-API.md), including several things that
are easy to get backwards:

- lock state is encoded **1 = locked, 2 = unlocked**;
- system version for routing is at `location.system.version`, not the top-level
  `systemVersion`;
- events and doorlock control are **not** under the `ss3/` prefix;
- `numEvents` has an undocumented hard ceiling of **50**;
- `settings.pins` returns alarm codes in cleartext alongside harmless settings.

## Disclaimer

Unofficial. Not affiliated with or endorsed by SimpliSafe. It uses the same
private API the SimpliSafe mobile app uses, with your own account credentials.
Use at your own discretion.

## License

MIT
