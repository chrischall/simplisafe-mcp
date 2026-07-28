import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { registerUtilityTools } from '../../src/tools/utilities.js';
import { client } from '../../src/client.js';
import { createTestHarness, subscriptionFixture } from '../helpers.js';
import { parseToolResult } from '@chrischall/mcp-utils/test';

const userSpy = vi.spyOn(client, 'getUserId');
const listSpy = vi.spyOn(client, 'listSubscriptions');

let harness: Awaited<ReturnType<typeof createTestHarness>>;

beforeEach(() => {
  userSpy.mockReset();
  listSpy.mockReset();
});
afterAll(async () => {
  if (harness) await harness.close();
});

describe('simplisafe_healthcheck', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) => registerUtilityTools(server, client));
    expect((await harness.listTools()).map((t) => t.name)).toContain('simplisafe_healthcheck');
  });

  it('reports ok with the resolved user and system count', async () => {
    userSpy.mockResolvedValue(6973059);
    listSpy.mockResolvedValue([subscriptionFixture({ sid: 7858153 })]);

    const parsed = parseToolResult(await harness.callTool('simplisafe_healthcheck')) as Record<
      string,
      unknown
    >;
    expect(parsed).toMatchObject({
      status: 'ok',
      authenticated: true,
      userId: 6973059,
      activeSystems: 1,
      systemIds: [7858153],
    });
  });

  it('REPORTS a failure rather than throwing it', async () => {
    // A healthcheck that errors out tells you nothing; it must always answer.
    userSpy.mockRejectedValue(new Error('SIMPLISAFE_REFRESH_TOKEN is not set.'));

    const result = await harness.callTool('simplisafe_healthcheck');
    expect(result.isError).toBeFalsy();

    const parsed = parseToolResult(result) as Record<string, unknown>;
    expect(parsed.status).toBe('error');
    expect(parsed.authenticated).toBe(false);
    expect(String(parsed.hint)).toMatch(/bootstrap-auth/);
  });
});
