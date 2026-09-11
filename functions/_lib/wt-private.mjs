/**
 * Which paths a candidate-facing deployment must not serve.
 *
 * Cloudflare Pages serves whatever is in the deployment root, and this project has no build
 * step, so every file in the repo is reachable on the candidate hostname by anyone holding a
 * link. Most of it is harmless. Three things are not:
 *
 *   tools/*.json    The spec is the whole test in one file, including the Stage 2 briefs for
 *                   every option. A candidate who fetched it would read all three paths before
 *                   choosing one, which is exactly what the branching is there to prevent.
 *   builder.html    The authoring tool. It reads and writes no candidate data, but it has no
 *                   authentication either, and it has no business on the hostname candidates
 *                   are sitting a hiring assessment on.
 *   README.md       Deployment notes, the Airtable table the answers land in, and the shape of
 *                   the admin surface.
 *
 * Denying by prefix rather than listing files, so a spec or a tool added later is covered
 * without anyone remembering to come back here. `assets/` stays served: the candidate page
 * needs it.
 *
 * This is a 404 rather than a 403 on purpose. A 403 confirms the file is there.
 */

/** Path prefixes and exact paths that never reach a candidate-facing deployment. */
export const PRIVATE_PREFIXES = ['/tools/'];
export const PRIVATE_PATHS = ['/builder.html', '/readme.md'];

/**
 * True when `pathname` must not be served. Case-insensitive, because Pages will answer
 * /README.MD and /Builder.HTML for the same files on a case-insensitive lookup.
 */
export function isPrivatePath(pathname) {
  const p = String(pathname || '').toLowerCase();
  if (PRIVATE_PATHS.includes(p)) return true;
  return PRIVATE_PREFIXES.some((prefix) => p.startsWith(prefix));
}
