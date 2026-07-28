#!/usr/bin/env node
/**
 * One-time SimpliSafe OAuth2 (Auth0 + PKCE) bootstrap.
 *
 * SimpliSafe's mobile client is a public PKCE client: no client secret, and the
 * refresh_token grant is enabled. So a human logs in through the browser exactly
 * once here; after that the MCP server mints access tokens from the stored
 * refresh token with no browser and no human in the loop.
 *
 *   Step 1:  node scripts/bootstrap-auth.mjs
 *            -> prints an authorize URL; log in there.
 *
 *   Step 2:  node scripts/bootstrap-auth.mjs "<pasted callback URL or bare code>"
 *            -> exchanges the code, verifies it against the live API, writes .env.
 *
 * Dependency-free (node builtins only) so it runs before `npm install`.
 */

import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_FILE = path.join(REPO_ROOT, '.auth-bootstrap.json');
const ENV_FILE = path.join(REPO_ROOT, '.env');

// Pinned from the SimpliSafe iOS client; verified live 2026-07-28 (the authorize
// endpoint accepts this client_id, and /oauth/token accepts both grants).
const AUTH_BASE = 'https://auth.simplisafe.com';
const API_BASE = 'https://api.simplisafe.com/v1';
const CLIENT_ID = '42aBZ5lYrVW12jfOuu3CQROitwxg9sN5';
const REDIRECT_URI =
  'com.simplisafe.mobile://auth.simplisafe.com/ios/com.simplisafe.mobile/callback';
const SCOPE =
  'offline_access email openid https://api.simplisafe.com/scopes/user:platform';
const AUTH0_CLIENT =
  'eyJ2ZXJzaW9uIjoiMi4zLjIiLCJuYW1lIjoiQXV0aDAuc3dpZnQiLCJlbnYiOnsic3dpZnQiOiI1LngiLCJpT1MiOiIxNi4zIn19';

function codeVerifier() {
  return randomBytes(40).toString('base64url').replace(/[^a-zA-Z0-9]/g, '');
}

function codeChallenge(verifier) {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

function mask(secret) {
  if (!secret) return '(none)';
  return `${secret.slice(0, 4)}…${secret.slice(-4)} (${secret.length} chars)`;
}

function printUrl() {
  const verifier = codeVerifier();
  const deviceId = randomUUID().toUpperCase();
  const params = new URLSearchParams({
    audience: 'https://api.simplisafe.com/',
    auth0Client: AUTH0_CLIENT,
    client_id: CLIENT_ID,
    code_challenge: codeChallenge(verifier),
    code_challenge_method: 'S256',
    device: 'iPhone',
    device_id: deviceId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
  });

  writeFileSync(STATE_FILE, JSON.stringify({ verifier, deviceId }, null, 2), {
    mode: 0o600,
  });

  process.stdout.write(`
SimpliSafe login — step 1 of 2
==============================

1. Open this URL in your browser and sign in (complete MFA if your account has it):

${AUTH_BASE}/authorize?${params}

2. After the final "Approve"/login step the browser will try to redirect to
   com.simplisafe.mobile://... and FAIL to open anything. That failure is expected
   and is the point — the authorization code is in that URL.

   Grab it whichever way is easiest:
     • Chrome/Safari usually leaves the full com.simplisafe.mobile://... URL in the
       address bar — copy the whole thing.
     • Or: DevTools ▸ Network ▸ the last (failed/blocked) request ▸ copy its URL.
     • Or: right-click the "Open in app" link ▸ Copy Link Address.

3. Run step 2 with what you copied (full URL or just the code — either works):

     node scripts/bootstrap-auth.mjs "com.simplisafe.mobile://…?code=…"

The code is single-use and expires in a couple of minutes, so run step 2 promptly.
`);
}

function extractCode(input) {
  const trimmed = input.trim().replace(/^["']|["']$/g, '');
  // Accept a full callback URL, a bare "code=..." fragment, or just the code.
  const match = trimmed.match(/[?&]code=([^&\s]+)/);
  if (match) return decodeURIComponent(match[1]);
  if (/^[\w-]+$/.test(trimmed)) return trimmed;
  throw new Error(
    `Could not find an authorization code in that input. Paste the full ` +
      `com.simplisafe.mobile://... callback URL, or just the code itself.`,
  );
}

async function exchange(rawInput) {
  if (!existsSync(STATE_FILE)) {
    throw new Error(
      `No bootstrap state found at ${STATE_FILE}. Run step 1 first: node scripts/bootstrap-auth.mjs`,
    );
  }
  const { verifier } = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  const code = extractCode(rawInput);

  process.stdout.write('Exchanging authorization code…\n');
  const tokenRes = await fetch(`${AUTH_BASE}/oauth/token`, {
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

  const tokenBody = await tokenRes.text();
  if (!tokenRes.ok) {
    // Never echo the code or verifier back out.
    throw new Error(
      `Token exchange failed (HTTP ${tokenRes.status}): ${tokenBody.slice(0, 300)}\n` +
        `If this says "Invalid authorization code", the code was already used or expired — ` +
        `re-run step 1 for a fresh URL.`,
    );
  }

  const tokens = JSON.parse(tokenBody);
  if (!tokens.refresh_token) {
    throw new Error(
      'Token response contained no refresh_token — the "offline_access" scope was not granted.',
    );
  }

  // Live-verify the access token against the real API before persisting anything.
  process.stdout.write('Verifying the access token against api.simplisafe.com…\n');
  const checkRes = await fetch(`${API_BASE}/api/authCheck`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!checkRes.ok) {
    throw new Error(
      `authCheck failed (HTTP ${checkRes.status}) — the minted token was rejected.`,
    );
  }
  const { userId } = await checkRes.json();

  // Persist to .env (0600), preserving any unrelated keys already there.
  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const kept = existing
    .split('\n')
    .filter(
      (line) =>
        line.trim() &&
        !/^SIMPLISAFE_(REFRESH_TOKEN|USER_ID)=/.test(line.trim()),
    );
  kept.push(`SIMPLISAFE_REFRESH_TOKEN=${tokens.refresh_token}`);
  kept.push(`SIMPLISAFE_USER_ID=${userId}`);
  writeFileSync(ENV_FILE, `${kept.join('\n')}\n`, { mode: 0o600 });

  unlinkSync(STATE_FILE);

  process.stdout.write(`
Success — SimpliSafe is authenticated.
======================================
  user id        ${userId}
  refresh token  ${mask(tokens.refresh_token)}   (written to .env, mode 0600)
  access token   expires in ${tokens.expires_in}s (minted on demand from now on)

The browser is no longer needed. .env is gitignored — never commit it.
`);
}

const [, , arg] = process.argv;
try {
  if (arg) {
    await exchange(arg);
  } else {
    printUrl();
  }
} catch (err) {
  process.stderr.write(`\nError: ${err.message}\n`);
  process.exitCode = 1;
}
