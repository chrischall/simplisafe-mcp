import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tokenCachePath, createTokenCache, failOnCacheWriteError } from '../src/token-cache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ss-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const on = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  MCP_DATA_DIR: dir,
  SIMPLISAFE_REFRESH_TOKEN: 'seed-rt',
  SIMPLISAFE_TOKEN_CACHE: 'true',
  ...over,
});

const tokens = (over: Partial<{ accessToken: string; refreshToken: string; expiresAt: number }> = {}) => ({
  accessToken: 'AT',
  refreshToken: 'RT-rotated',
  expiresAt: Date.now() + 3_600_000,
  ...over,
});

const cacheFile = (d: string): string => join(d, '.simplisafe-mcp', 'token.json');

describe('tokenCachePath', () => {
  it('prefers MCP_DATA_DIR, the variable mcp-host injects', () => {
    expect(tokenCachePath({ MCP_DATA_DIR: '/data' })).toBe('/data/.simplisafe-mcp/token.json');
  });

  it('honours an explicit SIMPLISAFE_TOKEN_FILE', () => {
    expect(tokenCachePath({ SIMPLISAFE_TOKEN_FILE: '/tmp/x.json', MCP_DATA_DIR: '/data' })).toBe(
      '/tmp/x.json',
    );
  });

  it('ignores a sentinel override rather than making a relative ./null', () => {
    expect(tokenCachePath({ SIMPLISAFE_TOKEN_FILE: 'null', HOME: '/home/u' })).toBe(
      '/home/u/.simplisafe-mcp/token.json',
    );
  });
});

describe('createTokenCache', () => {
  it('round-trips a rotated pair through a 0600 file', () => {
    createTokenCache(on())!.save(tokens());
    expect(statSync(cacheFile(dir)).mode & 0o777).toBe(0o600);
    expect(createTokenCache(on())!.load()).toEqual(
      expect.objectContaining({ refreshToken: 'RT-rotated' }),
    );
  });

  it('discards the cache when the bootstrap token is replaced', () => {
    // Re-running scripts/bootstrap-auth.mjs mints a new chain. A record from the
    // old one must not shadow it — that is the failure freshbooks-mcp tracked as
    // seededFromEnv before the shared helper had `boundTo`.
    createTokenCache(on())!.save(tokens());
    expect(createTokenCache(on({ SIMPLISAFE_REFRESH_TOKEN: 'fresh-seed' }))!.load()).toBeNull();
  });

  it('writes no seed token to disk in plaintext', () => {
    createTokenCache(on())!.save(tokens());
    expect(readFileSync(cacheFile(dir), 'utf8')).not.toContain('seed-rt');
  });

  it('never persists the env refresh token, even when it is the live one', () => {
    // SimpliSafe does not rotate refresh tokens, so the record TokenManager
    // saves normally carries the env seed itself. Writing it would put a second
    // plaintext copy of a credential that can disarm the alarm on disk, undoing
    // the .mcpb keychain storage. Only the short-lived access token is cached.
    createTokenCache(on())!.save(tokens({ refreshToken: 'seed-rt' }));
    const raw = readFileSync(cacheFile(dir), 'utf8');
    expect(raw).not.toContain('seed-rt');
    expect(raw).toContain('AT');
  });

  it('restores the env refresh token alongside the cached access token', () => {
    const t = tokens({ refreshToken: 'seed-rt' });
    createTokenCache(on())!.save(t);
    expect(createTokenCache(on())!.load()).toEqual(t);
  });

  it('scrubs a seed refresh token written by an older version on load', () => {
    const p = createTokenCache(on())!;
    p.save(tokens({ refreshToken: 'seed-rt' }));
    const envelope = JSON.parse(readFileSync(cacheFile(dir), 'utf8')) as { state: Record<string, unknown> };
    envelope.state.refreshToken = 'seed-rt';
    writeFileSync(cacheFile(dir), JSON.stringify(envelope), { mode: 0o600 });

    expect(createTokenCache(on())!.load()).toEqual(expect.objectContaining({ refreshToken: 'seed-rt' }));
    expect(readFileSync(cacheFile(dir), 'utf8')).not.toContain('seed-rt');
  });

  it.each([
    ['SIMPLISAFE_TOKEN_CACHE=false', on({ SIMPLISAFE_TOKEN_CACHE: 'false' })],
    ['no configured refresh token', { MCP_DATA_DIR: dir, SIMPLISAFE_TOKEN_CACHE: 'true' }],
  ])('is disabled for %s', (_label, env) => {
    expect(createTokenCache(env)).toBeNull();
  });

  it('writes nothing at all when disabled', () => {
    expect(createTokenCache(on({ SIMPLISAFE_TOKEN_CACHE: 'false' }))).toBeNull();
    expect(existsSync(join(dir, '.simplisafe-mcp'))).toBe(false);
  });
});

describe('stored-record shape guard', () => {
  it.each([
    ['null', null],
    ['a primitive', 'nope'],
    ['an empty refreshToken', { accessToken: 'AT', refreshToken: '', expiresAt: 1 }],
    ['a non-string refreshToken', { accessToken: 'AT', refreshToken: 7, expiresAt: 1 }],
    ['a missing accessToken', { refreshToken: 'RT', expiresAt: 1 }],
    ['a non-numeric expiry', { accessToken: 'AT', refreshToken: 'RT', expiresAt: 'soon' }],
  ])('rejects %s rather than handing it to the token manager', (_label, body) => {
    // The refresh token is the only durable credential here, so a record
    // without one is worse than no record: it would look restorable and then
    // leave the manager unable to refresh.
    const p = createTokenCache(on())!;
    p.save(tokens());
    // Swap only the STATE, keeping the envelope's salted binding intact —
    // overwriting the whole file would be rejected by the binding check before
    // the shape guard ever ran, which is the wrong reason to pass.
    const envelope = JSON.parse(readFileSync(cacheFile(dir), 'utf8')) as { state: unknown };
    envelope.state = body;
    writeFileSync(cacheFile(dir), JSON.stringify(envelope), { mode: 0o600 });
    expect(createTokenCache(on())!.load()).toBeNull();
  });
});

describe('failOnCacheWriteError', () => {
  it('throws, rather than reporting, when a rotated token cannot be stored', () => {
    // Deliberately unlike the other adoptions: if SimpliSafe invalidates the
    // previous token when it issues a new one, silently losing the new one
    // leaves the server with no usable credential.
    expect(() => failOnCacheWriteError(new Error('EROFS'))).toThrow(/could not persist/i);
  });

  it('names both ways out in the hint', () => {
    try {
      failOnCacheWriteError(new Error('EROFS'));
      expect.unreachable('should have thrown');
    } catch (err) {
      const hint = (err as { hint?: string }).hint ?? '';
      expect(hint).toContain('SIMPLISAFE_TOKEN_FILE');
      expect(hint).toContain('SIMPLISAFE_TOKEN_CACHE=false');
    }
  });

  it('renders a non-Error cause', () => {
    expect(() => failOnCacheWriteError('disk gone')).toThrow(/disk gone/);
  });
});
