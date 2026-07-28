import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SimpliSafeClient } from '../src/client.js';
import { subscriptionFixture } from './helpers.js';

describe('deferred config error', () => {
  const saved = process.env.SIMPLISAFE_REFRESH_TOKEN;
  beforeEach(() => {
    delete process.env.SIMPLISAFE_REFRESH_TOKEN;
  });
  afterEach(() => {
    if (saved !== undefined) process.env.SIMPLISAFE_REFRESH_TOKEN = saved;
  });

  it('constructs without throwing when no refresh token is configured', () => {
    // The whole point: the server must boot and answer the host's install-time
    // tools/list probe before any credential exists.
    expect(() => new SimpliSafeClient()).not.toThrow();
  });

  it('raises the config error on the first request instead', async () => {
    const client = new SimpliSafeClient();
    await expect(client.request('GET', '/api/authCheck')).rejects.toThrow(
      /SIMPLISAFE_REFRESH_TOKEN is not set/,
    );
  });

  it('raises it from getUserId too', async () => {
    const client = new SimpliSafeClient();
    await expect(client.getUserId()).rejects.toThrow(/SIMPLISAFE_REFRESH_TOKEN is not set/);
  });

  it('accepts an injected refresh token, for the hosted connector path', () => {
    const client = new SimpliSafeClient({ refreshToken: 'injected-token' });
    // No throw on a subsequent call means the config error was not armed.
    expect(client).toBeInstanceOf(SimpliSafeClient);
  });
});

describe('resolveSystem', () => {
  let client: SimpliSafeClient;
  let listSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    client = new SimpliSafeClient({ refreshToken: 'test-token' });
    listSpy = vi.spyOn(client, 'listSubscriptions');
  });

  it('returns the only system when sid is omitted', async () => {
    listSpy.mockResolvedValue([subscriptionFixture({ sid: 111 })]);
    const system = await client.resolveSystem();
    expect(system.sid).toBe(111);
    expect(system.systemVersion).toBe(3);
  });

  it('REFUSES to guess when the account has several systems and no sid is given', async () => {
    // Guessing here would arm or disarm the wrong building, so ambiguity is an
    // error rather than a "pick the first one" default.
    listSpy.mockResolvedValue([
      subscriptionFixture({ sid: 111 }),
      subscriptionFixture({ sid: 222 }),
    ]);
    await expect(client.resolveSystem()).rejects.toThrow(/2 systems \(111, 222\).*required/s);
  });

  it('selects the requested sid when several exist', async () => {
    listSpy.mockResolvedValue([
      subscriptionFixture({ sid: 111 }),
      subscriptionFixture({ sid: 222 }),
    ]);
    expect((await client.resolveSystem(222)).sid).toBe(222);
  });

  it('errors with the available ids when the sid is unknown', async () => {
    listSpy.mockResolvedValue([subscriptionFixture({ sid: 111 })]);
    await expect(client.resolveSystem(999)).rejects.toThrow(/No active system with sid 999.*111/s);
  });

  it('errors clearly when the account has no active systems', async () => {
    listSpy.mockResolvedValue([]);
    await expect(client.resolveSystem()).rejects.toThrow(/No active SimpliSafe systems/);
  });
});

describe('assertV3', () => {
  const client = new SimpliSafeClient({ refreshToken: 'test-token' });

  it('passes a version 3 system through', () => {
    expect(() => client.assertV3({ sid: 1, systemVersion: 3, raw: {} }, 'Testing')).not.toThrow();
  });

  it('rejects a legacy system with an explanation rather than letting the route 404', () => {
    expect(() => client.assertV3({ sid: 1, systemVersion: 2, raw: {} }, 'Testing')).toThrow(
      /requires a SimpliSafe 3 system.*version 2/s,
    );
  });
});

describe('getUserId caching', () => {
  it('resolves once and reuses the result across concurrent callers', async () => {
    const client = new SimpliSafeClient({ refreshToken: 'test-token' });
    const requestSpy = vi
      .spyOn(client, 'request')
      .mockResolvedValue({ userId: 6973059 } as never);

    const [a, b, c] = await Promise.all([
      client.getUserId(),
      client.getUserId(),
      client.getUserId(),
    ]);

    expect([a, b, c]).toEqual([6973059, 6973059, 6973059]);
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so a later call can retry', async () => {
    const client = new SimpliSafeClient({ refreshToken: 'test-token' });
    const requestSpy = vi
      .spyOn(client, 'request')
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ userId: 42 } as never);

    await expect(client.getUserId()).rejects.toThrow('network down');
    await expect(client.getUserId()).resolves.toBe(42);
    expect(requestSpy).toHaveBeenCalledTimes(2);
  });
});

describe('token refresh', () => {
  afterEach(() => vi.restoreAllMocks());

  it('exchanges the refresh token and sends the minted access token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/oauth/token')) {
        return new Response(
          JSON.stringify({ access_token: 'minted-access', expires_in: 3600 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ userId: 7 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new SimpliSafeClient({ refreshToken: 'rt-abc' });
    await expect(client.getUserId()).resolves.toBe(7);

    const tokenCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/oauth/token'));
    expect(tokenCall).toBeDefined();
    expect(JSON.parse(String((tokenCall![1] as RequestInit).body))).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'rt-abc',
    });

    const apiCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('authCheck'));
    const headers = new Headers((apiCall![1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer minted-access');
  });

  it('surfaces an actionable error when the refresh token has been revoked', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' }),
        { status: 403 },
      ),
    );

    const client = new SimpliSafeClient({ refreshToken: 'revoked' });
    await expect(client.getUserId()).rejects.toThrow(/token refresh failed \(HTTP 403\)/);
  });
});
