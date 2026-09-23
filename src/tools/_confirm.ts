import type { CallToolResult } from '@modelcontextprotocol/server';
import { minifiedResult, schemaConfirm } from '@chrischall/mcp-utils';

export { schemaConfirm };

/**
 * Confirm-gate for a sensitive tool (the fleet convention). When `confirm` is
 * not `true`, returns a no-network dry-run preview of exactly what would be
 * sent; when it is `true`, returns `null` so the caller proceeds.
 *
 * The stakes here are higher than in most of the fleet. These calls act on a
 * physical security system: disarming leaves a house unprotected, arming an
 * occupied house can trip a siren and a monitoring-center dispatch, and
 * unlocking opens a real door. A hallucinated or mis-parsed tool call must not
 * do any of that silently, so the gate is unconditional — there is no
 * "trusted" path that skips it.
 */
export function previewUnlessConfirmed(
  confirm: boolean | undefined,
  action: string,
  method: string,
  path: string,
  extra?: { body?: unknown; warning?: string; [key: string]: unknown },
): CallToolResult | null {
  if (confirm === true) return null;

  const { body, warning, ...rest } = extra ?? {};
  return minifiedResult({
    dryRun: true,
    action,
    method,
    path,
    ...(body !== undefined ? { willSend: body } : {}),
    ...rest,
    ...(warning ? { warning } : {}),
    note: 'Nothing was sent. Re-run with confirm: true to execute.',
  });
}

/**
 * Detail text for a confirmed write whose post-write re-read failed.
 *
 * The command was already sent and may well have taken effect, so the result
 * must say so unambiguously — a tool error here would read as "the unlock /
 * disarm failed" and invite a retry or a wrong report to the user.
 */
export function unverifiedDetail(err: unknown, reReadTool: string): string {
  const reason = err instanceof Error ? err.message : String(err);
  return (
    `The command WAS sent and accepted, but re-reading the state to verify it failed: ${reason}. ` +
    `Do NOT assume it failed and do not simply retry — check the current state with ${reReadTool}.`
  );
}
