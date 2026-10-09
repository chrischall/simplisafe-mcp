// Invariant: the Claude Code plugin manifest points at its MCP config under
// `mcpServers` — the key Claude Code actually reads. A bare `mcp` key is
// ignored at load time (`claude plugin validate` flags it as unknown); it only
// appeared to work here because ./.mcp.json is also the default location.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(
  readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
) as Record<string, unknown>;

describe('plugin.json', () => {
  it('declares its MCP config under `mcpServers`, not the ignored `mcp` key', () => {
    expect(plugin).not.toHaveProperty('mcp');
    expect(typeof plugin.mcpServers).toBe('string');
  });

  it('references an MCP config file that exists', () => {
    expect(existsSync(join(ROOT, plugin.mcpServers as string))).toBe(true);
  });
});
