import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { createTestHarness } from '@chrischall/mcp-utils/test';
import { SimpliSafeClient } from '../src/client.js';
import { simplisafeAuth } from '../src/simplisafe-auth.js';
import { registerSystemTools } from '../src/tools/systems.js';
import { registerDeviceTools } from '../src/tools/devices.js';
import { registerEventTools } from '../src/tools/events.js';
import { registerAlarmTools } from '../src/tools/alarm.js';
import { registerLockTools } from '../src/tools/locks.js';
import { registerUtilityTools } from '../src/tools/utilities.js';

// Runs inside the real Workers runtime (Miniflare) via
// `@cloudflare/vitest-pool-workers` against wrangler.jsonc. It covers what can
// be proven without a live SimpliSafe session: the OAuth surface, the two-step
// login state machine (against the REAL OAUTH_KV binding), the tool roster as
// worker.ts wires it, and the `this`-binding trap that only workerd exhibits.

describe('SimpliSafe connector — OAuth surface', () => {
  it('serves the OAuth authorization-server discovery document', async () => {
    const res = await SELF.fetch('https://example.com/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const meta = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string };
    expect(meta.authorization_endpoint).toContain('/authorize');
    expect(meta.token_endpoint).toContain('/token');
  });

  it('rejects an unauthenticated /mcp request before any tool code runs', async () => {
    const res = await SELF.fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('does NOT block the first submit with a required, empty callback box', async () => {
    // The bug this guards: every login field is `required` by default, so an
    // empty callback box made the browser silently refuse to submit — no
    // request, no authorize URL, no explanation, and the whole two-step flow
    // unreachable. Asserts the rendered OUTCOME, not that some flag was set.
    const res = await SELF.fetch(
      'https://example.com/authorize?response_type=code&state=abc&redirect_uri=' +
        encodeURIComponent('https://example.com/callback'),
    );
    const html = await res.text();

    const callbackInput = html.match(/<input[^>]*name="callback"[^>]*>/)?.[0] ?? '';
    expect(callbackInput, 'callback input should render').not.toBe('');
    // Disabled is the load-bearing part: excluded from native validation AND
    // from submission, so an empty box cannot block step 1.
    expect(callbackInput).toContain('disabled');
    expect(callbackInput).not.toMatch(/\srequired/);

    // The email field, by contrast, is genuinely required on step 1.
    const emailInput = html.match(/<input[^>]*name="email"[^>]*>/)?.[0] ?? '';
    expect(emailInput).toMatch(/\srequired/);
  });

  it('GET /authorize renders the login page with both bootstrap fields', async () => {
    // `redirect_uri` is required: workers-oauth-provider 0.8.x validates the
    // scheme unconditionally and rejects the empty string an absent value becomes.
    const res = await SELF.fetch(
      'https://example.com/authorize?response_type=code&state=abc&redirect_uri=' +
        encodeURIComponent('https://example.com/callback'),
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('SimpliSafe');
    expect(html).toContain('email');
    expect(html).toContain('callback');
  });
});

describe('SimpliSafe connector — two-step PKCE login', () => {
  it('submission 1 stashes a verifier and answers with an authorize URL', async () => {
    // Blank callback = "start the flow". It must THROW (that is how the harness
    // renders step 2 on the page) and hand back a usable authorize URL.
    await expect(
      simplisafeAuth.login({ email: 'someone@example.com', callback: '' }, env),
    ).rejects.toThrow(/Step 1 of 2[\s\S]*auth\.simplisafe\.com\/authorize/);
  });

  it('submission 1 asks the harness to REVEAL the callback box', async () => {
    // Without revealFields the box stays hidden and disabled, so step 2 is
    // unreachable even though step 1 succeeded.
    let err: unknown;
    try {
      await simplisafeAuth.login({ email: 'someone@example.com', callback: '' }, env);
    } catch (e) {
      err = e;
    }
    expect((err as { revealFields?: string[] }).revealFields).toEqual(['callback']);
    expect((err as { fieldHints?: Record<string, string> }).fieldHints?.callback).toMatch(
      /com\.simplisafe\.mobile/,
    );
  });

  it('keeps the callback box revealed on EVERY submission-2 failure', async () => {
    // A re-render hides a revealOnDemand field unless the rejection names it, so
    // a failed retry would hide the box the user needs to fix — the same
    // stranding as the required-empty-box bug, but only without JS.
    const state = crypto.randomUUID();
    await env.OAUTH_KV.put(`ss_bootstrap:${state}`, 'seededverifier123', { expirationTtl: 900 });

    const failures: Record<string, string> = {
      unparseable: 'this is not a url at all',
      'no state': 'com.simplisafe.mobile://cb?code=abc123',
      'unknown handle': 'com.simplisafe.mobile://cb?code=abc&state=00000000-0000-0000-0000-000000000000',
      'rejected code': `com.simplisafe.mobile://cb?code=bogus&state=${state}`,
    };

    for (const [label, callback] of Object.entries(failures)) {
      let err: unknown;
      try {
        await simplisafeAuth.login({ email: 'a@example.com', callback }, env);
      } catch (e) {
        err = e;
      }
      expect(err, `${label} should reject`).toBeDefined();
      expect((err as { revealFields?: string[] }).revealFields, label).toEqual(['callback']);
      // Still a real error, not a silent prompt: the harness only suppresses its
      // generic fallback for an EMPTY message.
      expect((err as Error).message, label).not.toBe('');
    }
  });

  it('the stashed handle is a PKCE verifier only — never a credential', async () => {
    let authorizeUrl = '';
    try {
      await simplisafeAuth.login({ email: 'someone@example.com', callback: '' }, env);
    } catch (err) {
      authorizeUrl = (err as Error).message;
    }

    const state = authorizeUrl.match(/[?&]state=([^&\s]+)/)?.[1];
    expect(state).toBeTruthy();

    const stored = await env.OAUTH_KV.get(`ss_bootstrap:${state}`);
    expect(stored).toBeTruthy();
    // A bare PKCE verifier: alphanumeric, and useless without the code.
    expect(stored).toMatch(/^[A-Za-z0-9]+$/);
    expect(stored).not.toContain('someone@example.com');
  });

  it('refuses a callback URL with no state rather than guessing', async () => {
    await expect(
      simplisafeAuth.login(
        { email: 'a@example.com', callback: 'com.simplisafe.mobile://cb?code=abc123' },
        env,
      ),
    ).rejects.toThrow(/no "state" parameter/);
  });

  it('refuses an unknown or expired handle', async () => {
    await expect(
      simplisafeAuth.login(
        {
          email: 'a@example.com',
          callback: 'com.simplisafe.mobile://cb?code=abc123&state=00000000-dead-beef-0000-000000000000',
        },
        env,
      ),
    ).rejects.toThrow(/expired or was already used/);
  });

  it('deletes the handle on use, so a code cannot be replayed', async () => {
    // Seed a handle directly, then burn it with a (bogus) code. The exchange
    // will fail upstream, but the handle must be gone either way — otherwise a
    // captured callback URL could be replayed.
    const state = crypto.randomUUID();
    await env.OAUTH_KV.put(`ss_bootstrap:${state}`, 'seededverifier123', {
      expirationTtl: 900,
    });

    await expect(
      simplisafeAuth.login(
        { email: 'a@example.com', callback: `com.simplisafe.mobile://cb?code=bogus&state=${state}` },
        env,
      ),
    ).rejects.toThrow();

    expect(await env.OAUTH_KV.get(`ss_bootstrap:${state}`)).toBeNull();
  });

  it('never echoes the authorization code back into an error message', async () => {
    const state = crypto.randomUUID();
    await env.OAUTH_KV.put(`ss_bootstrap:${state}`, 'seededverifier123', { expirationTtl: 900 });

    const code = 'SUPERSECRETCODEVALUE';
    let message = '';
    try {
      await simplisafeAuth.login(
        { email: 'a@example.com', callback: `com.simplisafe.mobile://cb?code=${code}&state=${state}` },
        env,
      );
    } catch (err) {
      message = (err as Error).message;
    }
    // Asserts the OUTCOME (the secret is absent), not that some sanitizer was
    // called — a mechanism assertion would pass while still leaking.
    expect(message).not.toContain(code);
    expect(message).not.toContain('seededverifier123');
  });
});

describe('SimpliSafe connector — runtime safety', () => {
  it('constructs the client in the Workers runtime without a global-scope violation', () => {
    // The module-singleton client is built in global scope when the Worker's
    // module graph loads; a constructor doing I/O, timers or random-value
    // generation there fails deploy-time startup validation (code 10021).
    expect(() => new SimpliSafeClient({ refreshToken: 'test-token' })).not.toThrow();
  });

  it('does not call a DETACHED globalThis.fetch', async () => {
    // workerd requires `fetch` to be invoked with `this === globalThis`; a client
    // storing it as a property and calling it detached throws "Illegal
    // invocation" on every request. Node has no such rule, so the entire node
    // suite passes while the deployed connector can fetch nothing.
    //
    // The request itself may fail (no network egress in CI) — what matters is
    // that it never fails for THAT reason.
    const client = new SimpliSafeClient({ refreshToken: 'test-token' });
    let reason = '';
    try {
      await client.getUserId();
    } catch (err) {
      reason = (err as Error).message;
    }
    expect(reason).not.toMatch(/illegal invocation/i);
  });
});

describe('SimpliSafe connector — tool surface', () => {
  it('registers the full tool set via the same wiring as worker.ts', async () => {
    const client = new SimpliSafeClient({ refreshToken: 'test-token' });

    // Mirror src/worker.ts's `tools` array exactly (same order, same wiring).
    const harness = await createTestHarness((server) => {
      registerSystemTools(server, client);
      registerDeviceTools(server, client);
      registerEventTools(server, client);
      registerAlarmTools(server, client);
      registerLockTools(server, client);
      registerUtilityTools(server, client);
    });

    try {
      const names = (await harness.listTools()).map((t) => t.name).sort();
      expect(names).toEqual([
        'simplisafe_get_events',
        'simplisafe_get_pins',
        'simplisafe_get_settings',
        'simplisafe_get_system',
        'simplisafe_healthcheck',
        'simplisafe_list_locks',
        'simplisafe_list_sensors',
        'simplisafe_list_systems',
        'simplisafe_set_alarm_state',
        'simplisafe_set_lock_state',
      ]);
    } finally {
      await harness.close();
    }
  });
});
