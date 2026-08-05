/**
 * Cloudflare Pages Function: POST /api/test
 *
 * The candidate-facing endpoint. Actions: state, start, answer, finish. Every rule that
 * matters is in _lib/engine.js; this file only binds storage and shapes the HTTP response.
 *
 * Required binding (Pages project > Settings > Functions > KV namespace bindings):
 *   TESTS  - a KV namespace. Holds one record per candidate plus a `roster` index.
 *
 * Optional variables:
 *   DURATION_SEC      - overrides the duration set in _lib/questions.js. Useful for running a
 *                       short rehearsal on the Preview environment without touching code.
 *   OPEN_REGISTRATION - set to `off` to stop accepting self-registration, so only links
 *                       issued from /admin.html work. Anything else, including unset, leaves
 *                       self-registration on.
 *
 * Bindings are per-environment. Bind it on Production AND Preview, then redeploy: Pages
 * does not apply binding changes to deployments that already exist.
 */

import { handle, config } from '../_lib/engine.js';
import { kvStore, json, readJson } from '../_lib/kv.js';

export async function onRequestPost({ request, env }) {
  if (!env.TESTS) {
    return json({ ok: false, error: 'server_not_configured', detail: 'KV namespace TESTS is not bound.' }, 500);
  }
  const body = await readJson(request);
  const cfg = config({ durationSec: env.DURATION_SEC, openRegistration: env.OPEN_REGISTRATION });
  const result = await handle(kvStore(env.TESTS), body, Date.now(), cfg);
  const status = result.status || (result.ok ? 200 : 400);
  delete result.status;
  return json(result, status);
}

/** A GET here is almost always someone poking at the URL; do not hint at the shape. */
export const onRequestGet = () => json({ ok: false, error: 'post_only' }, 405);
