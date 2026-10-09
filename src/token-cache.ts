import {
  createFileStatePersistence,
  resolveStateFile,
  type BearerTokens,
  type SyncStatePersistence,
} from '@chrischall/mcp-utils/session';
import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils';

/** Where the token pair is cached between runs. */
export function tokenCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateFile({
    env,
    envVar: 'SIMPLISAFE_TOKEN_FILE',
    subdir: '.simplisafe-mcp',
    fileName: 'token.json',
  });
}

/**
 * What is actually written: the access token and its expiry, plus a refresh
 * token ONLY when it differs from the env seed (i.e. SimpliSafe rotated it and
 * the new one exists nowhere else). The env/keychain seed itself never touches
 * disk.
 */
interface StoredTokens {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

function isStored(raw: unknown): raw is StoredTokens {
  if (raw === null || typeof raw !== 'object') return false;
  const t = raw as Partial<StoredTokens>;
  return (
    typeof t.accessToken === 'string' &&
    typeof t.expiresAt === 'number' &&
    // Absent means "the env seed". Present-but-empty or non-string is corrupt,
    // and would leave the manager unable to refresh.
    (t.refreshToken === undefined || (typeof t.refreshToken === 'string' && t.refreshToken !== ''))
  );
}

/**
 * The token cache, or `null` when disabled or unconfigured.
 *
 * SimpliSafe does not rotate refresh tokens (verified live — see client.ts), so
 * the refresh token TokenManager holds is the `SIMPLISAFE_REFRESH_TOKEN` seed
 * itself. That seed can disarm the alarm and unlock doors indefinitely, and
 * .mcpb installs keep it in the OS keychain; writing it to a plaintext file
 * would silently undo that. So the cache stores only the short-lived access
 * token and its expiry (saving one token exchange per restart), and re-attaches
 * the seed from env on load.
 *
 * The one exception is a rotated refresh token: should SimpliSafe ever start
 * rotating, the new token exists nowhere but memory, and dropping it on exit
 * could strand the server. Only then is a refresh token written.
 *
 * `boundTo` is the env token, so re-running the bootstrap discards the cache
 * rather than letting a record minted from the old chain shadow the new one.
 * The binding is stored as a salted digest, never the token.
 */
export function createTokenCache(
  env: NodeJS.ProcessEnv = process.env,
): SyncStatePersistence<BearerTokens> | null {
  if (!parseBoolEnv('SIMPLISAFE_TOKEN_CACHE', { env, default: true })) return null;
  const seed = readEnvVar('SIMPLISAFE_REFRESH_TOKEN', { env });
  if (seed === undefined) return null;

  const file = createFileStatePersistence<StoredTokens>({
    filePath: tokenCachePath(env),
    boundTo: seed,
    validate: (raw) => (isStored(raw) ? raw : null),
  });

  const toStored = (t: BearerTokens): StoredTokens => ({
    accessToken: t.accessToken,
    expiresAt: t.expiresAt,
    ...(t.refreshToken !== seed ? { refreshToken: t.refreshToken } : {}),
  });

  return {
    load(): BearerTokens | null {
      const stored = file.load();
      if (!stored) return null;
      const tokens: BearerTokens = {
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken ?? seed,
        expiresAt: stored.expiresAt,
      };
      if (stored.refreshToken === seed) {
        // Written by an older version that persisted the seed verbatim. Scrub
        // it; a failure here only leaves the old file as it was.
        try {
          file.save(toStored(tokens));
        } catch {
          /* best effort */
        }
      }
      return tokens;
    },
    save(tokens: BearerTokens): void {
      file.save(toStored(tokens));
    },
    clear(): void {
      file.clear();
    },
  };
}

/**
 * Report a cache write that failed. Not fatal, which is TokenManager's default
 * stance too: SimpliSafe does not rotate refresh tokens (verified live — see
 * client.ts), so the `SIMPLISAFE_REFRESH_TOKEN` seed in env is always the live
 * credential and a lost write costs the next start one token exchange, never
 * access. Failing the tool call instead would turn a read-only data dir or a bad
 * `SIMPLISAFE_TOKEN_FILE` into a server that errors on its first call and on
 * every hourly refresh after it, while protecting nothing.
 *
 * Should SimpliSafe ever start rotating, the rotated token is the one write
 * that matters — this line is then the signal to fix the store before the
 * process exits. Worth saying either way: a broken store otherwise looks
 * exactly like a server that never caches.
 *
 * stderr only; stdout is the JSON-RPC channel.
 */
export function reportCacheWriteFailure(err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  console.error(
    `[simplisafe-mcp] could not cache the SimpliSafe access token (${detail}); continuing ` +
      'without the cache — every restart will exchange the refresh token again until the ' +
      'store path/permissions (SIMPLISAFE_TOKEN_FILE) are fixed, or set ' +
      'SIMPLISAFE_TOKEN_CACHE=false to silence this.',
  );
}
