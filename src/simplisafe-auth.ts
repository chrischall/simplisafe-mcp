import type { ConnectorAuth } from '@chrischall/mcp-connector';
import { SimpliSafeClient, CLIENT_ID } from './client.js';

const AUTH_BASE = 'https://auth.simplisafe.com';
const REDIRECT_URI =
  'com.simplisafe.mobile://auth.simplisafe.com/ios/com.simplisafe.mobile/callback';
const SCOPE =
  'offline_access email openid https://api.simplisafe.com/scopes/user:platform';
const AUTH0_CLIENT =
  'eyJ2ZXJzaW9uIjoiMi4zLjIiLCJuYW1lIjoiQXV0aDAuc3dpZnQiLCJlbnYiOnsic3dpZnQiOiI1LngiLCJpT1MiOiIxNi4zIn19';

/** How long a pending bootstrap may sit in KV. The auth code itself dies sooner. */
const BOOTSTRAP_TTL_SECONDS = 900;

/**
 * The three KV operations this module uses, declared structurally rather than
 * importing `KVNamespace` from @cloudflare/workers-types. That keeps this file
 * typecheckable by the stdio `tsc` build (which loads only Node types) while
 * still matching the real binding at runtime.
 */
interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * OAuth props persisted per user, encrypted at rest in OAUTH_KV.
 *
 * Only the refresh token is stored — never the account password (SimpliSafe's
 * Auth0 tenant disables the password grant outright, so we never see one) and
 * never the single-use authorization code.
 */
export interface SimpliSafeProps {
  refreshToken: string;
  userId: number;
  [key: string]: unknown;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  // Generated inside login(), never at module scope: the Workers runtime forbids
  // random-value generation in global scope and fails deploy-time startup
  // validation (code 10021) if a module-level constructor does this.
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(40))).replace(
    /[^a-zA-Z0-9]/g,
    '',
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

function authorizeUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    audience: 'https://api.simplisafe.com/',
    auth0Client: AUTH0_CLIENT,
    client_id: CLIENT_ID,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    device: 'iPhone',
    device_id: crypto.randomUUID().toUpperCase(),
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    // Auth0 echoes `state` back on the callback, which is how submission 2
    // finds the PKCE verifier that submission 1 stashed.
    state,
  });
  return `${AUTH_BASE}/authorize?${params}`;
}

/** Pull the code and state out of a pasted callback URL (or a bare code). */
function parseCallback(raw: string): { code: string; state: string | null } {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  const code = trimmed.match(/[?&]code=([^&\s]+)/);
  const state = trimmed.match(/[?&]state=([^&\s]+)/);
  if (code) {
    return {
      code: decodeURIComponent(code[1]!),
      state: state ? decodeURIComponent(state[1]!) : null,
    };
  }
  if (/^[\w-]+$/.test(trimmed)) return { code: trimmed, state: null };
  throw new Error(
    'That does not look like a callback URL. Paste the whole com.simplisafe.mobile://… ' +
      'URL your browser failed to open.',
  );
}

/**
 * `ConnectorAuth` for the hosted SimpliSafe connector.
 *
 * SimpliSafe offers no API key, and its Auth0 tenant disables the password grant
 * (`unauthorized_client`, verified 2026-07-28), so the ONLY way to obtain a
 * credential is the authorization-code + PKCE flow. Its redirect URI is a
 * custom scheme belonging to SimpliSafe's own tenant, which we cannot change.
 *
 * So the connector runs that bootstrap ITSELF, as two submissions:
 *
 *   1. The user submits their email with the callback box blank. We mint a PKCE
 *      pair, stash the verifier in OAUTH_KV under a random handle carried in the
 *      OAuth `state`, and THROW — the harness renders the thrown message on the
 *      page, which is what turns "failure" into step 2 of 2.
 *   2. The user pastes the callback URL. We look the verifier up by `state`,
 *      delete it immediately so a code cannot be replayed, exchange it, and
 *      verify the result against the live API before storing anything.
 *
 * The stash holds no credential — only a per-attempt PKCE verifier, useless on
 * its own — and it is deleted on use. Nobody ever pastes a long-lived token, so
 * this connector does not depend on a local install.
 */
export const simplisafeAuth: ConnectorAuth<SimpliSafeProps> = {
  service: 'SimpliSafe',
  accent: '#FFFFFF',
  // The first field's value becomes the OAuth grant's user id, so the email
  // (an identity label here, never a credential) keys the grant.
  privacyNote:
    'Only the resulting refresh token is stored, encrypted. Your SimpliSafe password is never ' +
    'sent to this connector — you enter it on SimpliSafe\'s own login page. The token grants ' +
    'full control of the alarm system, including disarming.',
  preserveFieldsOnError: true,
  fields: [
    { name: 'email', label: 'SimpliSafe email (labels this connection)', type: 'text' },
    {
      name: 'callback',
      label: 'Paste the com.simplisafe.mobile:// URL your browser failed to open',
      type: 'text',
      // Hidden AND disabled until submission 1 asks for it. `disabled` is the
      // load-bearing part: every field is `required` by default, and a required
      // empty box makes the browser silently refuse to submit — which would make
      // the first step, and therefore the whole flow, unreachable. It is also
      // honest: before the authorize URL exists there is no callback URL to
      // paste, so showing the box up front reads like the page claiming there is.
      revealOnDemand: true,
    },
  ],

  async login(fields, env) {
    const kv = env?.OAUTH_KV as KvLike | undefined;
    if (!kv) {
      throw new Error('Connector misconfigured: OAUTH_KV binding is missing.');
    }

    const callback = (fields.callback ?? '').trim();

    // ---- Submission 1: start the flow -------------------------------------
    if (!callback) {
      const { verifier, challenge } = await pkcePair();
      const handle = crypto.randomUUID();
      await kv.put(`ss_bootstrap:${handle}`, verifier, {
        expirationTtl: BOOTSTRAP_TTL_SECONDS,
      });

      // Rejecting here is how the harness renders step 2 — `revealFields`
      // un-hides the callback box (both with JS and on a no-JS re-render). This
      // is a PROMPT, not a failure, so the message reads as instructions.
      const prompt = Object.assign(
        new Error(
          `Step 1 of 2 — open this URL in a new tab and sign in to SimpliSafe:\n\n` +
            `${authorizeUrl(challenge, handle)}\n\n` +
            `After signing in, your browser will FAIL to open a "com.simplisafe.mobile://…" ` +
            `link. That failure is expected and is the point — that URL contains the code. ` +
            `Copy it into the box below and submit again.\n\n` +
            `Tip: open DevTools → Network, tick "Preserve log" BEFORE signing in, then copy ` +
            `the link address of the final failed request. The code expires in ~2 minutes.`,
        ),
        {
          revealFields: ['callback'],
          fieldHints: {
            callback: 'Starts with com.simplisafe.mobile:// and contains ?code=…&state=…',
          },
        },
      );
      throw prompt;
    }

    // ---- Submission 2: finish the flow ------------------------------------
    // Every failure below must keep the callback box REVEALED. A server-side
    // re-render re-hides a revealOnDemand field unless the rejection names it
    // (`hidden = revealOnDemand && !revealFields.includes(name)`), so a mistyped
    // or expired code would otherwise hide the very box the user needs in order
    // to correct it — stranding them exactly like the required-empty-box bug
    // this flow was just fixed for, but only on the no-JS path, which is the
    // sort of asymmetry nobody notices until someone is stuck.
    //
    // This does NOT disguise a real error as a prompt: the harness suppresses
    // its generic "Sign-in failed" fallback only when the message is EMPTY, and
    // every rejection below carries a specific one.
    try {
      return await completeBootstrap(callback, kv);
    } catch (err) {
      throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
        revealFields: ['callback'],
      });
    }
  },
};

/**
 * Submission 2: turn the pasted callback URL into a durable refresh token.
 *
 * Split out so the caller can attach `revealFields` to ANY failure in one place
 * — enumerating the throw sites instead would silently miss the next one added.
 */
async function completeBootstrap(callback: string, kv: KvLike): Promise<SimpliSafeProps> {
    const { code, state } = parseCallback(callback);
    if (!state) {
      throw new Error(
        'That URL has no "state" parameter, so it cannot be matched to your login attempt. ' +
          'Paste the complete callback URL, or clear the box and start again.',
      );
    }

    const key = `ss_bootstrap:${state}`;
    const verifier = await kv.get(key);
    if (!verifier) {
      throw new Error(
        'This login attempt expired or was already used. Clear the second box and submit ' +
          'again to start a fresh one.',
      );
    }
    // Delete before exchanging, so a replayed code finds nothing.
    await kv.delete(key);

    const res = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code_verifier: verifier,
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Scrub the code and verifier explicitly. The shared truncator matches
      // secret SHAPES (Bearer/JWT/sk-), and neither of these has one.
      let safe = detail.slice(0, 300);
      for (const secret of [code, verifier]) {
        if (secret) safe = safe.split(secret).join('[redacted]');
      }
      throw new Error(
        `SimpliSafe rejected the authorization code (HTTP ${res.status}): ${safe}. ` +
          `Codes are single-use and expire in ~2 minutes — clear the second box and start again.`,
      );
    }

    const tokens = (await res.json()) as { refresh_token?: string };
    if (!tokens.refresh_token) {
      throw new Error(
        'SimpliSafe returned no refresh token, so this connection could not be made durable.',
      );
    }

    // Verify against the live API before persisting — a stored credential that
    // has never worked is worse than a failed login.
    const client = new SimpliSafeClient({ refreshToken: tokens.refresh_token });
    const userId = await client.getUserId();

    return { refreshToken: tokens.refresh_token, userId };
}
