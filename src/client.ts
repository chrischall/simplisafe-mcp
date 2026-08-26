import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  loadDotenvSafely,
  readEnvVar,
  createApiClient,
  McpToolError,
  truncateErrorMessage,
  type ApiClient,
} from '@chrischall/mcp-utils';
import { TokenManager } from '@chrischall/mcp-utils/session';
import { createTokenCache, failOnCacheWriteError } from './token-cache.js';

// Load .env for local dev; silently skip if dotenv is unavailable (e.g. the
// .mcpb bundle). The try/catch guards a non-Node runtime, where
// `import.meta.url` is undefined and `fileURLToPath(undefined)` would throw at
// module init — that throw fails startup validation in such a runtime, and
// a Node test run does not catch it. There is no filesystem there anyway.
try {
  const dir = dirname(fileURLToPath(import.meta.url));
  await loadDotenvSafely({ path: join(dir, '..', '.env'), override: false });
} catch {
  /* non-Node runtime (Workers): no .env to load */
}

const API_BASE_URL = 'https://api.simplisafe.com/v1';
const AUTH_TOKEN_URL = 'https://auth.simplisafe.com/oauth/token';
const SERVICE_NAME = 'SimpliSafe';

/**
 * SimpliSafe's public iOS OAuth client. Verified live 2026-07-28: the authorize
 * endpoint accepts this client_id, and /oauth/token accepts both the
 * authorization_code (PKCE, no client secret) and refresh_token grants.
 */
export const CLIENT_ID = '42aBZ5lYrVW12jfOuu3CQROitwxg9sN5';

/** Shape of the /oauth/token response we depend on. */
interface TokenResponse {
  access_token: string;
  expires_in: number;
  /**
   * SimpliSafe does NOT rotate refresh tokens — verified live 2026-07-28: a
   * refresh_token-grant response carries no `refresh_token` field at all, so the
   * bootstrap token stays valid indefinitely. It is typed optional anyway so
   * that if SimpliSafe ever enables Auth0 rotation, TokenManager adopts the new
   * token instead of silently reusing a dead one.
   */
  refresh_token?: string;
}

export interface SimpliSafeSystemSummary {
  sid: number;
  systemVersion: number;
  raw: Record<string, unknown>;
}

/**
 * Client for the SimpliSafe cloud API.
 *
 * Auth is a one-time browser OAuth2/PKCE bootstrap (`scripts/bootstrap-auth.mjs`)
 * that yields a long-lived refresh token; from then on the client mints access
 * tokens headlessly. No browser, no bridge, no MFA prompt at runtime — which is
 * also what makes hosting this service viable at all.
 */
export class SimpliSafeClient {
  private readonly refreshToken: string | null;
  private readonly configError: Error | null;
  private readonly api: ApiClient;
  private readonly tokens: TokenManager | null;
  private userIdPromise: Promise<number> | null = null;

  /**
   * Defer the config error so the server still boots (and answers the host's
   * install-time tools/list probe) when SIMPLISAFE_REFRESH_TOKEN is absent — the
   * error surfaces on the first tool call instead.
   *
   * The optional `refreshToken` seam lets a hosted deployment build one client
   * per authenticated user; the stdio path passes nothing and resolves from env
   * exactly as before.
   *
   * The constructor is deliberately PURE — no fetch, no timers, no random values.
   * A module-level singleton is constructed in global scope when the module
   * graph loads, and sandboxed runtimes forbid all three there — a violation
   * fails startup validation rather than a request.
   */
  constructor(opts?: { refreshToken?: string }) {
    const token = opts?.refreshToken ?? readEnvVar('SIMPLISAFE_REFRESH_TOKEN');

    if (!token) {
      this.refreshToken = null;
      this.tokens = null;
      this.configError = new McpToolError(
        'SIMPLISAFE_REFRESH_TOKEN is not set.',
        {
          hint:
            'Run the one-time browser login to mint one: `node scripts/bootstrap-auth.mjs`, ' +
            'then re-run it with the com.simplisafe.mobile:// callback URL it tells you to copy.',
        },
      );
    } else {
      this.refreshToken = token;
      this.configError = null;
      const cache = createTokenCache();
      this.tokens = new TokenManager({
        // The FUNCTION form, so a cached pair is consulted before the env token
        // is used at all — the eager object form skips persistence entirely.
        // The fallback is the old behaviour: no access token and an expiry in
        // the past, so the first request triggers a refresh. TokenManager
        // coalesces a concurrent burst onto a single in-flight exchange.
        initial: async () => ({ accessToken: '', refreshToken: token, expiresAt: 0 }),
        refresh: (rt) => this.exchangeRefreshToken(rt),
        persistence: cache ?? undefined,
        // The bootstrap IS the env refresh token, so re-running it after a
        // failed refresh retries the exact exchange that just failed — and
        // burns a second call against a token the service has likely revoked.
        // Without this the revoked-token path exchanged twice.
        isRefreshRevoked: () => false,
        // Fatal rather than reported — see failOnCacheWriteError for why the
        // asymmetry favours failing loudly here.
        onPersistError: failOnCacheWriteError,
      });
    }

    this.api = createApiClient({
      baseUrl: API_BASE_URL,
      // Routing through the TokenManager gives proactive refresh inside the skew
      // window plus exactly one reactive replay on a 401.
      ...(this.tokens ? { tokenManager: this.tokens } : { getToken: () => this.requireAuth() }),
      serviceName: SERVICE_NAME,
      retry: { count: 1, delayMs: 2000 },
      timeout: 30_000,
      onUnauthorized: () =>
        new McpToolError('SimpliSafe rejected the credentials (HTTP 401).', {
          hint:
            'The refresh token may have been revoked — signing out of all devices in the ' +
            'SimpliSafe app invalidates it. Re-run `node scripts/bootstrap-auth.mjs` to mint a new one.',
        }),
      onRateLimited: () =>
        new McpToolError('Rate limited by the SimpliSafe API.', {
          hint: 'Wait a few seconds and retry; avoid tight polling loops.',
        }),
    });
  }

  /** Exchange the refresh token for a fresh access token. */
  private async exchangeRefreshToken(refreshToken: string) {
    const res = await fetch(AUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      // The body echoes no secret, but route it through the truncator anyway so
      // an unexpected upstream payload can't dump a token into a tool result.
      const detail = truncateErrorMessage(await res.text().catch(() => ''));
      throw new McpToolError(
        `SimpliSafe token refresh failed (HTTP ${res.status}): ${detail}`,
        {
          hint:
            'If this says "Unknown or invalid refresh token", the token was revoked — ' +
            're-run `node scripts/bootstrap-auth.mjs`.',
        },
      );
    }

    const data = (await res.json()) as TokenResponse;
    return {
      accessToken: data.access_token,
      // Omitted when SimpliSafe returns no new token, which keeps the current one.
      ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
      expiresAt: Date.now() + data.expires_in * 1000,
    };
  }

  private requireAuth(): string {
    if (this.configError) throw this.configError;
    return this.refreshToken!;
  }

  /** Raw request helper. Every call in this client funnels through it. */
  async request<T>(
    method: string,
    path: string,
    opts?: { body?: unknown; query?: Record<string, string | number | undefined> },
  ): Promise<T> {
    if (this.configError) throw this.configError;

    let url = path;
    if (opts?.query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    }

    return this.api.fetchJson<T>(method, url, opts?.body !== undefined ? { body: opts.body } : {});
  }

  /**
   * Every mutating call routes through here, so the confirm gate in the tool
   * layer has exactly one bypass-proof choke point beneath it.
   */
  async write<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body !== undefined ? { body } : undefined);
  }

  /** The authenticated user's id, resolved once and cached for the process. */
  async getUserId(): Promise<number> {
    if (this.configError) throw this.configError;
    // Cache the promise, not the value, so a concurrent burst issues one call.
    this.userIdPromise ??= this.request<{ userId: number }>('GET', '/api/authCheck')
      .then((r) => r.userId)
      .catch((err: unknown) => {
        this.userIdPromise = null; // don't cache a failure
        throw err;
      });
    return this.userIdPromise;
  }

  /** Active subscriptions (one per monitored location), raw from the API. */
  async listSubscriptions(): Promise<Record<string, unknown>[]> {
    const userId = await this.getUserId();
    const res = await this.request<{ subscriptions?: Record<string, unknown>[] }>(
      'GET',
      `/users/${userId}/subscriptions`,
      { query: { activeOnly: 'true' } },
    );
    return res.subscriptions ?? [];
  }

  /**
   * Resolve which system to act on.
   *
   * With one system (the common case) `sid` is optional. With several, an
   * ambiguous call is an ERROR rather than a guess — picking the wrong one would
   * arm or disarm the wrong building.
   */
  async resolveSystem(sid?: number): Promise<SimpliSafeSystemSummary> {
    const subs = await this.listSubscriptions();

    if (subs.length === 0) {
      throw new McpToolError('No active SimpliSafe systems found on this account.', {
        hint: 'Confirm the account has an active monitoring subscription.',
      });
    }

    const summarize = (sub: Record<string, unknown>): SimpliSafeSystemSummary => {
      const location = (sub.location ?? {}) as Record<string, unknown>;
      const system = (location.system ?? {}) as Record<string, unknown>;
      return {
        sid: Number(sub.sid),
        systemVersion: Number(system.version ?? 0),
        raw: sub,
      };
    };

    if (sid === undefined) {
      if (subs.length > 1) {
        const ids = subs.map((s) => Number(s.sid)).join(', ');
        throw new McpToolError(
          `This account has ${subs.length} systems (${ids}); \`sid\` is required to disambiguate.`,
          { hint: 'Call simplisafe_list_systems and pass the sid you mean.' },
        );
      }
      return summarize(subs[0]!);
    }

    const match = subs.find((s) => Number(s.sid) === sid);
    if (!match) {
      const ids = subs.map((s) => Number(s.sid)).join(', ');
      throw new McpToolError(`No active system with sid ${sid} (have: ${ids}).`, {
        hint: 'Call simplisafe_list_systems for the current list.',
      });
    }
    return summarize(match);
  }

  /**
   * Guard the SS3-only routes. The `ss3/` paths 404 on a legacy SS2 base
   * station, so fail with an explanation rather than an opaque upstream error.
   */
  assertV3(system: SimpliSafeSystemSummary, feature: string): void {
    if (system.systemVersion !== 3) {
      throw new McpToolError(
        `${feature} requires a SimpliSafe 3 system; sid ${system.sid} reports version ${system.systemVersion}.`,
        { hint: 'This server implements the SS3 API surface only.' },
      );
    }
  }
}

/**
 * Module-level singleton shared by every tool module. Constructing it here (not
 * in index.ts) preserves the deferred-config-error pattern: the server boots and
 * answers the host's install-time tools/list smoke test even with no refresh
 * token — the error only surfaces on the first request.
 */
export const client = new SimpliSafeClient();
