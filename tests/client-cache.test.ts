import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SimpliSafeClient } from '../src/client.js';

/**
 * The wiring test the unit suites cannot be.
 *
 * `tests/token-cache.test.ts` drives `createTokenCache()` standalone, and the
 * rest of the suite runs with `SIMPLISAFE_TOKEN_CACHE=false` — so the seam
 * BETWEEN the client's TokenManager and the cache was never exercised at all.
 *
 * That seam is one line, and it is quietly breakable: `initial:` must stay the
 * FUNCTION form, because TokenManager consults persistence only when it has to
 * call the bootstrap — hand it the eager object and it never reads the cache.
 * Nothing in a unit test notices; every assertion still passes while the cache
 * silently stops working. These tests fail if that line changes.
 *
 * Turning the cache ON here is what guard #2 in tests/_setup.ts exists for: the
 * path is already pinned into a temp dir, and guard #3 fails the suite if $HOME
 * is touched regardless.
 */

let dir: string;
const SEED = 'rt-seed-1';

const tokenResponse = (accessToken: string, refreshToken = SEED): Response =>
  new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      token_type: 'Bearer',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );

const authCheck = (): Response =>
  new Response(JSON.stringify({ userId: 42 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** Route the two hosts the client talks to, and record every call. */
function stubFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
    const url = String(input);
    if (url.includes('/oauth/token')) return tokenResponse('access-minted');
    if (url.includes('authCheck')) return authCheck();
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const tokenCalls = (spy: ReturnType<typeof stubFetch>): unknown[][] =>
  spy.mock.calls.filter((c) => String(c[0]).includes('/oauth/token'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'simplisafe-wiring-'));
  // Overrides _setup.ts's beforeEach, which runs first (setupFiles register
  // ahead of a file's own hooks).
  process.env.SIMPLISAFE_TOKEN_CACHE = 'true';
  process.env.SIMPLISAFE_TOKEN_FILE = join(dir, 'token.json');
  process.env.SIMPLISAFE_REFRESH_TOKEN = SEED;
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SIMPLISAFE_REFRESH_TOKEN;
});

describe('client + token cache, wired together', () => {
  it('persists the minted pair on the first refresh', async () => {
    const spy = stubFetch();
    await new SimpliSafeClient().getUserId();

    expect(tokenCalls(spy)).toHaveLength(1);
    const path = process.env.SIMPLISAFE_TOKEN_FILE!;
    expect(existsSync(path)).toBe(true);
    // The minted ACCESS token is what a later process needs; the seed alone
    // would leave it refreshing on every start.
    expect(readFileSync(path, 'utf8')).toContain('access-minted');
  });

  it('restores from the cache instead of exchanging again', async () => {
    const first = stubFetch();
    await new SimpliSafeClient().getUserId();
    expect(tokenCalls(first)).toHaveLength(1);
    vi.restoreAllMocks();

    // A second process, same credentials: the cached access token is still
    // inside its expiry window, so there is nothing to exchange.
    const second = stubFetch();
    await new SimpliSafeClient().getUserId();

    expect(tokenCalls(second)).toHaveLength(0);
    const apiCall = second.mock.calls.find((c) => String(c[0]).includes('authCheck'));
    const headers = (apiCall?.[1] as { headers?: Record<string, string> })?.headers ?? {};
    // Not just "no refresh happened" — the RESTORED token is the one on the
    // wire. A manager that skipped the exchange but sent an empty bearer would
    // pass the count assertion and fail every real request.
    expect(headers.Authorization).toBe('Bearer access-minted');
  });

  it('exchanges again after the bootstrap token is rotated', async () => {
    stubFetch();
    await new SimpliSafeClient().getUserId();
    vi.restoreAllMocks();

    // Re-running the bootstrap mints a new seed; the record is bound to the old
    // one, so it must be discarded rather than replayed against a token the
    // service has likely revoked.
    process.env.SIMPLISAFE_REFRESH_TOKEN = 'rt-seed-2';
    const after = stubFetch();
    await new SimpliSafeClient().getUserId();

    expect(tokenCalls(after)).toHaveLength(1);
  });

  it('writes nothing when the cache is disabled', async () => {
    process.env.SIMPLISAFE_TOKEN_CACHE = 'false';
    const spy = stubFetch();
    await new SimpliSafeClient().getUserId();

    expect(tokenCalls(spy)).toHaveLength(1);
    expect(existsSync(process.env.SIMPLISAFE_TOKEN_FILE!)).toBe(false);
  });
});
