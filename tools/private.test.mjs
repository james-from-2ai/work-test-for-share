/**
 * The two guarantees that keep the authoring tool and the spec off a candidate's hostname:
 * the middleware denylist, and the standalone builder build.
 *
 * Both are worth testing because both fail silently. A denylist that stops matching serves the
 * whole test to anyone with a link, and a build that quietly starts copying the EVP spec puts
 * it on an origin that is unlisted rather than private. Neither shows up in the page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { isPrivatePath } from '../functions/_lib/wt-private.mjs';
import { buildBuilder, COPY } from './build-builder.mjs';
import { onRequest } from '../functions/_middleware.js';

/* ------------------------------------------------------------------ the denylist -------- */

test('the spec, the builder and the README are not served', () => {
  for (const path of [
    '/tools/evp-spec.json',
    '/tools/example-branching-spec.json',
    '/tools/spec-apply.mjs',
    '/tools/dev-server.mjs',
    '/builder.html',
    '/README.md',
  ]) {
    assert.equal(isPrivatePath(path), true, `${path} must not be served`);
  }
});

test('a spec or tool added later is covered without touching the list', () => {
  assert.equal(isPrivatePath('/tools/next-role-spec.json'), true);
  assert.equal(isPrivatePath('/tools/some/deeper/thing.mjs'), true);
});

test('everything the candidate page and the admin page need is still served', () => {
  for (const path of [
    '/',
    '/index.html',
    '/admin.html',
    '/assets/app.js',
    '/assets/styles.css',
    '/assets/theme.js',
    '/assets/wt-flow.mjs',
    '/api/work-test',
    '/api/work-test-admin',
  ]) {
    assert.equal(isPrivatePath(path), false, `${path} must still be served`);
  }
});

test('case does not get around it', () => {
  assert.equal(isPrivatePath('/README.MD'), true);
  assert.equal(isPrivatePath('/Builder.HTML'), true);
  assert.equal(isPrivatePath('/TOOLS/evp-spec.json'), true);
});

test('a path that merely starts with the same letters is not caught', () => {
  assert.equal(isPrivatePath('/toolset.html'), false);
  assert.equal(isPrivatePath('/assets/tools/thing.js'), false);
});

test('nothing but a string is treated as private', () => {
  assert.equal(isPrivatePath(''), false);
  assert.equal(isPrivatePath(null), false);
  assert.equal(isPrivatePath(undefined), false);
});

/* ----------------------------------------------------------------- the middleware ------- */

const ask = (url) => onRequest({
  request: new Request(url),
  next: async () => new Response('the real response', { status: 200 }),
});

test('the middleware 404s a private path and passes everything else through', async () => {
  const denied = await ask('https://example.pages.dev/tools/evp-spec.json');
  assert.equal(denied.status, 404);
  assert.doesNotMatch(await denied.text(), /questions|stage/i, 'the 404 body must not echo the file');

  const allowed = await ask('https://example.pages.dev/assets/app.js');
  assert.equal(allowed.status, 200);
  assert.equal(await allowed.text(), 'the real response');
});

test('a query string or a hash does not get around the middleware', async () => {
  for (const url of [
    'https://example.pages.dev/tools/evp-spec.json?v=2',
    'https://example.pages.dev/builder.html?k=anything',
  ]) {
    assert.equal((await ask(url)).status, 404, url);
  }
});

test('the denial is a 404, not a 403, so it does not confirm the file is there', async () => {
  const res = await ask('https://example.pages.dev/README.md');
  assert.equal(res.status, 404);
});

/* --------------------------------------------------------------- the builder build ------ */

const listFiles = (dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
};

test('the builder build ships what the tool needs and nothing else', () => {
  const out = mkdtempSync(join(tmpdir(), 'builder-dist-'));
  try {
    const written = buildBuilder(out);
    const files = listFiles(out).map((f) => relative(out, f).split('\\').join('/')).sort();

    assert.deepEqual(files, [
      '_headers',
      'assets/wt-flow.mjs',
      'builder.html',
      'index.html',
      'tools/example-branching-spec.json',
    ], 'the output is exactly these files');
    assert.equal(written.length, COPY.length + 1);

    // the bare hostname opens the tool, and an old bookmark still works
    const index = readFileSync(join(out, 'index.html'), 'utf8');
    assert.equal(index, readFileSync(join(out, 'builder.html'), 'utf8'));
    assert.match(index, /wt-flow\.mjs/, 'the tool still imports the flow module it validates with');

    // the module it imports has to actually be there, or the page is dead on arrival
    assert.ok(existsSync(join(out, 'assets/wt-flow.mjs')));

    // the live assessment must not be on this origin
    assert.equal(existsSync(join(out, 'tools/evp-spec.json')), false, 'the EVP spec must not ship');

    // nothing that could touch a candidate
    for (const path of ['functions', 'admin.html', 'assets/app.js', 'assets/styles.css']) {
      assert.equal(existsSync(join(out, path)), false, `${path} must not ship`);
    }

    const headers = readFileSync(join(out, '_headers'), 'utf8');
    assert.match(headers, /X-Robots-Tag: noindex/, 'the builder stays out of search results');
    assert.match(headers, /Content-Security-Policy:/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('building twice leaves the same output, so a redeploy is not a surprise', () => {
  const out = mkdtempSync(join(tmpdir(), 'builder-dist-'));
  try {
    const first = buildBuilder(out);
    const second = buildBuilder(out);
    assert.deepEqual(second, first);
    assert.equal(listFiles(out).length, 5);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
