/**
 * Local dev server. Runs the real Pages Functions logic against a JSON file instead of KV,
 * so you can rehearse the whole candidate flow offline before deploying:
 *
 *   node tools/dev-server.mjs
 *   -> http://localhost:8788/admin.html   (admin key is "dev")
 *
 * State lives in tools/.dev-store.json. Delete that file to reset everything. It is the one
 * place the "you cannot restart the timer" rule can be bypassed, which is exactly why it
 * exists only here and never in production.
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle, config, createCandidates, listCandidates, deleteCandidate, toCsv } from '../functions/_lib/engine.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STORE = join(ROOT, 'tools', '.dev-store.json');
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : undefined;
};

const PORT = Number(arg('port') || process.env.PORT || 8788);

// `--duration=25` shortens the clock so you can watch the time-up screen without waiting
// five minutes. Mirrors the DURATION_SEC variable in production.
const CFG = config({
  durationSec: arg('duration') || process.env.DURATION_SEC,
  openRegistration: arg('registration') || process.env.OPEN_REGISTRATION,
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
  '.svg': 'image/svg+xml',
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

  if (url.pathname === '/api/test') {
    if (req.method !== 'POST') return json(res, { ok: false, error: 'post_only' }, 405);
    const result = await handle(store, await readBody(req), Date.now(), CFG);
    const status = result.status || (result.ok ? 200 : 400);
    delete result.status;
    return json(res, result, status);
  }

  if (url.pathname === '/api/admin') {
    if (req.method !== 'POST') return json(res, { ok: false, error: 'post_only' }, 405);
    if ((req.headers['x-admin-key'] || '') !== ADMIN_KEY) return json(res, { ok: false, error: 'unauthorized' }, 401);
    const body = await readBody(req);
    const origin = `http://localhost:${PORT}`;
    if (body.action === 'create') {
      const made = await createCandidates(store, Array.isArray(body.people) ? body.people : []);
      return json(res, { ok: true, created: made.map((m) => ({ ...m, link: `${origin}/?t=${m.token}` })) });
    }
    if (body.action === 'list') return json(res, { ok: true, rows: await listCandidates(store, Date.now(), CFG), origin });
    if (body.action === 'csv') return send(res, 200, '\uFEFF' + toCsv(await listCandidates(store, Date.now(), CFG)), 'text/csv; charset=utf-8');
    if (body.action === 'delete') {
      await deleteCandidate(store, String(body.token || ''));
      return json(res, { ok: true });
    }
    return json(res, { ok: false, error: 'bad_action' }, 400);
  }

  // Static files. normalize() plus the prefix check keeps ../ out of the served root.
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
  const file = normalize(join(ROOT, rel));
  if (!file.startsWith(normalize(ROOT))) return send(res, 403, 'forbidden', 'text/plain');
  try {
    send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'not found', 'text/plain');
  }
}).listen(PORT, () => {
  console.log(`work-test dev server on http://localhost:${PORT}`);
  console.log(`admin:  http://localhost:${PORT}/admin.html   key: ${ADMIN_KEY}`);
  console.log(`clock:  ${CFG.durationSec}s total, ${CFG.graceSec}s grace`);
});
