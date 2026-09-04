/**
 * Tests for branching: the route a candidate takes, and the guarantees that have to survive it.
 *
 * The flat-list version of this engine got guarantee 2 for free, because "the next question" was
 * `QUESTIONS[answers.length]` and there was nowhere else to go. Branching removes that, so every
 * property that used to be structural is now something code has to enforce, and therefore
 * something worth a test. The suite in engine.test.mjs covers the same guarantees against the
 * real, unbranched spec; this one covers them against a spec that branches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handle, createCandidates, listCandidates, toCsv, config } from '../functions/_lib/wt-engine.mjs';
import {
  currentQuestionId, remainingRange, validateFlow, optionLabels, routesFrom,
} from '../functions/_lib/wt-flow.mjs';

function memStore() {
  const db = new Map();
  return {
    async get(k) { return db.has(k) ? JSON.parse(db.get(k)) : null; },
    async put(k, v) { db.set(k, JSON.stringify(v)); },
    async delete(k) { db.delete(k); },
  };
}

/**
 * Three routes of three different lengths out of one choice, which is what makes the totals
 * genuinely uncertain rather than uncertain in principle only. `why_hold` keeps the short route
 * inside Part 1, so Part 2 can be observably skipped while the candidate is still sitting.
 */
const BRANCHY = [
  {
    id: 'stance',
    section: 'part1',
    type: 'choice',
    prompt: 'What do you recommend?',
    options: [
      { label: 'Expand into more states', next: 'expand_1' },
      { label: 'Pivot to a deeper pilot', next: 'pivot_1' },
      { label: 'Hold and gather data', next: 'why_hold' },
    ],
  },
  { id: 'why_hold', section: 'part1', type: 'short', prompt: 'Why hold?', next: null },
  { id: 'expand_1', section: 'part2', type: 'short', prompt: 'Which states would you add?', next: 'expand_2' },
  { id: 'expand_2', section: 'part2', type: 'short', prompt: 'What would you cut to pay for it?', next: 'wrap' },
  { id: 'pivot_1', section: 'part2', type: 'short', prompt: 'Pivot to what?', next: 'wrap' },
  { id: 'wrap', section: 'part2', type: 'short', required: false, prompt: 'Anything else?', next: null },
];

/** The two parts BRANCHY refers to, weighted like the original PM task: Part 1 is the bulk. */
const PARTS = [
  { id: 'part1', label: 'Part 1', summary: 'Analysis', recommendedMin: 60 },
  { id: 'part2', label: 'Part 2', summary: 'Follow-up', recommendedMin: 30 },
];

const CFG = config({ questions: BRANCHY, sections: PARTS, durationSec: 90 * 60 });
const T0 = 1_800_000_000_000;

async function started() {
  const store = memStore();
  const [c] = await createCandidates(store, [{ name: 'Branch Tester', email: 'b@example.com' }]);
  await handle(store, { action: 'start', token: c.token }, T0, CFG);
  return { store, token: c.token };
}

/** Answers the question currently open, whatever it is. `value` is an option index on a choice. */
const answer = (store, token, index, value, at, extra = {}) =>
  handle(store, { action: 'answer', token, index, value, ...extra }, at, CFG);

/* --------------------------------------------------------------- the route ---------- */

test('an option sends the candidate down its own branch', async () => {
  const { store, token } = await started();
  const res = await answer(store, token, 0, 0, T0 + 1000); // "Expand"
  assert.equal(res.question.id, 'expand_1');
  assert.equal(res.phase, 'running');
});

test('a different option from the same question leads somewhere else', async () => {
  const { store, token } = await started();
  const res = await answer(store, token, 0, 1, T0 + 1000); // "Pivot"
  assert.equal(res.question.id, 'pivot_1');
});

test('two candidates finish the same test after different numbers of questions', async () => {
  const short = await started();
  await answer(short.store, short.token, 0, 2, T0 + 1000); // "Hold"
  const shortEnd = await answer(short.store, short.token, 1, 'Costs outweigh reach', T0 + 2000);
  assert.equal(shortEnd.phase, 'done');
  assert.equal(shortEnd.answered, 2);

  const long = await started();
  await answer(long.store, long.token, 0, 0, T0 + 1000); // "Expand"
  await answer(long.store, long.token, 1, 'Kwara and Benue', T0 + 2000);
  await answer(long.store, long.token, 2, 'The baseline survey', T0 + 3000);
  const longEnd = await answer(long.store, long.token, 3, 'Nothing further', T0 + 4000);
  assert.equal(longEnd.phase, 'done');
  assert.equal(longEnd.answered, 4);
});

/* ------------------------------------------------- what the client may not see ------ */

test('an option never tells the candidate where it leads', async () => {
  const { store, token } = await started();
  const res = await handle(store, { action: 'state', token }, T0, CFG);
  // Plain strings, so there is no `next` to read. Picking is not also a preview of the cost of
  // picking, which is the whole reason optionLabels exists.
  assert.deepEqual(res.question.options, [
    'Expand into more states',
    'Pivot to a deeper pilot',
    'Hold and gather data',
  ]);
  for (const o of res.question.options) assert.equal(typeof o, 'string');
  assert.equal(JSON.stringify(res).includes('expand_1'), false);
});

test('a question on a branch not taken cannot be answered', async () => {
  const { store, token } = await started();
  await answer(store, token, 0, 0, T0 + 1000); // "Expand", so pivot_1 is now unreachable
  const res = await answer(store, token, 1, 'sneaking in', T0 + 2000, { questionId: 'pivot_1' });
  assert.equal(res.rejected, 'out_of_order');
  assert.equal(res.answered, 1);
  assert.equal(res.question.id, 'expand_1');
});

test('naming the right question still has to be the next index', async () => {
  const { store, token } = await started();
  const res = await answer(store, token, 5, 0, T0 + 1000, { questionId: 'stance' });
  assert.equal(res.rejected, 'out_of_order');
  assert.equal(res.answered, 0);
});

/* ----------------------------------------------------------------- totals ----------- */

test('no total is claimed while the routes ahead differ in length', async () => {
  const { store, token } = await started();
  const res = await handle(store, { action: 'state', token }, T0, CFG);
  assert.equal(res.total, null);
  assert.equal(res.question.total, null);
  // But the honest range is still there, so a page can say something true.
  assert.deepEqual(res.totalRange, { min: 2, max: 4, certain: false });
});

test('the total becomes certain once the branch is resolved', async () => {
  const { store, token } = await started();
  const res = await answer(store, token, 0, 0, T0 + 1000); // "Expand": one route from here
  assert.equal(res.total, 4);
  assert.equal(res.question.total, 4);
  assert.equal(res.totalRange.certain, true);
});

test('the last question on a route knows it is the last', async () => {
  const { store, token } = await started();
  await answer(store, token, 0, 2, T0 + 1000); // "Hold" leads to why_hold, which ends
  const res = await handle(store, { action: 'state', token }, T0 + 1500, CFG);
  assert.equal(res.question.id, 'why_hold');
  assert.equal(res.question.isLast, true);
});

/* ---------------------------------------------------------------- progress ---------- */

test('a part the branch routes around is marked skipped, not todo', async () => {
  const { store, token } = await started();
  const res = await answer(store, token, 0, 2, T0 + 1000); // "Hold": Part 2 is now unreachable
  const part2 = res.progress.sections.find((s) => s.id === 'part2');
  assert.equal(part2.state, 'skipped');
  assert.equal(part2.done, 0);
});

test('a skipped part does not hold a share of the bar that can never fill', async () => {
  const { store, token } = await started();
  const res = await answer(store, token, 0, 2, T0 + 1000);
  const part1 = res.progress.sections.find((s) => s.id === 'part1');
  // Part 1 is the whole of what is left to do, so it is the whole of the bar.
  assert.equal(part1.share, 100);
  assert.equal(res.progress.minutesLeft, part1.recommendedMin);
});

/* -------------------------------------------------- editing the spec underneath ----- */

test('rewording an option does not reroute a candidate who already chose it', async () => {
  const { store, token } = await started();
  await answer(store, token, 0, 0, T0 + 1000); // picked index 0, "Expand into more states"

  // An author fixes a typo mid-sitting. The route is decided by the recorded index, not the
  // wording, so the candidate carries on exactly where they were.
  const reworded = JSON.parse(JSON.stringify(BRANCHY));
  reworded[0].options[0].label = 'Expand into additional states';
  const res = await handle(store, { action: 'state', token }, T0 + 2000, { ...CFG, questions: reworded });
  assert.equal(res.question.id, 'expand_1');
});

test('a route back to an answered question ends the test rather than re-serving it', () => {
  const looping = [
    { id: 'a', type: 'short', prompt: 'A', next: 'b' },
    { id: 'b', type: 'short', prompt: 'B', next: 'a' },
  ];
  const answers = [{ id: 'a' }, { id: 'b' }];
  assert.equal(currentQuestionId(answers, looping), null);
});

/* --------------------------------------------------------------- pure flow ---------- */

test('a spec with no branching resolves exactly like a flat list', () => {
  const flat = [
    { id: 'one', type: 'short', prompt: '1' },
    { id: 'two', type: 'short', prompt: '2' },
    { id: 'three', type: 'short', prompt: '3' },
  ];
  assert.equal(currentQuestionId([], flat), 'one');
  assert.equal(currentQuestionId([{ id: 'one' }], flat), 'two');
  assert.equal(currentQuestionId([{ id: 'one' }, { id: 'two' }], flat), 'three');
  assert.equal(currentQuestionId([{ id: 'one' }, { id: 'two' }, { id: 'three' }], flat), null);
  assert.deepEqual(remainingRange('one', flat, []), { min: 3, max: 3, certain: true });
});

test('every route out of a branch is enumerated', () => {
  const { routes, truncated } = routesFrom('stance', BRANCHY, []);
  assert.equal(truncated, false);
  assert.deepEqual(routes.map((r) => r.length).sort(), [2, 3, 4]);
});

test('optionLabels accepts both the plain and the branching shape', () => {
  assert.deepEqual(optionLabels({ options: ['Yes', 'No'] }), ['Yes', 'No']);
  assert.deepEqual(optionLabels({ options: [{ label: 'Yes', next: 'a' }, { label: 'No' }] }), ['Yes', 'No']);
  assert.equal(optionLabels({ type: 'short' }), null);
});

/* -------------------------------------------------------------- validation ---------- */

test('the real spec is a valid flow', async () => {
  const { QUESTIONS } = await import('../functions/_lib/wt-questions.mjs');
  assert.deepEqual(validateFlow(QUESTIONS), []);
});

test('the branching fixture is a valid flow', () => {
  assert.deepEqual(validateFlow(BRANCHY), []);
});

test('a destination that does not exist is an error', () => {
  const problems = validateFlow([{ id: 'a', type: 'short', prompt: 'A', next: 'nowhere' }]);
  assert.equal(problems.some((p) => p.level === 'error' && p.message.includes('nowhere')), true);
});

test('an option pointing at nothing is an error', () => {
  const problems = validateFlow([
    { id: 'a', type: 'choice', prompt: 'A', options: [{ label: 'x', next: 'gone' }] },
  ]);
  assert.equal(problems.some((p) => p.level === 'error' && p.message.includes('gone')), true);
});

test('duplicate ids are an error', () => {
  const problems = validateFlow([
    { id: 'a', type: 'short', prompt: 'A', next: null },
    { id: 'a', type: 'short', prompt: 'A again', next: null },
  ]);
  assert.equal(problems.some((p) => p.message.includes('share the id')), true);
});

test('a choice with no options is an error', () => {
  const problems = validateFlow([{ id: 'a', type: 'choice', prompt: 'A', options: [] }]);
  assert.equal(problems.some((p) => p.message.includes('no options')), true);
});

test('branching on a question that is not a choice is an error', () => {
  const problems = validateFlow([
    { id: 'a', type: 'short', prompt: 'A', options: [{ label: 'x', next: 'b' }], next: 'b' },
    { id: 'b', type: 'short', prompt: 'B', next: null },
  ]);
  assert.equal(problems.some((p) => p.message.includes('not "choice"')), true);
});

test('a loop is an error, and an unreachable question is a warning', () => {
  const problems = validateFlow([
    { id: 'a', type: 'short', prompt: 'A', next: 'b' },
    { id: 'b', type: 'short', prompt: 'B', next: 'a' },
    { id: 'orphan', type: 'short', prompt: 'Nobody points here', next: null },
  ]);
  assert.equal(problems.some((p) => p.level === 'error' && p.message.includes('loops back')), true);
  assert.equal(problems.some((p) => p.level === 'warning' && p.message.includes('orphan')), true);
});

/* ------------------------------------------------------------------ review ---------- */

test('the admin listing reports a per-candidate total, and null while it is unknown', async () => {
  const { store, token } = await started();
  let rows = await listCandidates(store, T0 + 1000, CFG);
  assert.equal(rows[0].total, null); // three routes, three lengths

  await answer(store, token, 0, 1, T0 + 1000); // "Pivot"
  rows = await listCandidates(store, T0 + 2000, CFG);
  assert.equal(rows[0].total, 3);
});

test('the CSV records which question each answer belongs to', async () => {
  const { store, token } = await started();
  await answer(store, token, 0, 1, T0 + 1000); // "Pivot"
  await answer(store, token, 1, 'Deeper pilot in Kwara', T0 + 2000);

  const csv = toCsv(await listCandidates(store, T0 + 3000, CFG));
  const [head, ...rows] = csv.split('\r\n');
  assert.equal(head.includes('"question_id"'), true);
  assert.equal(rows[0].includes('"stance"'), true);
  assert.equal(rows[1].includes('"pivot_1"'), true);
  // Header and every row must have the same number of columns or the file will not open cleanly.
  const columns = (line) => line.split('","').length;
  for (const row of rows) assert.equal(columns(row), columns(head));
});

test('a choice answer is stored as its label, so the CSV reads as words not numbers', async () => {
  const { store, token } = await started();
  const res = await answer(store, token, 0, 1, T0 + 1000);
  assert.equal(res.phase, 'running');
  const rows = await listCandidates(store, T0 + 2000, CFG);
  assert.equal(rows[0].answers[0].value, 'Pivot to a deeper pilot');
  assert.equal(rows[0].answers[0].choiceIndex, 1);
});
