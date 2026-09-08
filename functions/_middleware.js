/**
 * Cloudflare Pages middleware, running in front of every request to this deployment.
 *
 * Its only job is to stop the candidate hostname serving the repo's internal files. See
 * _lib/wt-private.mjs for what is on the list and why; the short version is that the spec file
 * is the entire test, all three Stage 2 paths included, and without this it is a fetch away
 * from anyone holding a candidate link.
 *
 * Everything else passes straight through to the static asset or the API function that would
 * have handled it, so this changes nothing a candidate or an admin does.
 *
 * The standalone builder deployment does not carry this file: its build output has no
 * functions/ directory, and there builder.html is the point.
 */

import { isPrivatePath } from './_lib/wt-private.mjs';

export async function onRequest(context) {
  if (isPrivatePath(new URL(context.request.url).pathname)) {
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return context.next();
}
