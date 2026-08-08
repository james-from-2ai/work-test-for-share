/**
 * Local dev server for the work test. Runs the real Pages Functions logic against a JSON file
 * instead of KV, and serves the repo the way Cloudflare does, so you can rehearse the whole
 * candidate flow offline:
 *
 *   node tools/dev-server.mjs
 *   -> http://localhost:8788/            the candidate view
 *   -> http://localhost:8788/admin.html  results, admin key "dev"
 *
 * State lives in tools/.dev-store.json (gitignored). Delete that file to reset
 * everything. It is the one place the "you cannot restart the timer" rule can be bypassed,
 * which is exactly why it exists only here and never in production.
 *
 * This serves the repo root so the /api/* paths match production.
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle, config, createCandidates, listCandidates, deleteCandidate, toCsv } from '../functions/_lib/wt-engine.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STORE = join(ROOT, 'tools', '.dev-store.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev';
const TEST_PATH = '/';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : undefined;
};

const PORT = Number(arg('port') || process.env.PORT || 8788);

// `--duration=120` shortens the clock so you can watch the time-up screen without waiting the
// full 90 minutes. Mirrors the DURATION_SEC variable in production.
const CFG = config({
  durationSec: arg('duration') || process.env.DURATION_SEC,
  openRegistration: arg('registration') || process.env.OPEN_REGISTRATION,
  // Local testing wants this on almost always, hence the default the deployed site never gets.
  allowSelfReset: arg('selfreset') || process.env.ALLOW_SELF_RESET || 'on',
});

/** Same three-method interface as the KV wrapper, backed by one JSON file. */
const store = {
  async all() {
    try {
      return JSON.parse(await readFile(STORE, 'utf8'));
    } catch {
      return {};
    }
  },
  async get(key) {
    const db = await store.all();
    return db[key] ?? null;
  },
  async put(key, value) {
    const db = await store.all();
    db[key] = value;
    await writeFile(STORE, JSON.stringify(db, null, 2));
  },
  async delete(key) {
    const db = await store.all();
    delete db[key];
    await writeFile(STORE, JSON.stringify(db, null, 2));
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const json = (res, obj, status = 200) => send(res, status, JSON.stringify(obj));

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw)); } catch { resolve({}); }
    });
  });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/work-test') {
    if (req.method !== 'POST') return json(res, { ok: false, error: 'post_only' }, 405);
    const result = await handle(store, await readBody(req), Date.now(), CFG);
    const status = result.status || (result.ok ? 200 : 400);
    delete result.status;
    return json(res, result, status);
  }

  if (url.pathname === '/api/work-test-admin') {
    if (req.method !== 'POST') return json(res, { ok: false, error: 'post_only' }, 405);
    if ((req.headers['x-admin-key'] || '') !== ADMIN_KEY) return json(res, { ok: false, error: 'unauthorized' }, 401);
    const body = await readBody(req);
    const base = `http://localhost:${PORT}${TEST_PATH}`;
    if (body.action === 'create') {
      const made = await createCandidates(store, Array.isArray(body.people) ? body.people : []);
      return json(res, { ok: true, created: made.map((m) => ({ ...m, link: `${base}?t=${m.token}` })) });
    }
    if (body.action === 'list') return json(res, { ok: true, rows: await listCandidates(store, Date.now(), CFG), base });
    if (body.action === 'csv') return send(res, 200, '\uFEFF' + toCsv(await listCandidates(store, Date.now(), CFG)), 'text/csv; charset=utf-8');
    if (body.action === 'delete') {
      await deleteCandidate(store, String(body.token || ''));
      return json(res, { ok: true });
    }
    return json(res, { ok: false, error: 'bad_action' }, 400);
  }

  // Static files, with directory indexes so a bare path behaves as it does on Pages.
  let rel = decodeURIComponent(url.pathname).slice(1);
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(normalize(ROOT))) return send(res, 403, 'forbidden', 'text/plain');
  try {
    send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}).listen(PORT, () => {
  console.log(`work test dev server on http://localhost:${PORT}${TEST_PATH}`);
  console.log(`admin:  http://localhost:${PORT}${TEST_PATH}admin.html   key: ${ADMIN_KEY}`);
  console.log(`clock:  ${CFG.durationSec}s total, ${CFG.graceSec}s grace`);
});
