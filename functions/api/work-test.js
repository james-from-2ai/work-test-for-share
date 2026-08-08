/**
 * Cloudflare Pages Function: POST /api/work-test
 *
 * The candidate-facing endpoint for the timed work test at /work-test/. Actions: hello, register,
 * state, start, answer, finish. Every rule that matters lives in `functions/_lib/wt-engine.mjs`;
 * this file only picks the store and shapes the HTTP response.
 *
 * Storage: Airtable when `AIRTABLE_TOKEN` is set, otherwise a KV namespace bound as `TESTS`. See
 * `functions/_lib/wt-store.mjs` for the variables and the trade-off between the two. Submissions
 * land in the Work Test Sessions table of the same base the tech request form writes to, so no
 * new secret is needed.
 *
 * Optional variables:
 *   DURATION_SEC      - overrides the duration set in _lib/wt-questions.mjs. Handy for a short
 *                       rehearsal on Preview without touching code.
 *   OPEN_REGISTRATION - set to `off` to stop accepting self-registration, so only links issued
 *                       from /work-test/admin.html work.
 *   ALLOW_SELF_RESET  - set to `on` to let whoever is on the page wipe their own session and
 *                       start again. INTERNAL TESTING ONLY: it makes the clock restartable by
 *                       anyone with the link, which is the one thing this whole thing exists to
 *                       prevent. Defaults to off. Turn it off before any candidate is invited.
 *
 * Variables are per-environment and Pages does not apply changes to deployments that already
 * exist, so redeploy after setting them.
 *
 * While this site sits behind Cloudflare Access, only @aiaccessinitiative.org accounts can reach
 * this at all, so the test is internal-only. External candidates cannot use it until it moves out
 * from behind the gate. See the work test section of CLAUDE.md.
 */

import { handle, config } from '../_lib/wt-engine.mjs';
import { storeFor } from '../_lib/wt-store.mjs';
import { json, readJson } from '../_lib/wt-kv.mjs';

export async function onRequestPost({ request, env }) {
  const { store, backend } = storeFor(env);
  if (!store) {
    return json({
      ok: false,
      error: 'server_not_configured',
      detail: 'Set AIRTABLE_TOKEN, or bind a KV namespace as TESTS, then redeploy.',
    }, 500);
  }

  const body = await readJson(request);
  const cfg = config({ durationSec: env.DURATION_SEC, openRegistration: env.OPEN_REGISTRATION, allowSelfReset: env.ALLOW_SELF_RESET });

  try {
    const result = await handle(store, body, Date.now(), cfg);
    const status = result.status || (result.ok ? 200 : 400);
    delete result.status;
    return json(result, status);
  } catch (err) {
    // A storage failure mid-test is the worst thing that can happen here, because the candidate
    // is on a clock. Say plainly that it is our fault and not to start over, since starting over
    // would not help: the session is keyed to them either way.
    console.error('work-test store failure', backend, err && err.message);
    return json({
      ok: false,
      error: 'store_unavailable',
      detail: 'We could not save that. Wait a moment and press the button again. Do not reload or start again.',
    }, 503);
  }
}

/** A GET here is almost always someone poking at the URL; do not hint at the shape. */
export const onRequestGet = () => json({ ok: false, error: 'post_only' }, 405);
