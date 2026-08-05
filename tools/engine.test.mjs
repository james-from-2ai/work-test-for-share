/**
 * Tests for the guarantees the whole exercise rests on. Run with `npm test`. No dependencies.
 *
 * These are worth having because the guarantees are invisible in the UI: a broken rule looks
 * exactly like a working one until a candidate exploits it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handle, createCandidates, listCandidates, config } from '../functions/_lib/engine.js';
import { DURATION_SEC, GRACE_SEC, QUESTIONS, BRIEFS } from '../functions/_lib/questions.js';

/** In-memory store with the same three methods as the KV and file-backed ones. */
function memStore() {
  const db = new Map();
  return {
    async get(k) { return db.has(k) ? JSON.parse(db.get(k)) : null; },
    async put(k, v) { db.set(k, JSON.stringify(v)); },
    async delete(k) { db.delete(k); },
  };
}

async function fixture() {
  const store = memStore();
  const [c] = await createCandidates(store, [{ name: 'Test Candidate', email: 't@example.com' }]);
  return { store, token: c.token };
}

const T0 = 1_800_000_000_000; // a fixed epoch so tests never depend on the wall clock

/** A valid answer for whatever type question `index` happens to be. */
const answerFor = (index) => (QUESTIONS[index].type === 'choice' ? 0 : `answer for question ${index + 1}`);

/** Walks a started candidate through every question. */
async function answerAll(store, token, startAt = T0) {
  let res;
  for (let i = 0; i < QUESTIONS.length; i++) {
    res = await handle(store, { action: 'answer', token, index: i, value: answerFor(i) }, startAt + (i + 1) * 1_000);
  }
  return res;
}

/* ------------------------------------------------------------------ access ---------- */

test('an unknown token is refused', async () => {
  const { store } = await fixture();
  const res = await handle(store, { action: 'state', token: 'deadbeefdeadbeef' }, T0);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_link');
});

test('before starting, the candidate sees no question', async () => {
  const { store, token } = await fixture();
  const res = await handle(store, { action: 'state', token }, T0);
  assert.equal(res.phase, 'ready');
  assert.equal(res.question, undefined);
  assert.equal(res.deadline, undefined);
});

test('hello reports the format without needing a token', async () => {
  const { store } = await fixture();
  const res = await handle(store, { action: 'hello' }, T0);
  assert.equal(res.phase, 'anonymous');
  assert.equal(res.openRegistration, true);
  assert.equal(res.total, QUESTIONS.length);
  assert.equal(res.question, undefined);
});

/* ------------------------------------------------- self-serve registration ---------- */

test('a candidate can register themselves and gets a session', async () => {
  const store = memStore();
  const res = await handle(store, { action: 'register', name: 'Amina Yusuf', email: 'amina@example.com' }, T0);
  assert.equal(res.ok, true);
  assert.equal(res.phase, 'ready');
  assert.equal(res.candidate.name, 'Amina Yusuf');
  assert.ok(res.token, 'no token was issued');
});

test('registering twice returns the SAME session, so only the first attempt counts', async () => {
  const store = memStore();
  const first = await handle(store, { action: 'register', name: 'Amina Yusuf', email: 'amina@example.com' }, T0);
  await handle(store, { action: 'start', token: first.token }, T0);
  await handle(store, { action: 'answer', token: first.token, index: 0, value: answerFor(0) }, T0 + 5_000);

  // Same person comes back an hour later hoping for a clean run.
  const second = await handle(store, { action: 'register', name: 'Amina Yusuf', email: 'amina@example.com' }, T0 + 3_600_000);
  assert.equal(second.token, first.token, 'a second registration issued a fresh session');
  assert.equal(second.returning, true);
  assert.equal(second.answered, 1, 'the first attempt was discarded');
  assert.equal(second.deadline, T0 + DURATION_SEC * 1000, 'the deadline moved');
});

test('email matching ignores case and surrounding spaces', async () => {
  const store = memStore();
  const first = await handle(store, { action: 'register', name: 'Amina Yusuf', email: 'amina@example.com' }, T0);
  const again = await handle(store, { action: 'register', name: 'A Yusuf', email: '  AMINA@Example.COM ' }, T0 + 1_000);
  assert.equal(again.token, first.token);
});

test('a link issued from the admin page claims the email too', async () => {
  const { store, token } = await fixture();
  const self = await handle(store, { action: 'register', name: 'Test Candidate', email: 'T@Example.com' }, T0);
  assert.equal(self.token, token, 'self-registration created a second session for an invited candidate');
});

test('registration can be switched off so only issued links work', async () => {
  const store = memStore();
  const cfg = config({ openRegistration: 'off' });
  const res = await handle(store, { action: 'register', name: 'Walk In', email: 'walkin@example.com' }, T0, cfg);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'registration_closed');
  const hello = await handle(store, { action: 'hello' }, T0, cfg);
  assert.equal(hello.openRegistration, false);
});

test('a bad name or email is refused before any session exists', async () => {
  const store = memStore();
  assert.equal((await handle(store, { action: 'register', name: 'X', email: 'a@b.co' }, T0)).error, 'name_required');
  assert.equal((await handle(store, { action: 'register', name: 'Real Name', email: 'not-an-email' }, T0)).error, 'email_required');
});

/* --------------------------------------------------------------- the clock ---------- */

test('the timer cannot be restarted by calling start again', async () => {
  const { store, token } = await fixture();
  const first = await handle(store, { action: 'start', token }, T0);
  assert.equal(first.deadline, T0 + DURATION_SEC * 1000);

  // Stand in for a refresh, a second device, or incognito: all of them call start again.
  const later = await handle(store, { action: 'start', token }, T0 + 120_000);
  assert.equal(later.deadline, first.deadline, 'deadline moved, so the timer was resettable');
  assert.equal(later.question.index, 0);
});

test('an answer inside the grace window still lands', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  const atEdge = T0 + DURATION_SEC * 1000 + (GRACE_SEC - 1) * 1000;
  const res = await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, atEdge);
  assert.equal(res.answered, 1);
});

test('once time is up, nothing more is accepted', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  const past = T0 + DURATION_SEC * 1000 + (GRACE_SEC + 5) * 1000;

  const res = await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, past);
  assert.equal(res.phase, 'expired');
  assert.equal(res.rejected, 'expired');
  assert.equal(res.answered, 0);
  assert.equal(res.question, undefined, 'an expired candidate was still shown a question');
});

test('finish freezes a running test', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  const done = await handle(store, { action: 'finish', token }, T0 + 10_000);
  assert.equal(done.phase, 'done');
  assert.equal(done.ranOut, true);
  const after = await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, T0 + 11_000);
  assert.equal(after.rejected, 'done');
  assert.equal(after.answered, 0);
});

/* ------------------------------------------------------------ forward only ---------- */

test('answers are forward-only: an earlier index is refused', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  await handle(store, { action: 'answer', token, index: 0, value: 'my first answer' }, T0 + 5_000);

  const back = await handle(store, { action: 'answer', token, index: 0, value: 'actually, this instead' }, T0 + 6_000);
  assert.equal(back.rejected, 'out_of_order');
  assert.equal(back.answered, 1, 'a resubmitted answer changed the record');
  assert.equal(back.question.index, 1, 'the candidate was moved off the current question');
});

test('a skipped index is refused, so nobody can jump ahead', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  const jump = await handle(store, { action: 'answer', token, index: 2, value: 'x' }, T0 + 1_000);
  assert.equal(jump.rejected, 'out_of_order');
  assert.equal(jump.answered, 0);
});

test('a duplicate submit from a double click is absorbed', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, T0 + 2_000);
  const again = await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, T0 + 2_100);
  assert.equal(again.answered, 1);
});

test('answering the last question finishes the task and closes the link', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  const res = await answerAll(store, token);
  assert.equal(res.phase, 'done');
  assert.equal(res.answered, QUESTIONS.length);

  const reopen = await handle(store, { action: 'state', token }, T0 + 60_000);
  assert.equal(reopen.phase, 'done');
  assert.equal(reopen.question, undefined);
});

/* ------------------------------------------------------ what reaches the wire ------- */

test('only the current question is ever sent to the client', async () => {
  const { store, token } = await fixture();
  const res = await handle(store, { action: 'start', token }, T0);
  const wire = JSON.stringify(res);
  // Compare against the JSON-escaped form, since prompts may contain quotes.
  const onWire = (s) => wire.includes(JSON.stringify(s).slice(1, -1));
  assert.ok(onWire(QUESTIONS[0].prompt));
  for (const q of QUESTIONS.slice(1)) {
    assert.ok(!onWire(q.prompt), `question "${q.id}" leaked to the client`);
  }
});

test('Part 2 is not visible while the candidate is still on Part 1', async () => {
  const { store, token } = await fixture();
  const res = await handle(store, { action: 'start', token }, T0);
  const wire = JSON.stringify(res);
  const onWire = (s) => wire.includes(JSON.stringify(s).slice(1, -1));

  assert.ok(res.question.brief, 'the Part 1 brief was not attached to the question');
  assert.ok(onWire(BRIEFS.part1.blocks[1].text), 'the manager Slack should be visible in Part 1');
  for (const block of BRIEFS.part2.blocks) {
    if (block.text) assert.ok(!onWire(block.text), 'a Part 2 block leaked during Part 1');
    for (const item of block.list || []) {
      assert.ok(!onWire(item), 'a point from the Part 2 email leaked during Part 1');
    }
  }
});

test('the brief follows the part the candidate is actually on', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  const part1Count = QUESTIONS.filter((q) => q.brief === 'part1').length;
  let res;
  for (let i = 0; i < part1Count; i++) {
    res = await handle(store, { action: 'answer', token, index: i, value: answerFor(i) }, T0 + (i + 1) * 1_000);
  }
  assert.equal(res.question.brief.section, BRIEFS.part2.section);
  assert.ok(JSON.stringify(res).includes('Kovar'), 'Part 2 should now include the manager reply');
});

/* ----------------------------------------------------------- answer handling -------- */

test('a required question cannot be skipped with an empty answer', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  const res = await handle(store, { action: 'answer', token, index: 0, value: '   ' }, T0 + 1_000);
  assert.equal(res.rejected, 'empty');
  assert.equal(res.answered, 0);
});

test('an optional question accepts a blank answer', async () => {
  const { store, token } = await fixture();
  const optionalIndex = QUESTIONS.findIndex((q) => q.required === false);
  assert.ok(optionalIndex > 0, 'expected at least one optional question');
  await handle(store, { action: 'start', token }, T0);
  for (let i = 0; i < optionalIndex; i++) {
    await handle(store, { action: 'answer', token, index: i, value: answerFor(i) }, T0 + (i + 1) * 1_000);
  }
  const res = await handle(store, { action: 'answer', token, index: optionalIndex, value: '' }, T0 + 60_000);
  assert.equal(res.rejected, undefined);
  assert.equal(res.answered, optionalIndex + 1);
});

test('long answers are clamped to the question maxLength', async () => {
  const { store, token } = await fixture();
  const longIndex = QUESTIONS.findIndex((q) => q.type === 'long' && q.maxLength);
  await handle(store, { action: 'start', token }, T0);
  for (let i = 0; i < longIndex; i++) {
    await handle(store, { action: 'answer', token, index: i, value: answerFor(i) }, T0 + (i + 1) * 1_000);
  }
  await handle(store, { action: 'answer', token, index: longIndex, value: 'x'.repeat(50_000) }, T0 + 90_000);
  const rec = await store.get(`c:${token}`);
  assert.equal(rec.answers[longIndex].value.length, QUESTIONS[longIndex].maxLength);
});

test('a multiple-choice answer is resolved from our own options, not the client label', async () => {
  const choiceIndex = QUESTIONS.findIndex((q) => q.type === 'choice');
  if (choiceIndex === -1) return; // the current task is all free text; the path stays covered if one is added

  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  for (let i = 0; i < choiceIndex; i++) {
    await handle(store, { action: 'answer', token, index: i, value: answerFor(i) }, T0 + (i + 1) * 1_000);
  }
  await handle(store, { action: 'answer', token, index: choiceIndex, value: 'a label I made up' }, T0 + 90_000);
  const rec = await store.get(`c:${token}`);
  assert.equal(rec.answers[choiceIndex].value, '', 'a client-supplied label was stored verbatim');
});

test('time spent per question is measured server-side', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, T0 + 30_000);
  await handle(store, { action: 'answer', token, index: 1, value: answerFor(1) }, T0 + 95_000);
  const rec = await store.get(`c:${token}`);
  assert.equal(rec.answers[0].msSpent, 30_000);
  assert.equal(rec.answers[1].msSpent, 65_000);
});

/* ----------------------------------------------------------------- reporting -------- */

test('self-registered candidates show up in the admin listing', async () => {
  const store = memStore();
  const reg = await handle(store, { action: 'register', name: 'Amina Yusuf', email: 'amina@example.com' }, T0);
  await handle(store, { action: 'start', token: reg.token }, T0);
  await handle(store, { action: 'answer', token: reg.token, index: 0, value: 'Kwara and two others' }, T0 + 20_000);

  const rows = await listCandidates(store, T0 + 30_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Amina Yusuf');
  assert.equal(rows[0].phase, 'running');
  assert.equal(rows[0].answers[0].value, 'Kwara and two others');
});
