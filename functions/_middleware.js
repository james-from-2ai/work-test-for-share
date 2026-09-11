/**
 * Cloudflare Pages middleware, running in front of every request to this deployment.
 *
 * Three jobs, in this order, and the last two do nothing at all unless their variable is set,
 * so the hostname candidates use is unaffected by either:
 *
 *   1. Keep the repo's internal files off a candidate-facing hostname. See _lib/wt-private.mjs
 *      for the list and the reasoning; the short version is that the spec file is the entire
 *      test, all three Stage 2 paths included.
 *   2. PREVIEW_PASSWORD: hold the whole deployment behind one shared password, so an internal
 *      copy of a live assessment is not sitting on the open internet.
 *   3. DEPLOYMENT_BANNER: stamp every page with a label, so nobody walking an internal copy can
 *      mistake it for the real thing.
 *
 * The standalone builder deployment carries no functions/ directory, so none of this runs there.
 */

import { isPrivatePath } from './_lib/wt-private.mjs';
import { isUnlocked, tokenFor, sameSecret, setCookie, loginPage, bannerHtml } from './_lib/wt-gate.mjs';

const notFound = () => new Response('Not found', {
  status: 404,
  headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
});

const html = (body, status = 200, extra = {}) => new Response(body, {
  status,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...extra },
});

/** Only ever redirect within this deployment, so ?next= cannot be pointed somewhere else. */
function safeNext(raw) {
  const value = String(raw || '/');
  return value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export async function onRequest(context) {
  const { request, next } = context;
  // Defaulted rather than destructured: a deployment with no variables bound should serve the
  // test, not 500 on every request because a lookup threw.
  const env = context.env || {};
  const url = new URL(request.url);

  if (isPrivatePath(url.pathname)) return notFound();

  const password = env.PREVIEW_PASSWORD || '';
  const banner = env.DEPLOYMENT_BANNER || '';

  if (password) {
    // The form posts here rather than to the page it wants, so an unauthenticated POST to the
    // API is never parsed as a login attempt and its body is never touched.
    if (url.pathname === '/__unlock') {
      if (request.method !== 'POST') return html(loginPage({ next: '/', label: banner }), 405);
      const form = await request.formData().catch(() => null);
      const given = form ? String(form.get('password') || '') : '';
      const target = safeNext(url.searchParams.get('next'));
      if (!sameSecret(given, password)) {
        return html(loginPage({ next: target, error: 'That password did not match. Try again.', label: banner }), 401);
      }
      return new Response(null, {
        status: 303,
        headers: { location: target, 'set-cookie': setCookie(await tokenFor(password)), 'cache-control': 'no-store' },
      });
    }

    if (!(await isUnlocked(request.headers.get('cookie'), password))) {
      // A page request gets the form. Anything else gets a status, because an API caller or a
      // fetch from the page itself cannot do anything useful with a login form.
      if (request.method === 'GET' || request.method === 'HEAD') {
        return html(loginPage({ next: url.pathname + url.search, label: banner }), 200);
      }
      return new Response(JSON.stringify({ ok: false, error: 'locked' }), {
        status: 401,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
  }

  const response = await next();

  if (banner && (response.headers.get('content-type') || '').includes('text/html')) {
    // Injected server-side rather than committed into the pages, so the deployment that serves
    // candidates cannot grow a banner by accident.
    return new HTMLRewriter()
      .on('body', { element: (el) => el.prepend(bannerHtml(banner), { html: true }) })
      .transform(response);
  }

  return response;
}
