/**
 * All test rules live here. Storage is injected so the same code runs on Cloudflare KV in
 * production and on a file-backed store in tools/dev-server.mjs locally. If a rule is not
 * enforced in this file, it is not enforced at all: the client is treated as hostile.
 *
 * The three guarantees the client cannot break, and how:
 *
 *   1. The timer cannot be reset. `startedAt` is written once, on the first `start` call,
 *      and never rewritten. A refresh, a new browser, incognito, another device, or a
 *      cleared cache all read back the same `startedAt` and therefore the same deadline.
 *      The client is told the deadline; it does not decide it.
 *   2. Answers cannot be revisited. The server hands out exactly one question, the one at
 *      index === answers.length. There is no endpoint that edits or deletes an answer, and
 *      `answer` refuses any index that is not the next one. Going back is not a UI state we
 *      hide, it is an operation that does not exist.
 *   3. Questions cannot be read ahead. Only the current question is ever serialized to the
 *      client. QUESTIONS is never sent as a whole.
 *
 * What this does NOT prevent, stated plainly: a candidate can still read the question and
 * ask someone else, or paste in an answer written elsewhere. Pastes and tab switches are
 * recorded as signals in the export, not blocked. Treat the result as evidence, not proof.
 */

import { QUESTIONS, BRIEFS, DURATION_SEC, GRACE_SEC, INTEGRITY } from './questions.js';

const KEY = (token) => `c:${token}`;
/**
 * One key per email address, pointing at that person's token. This is what enforces "we will
 * only accept your first submission": a second registration with the same email is handed
 * back the existing session, which by then is running, finished, or expired.
 */
const EMAIL_KEY = (email) => `e:${String(email).trim().toLowerCase()}`;
const ROSTER = 'roster';

/**
 * Resolves the runtime limits. Everything defaults to questions.js; the only reason to
 * override is to shorten the clock while rehearsing the flow, which is why the override
 * comes from the environment rather than from anything a candidate can send.
 */
export function config(overrides = {}) {
  const d = Number(overrides.durationSec);
  const g = Number(overrides.graceSec);
  return {
    durationSec: Number.isFinite(d) && d > 0 ? Math.floor(d) : DURATION_SEC,
    graceSec: Number.isFinite(g) && g >= 0 ? Math.floor(g) : GRACE_SEC,
    // When open registration is on, anyone with the unlisted URL can enter their own name and
    // start. Turn it off (OPEN_REGISTRATION=off) to accept only admin-issued links.
    openRegistration: String(overrides.openRegistration ?? '') !== 'off',
  };
}

/** Tokens are opaque and unguessable; the token IS the candidate's authentication. */
export function newToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const clamp = (s, n) => String(s == null ? '' : s).slice(0, n);

/**
 * What the candidate is allowed to see about a question. Never the whole QUESTIONS array, and
 * never a brief belonging to a part they have not reached: Part 2's email would otherwise
 * tell them what Part 1's answer is being tested for.
 */
function publicQuestion(index) {
  const q = QUESTIONS[index];
  if (!q) return null;
  return {
    index,
    number: index + 1,
    total: QUESTIONS.length,
    type: q.type,
    prompt: q.prompt,
    context: q.context || null,
    options: q.options || null,
    maxLength: q.maxLength || (q.type === 'long' ? 2000 : 300),
    placeholder: q.placeholder || null,
    required: q.required !== false,
    brief: q.brief ? BRIEFS[q.brief] || null : null,
  };
}

function deadlineOf(rec, cfg) {
  return rec.startedAt + cfg.durationSec * 1000;
}

/** Single place that decides where a candidate stands, so every endpoint agrees. */
function phaseOf(rec, now, cfg) {
  if (rec.finishedAt) return 'done';
  if (!rec.startedAt) return 'ready';
  if (rec.answers.length >= QUESTIONS.length) return 'done';
  if (now > deadlineOf(rec, cfg) + cfg.graceSec * 1000) return 'expired';
  return 'running';
}

/** The response shape the client renders from. Deliberately small. */
function view(rec, now, cfg, extra = {}) {
  const phase = phaseOf(rec, now, cfg);
  const out = {
    ok: true,
    phase,
    serverNow: now,
    candidate: { name: rec.name || null },
    durationSec: cfg.durationSec,
    total: QUESTIONS.length,
    answered: rec.answers.length,
    ranOut: !!rec.ranOut,
    blockPaste: INTEGRITY.blockPaste,
    ...extra,
  };
  if (rec.startedAt) out.deadline = deadlineOf(rec, cfg);
  if (phase === 'running') out.question = publicQuestion(rec.answers.length);
  return out;
}

async function load(store, token) {
  if (!token || !/^[a-f0-9]{8,64}$/.test(token)) return null;
  return await store.get(KEY(token));
}

/**
 * Handle one candidate action. `now` is passed in rather than read from the clock so the
 * caller controls time in tests.
 */
export async function handle(store, body, now = Date.now(), cfg = config()) {
  // These two run before a token exists, so they sit ahead of the token lookup.
  if (body.action === 'hello') {
    return {
      ok: true,
      phase: 'anonymous',
      serverNow: now,
      openRegistration: cfg.openRegistration,
      durationSec: cfg.durationSec,
      total: QUESTIONS.length,
    };
  }
  if (body.action === 'register') return register(store, body, now, cfg);

  const token = body && body.token;
  const rec = await load(store, token);
  if (!rec) return { ok: false, error: 'invalid_link', status: 404 };

  switch (body.action) {
    case 'state':
      return view(rec, now, cfg);

    case 'start': {
      // Idempotent by design: the second call returns the first call's deadline. This is
      // what makes a refresh useless as a way to buy more time.
      if (!rec.startedAt && !rec.finishedAt) {
        rec.startedAt = now;
        rec.userAgent = clamp(body.userAgent, 300);
        await store.put(KEY(token), rec);
      }
      return view(rec, now, cfg);
    }

    case 'answer': {
      const phase = phaseOf(rec, now, cfg);
      if (phase !== 'running') return view(rec, now, cfg, { rejected: phase });

      const index = Number(body.index);
      // The only acceptable index is the next one. This kills both going back and a
      // duplicate submit from a double click or a retried request.
      if (index !== rec.answers.length) return view(rec, now, cfg, { rejected: 'out_of_order' });

      const q = QUESTIONS[index];
      const max = q.maxLength || (q.type === 'long' ? 2000 : 300);
      let value = clamp(body.value, max);
      if (q.type === 'choice') {
        // Never trust a client-sent label; accept only an index into our own options.
        const pick = Number(body.value);
        value = Number.isInteger(pick) && q.options[pick] != null ? q.options[pick] : '';
      }

      // The client blocks this too, but a required question must not be skippable by anyone
      // hand-rolling a request. Optional questions accept an empty string and move on.
      if (q.required !== false && value.trim() === '') return view(rec, now, cfg, { rejected: 'empty' });

      const prevAt = rec.answers.length ? rec.answers[rec.answers.length - 1].at : rec.startedAt;
      rec.answers.push({
        id: q.id,
        index,
        prompt: q.prompt,
        value,
        at: now,
        msSpent: now - prevAt,
        // Integrity signals, recorded not enforced. See the note at the top of this file.
        pastes: Math.max(0, Math.min(99, Number(body.pastes) || 0)),
        blurs: Math.max(0, Math.min(99, Number(body.blurs) || 0)),
      });
      if (rec.answers.length >= QUESTIONS.length) rec.finishedAt = now;
      await store.put(KEY(token), rec);
      return view(rec, now, cfg);
    }

    case 'finish': {
      // Called when the clock runs out. Freezes the record so nothing lands afterwards.
      if (!rec.finishedAt && rec.startedAt) {
        rec.finishedAt = now;
        rec.ranOut = true;
        await store.put(KEY(token), rec);
      }
      return view(rec, now, cfg);
    }

    default:
      return { ok: false, error: 'bad_action', status: 400 };
  }
}

/**
 * Self-serve entry from the unlisted URL: the candidate gives their own name and email and
 * gets a session back. Returning with the same email hands back the SAME session rather than
 * a fresh one, which is how "only your first submission counts" is enforced, and is also the
 * recovery path if someone loses their link or clears their browser.
 *
 * Known limit, worth being clear about: knowing a candidate's email is enough to resume their
 * session. The unlisted URL is only ever sent to candidates, so the exposure is small, but if
 * that is not acceptable, set OPEN_REGISTRATION=off and issue per-candidate links from the
 * admin page instead. Those carry a 128-bit token that cannot be guessed.
 */
async function register(store, body, now, cfg) {
  if (!cfg.openRegistration) return { ok: false, error: 'registration_closed', status: 403 };

  const name = clamp(body.name, 120).trim();
  const email = clamp(body.email, 200).trim();
  if (name.length < 2) return { ok: false, error: 'name_required', status: 400 };
  // Deliberately loose: an over-strict pattern rejecting a valid address would lock a
  // candidate out of the test entirely, which is a far worse failure than a typo.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: 'email_required', status: 400 };

  const existingToken = await store.get(EMAIL_KEY(email));
  if (existingToken) {
    const rec = await store.get(KEY(existingToken));
    if (rec) return { ...view(rec, now, cfg), token: existingToken, returning: true };
  }

  const token = newToken();
  const rec = {
    token,
    name,
    email,
    createdAt: now,
    selfRegistered: true,
    startedAt: null,
    finishedAt: null,
    answers: [],
  };
  await store.put(KEY(token), rec);
  await store.put(EMAIL_KEY(email), token);

  const roster = (await store.get(ROSTER)) || { tokens: [] };
  roster.tokens.push(token);
  await store.put(ROSTER, roster);

  return { ...view(rec, now, cfg), token };
}

/* ---------------------------------------------------------------- admin side ------- */

export async function createCandidates(store, people) {
  const roster = (await store.get(ROSTER)) || { tokens: [] };
  const made = [];
  for (const p of people) {
    const name = clamp(p.name, 120).trim();
    if (!name) continue;
    const email = clamp(p.email, 200).trim();
    const token = newToken();
    await store.put(KEY(token), {
      token,
      name,
      email,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      answers: [],
    });
    // Claim the email too, so someone who was sent a link but self-registers instead lands in
    // the session we already made for them rather than getting a second one.
    if (email) await store.put(EMAIL_KEY(email), token);
    roster.tokens.push(token);
    made.push({ token, name, email });
  }
  await store.put(ROSTER, roster);
  return made;
}

export async function listCandidates(store, now = Date.now(), cfg = config()) {
  const roster = (await store.get(ROSTER)) || { tokens: [] };
  const rows = [];
  for (const token of roster.tokens) {
    const rec = await store.get(KEY(token));
    if (!rec) continue;
    rows.push({
      token,
      name: rec.name,
      email: rec.email,
      createdAt: rec.createdAt,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt,
      ranOut: !!rec.ranOut,
      phase: phaseOf(rec, now, cfg),
      answered: rec.answers.length,
      total: QUESTIONS.length,
      answers: rec.answers,
    });
  }
  rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return rows;
}

export async function deleteCandidate(store, token) {
  const rec = await store.get(KEY(token));
  const roster = (await store.get(ROSTER)) || { tokens: [] };
  roster.tokens = roster.tokens.filter((t) => t !== token);
  await store.put(ROSTER, roster);
  // Release the email claim as well, so deleting a session genuinely lets that person start
  // again. This is the only way to grant a retake.
  if (rec && rec.email) await store.delete(EMAIL_KEY(rec.email));
  await store.delete(KEY(token));
}

export function toCsv(rows) {
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
  // Pastes and tab switches are activity context, not integrity signals: candidates are told
  // they may use AI and must open a spreadsheet, so both are expected behaviour.
  const head = [
    'name', 'email', 'status', 'started_utc', 'finished_utc', 'ran_out',
    'question', 'prompt', 'answer', 'seconds_on_question', 'words', 'pastes', 'tab_switches',
  ];
  const lines = [head.map(esc).join(',')];
  const wordCount = (s) => (String(s || '').trim() ? String(s).trim().split(/\s+/).length : 0);
  for (const r of rows) {
    if (!r.answers.length) {
      lines.push([r.name, r.email, r.phase, iso(r.startedAt), iso(r.finishedAt), r.ranOut ? 'yes' : 'no', '', '', '', '', '', '', ''].map(esc).join(','));
      continue;
    }
    for (const a of r.answers) {
      lines.push([
        r.name, r.email, r.phase, iso(r.startedAt), iso(r.finishedAt), r.ranOut ? 'yes' : 'no',
        a.index + 1, a.prompt, a.value, Math.round(a.msSpent / 1000), wordCount(a.value), a.pastes, a.blurs,
      ].map(esc).join(','));
    }
  }
  return lines.join('\r\n');
}
