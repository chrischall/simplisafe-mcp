import type { CallToolResult, InputRequiredResult, ServerContext } from '@modelcontextprotocol/server';
import { confirmationFromEnv, requireConfirmationWithFallback } from '@chrischall/mcp-utils';

/** What {@link confirmGate} needs to describe and bind one sensitive call. */
export interface GatedRequest {
  /** The tool name the confirmToken is bound to. */
  tool: string;
  /** Stable `<service>.<verb>` identifier for the operation. */
  action: string;
  /** Human-readable prompt shown above the preview. */
  message: string;
  /** Plain-English description of the call, shown as the preview's `action`. */
  summary: string;
  method: string;
  path: string;
  /** Request body, shown as `willSend`. */
  body?: unknown;
  /** The primary id acted on (sid, lock serial). */
  target: string;
  /**
   * The state the preview reports (sid, lock name, current state, …). Bound
   * into the token with the request, so a change between the two phases is
   * refused as DRAFT_CHANGED rather than acting on something the user did not see.
   */
  context: Record<string, unknown>;
  /** The physical consequence, spelled out. Shown, not bound. */
  warning: string;
  /** The phase-2 token from the tool input, or undefined on phase 1. */
  confirmToken?: string;
}

/**
 * Confirm gate for a sensitive tool. `undefined` means the user confirmed and
 * the caller proceeds; anything else is the result to return unchanged — the
 * confirmation prompt, the phase-1 preview plus confirmToken, or a refusal.
 *
 * The stakes here are higher than in most of the fleet. These calls act on a
 * physical security system: disarming leaves a house unprotected, arming an
 * occupied house can trip a siren and a monitoring-center dispatch, and
 * unlocking opens a real door. A hallucinated or mis-parsed tool call must not
 * do any of that silently, so the gate is unconditional — there is no
 * "trusted" path that skips it.
 *
 * The caller does its reads BEFORE calling this, on every call, so the preview
 * and the bound payload always reflect the system as it is now.
 */
export function confirmGate(
  ctx: ServerContext,
  req: GatedRequest,
): Promise<InputRequiredResult | CallToolResult | undefined> {
  const { method, path, body, context, warning } = req;
  const preview: Record<string, unknown> = {
    action: req.summary,
    method,
    path,
    ...(body !== undefined ? { willSend: body } : {}),
    ...context,
    warning,
  };
  return requireConfirmationWithFallback(
    ctx,
    confirmationFromEnv({
      action: req.action,
      message: req.message,
      details: preview,
      tool: req.tool,
      confirmToken: req.confirmToken,
      subject: () => ({
        target: req.target,
        payload: { method, path, body, ...context },
        preview,
      }),
    }),
  );
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
