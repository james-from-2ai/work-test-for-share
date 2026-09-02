/**
 * Cloudflare Pages Function: POST /api/work-test-admin
 *
 * Issues candidate links and reads results for the timed work test, served at the site root in
 * this copy.
 *
 * Access control, and it is deliberately thinner here than in the internal copy:
 *
 *   ADMIN_KEY, a shared secret sent in the `x-admin-key` header. If it is unset, every admin
 *   action is refused rather than defaulting to open. That is the ONLY layer on this deployment.
 *   There is no Cloudflare Access in front of this hostname, so this endpoint is reachable from
 *   anywhere and the key is the whole of the defence.
 *
 * That is acceptable only because what sits behind it is demo data, and three separate things
 * depend on it staying that way: wt-store.mjs points at the demo Airtable table, admin.html
 * accepts the key from a `?k=` query string and so leaks it into browser history, and README.md
 * tells deployers to pick a short throwaway key. None of the three is safe with real candidates'
 * answers behind it. If you need that, use the copy in master-mega-badass-site, which is gated
 * by Cloudflare Access.
 *
 * Cloudflare environment variables (Pages project > Settings > Variables and secrets):
 *   ADMIN_KEY - REQUIRED, type Secret. Any long random string. Whoever holds it can read every
 *               candidate's answers, so treat it like a password and never commit it.
 *   TEST_PATH - optional, defaults to / in this copy. Only used to build candidate links.
 */

import { createCandidates, listCandidates, deleteCandidate, toCsv, config } from '../_lib/wt-engine.mjs';
import { storeFor } from '../_lib/wt-store.mjs';
import { json, readJson, secretEquals } from '../_lib/wt-kv.mjs';

const TEST_PATH = '/';

export async function onRequestPost({ request, env }) {
  // Authenticate BEFORE reporting anything about configuration. This copy of the code also runs
  // on a public demo with no Access gate in front of it, where an anonymous visitor should learn
  // nothing beyond "wrong key", not which variables the deployment is missing.
  const supplied = request.headers.get('x-admin-key') || '';

  /**
   * Setting a Pages variable and having it reach a Function are two different things: it has to
   * be on the right environment AND a deployment has to be made after it was saved. When one has
   * not arrived, the useful question is what DID, so these errors can list the variable names
   * this Function can see. Names only, never values.
   *
   * Only for a caller who supplied a key, so a passer-by on the public demo learns nothing about
   * the deployment while someone actually configuring it still gets a straight answer.
   */
  const diagnose = (error, detail, status) => json(
    supplied ? { ok: false, error, detail, visibleNames: Object.keys(env).sort() } : { ok: false, error },
    status,
  );

  if (!env.ADMIN_KEY) {
    return diagnose('admin_disabled', 'ADMIN_KEY is not visible to this deployment.', 503);
  }
  if (!secretEquals(supplied, env.ADMIN_KEY)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  // Only now, once the caller is authenticated, say anything about storage.
  const { store } = storeFor(env);
  if (!store) {
    return diagnose(
      'server_not_configured',
      'No storage. Set AIRTABLE_TOKEN (or AirtablePAT), or bind a KV namespace as TESTS, then REDEPLOY.',
      500,
    );
  }

  const body = await readJson(request);
  const base = new URL(request.url).origin + (env.TEST_PATH || TEST_PATH);
  const cfg = config({ durationSec: env.DURATION_SEC, openRegistration: env.OPEN_REGISTRATION, allowSelfReset: env.ALLOW_SELF_RESET });

  try {
    switch (body.action) {
      case 'create': {
        const people = Array.isArray(body.people) ? body.people.slice(0, 200) : [];
        const made = await createCandidates(store, people);
        return json({ ok: true, created: made.map((m) => ({ ...m, link: `${base}?t=${m.token}` })) });
      }

      case 'list':
        return json({ ok: true, rows: await listCandidates(store, Date.now(), cfg), base });

      case 'csv': {
        // Leading BOM so Excel reads it as UTF-8 rather than the system codepage, which
        // otherwise mangles any name with an accent in it.
        const csv = '\uFEFF' + toCsv(await listCandidates(store, Date.now(), cfg));
        return new Response(csv, {
          headers: {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': 'attachment; filename="work-test-results.csv"',
            'cache-control': 'no-store',
          },
        });
      }

      case 'delete':
        await deleteCandidate(store, String(body.token || ''));
        return json({ ok: true });

      default:
        return json({ ok: false, error: 'bad_action' }, 400);
    }
  } catch (err) {
    // Without this an Airtable problem surfaces as a blank 500, which tells whoever is setting
    // this up nothing. The admin page is internal, so returning the real message is the right
    // trade: it is the difference between "it is broken" and "the token cannot read".
    const message = (err && err.message) || String(err);
    console.error('work-test admin store failure', message);
    return json({ ok: false, error: 'store_unavailable', detail: storeHint(message) }, 502);
  }
}

/**
 * Turns the two failures worth anticipating into something actionable. Both are configuration,
 * not code: the token that writes tech requests never needed to read anything, so it may well
 * lack the read scope, and it obviously needs access to the base it is being pointed at.
 */
function storeHint(message) {
  if (/\b40[13]\b/.test(message)) {
    return 'Airtable refused the request. The token needs BOTH data.records:read and '
      + 'data.records:write on the base holding the Work Test Sessions table. Check its scopes at '
      + `airtable.com/create/tokens. Original error: ${message}`;
  }
  if (/\b404\b/.test(message)) {
    return 'Airtable could not find that base or table. Check AIRTABLE_WT_BASE and '
      + `AIRTABLE_WT_TABLE, or leave both unset to use the defaults. Original error: ${message}`;
  }
  return message;
}

export const onRequestGet = () => json({ ok: false, error: 'post_only' }, 405);
