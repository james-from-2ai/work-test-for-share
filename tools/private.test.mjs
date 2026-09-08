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

const ask = (url, { env = {}, method = 'GET', headers = {}, body } = {}) => onRequest({
  request: new Request(url, { method, headers, body }),
  env,
  next: async () => new Response('<html><body>the real response</body></html>', {
    status: 200, headers: { 'content-type': 'text/html; charset=utf-8' },
  }),
});

test('the middleware 404s a private path and passes everything else through', async () => {
  const denied = await ask('https://example.pages.dev/tools/evp-spec.json');
  assert.equal(denied.status, 404);
  assert.doesNotMatch(await denied.text(), /questions|stage/i, 'the 404 body must not echo the file');

  const allowed = await ask('https://example.pages.dev/assets/app.js');
  assert.equal(allowed.status, 200);
  assert.match(await allowed.text(), /the real response/);
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

/* ------------------------------------------------------------------ the gate ------------ */

import { tokenFor, cookieValue, sameSecret, isUnlocked, setCookie, loginPage, bannerHtml } from '../functions/_lib/wt-gate.mjs';

test('the cookie carries an HMAC, never the password', async () => {
  const token = await tokenFor('correct horse battery staple');
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(!token.includes('horse'));
  assert.equal(token, await tokenFor('correct horse battery staple'), 'stable for one password');
  assert.notEqual(token, await tokenFor('correct horse battery stapl'), 'changing it logs everyone out');
});

test('a cookie is read without a regex over the header', () => {
  assert.equal(cookieValue('a=1; wt_gate=abc; b=2'), 'abc');
  assert.equal(cookieValue('wt_gate=abc'), 'abc');
  assert.equal(cookieValue('other=abc'), '');
  assert.equal(cookieValue(''), '');
  assert.equal(cookieValue(null), '');
  assert.equal(cookieValue('wt_gate_other=abc'), '', 'a longer name is not a match');
});

test('the compare rejects a prefix and a different length', () => {
  assert.equal(sameSecret('abcdef', 'abcdef'), true);
  assert.equal(sameSecret('abcdef', 'abcde'), false);
  assert.equal(sameSecret('abcdef', 'abcdeg'), false);
  assert.equal(sameSecret('', ''), true);
  assert.equal(sameSecret(undefined, ''), true);
});

test('no password set means the gate is not in the way', async () => {
  assert.equal(await isUnlocked('', ''), true);
  assert.equal(await isUnlocked(null, undefined), true);
});

test('a good cookie unlocks and anything else does not', async () => {
  const pw = 'a shared password';
  const good = await tokenFor(pw);
  assert.equal(await isUnlocked(`wt_gate=${good}`, pw), true);
  assert.equal(await isUnlocked(`wt_gate=${good}x`, pw), false);
  assert.equal(await isUnlocked('wt_gate=', pw), false);
  assert.equal(await isUnlocked('', pw), false);
  assert.equal(await isUnlocked(`wt_gate=${await tokenFor('another password')}`, pw), false);
});

test('the cookie is HttpOnly, Secure and scoped to the site', () => {
  const c = setCookie('deadbeef');
  for (const bit of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) assert.match(c, new RegExp(bit));
  assert.doesNotMatch(c, /Max-Age|Expires/, 'a session cookie, so closing the browser ends it');
});

test('the sign-in page says nothing about what is behind it', () => {
  const page = loginPage({ next: '/some/path' });
  assert.match(page, /Sign in/);
  assert.match(page, /name="password"/);
  assert.match(page, /action="\/__unlock\?next=%2Fsome%2Fpath"/);
  assert.doesNotMatch(page, /Evidence Action|MMS|candidate/i, 'no hint at whose assessment this is');
  assert.match(page, /noindex/);
});

test('the sign-in page escapes what it is handed', () => {
  const page = loginPage({ next: '/x', error: '<script>alert(1)</script>', label: '"><b>' });
  assert.doesNotMatch(page, /<script>alert/);
  assert.match(page, /&lt;script&gt;/);
  assert.doesNotMatch(page, /"><b>/);
});

test('the banner shows its text and pushes the page down', () => {
  const b = bannerHtml('INTERNAL - TEST');
  assert.match(b, /INTERNAL - TEST/);
  assert.match(b, /position: fixed/);
  assert.match(b, /padding-top/, 'the page is pushed clear of it');
  const nasty = bannerHtml('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(nasty, /<img/);
});

/* ------------------------------------------------- the gate, through the middleware ----- */

const PW = 'a shared password';
const unlockedCookie = async () => ({ cookie: `wt_gate=${await tokenFor(PW)}` });

test('with no password set, nothing is gated', async () => {
  const res = await ask('https://example.pages.dev/');
  assert.equal(res.status, 200);
});

test('a locked deployment shows the sign-in page for a page request', async () => {
  const res = await ask('https://example.pages.dev/', { env: { PREVIEW_PASSWORD: PW } });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /name="password"/);
  assert.doesNotMatch(body, /the real response/, 'the page behind it is never rendered');
});

test('a locked deployment gives the API a status, not a login form', async () => {
  const res = await ask('https://example.pages.dev/api/work-test', {
    env: { PREVIEW_PASSWORD: PW }, method: 'POST', body: '{}',
  });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, 'locked');
});

test('the right password sets a cookie and sends you where you were going', async () => {
  const res = await ask('https://example.pages.dev/__unlock?next=%2Fadmin.html', {
    env: { PREVIEW_PASSWORD: PW },
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `password=${encodeURIComponent(PW)}`,
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin.html');
  assert.match(res.headers.get('set-cookie'), /wt_gate=[0-9a-f]{64}/);
});

test('the wrong password is refused and says so', async () => {
  const res = await ask('https://example.pages.dev/__unlock?next=%2F', {
    env: { PREVIEW_PASSWORD: PW },
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=nope',
  });
  assert.equal(res.status, 401);
  assert.match(await res.text(), /did not match/);
  assert.equal(res.headers.get('set-cookie'), null, 'nothing is set on a failure');
});

test('next= cannot be pointed off this deployment', async () => {
  for (const [raw, expected] of [
    ['https%3A%2F%2Felsewhere.example%2Fx', '/'],
    ['%2F%2Felsewhere.example', '/'],
    ['%2Fadmin.html', '/admin.html'],
  ]) {
    const res = await ask(`https://example.pages.dev/__unlock?next=${raw}`, {
      env: { PREVIEW_PASSWORD: PW },
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `password=${encodeURIComponent(PW)}`,
    });
    assert.equal(res.headers.get('location'), expected, raw);
  }
});

test('a good cookie gets through to the page', async () => {
  const res = await ask('https://example.pages.dev/', {
    env: { PREVIEW_PASSWORD: PW }, headers: await unlockedCookie(),
  });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /the real response/);
});

test('the private denylist still applies to someone who is signed in', async () => {
  const res = await ask('https://example.pages.dev/tools/evp-spec.json', {
    env: { PREVIEW_PASSWORD: PW }, headers: await unlockedCookie(),
  });
  assert.equal(res.status, 404);
});

test('the banner is only added when its variable is set', async () => {
  const without = await ask('https://example.pages.dev/');
  assert.doesNotMatch(await without.text(), /wt-deployment-banner/);
});
