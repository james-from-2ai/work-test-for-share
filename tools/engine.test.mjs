/**
 * Tests for the guarantees the whole exercise rests on. Run with `npm test`. No dependencies.
 *
 * These are worth having because the guarantees are invisible in the UI: a broken rule looks
 * exactly like a working one until a candidate exploits it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handle, createCandidates, listCandidates, config } from '../functions/_lib/wt-engine.mjs';
import { DURATION_SEC, GRACE_SEC, QUESTIONS, BRIEFS, SECTIONS } from '../functions/_lib/wt-questions.mjs';
import { sanitizeRich, richToText, richIsEmpty, MAX_BLOCKS } from '../functions/_lib/wt-rich.mjs';

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
const answerFor = (index) => {
  const t = QUESTIONS[index].type;
  if (t === 'choice') return 0;
  if (t === 'rich') return [{ type: 'p', runs: [{ t: `answer for question ${index + 1}` }] }];
  return `answer for question ${index + 1}`;
};

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

test('finish freezes a running test, but only once the deadline has genuinely passed', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);

  // The page's clock is cosmetic and the page is not trusted, so a call ten seconds into a
  // ninety-minute test must not end it. This used to be accepted, which meant a device with a
  // wrong idea of the time could close a sitting early.
  const early = await handle(store, { action: 'finish', token }, T0 + 10_000);
  assert.equal(early.rejected, 'not_yet');
  assert.equal(early.phase, 'running');
  assert.equal(early.ranOut, false);

  const late = T0 + DURATION_SEC * 1000 + 1_000;
  const done = await handle(store, { action: 'finish', token }, late);
  assert.equal(done.phase, 'done');
  assert.equal(done.ranOut, true);
  const after = await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, late + 1_000);
  assert.equal(after.rejected, 'done');
  assert.equal(after.answered, 0);
});

/* ------------------------------------------------------------ forward only ---------- */

test('answers are forward-only: an earlier index is refused', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, T0 + 5_000);

  const back = await handle(store, { action: 'answer', token, index: 0, value: [{ type: 'p', runs: [{ t: 'actually, this instead' }] }] }, T0 + 6_000);
  // 'no_edit' since editing became a setting, 'out_of_order' before it did. Which of the two it
  // is matters far less than that the attempt was refused and nothing moved, so assert that
  // rather than pinning a string that will change again the next time the wording improves.
  assert.ok(['no_edit', 'out_of_order'].includes(back.rejected), `unexpected rejection: ${back.rejected}`);
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

/* -------------------------------------------------------------------- review -------- */

test('review returns what was submitted, and only what was submitted', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, T0 + 1_000);
  await handle(store, { action: 'answer', token, index: 1, value: answerFor(1) }, T0 + 2_000);

  const res = await handle(store, { action: 'review', token }, T0 + 3_000);
  assert.equal(res.ok, true);
  assert.equal(res.review.length, 2);
  assert.deepEqual(res.review.map((r) => r.number), [1, 2]);
  assert.equal(res.review[0].prompt, QUESTIONS[0].prompt);
  assert.equal(richToText(res.review[0].value), 'answer for question 1');
});

test('review cannot reveal a question the candidate has not reached', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, T0 + 1_000);

  const res = await handle(store, { action: 'review', token }, T0 + 2_000);
  const wire = JSON.stringify(res.review);
  const onWire = (s) => wire.includes(JSON.stringify(s).slice(1, -1));
  // Question 2 is the one they are on now, so its prompt is legitimately in `question`, but it
  // must not be in the review payload, and nothing beyond it may appear at all.
  for (const q of QUESTIONS.slice(1)) {
    assert.ok(!onWire(q.prompt), `an unanswered question leaked into review: ${q.id}`);
  }
  for (const block of BRIEFS.part2.blocks) {
    for (const item of block.list || []) assert.ok(!onWire(item), 'Part 2 leaked into review');
  }
});

test('reviewing does not let an answer be changed', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, T0 + 1_000);
  await handle(store, { action: 'review', token }, T0 + 2_000);

  // The obvious follow-up attempt: read it back, then try to send a better version.
  const retry = await handle(store, { action: 'answer', token, index: 0, value: 'a better answer' }, T0 + 3_000);
  // Refused because this test does not allow editing. The stored answer below is the assertion
  // that actually matters; the code just says which rule did the refusing.
  assert.ok(['no_edit', 'out_of_order'].includes(retry.rejected), `unexpected rejection: ${retry.rejected}`);

  const after = await handle(store, { action: 'review', token }, T0 + 4_000);
  assert.equal(after.review.length, 1);
  assert.equal(richToText(after.review[0].value), 'answer for question 1', 'the stored answer changed');
});

test('review still works once the task is finished or expired', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  await answerAll(store, token);

  const done = await handle(store, { action: 'review', token }, T0 + 60_000);
  assert.equal(done.phase, 'done');
  assert.equal(done.review.length, QUESTIONS.length);
  assert.equal(done.question, undefined, 'a finished candidate was shown a question again');
});

test('review on an untouched session is empty rather than an error', async () => {
  const { store, token } = await fixture();
  const res = await handle(store, { action: 'review', token }, T0);
  assert.equal(res.ok, true);
  assert.deepEqual(res.review, []);
});

/* ---------------------------------------------------------------- self reset -------- */

test('self reset is refused by default, so the clock stays unrestartable', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, T0 + 1_000);

  const res = await handle(store, { action: 'reset', token }, T0 + 2_000);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'reset_disabled');

  const still = await handle(store, { action: 'state', token }, T0 + 3_000);
  assert.equal(still.answered, 1, 'the session was wiped despite the refusal');
  assert.equal(still.deadline, T0 + DURATION_SEC * 1000);
});

test('self reset needs the word "on", but tolerates casing and stray whitespace', () => {
  assert.equal(config().allowSelfReset, false, 'unset must mean off');
  // A value meaning anything else leaves it off, so a guess never opens it up.
  for (const v of ['', 'off', 'false', 'no', 'true', '1', 'yes', 'onn']) {
    assert.equal(config({ allowSelfReset: v }).allowSelfReset, false, `"${v}" should not enable it`);
  }
  // Cloudflare's value box is a textarea, so these are all the same intent typed by a human.
  for (const v of ['on', 'ON', 'On', ' on', 'on ', 'on\n', ' On \n']) {
    assert.equal(config({ allowSelfReset: v }).allowSelfReset, true, `"${JSON.stringify(v)}" should enable it`);
  }
});

test('closing registration tolerates the same, since a typo there fails open', () => {
  assert.equal(config().openRegistration, true, 'unset must leave registration open');
  for (const v of ['off', 'OFF', 'Off', ' off ', 'off\n']) {
    assert.equal(config({ openRegistration: v }).openRegistration, false, `"${JSON.stringify(v)}" should close it`);
  }
});

test('a duration with stray whitespace is still read as a number', () => {
  assert.equal(config({ durationSec: ' 900 ' }).durationSec, 900);
  assert.equal(config({ durationSec: 'nonsense' }).durationSec, DURATION_SEC, 'garbage falls back to the default');
  assert.equal(config({ durationSec: '0' }).durationSec, DURATION_SEC, 'zero would expire everyone instantly');
  assert.equal(config({ durationSec: '-5' }).durationSec, DURATION_SEC);
});

test('with the flag on, reset clears the session and frees the email', async () => {
  const store = memStore();
  const cfg = config({ allowSelfReset: 'on' });
  const reg = await handle(store, { action: 'register', name: 'Team Tester', email: 'tester@example.com' }, T0, cfg);
  await handle(store, { action: 'start', token: reg.token }, T0, cfg);
  await handle(store, { action: 'answer', token: reg.token, index: 0, value: answerFor(0) }, T0 + 1_000, cfg);

  const res = await handle(store, { action: 'reset', token: reg.token }, T0 + 2_000, cfg);
  assert.equal(res.ok, true);
  assert.equal(res.phase, 'anonymous');

  // The old token is gone, and the same email now gets a genuinely fresh clock.
  const gone = await handle(store, { action: 'state', token: reg.token }, T0 + 3_000, cfg);
  assert.equal(gone.error, 'invalid_link');

  const again = await handle(store, { action: 'register', name: 'Team Tester', email: 'tester@example.com' }, T0 + 4_000, cfg);
  assert.notEqual(again.token, reg.token);
  assert.equal(again.answered, 0);
  assert.equal(again.phase, 'ready');

  await handle(store, { action: 'start', token: again.token }, T0 + 5_000, cfg);
  const fresh = await handle(store, { action: 'state', token: again.token }, T0 + 6_000, cfg);
  assert.equal(fresh.deadline, T0 + 5_000 + DURATION_SEC * 1000, 'the new session did not get a fresh clock');
});

test('a reset candidate leaves nothing behind in the listing', async () => {
  const store = memStore();
  const cfg = config({ allowSelfReset: 'on' });
  const reg = await handle(store, { action: 'register', name: 'Team Tester', email: 'tester@example.com' }, T0, cfg);
  await handle(store, { action: 'reset', token: reg.token }, T0 + 1_000, cfg);
  assert.deepEqual(await listCandidates(store, T0 + 2_000, cfg), []);
});

test('the client is told whether reset is available', async () => {
  const { store, token } = await fixture();
  assert.equal((await handle(store, { action: 'state', token }, T0)).allowSelfReset, false);
  const on = config({ allowSelfReset: 'on' });
  assert.equal((await handle(store, { action: 'state', token }, T0, on)).allowSelfReset, true);
  assert.equal((await handle(store, { action: 'hello' }, T0, on)).allowSelfReset, true);
});

/* ------------------------------------------------------------------ progress -------- */

test('progress is weighted by effort, not by question count', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);

  const part1 = QUESTIONS.filter((q) => q.section === 'part1').length;
  let res = await handle(store, { action: 'state', token }, T0);
  assert.equal(res.progress.percentDone, 0);
  assert.equal(res.progress.sectionNumber, 1);

  for (let i = 0; i < part1; i++) {
    res = await handle(store, { action: 'answer', token, index: i, value: answerFor(i) }, T0 + (i + 1) * 1_000);
  }

  // Part 1 is 60 of the 90 recommended minutes, so finishing it is two thirds of the work even
  // though it is four of six questions. Counting questions would have said 67% by coincidence
  // here, so pin the section states too, which is where the two measures actually diverge.
  assert.equal(res.progress.percentDone, 67);
  assert.equal(res.progress.sections[0].state, 'done');
  assert.equal(res.progress.sections[1].state, 'current');
  assert.equal(res.progress.sectionNumber, 2);
  assert.equal(res.progress.inSection, 1);
});

test('one answer into Part 1 is a quarter of Part 1, not a sixth of the task', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  const res = await handle(store, { action: 'answer', token, index: 0, value: answerFor(0) }, T0 + 1_000);

  const p1 = res.progress.sections[0];
  // 1 of 4 questions in a section worth 60 of 90 minutes: (1/4) * 60 / 90 = 17%.
  assert.equal(res.progress.percentDone, 17);
  assert.equal(p1.done, 1);
  assert.equal(p1.state, 'current');
  assert.equal(res.progress.inSection, 2, 'the candidate is now on the second question of Part 1');
});

test('the section shares are whole percentages that describe the split', async () => {
  const { store, token } = await fixture();
  const res = await handle(store, { action: 'state', token }, T0);
  const shares = res.progress.sections.map((s) => s.share);
  assert.deepEqual(shares, [67, 33]);
  assert.equal(res.progress.sections.reduce((n, s) => n + s.total, 0), QUESTIONS.length,
    'every question belongs to exactly one section');
});

test('the recommended minutes add up to the time actually given', async () => {
  const total = SECTIONS.reduce((n, s) => n + s.recommendedMin, 0);
  assert.equal(total * 60, DURATION_SEC,
    'the progress bar and the clock would tell the candidate different stories');
});

test('progress is shown before starting, but never a question', async () => {
  const { store, token } = await fixture();
  const res = await handle(store, { action: 'state', token }, T0);
  assert.equal(res.phase, 'ready');
  assert.ok(res.progress, 'the instructions screen cannot show the shape of the task');
  assert.equal(res.question, undefined);
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

/* ------------------------------------------------------- formatted answers ---------- */

test('a formatted answer keeps its headings, marks, and lists', async () => {
  const { store, token } = await fixture();
  const i = QUESTIONS.findIndex((q) => q.type === 'rich');
  await handle(store, { action: 'start', token }, T0);
  const value = [
    { type: 'h2', runs: [{ t: 'Recommendation' }] },
    { type: 'p', runs: [{ t: 'Enter ' }, { t: 'three', b: 1, u: 1 }, { t: ' states.' }] },
    { type: 'bullet', runs: [{ t: 'Kwara' }] },
    { type: 'bullet', runs: [{ t: 'Benue' }] },
  ];
  await handle(store, { action: 'answer', token, index: i, value }, T0 + 5_000);

  const rec = await store.get(`c:${token}`);
  const saved = rec.answers[i].value;
  assert.equal(rec.answers[i].format, 'rich');
  assert.equal(saved[0].type, 'h2');
  assert.deepEqual(saved[1].runs[1], { t: 'three', b: 1, u: 1 });
  assert.equal(saved.filter((b) => b.type === 'bullet').length, 2);
  assert.equal(richToText(saved), '## Recommendation\nEnter three states.\n- Kwara\n- Benue');
});

test('nothing a candidate sends can become markup or an attribute', async () => {
  // The admin page renders answers, so this is the case that matters most. A candidate posting
  // directly, not using our editor, still cannot express a tag: only t/b/i/u survive, and t is
  // rendered with textContent. Everything else on the run and the block is dropped here.
  const hostile = [
    { type: 'script', runs: [{ t: 'alert(1)' }] },
    { type: 'p', tag: 'img', onerror: 'alert(1)', style: 'x', runs: [
      { t: '<img src=x onerror=alert(1)>', b: 1, href: 'javascript:alert(1)', style: 'color:red', size: 40 },
    ] },
  ];
  const { blocks } = sanitizeRich(hostile, 4000);

  assert.deepEqual(blocks.map((b) => b.type), ['p', 'p'], 'an unknown block type was preserved');
  for (const b of blocks) {
    assert.deepEqual(Object.keys(b).sort(), ['runs', 'type'], 'a block kept an extra key');
    for (const r of b.runs) {
      assert.ok(Object.keys(r).every((k) => ['t', 'b', 'i', 'u'].includes(k)), `run kept ${Object.keys(r)}`);
    }
  }
  // The angle brackets survive as literal text, which is correct: it is what they typed.
  assert.equal(richToText(blocks).includes('<img src=x onerror=alert(1)>'), true);
});

test('formatted answers are clamped to the question maxLength by text length', async () => {
  const { store, token } = await fixture();
  const i = QUESTIONS.findIndex((q) => q.type === 'rich' && q.maxLength);
  await handle(store, { action: 'start', token }, T0);
  const huge = Array.from({ length: 50 }, () => ({ type: 'p', runs: [{ t: 'x'.repeat(1000) }] }));
  await handle(store, { action: 'answer', token, index: i, value: huge }, T0 + 5_000);

  const rec = await store.get(`c:${token}`);
  const chars = rec.answers[i].value.reduce((n, b) => n + b.runs.reduce((m, r) => m + r.t.length, 0), 0);
  assert.equal(chars, QUESTIONS[i].maxLength);
});

test('a flood of blocks is capped rather than rejected', () => {
  const flood = Array.from({ length: MAX_BLOCKS + 500 }, (_, n) => ({ type: 'p', runs: [{ t: `line ${n}` }] }));
  const { blocks } = sanitizeRich(flood, 1_000_000);
  assert.equal(blocks.length, MAX_BLOCKS);
});

test('a formatted answer with only whitespace counts as unanswered', async () => {
  const { store, token } = await fixture();
  await handle(store, { action: 'start', token }, T0);
  const blankish = [{ type: 'h2', runs: [{ t: '   ' }] }, { type: 'p', runs: [] }];
  assert.equal(richIsEmpty(blankish), true);
  const res = await handle(store, { action: 'answer', token, index: 0, value: blankish }, T0 + 1_000);
  assert.equal(res.rejected, 'empty');
  assert.equal(res.answered, 0);
});

test('plain text answers still work alongside formatted ones', async () => {
  const { store, token } = await fixture();
  const shortIndex = QUESTIONS.findIndex((q) => q.type === 'short');
  await handle(store, { action: 'start', token }, T0);
  for (let i = 0; i < shortIndex; i++) {
    await handle(store, { action: 'answer', token, index: i, value: answerFor(i) }, T0 + (i + 1) * 1_000);
  }
  await handle(store, { action: 'answer', token, index: shortIndex, value: 'x'.repeat(50_000) }, T0 + 90_000);
  const rec = await store.get(`c:${token}`);
  assert.equal(rec.answers[shortIndex].format, 'text');
  assert.equal(rec.answers[shortIndex].value.length, QUESTIONS[shortIndex].maxLength);
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
  await handle(store, { action: 'answer', token: reg.token, index: 0, value: [{ type: 'p', runs: [{ t: 'Kwara and two others' }] }] }, T0 + 20_000);

  const rows = await listCandidates(store, T0 + 30_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Amina Yusuf');
  assert.equal(rows[0].phase, 'running');
  assert.equal(richToText(rows[0].answers[0].value), 'Kwara and two others');
});
