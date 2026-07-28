import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Boot the REAL built artifact and run the MCP handshake against it.
 *
 * Unit tests mock everything, so they cannot catch two failures that only
 * appear once a host actually spawns the server:
 *   1. an eager top-level import of a dependency esbuild marked `--external`
 *      — the .mcpb bundle ships NO node_modules, so it dies at load with
 *      ERR_MODULE_NOT_FOUND before answering `initialize`, and the host just
 *      logs "server transport closed unexpectedly";
 *   2. a wrong `bin` path / rootDir, so `npx simplisafe-mcp` finds no entry.
 *
 * The bundle case is exercised in a temp dir with no node_modules to reproduce
 * the .mcpb runtime faithfully.
 */
async function handshake(entry: string, cwd: string): Promise<{ tools: string[] }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Deliberately unconfigured: the deferred-config-error pattern means the
      // server must boot and list tools with no credential present.
      env: { ...process.env, SIMPLISAFE_REFRESH_TOKEN: '' },
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out. stderr:\n${stderr}\nstdout:\n${stdout}`));
    }, 20_000);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) {
            clearTimeout(timer);
            child.kill();
            resolve({ tools: (msg.result?.tools ?? []).map((t: { name: string }) => t.name) });
            return;
          }
        } catch {
          /* partial line; wait for more */
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timer);
        reject(new Error(`exited ${code}. stderr:\n${stderr}`));
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'boot-test', version: '1.0.0' },
        },
      })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  });
}

const built = existsSync(join(ROOT, 'dist', 'bundle.js'));

describe.skipIf(!built)('server boot', () => {
  it('the bin entry (dist/index.js) boots and lists tools', async () => {
    const { tools } = await handshake(join(ROOT, 'dist', 'index.js'), ROOT);
    // A floor, not an exact count: PR CI tests the branch merged with main, so a
    // hardcoded length breaks the moment another PR adds a tool. index.test.ts
    // owns the exact roster on its own branch.
    expect(tools.length).toBeGreaterThanOrEqual(10);
    expect(tools).toContain('simplisafe_healthcheck');
  }, 30_000);

  it('the .mcpb bundle boots with NO node_modules present', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'simplisafe-mcpb-'));
    copyFileSync(join(ROOT, 'dist', 'bundle.js'), join(dir, 'bundle.js'));
    // Node needs {"type":"module"} beside the bundle to read it as ESM.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

    const { tools } = await handshake(join(dir, 'bundle.js'), dir);
    expect(tools.length).toBeGreaterThanOrEqual(10);
    expect(tools).toContain('simplisafe_set_alarm_state');
  }, 30_000);
});
