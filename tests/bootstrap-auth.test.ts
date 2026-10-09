// SEC-3 (fleet-audit #715): writeFileSync's `mode` only applies when it
// creates the file, so a pre-existing 0644 .env (e.g. `cp .env.example .env`)
// would keep holding the refresh token world-readable. The bootstrap script's
// writer must re-assert 0600 on files that already exist.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, statSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- plain .mjs script, no type declarations
import { writePrivateFile } from '../scripts/bootstrap-auth.mjs';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'ss-bootstrap-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('bootstrap-auth writePrivateFile', () => {
  it('creates a new file with mode 0600', () => {
    const file = join(tempDir(), '.env');
    writePrivateFile(file, 'SIMPLISAFE_REFRESH_TOKEN=x\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe('SIMPLISAFE_REFRESH_TOKEN=x\n');
  });

  it('tightens a pre-existing world-readable file to 0600', () => {
    const file = join(tempDir(), '.env');
    writeFileSync(file, 'OTHER=1\n', { mode: 0o644 });
    expect(statSync(file).mode & 0o777).toBe(0o644);
    writePrivateFile(file, 'OTHER=1\nSIMPLISAFE_REFRESH_TOKEN=secret\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toContain('SIMPLISAFE_REFRESH_TOKEN=secret');
  });
});
