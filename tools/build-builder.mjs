/**
 * Assembles the standalone deployment of the authoring tool.
 *
 *   node tools/build-builder.mjs            # writes builder-dist/
 *   node tools/build-builder.mjs --out DIR
 *
 * The builder used to ride along on whichever Pages project served the test, because it is a
 * static file and the project serves the repo root. That put an unauthenticated authoring tool
 * on the hostname candidates sit the assessment on. It now gets its own Pages project, and this
 * script is what that project builds: only the files the builder needs, and nothing that
 * belongs to a candidate.
 *
 * Deliberately absent from the output:
 *
 *   functions/          No API, so nothing on that origin can read or write a candidate's
 *                       answers even if the hostname leaked.
 *   index.html,         The candidate page and the results board. The builder's live preview
 *   admin.html          needs a candidate page and an /api/dev-spec to drive it, so it works
 *                       against the local dev server and says so on a hosted copy.
 *   tools/evp-spec.json The live hiring assessment, all three Stage 2 paths in one file. The
 *                       builder offers it as an example locally; shipping it to an origin
 *                       anyone with the link can read would re-create the leak this separation
 *                       is closing. The generic example ships instead, and the Load example
 *                       button falls through to it.
 *
 * The output is served at the project root, so builder.html is written twice: as index.html so
 * the bare hostname opens the tool, and under its own name so an existing bookmark still works.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files copied verbatim, as `source in the repo` -> `path in the output`. */
export const COPY = [
  ['builder.html', 'index.html'],
  ['builder.html', 'builder.html'],
  ['assets/wt-flow.mjs', 'assets/wt-flow.mjs'],
  ['tools/example-branching-spec.json', 'tools/example-branching-spec.json'],
];

/**
 * Response headers for the builder's own hostname.
 *
 * Unlisted rather than gated, which is the decision this deployment exists to implement: anyone
 * with the link can author a test, and nothing about a test authored here reaches candidates
 * until someone runs spec-apply and deploys. So noindex is doing the work of keeping it out of
 * search results, and the CSP keeps the page to this origin. 'unsafe-inline' is required: the
 * builder's script and styles are inline in the one file.
 */
export const HEADERS = `# Cloudflare Pages response headers for the standalone authoring tool.
#
# This deployment is reachable by anyone holding the link and is not behind Cloudflare Access,
# which is deliberate: authoring a draft is not a privileged act. It publishes nothing. A draft
# becomes a live test only when someone downloads the spec, runs tools/spec-apply.mjs and
# deploys, which is a reviewed commit either way.
#
# It carries no API and no candidate data. noindex keeps it out of search results so the link
# stays the only way in.

/*
  Content-Security-Policy: default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Robots-Tag: noindex, nofollow, noarchive
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: no-referrer
`;

/** Builds the output directory. Returns the list of paths written, relative to `outDir`. */
export function buildBuilder(outDir, { root = ROOT } = {}) {
  rmSync(outDir, { recursive: true, force: true });
  const written = [];
  for (const [from, to] of COPY) {
    const target = join(outDir, to);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(root, from)));
    written.push(to);
  }
  writeFileSync(join(outDir, '_headers'), HEADERS);
  written.push('_headers');
  return written;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const at = process.argv.indexOf('--out');
  const outDir = at > -1 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : join(ROOT, 'builder-dist');
  const written = buildBuilder(outDir);
  console.log(`Built the authoring tool into ${outDir}`);
  for (const path of written) console.log(`  ${path}`);
  console.log('\nCloudflare Pages: build command "node tools/build-builder.mjs", output directory "builder-dist".');
}
