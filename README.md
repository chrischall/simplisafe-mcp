# simplisafe-mcp

MCP server for [SimpliSafe](https://simplisafe.com) home security. Check whether
the system is armed, review sensors and events, arm/disarm, and control smart
locks — from Claude.

> **This server can disarm a home alarm and unlock doors.** Every tool that
> changes physical state, plus the tool that reads alarm PINs, is gated behind an
> explicit `confirm: true`. Without it, no request is sent at all and you get a
> dry-run preview of exactly what would happen. Install it only where you'd be
> comfortable with that capability.

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
| `simplisafe_get_pins` | Alarm PINs — **cleartext, confirm-gated** |
| `simplisafe_set_alarm_state` | Arm home / arm away / disarm — **confirm-gated** |
| `simplisafe_set_lock_state` | Lock / unlock a door — **confirm-gated** |
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

## Writes are gated, and verified

Calling a write tool without `confirm: true` sends **nothing** and returns a
preview, including a plain statement of the physical consequence:

```json
{
  "dryRun": true,
  "action": "set alarm state to away",
  "method": "POST",
  "path": "/ss3/subscriptions/7858153/state/away",
  "currentState": "OFF",
  "warning": "Arms ALL sensors including interior motion. Starts an exit delay; anyone still moving inside when it expires can trigger the siren and a monitoring-center dispatch.",
  "note": "Nothing was sent. Re-run with confirm: true to execute."
}
```

With `confirm: true`, the tool executes and then **re-reads the system** to check
what actually happened, reporting `confirmed`, `in_progress` (the exit delay is
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
