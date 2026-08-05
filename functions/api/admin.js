/**
 * Cloudflare Pages Function: POST /api/admin
 *
 * Issues candidate links and reads results. Gated by a single shared secret sent in the
 * `x-admin-key` header, checked against the ADMIN_KEY environment secret.
 *
 * Cloudflare environment variables (Pages project > Settings > Variables and Secrets):
 *   ADMIN_KEY - REQUIRED, type Secret. Any long random string. Whoever holds it can read
 *               every candidate's answers, so treat it like a password and do not commit it.
 *
 * If ADMIN_KEY is unset, every admin action is refused rather than defaulting to open. The
 * one thing worse than no admin page is an unauthenticated one.
 *
 * A shared secret is deliberate rather than lazy: candidates are external, so this Pages
 * project cannot sit behind Cloudflare Access the way 2ai-workspace does. If you want SSO
 * on the admin side specifically, add an Access policy scoped to /admin.html and /api/admin
 * and keep this check as a second layer.
 */

import { createCandidates, listCandidates, deleteCandidate, toCsv, config } from '../_lib/engine.js';
import { kvStore, json, readJson, secretEquals } from '../_lib/kv.js';

export async function onRequestPost({ request, env }) {
  if (!env.TESTS) {
    return json({ ok: false, error: 'server_not_configured', detail: 'KV namespace TESTS is not bound.' }, 500);
  }
  if (!env.ADMIN_KEY) {
    return json({ ok: false, error: 'admin_disabled', detail: 'ADMIN_KEY secret is not set.' }, 503);
  }
  if (!secretEquals(request.headers.get('x-admin-key') || '', env.ADMIN_KEY)) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const store = kvStore(env.TESTS);
  const body = await readJson(request);
  const origin = new URL(request.url).origin;
  const cfg = config({ durationSec: env.DURATION_SEC });

  switch (body.action) {
    case 'create': {
      const people = Array.isArray(body.people) ? body.people.slice(0, 200) : [];
      const made = await createCandidates(store, people);
      return json({ ok: true, created: made.map((m) => ({ ...m, link: `${origin}/?t=${m.token}` })) });
    }

    case 'list':
      return json({ ok: true, rows: await listCandidates(store, Date.now(), cfg), origin });

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
}

export const onRequestGet = () => json({ ok: false, error: 'post_only' }, 405);
