// Suite-wide guard: no test may touch the developer's real token cache.
//
// `createTokenCache` resolves its path from MCP_DATA_DIR/HOME, so any test with
// SIMPLISAFE_REFRESH_TOKEN set would read and write
// ~/.simplisafe-mcp/token.json — non-hermetic, order-dependent, and able to
// leave a real file behind.
//
// Three guards, and the third is the one that actually holds:
//   1. The cache is OFF by default, so the ordinary suite never constructs one.
//   2. Its path is pinned into a temp dir, so a test that turns the cache ON to
//      exercise it still cannot reach $HOME.
//   3. A tripwire that FAILS the suite if the real home directory was touched.
//
// The first two work through process.env, which is not sufficient on its own: a
// client reading an INJECTED env bypasses them, and the path resolver then falls
// back to os.homedir(), which no environment variable can redirect. Fixing that
// plumbing in schoolpass-mcp is what created a real file under $HOME — so the
// third guard asserts the outcome rather than the mechanism, and cleans up
// before it throws so a caught regression leaves nothing behind.
import { beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const CACHE_DIR = mkdtempSync(join(tmpdir(), 'simplisafe-test-cache-'));

beforeEach(() => {
  process.env.SIMPLISAFE_TOKEN_CACHE = 'false';
  process.env.SIMPLISAFE_TOKEN_FILE = join(CACHE_DIR, 'token.json');
});

afterAll(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });

  const leaked = join(homedir(), '.simplisafe-mcp');
  if (existsSync(leaked)) {
    rmSync(leaked, { recursive: true, force: true });
    throw new Error(
      `A test wrote to ${leaked}. The suite must never touch the real home ` +
        'directory — inject SIMPLISAFE_TOKEN_CACHE=false (or a temp ' +
        'SIMPLISAFE_TOKEN_FILE) into the env that test hands the client.',
    );
  }
});
