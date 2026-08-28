import {
  createFileStatePersistence,
  resolveStateFile,
  type BearerTokens,
  type SyncStatePersistence,
} from '@chrischall/mcp-utils/session';
import { readEnvVar, parseBoolEnv } from '@chrischall/mcp-utils';
import { McpToolError } from '@chrischall/mcp-utils';

/** Where the token pair is cached between runs. */
export function tokenCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveStateFile({
    env,
    envVar: 'SIMPLISAFE_TOKEN_FILE',
    subdir: '.simplisafe-mcp',
    fileName: 'token.json',
  });
}

/** A usable record needs a refresh token — it is the only durable credential. */
function isTokens(raw: unknown): raw is BearerTokens {
  if (raw === null || typeof raw !== 'object') return false;
  const t = raw as Partial<BearerTokens>;
  return (
    typeof t.accessToken === 'string' &&
    typeof t.refreshToken === 'string' &&
    t.refreshToken !== '' &&
    typeof t.expiresAt === 'number'
  );
}

/**
 * The token cache, or `null` when disabled or unconfigured.
 *
 * This is a correctness fix more than an optimisation. SimpliSafe's exchange
 * can return a NEW refresh token, and the client already rotates onto it — but
 * only in memory. Every restart replayed the token from
 * `SIMPLISAFE_REFRESH_TOKEN` instead, so a rotation was discarded on exit. If
 * the service invalidates the old token when it issues a new one, that leaves
 * the server holding a dead credential and the operator re-running
 * `scripts/bootstrap-auth.mjs` — which is exactly what the 401 hint already
 * tells them to do.
 *
 * `boundTo` is the env token, so re-running the bootstrap discards the cache
 * rather than letting a record minted from the old chain shadow the new one.
 * Only a salted digest is written.
 */
export function createTokenCache(
  env: NodeJS.ProcessEnv = process.env,
): SyncStatePersistence<BearerTokens> | null {
  if (!parseBoolEnv('SIMPLISAFE_TOKEN_CACHE', { env, default: true })) return null;
  const seed = readEnvVar('SIMPLISAFE_REFRESH_TOKEN', { env });
  if (seed === undefined) return null;

  return createFileStatePersistence<BearerTokens>({
    filePath: tokenCachePath(env),
    boundTo: seed,
    validate: (raw) => (isTokens(raw) ? raw : null),
  });
}

/**
 * Fail the call when a rotated token cannot be stored.
 *
 * Deliberately fatal, unlike the other adoptions in this rollout, and the
 * reasoning is an asymmetry rather than a certainty. I could not confirm
 * whether SimpliSafe's rotation invalidates the previous token without live
 * credentials. If it does, a silent write failure means the next start replays
 * a dead token and the operator has to re-run the bootstrap by hand; if it does
 * not, the cost of failing loudly is one errored tool call pointing at a data
 * directory that is genuinely broken and worth fixing either way.
 *
 * The cheap wrong answer and the expensive wrong answer are not symmetric, so
 * this takes the cheap one.
 */
export function failOnCacheWriteError(err: unknown): never {
  const detail = err instanceof Error ? err.message : String(err);
  throw new McpToolError(`Refreshed the SimpliSafe token but could not persist it: ${detail}`, {
    hint:
      'SimpliSafe may have invalidated the previous refresh token when it issued this one, ' +
      'so losing the new one can leave the server without a usable credential. Fix the ' +
      'token store path/permissions (SIMPLISAFE_TOKEN_FILE), or set ' +
      'SIMPLISAFE_TOKEN_CACHE=false to accept re-running scripts/bootstrap-auth.mjs instead.',
  });
}
