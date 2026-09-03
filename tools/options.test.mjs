/**
 * Tests for the settings that change the shape of a sitting: how the clock works, whether a
 * candidate can go back, whether they can revise, and what counts as having answered.
 *
 * Two of these settings switch off guarantees the rest of the engine is built around, so the
 * tests worth having are in pairs: the default behaviour, and the behaviour once an author has
 * deliberately turned it on. A regression that silently flips a default would otherwise change
 * what a hiring assessment measures without anyone noticing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handle, createCandidates, config, requireOf, attachmentOf } from '../functions/_lib/wt-engine.mjs';

function memStore() {
  const db = new Map();
  const files = [];
  return {
    files,
    async get(k) { return db.has(k) ? JSON.parse(db.get(k)) : null; },
    async put(k, v) { db.set(k, JSON.stringify(v)); },
    async delete(k) { db.delete(k); },
    async putFile(k, f) { files.push(f); return { attachmentId: `a${files.length}`, recordId: k }; },
  };
}

const T0 = 1_800_000_000_000;
const PDF = Buffer.from('%PDF-1.7 real enough', 'binary').toString('base64');
const rich = (t) => [{ type: 'p', runs: [{ t }] }];

const SECTIONS = [
  { id: 'p1', label: 'Part 1', summary: 'First', recommendedMin: 30, limitMin: 30 },
  { id: 'p2', label: 'Part 2', summary: 'Second', recommendedMin: 30, limitMin: 20 },
];

const LINEAR = [
  { id: 'a', section: 'p1', type: 'short', prompt: 'A' },
  { id: 'b', section: 'p1', type: 'short', prompt: 'B' },
  { id: 'c', section: 'p2', type: 'short', prompt: 'C', next: null },
];

const make = (over) => config({ sections: SECTIONS, questions: LINEAR, ...over });

async function started(store, cfg) {
  const [c] = await createCandidates(store, [{ name: 'Opt', email: 'o@example.com' }]);
  await handle(store, { action: 'start', token: c.token }, T0, cfg);
  return c.token;
}

/* -------------------------------------------------------------- timing ------------- */

test('by default there is one clock for the whole test', async () => {
  const store = memStore();
  const cfg = make({ durationSec: 3600 });
  const token = await started(store, cfg);
  const res = await handle(store, { action: 'state', token }, T0 + 1000, cfg);
  assert.equal(res.timing.mode, 'total');
  assert.equal(res.durationSec, 3600);
  assert.equal(res.deadline, T0 + 3600 * 1000);
});

test('an untimed test has no deadline and never expires', async () => {
  const store = memStore();
  const cfg = make({ timing: { mode: 'none' } });
  const token = await started(store, cfg);

  const res = await handle(store, { action: 'state', token }, T0 + 400 * 24 * 3600 * 1000, cfg);
  assert.equal(res.timing.mode, 'none');
  assert.equal(res.deadline, undefined);
  assert.equal(res.durationSec, null);
  assert.equal(res.phase, 'running', 'an untimed test expired');
});

test('per-part limits give each part its own clock', async () => {
  const store = memStore();
  const cfg = make({ timing: { mode: 'section' } });
  const token = await started(store, cfg);

  const first = await handle(store, { action: 'state', token }, T0 + 1000, cfg);
  assert.equal(first.clockFor, 'p1');
  assert.equal(first.deadline, T0 + 30 * 60 * 1000);

  // Into Part 2, and its 20 minutes start from the last answer rather than from the sitting.
  const at = T0 + 5 * 60 * 1000;
  await handle(store, { action: 'answer', token, index: 0, value: 'a' }, at, cfg);
  const second = await handle(store, { action: 'answer', token, index: 1, value: 'b' }, at + 1000, cfg);
  assert.equal(second.clockFor, 'p2');
  assert.equal(second.deadline, at + 1000 + 20 * 60 * 1000);
});

test('running out of a part moves on to the next rather than ending the test', async () => {
  const store = memStore();
  const cfg = make({ timing: { mode: 'section' } });
  const token = await started(store, cfg);

  // Come back an hour later: Part 1's thirty minutes are long gone.
  const res = await handle(store, { action: 'state', token }, T0 + 60 * 60 * 1000, cfg);
  assert.equal(res.phase, 'running', 'the sitting ended when only a part should have');
  assert.equal(res.question.id, 'c', 'not moved into Part 2');
  assert.equal(res.answered, 2, 'the unreached questions were not recorded');
});

test('questions missed to a spent part clock are recorded as skipped, not blank', async () => {
  const store = memStore();
  const cfg = make({ timing: { mode: 'section' } });
  const token = await started(store, cfg);
  await handle(store, { action: 'state', token }, T0 + 60 * 60 * 1000, cfg);

  const res = await handle(store, { action: 'review', token }, T0 + 60 * 60 * 1000, cfg);
  assert.equal(res.review.length, 2);
  const raw = await store.get(`c:${(await store.get('roster')).tokens[0]}`);
  assert.equal(raw.answers[0].skipped, true);
  assert.equal(raw.answers[1].skipped, true);
});

/* ---------------------------------------------------------- going back ------------- */

test('by default going back is not an operation that exists', async () => {
  const store = memStore();
  const cfg = make();
  const token = await started(store, cfg);
  await handle(store, { action: 'answer', token, index: 0, value: 'a' }, T0 + 1000, cfg);

  const res = await handle(store, { action: 'back', token }, T0 + 2000, cfg);
  assert.equal(res.rejected, 'no_back');
  assert.equal(res.question.id, 'b', 'the candidate moved');
  assert.equal(res.canGoBack, false);
});

test('with back navigation on, a candidate can look at an earlier answer', async () => {
  const store = memStore();
  const cfg = make({ navigation: { back: true } });
  const token = await started(store, cfg);
  await handle(store, { action: 'answer', token, index: 0, value: 'my first answer' }, T0 + 1000, cfg);

  const back = await handle(store, { action: 'back', token }, T0 + 2000, cfg);
  assert.equal(back.viewingIndex, 0);
  assert.equal(back.question.id, 'a');
  assert.equal(back.given.value, 'my first answer');
  assert.equal(back.editable, false, 'looking back implied being able to edit');

  // The frontier is untouched: stepping back does not un-answer anything.
  assert.equal(back.answered, 1);
  const forward = await handle(store, { action: 'forward', token }, T0 + 3000, cfg);
  assert.equal(forward.viewingIndex, null);
  assert.equal(forward.question.id, 'b');
});

test('looking back does not let the answer be changed unless editing is on', async () => {
  const store = memStore();
  const cfg = make({ navigation: { back: true } });
  const token = await started(store, cfg);
  await handle(store, { action: 'answer', token, index: 0, value: 'original' }, T0 + 1000, cfg);
  await handle(store, { action: 'back', token }, T0 + 2000, cfg);

  const res = await handle(store, { action: 'answer', token, index: 0, value: 'rewritten' }, T0 + 3000, cfg);
  assert.equal(res.rejected, 'no_edit');
  const check = await handle(store, { action: 'review', token }, T0 + 4000, cfg);
  assert.equal(check.review[0].value, 'original');
});

/* ------------------------------------------------------------ revising ------------- */

test('with editing on, an earlier answer can be replaced', async () => {
  const store = memStore();
  const cfg = make({ navigation: { back: true, edit: true } });
  const token = await started(store, cfg);
  await handle(store, { action: 'answer', token, index: 0, value: 'original' }, T0 + 1000, cfg);

  const res = await handle(store, { action: 'answer', token, index: 0, value: 'rewritten' }, T0 + 2000, cfg);
  assert.equal(res.revised, true);
  const check = await handle(store, { action: 'review', token }, T0 + 3000, cfg);
  assert.equal(check.review[0].value, 'rewritten');
  assert.equal(check.review.length, 1, 'revising added an answer instead of replacing one');
});

test('a revision that changes the route asks before discarding what followed', async () => {
  const branchy = [
    {
      id: 'pick', section: 'p1', type: 'choice', prompt: 'Which way?',
      options: [{ label: 'Left', next: 'left' }, { label: 'Right', next: 'right' }],
    },
    { id: 'left', section: 'p2', type: 'short', prompt: 'Why left?', next: null },
    { id: 'right', section: 'p2', type: 'short', prompt: 'Why right?', next: null },
  ];
  const store = memStore();
  const cfg = config({ sections: SECTIONS, questions: branchy, navigation: { back: true, edit: true } });
  const token = await started(store, cfg);

  await handle(store, { action: 'answer', token, index: 0, value: 0 }, T0 + 1000, cfg); // Left
  await handle(store, { action: 'answer', token, index: 1, value: 'because left' }, T0 + 2000, cfg);

  // Switching to Right strands the answer to "Why left?", so it must not happen silently.
  const asked = await handle(store, { action: 'answer', token, index: 0, value: 1 }, T0 + 3000, cfg);
  assert.equal(asked.rejected, 'would_discard');
  assert.equal(asked.wouldDiscard, 1);
  assert.equal(asked.answered, 2, 'it discarded before being told to');

  const done = await handle(store, { action: 'answer', token, index: 0, value: 1, confirmDiscard: true }, T0 + 4000, cfg);
  assert.equal(done.revised, true);
  assert.equal(done.answered, 1);
  const check = await handle(store, { action: 'review', token }, T0 + 5000, cfg);
  assert.equal(check.review.length, 1);
  assert.equal(check.review[0].value, 'Right');
});

test('a revision that keeps the route leaves the answers after it alone', async () => {
  const store = memStore();
  const cfg = make({ navigation: { back: true, edit: true } });
  const token = await started(store, cfg);
  await handle(store, { action: 'answer', token, index: 0, value: 'first' }, T0 + 1000, cfg);
  await handle(store, { action: 'answer', token, index: 1, value: 'second' }, T0 + 2000, cfg);

  const res = await handle(store, { action: 'answer', token, index: 0, value: 'first, improved' }, T0 + 3000, cfg);
  assert.equal(res.revised, true);
  assert.equal(res.answered, 2);
  const check = await handle(store, { action: 'review', token }, T0 + 4000, cfg);
  assert.equal(check.review[0].value, 'first, improved');
  assert.equal(check.review[1].value, 'second');
});

/* ------------------------------------------------- what counts as an answer -------- */

test('requireOf reads the old fields when a spec does not say', () => {
  assert.equal(requireOf({ type: 'rich' }), 'text');
  assert.equal(requireOf({ type: 'rich', required: false }), 'optional');
  assert.equal(requireOf({ type: 'upload' }), 'both');
  assert.equal(requireOf({ type: 'rich', attachment: 'required' }), 'both');
  assert.equal(requireOf({ type: 'rich', attachment: 'required', required: false }), 'file');
  // And an explicit setting wins over all of it.
  assert.equal(requireOf({ type: 'rich', require: 'either' }), 'either');
  assert.equal(attachmentOf({ type: 'rich', require: 'either' }), 'optional');
  assert.equal(attachmentOf({ type: 'rich', require: 'text' }), 'none');
});

test('"a file or a written answer" accepts either one on its own', async () => {
  const spec = [{ id: 'work', section: 'p1', type: 'rich', require: 'either', prompt: 'Your working', accept: ['pdf'], next: null }];
  const cfg = config({ sections: SECTIONS, questions: spec });

  // Neither: refused.
  const a = memStore();
  const t1 = await started(a, cfg);
  const empty = await handle(a, { action: 'answer', token: t1, index: 0, value: '' }, T0 + 1000, cfg);
  assert.equal(empty.rejected, 'need_one');

  // Text alone: accepted.
  const b = memStore();
  const t2 = await started(b, cfg);
  const text = await handle(b, { action: 'answer', token: t2, index: 0, value: rich('here is my reasoning') }, T0 + 1000, cfg);
  assert.equal(text.phase, 'done');

  // A file alone: also accepted.
  const c = memStore();
  const t3 = await started(c, cfg);
  await handle(c, { action: 'upload', token: t3, questionId: 'work', filename: 'work.pdf', contentType: 'application/pdf', data: PDF }, T0 + 1000, cfg);
  const file = await handle(c, { action: 'answer', token: t3, index: 0, value: '' }, T0 + 2000, cfg);
  assert.equal(file.phase, 'done');
});

test('a question can take a file alongside text without insisting on one', async () => {
  const spec = [{ id: 'work', section: 'p1', type: 'rich', require: 'text', attachment: 'optional', prompt: 'Your working', next: null }];
  const cfg = config({ sections: SECTIONS, questions: spec });
  const store = memStore();
  const token = await started(store, cfg);

  const res = await handle(store, { action: 'state', token }, T0 + 500, cfg);
  assert.equal(res.question.attachment, 'optional');
  assert.equal(res.question.require, 'text');

  const done = await handle(store, { action: 'answer', token, index: 0, value: rich('no file needed') }, T0 + 1000, cfg);
  assert.equal(done.phase, 'done');
});

/* --------------------------------------------------- what candidates are told ----- */

/**
 * The instructions page is where promises are made to someone about to be assessed, so the rules
 * on it have to describe the test that is actually configured. It used to be hardcoded HTML,
 * which meant it went on saying "you cannot go back" and "the clock does not stop" long after
 * either had stopped being true.
 */
const leads = (res) => res.intro.rules.map((r) => r.lead);

test('the instructions describe a single clock when there is one', async () => {
  const store = memStore();
  const cfg = make({ durationSec: 3600 });
  const [c] = await createCandidates(store, [{ name: 'A', email: 'a@example.com' }]);
  const res = await handle(store, { action: 'state', token: c.token }, T0, cfg);
  assert.equal(res.phase, 'ready');
  assert.ok(leads(res).includes('The clock does not stop or restart.'));
  assert.equal(res.intro.startLabel, 'I understand, start the clock');
});

test('an untimed test does not tell anyone about a clock', async () => {
  const store = memStore();
  const cfg = make({ timing: { mode: 'none' } });
  const [c] = await createCandidates(store, [{ name: 'A', email: 'a@example.com' }]);
  const res = await handle(store, { action: 'state', token: c.token }, T0, cfg);
  assert.ok(leads(res).includes('There is no time limit.'));
  assert.equal(leads(res).some((l) => l.includes('clock does not stop')), false);
  // Pressing a button labelled "start the clock" on an untimed test is a small lie of its own.
  assert.equal(res.intro.startLabel, 'I understand, begin');
});

test('per-part limits are explained as per-part limits', async () => {
  const store = memStore();
  const cfg = make({ timing: { mode: 'section' } });
  const [c] = await createCandidates(store, [{ name: 'A', email: 'a@example.com' }]);
  const res = await handle(store, { action: 'state', token: c.token }, T0, cfg);
  assert.ok(leads(res).includes('Each part has its own time limit.'));
});

test('the going-back rule follows the setting rather than a hardcoded promise', async () => {
  const forOptions = async (navigation) => {
    const store = memStore();
    const cfg = make(navigation ? { navigation } : {});
    const [c] = await createCandidates(store, [{ name: 'A', email: 'a@example.com' }]);
    return leads(await handle(store, { action: 'state', token: c.token }, T0, cfg));
  };

  assert.ok((await forOptions(null)).includes('You cannot go back.'));
  assert.ok((await forOptions({ back: true })).includes('You can look back, but not change anything.'));
  assert.ok((await forOptions({ back: true, edit: true })).includes('You can go back and change your answers.'));

  // And never two of them at once, which is what a hardcoded list plus a generated one would do.
  const both = await forOptions({ back: true, edit: true });
  assert.equal(both.filter((l) => l.startsWith('You can') || l.startsWith('You cannot')).length, 1);
});

test('blocked pasting is stated, and not contradicted by the formatting rule', async () => {
  const store = memStore();
  const cfg = config({
    sections: SECTIONS,
    questions: [{ id: 'a', section: 'p1', type: 'rich', prompt: 'A', next: null }],
    integrity: { blockPaste: true },
  });
  const [c] = await createCandidates(store, [{ name: 'A', email: 'a@example.com' }]);
  const res = await handle(store, { action: 'state', token: c.token }, T0, cfg);
  assert.ok(leads(res).includes('Pasting is switched off.'));
  const formatting = res.intro.rules.find((r) => r.lead === 'You can format your answers.');
  assert.equal(formatting.text.includes('Pasting'), false, 'told them pasting keeps formatting while blocking it');
});

test('files are only mentioned when a question actually takes one', async () => {
  const noFiles = memStore();
  const plain = make();
  const [a] = await createCandidates(noFiles, [{ name: 'A', email: 'a@example.com' }]);
  const without = await handle(noFiles, { action: 'state', token: a.token }, T0, plain);
  assert.equal(leads(without).includes('Some answers take a file.'), false);

  const withFiles = memStore();
  const cfg = config({
    sections: SECTIONS,
    questions: [{ id: 'a', section: 'p1', type: 'rich', require: 'either', accept: ['pdf'], prompt: 'A', next: null }],
  });
  const [b] = await createCandidates(withFiles, [{ name: 'B', email: 'b@example.com' }]);
  const res = await handle(withFiles, { action: 'state', token: b.token }, T0, cfg);
  const rule = res.intro.rules.find((r) => r.lead === 'Some answers take a file.');
  assert.match(rule.text, /PDF/);
  assert.match(rule.text, /enough on its own/, 'did not explain what "either" means');
});

test('the author’s own rules and prose come through, after the generated ones', async () => {
  const store = memStore();
  const cfg = make({
    intro: {
      blurb: 'A note before the rules.',
      rules: [{ lead: 'Part 1 needs a spreadsheet.', text: 'Work in your own copy.' }],
      sections: [{ heading: 'What we are looking for', text: 'Clarity over polish.' }],
      closing: 'Please do not share this task.',
      contactEmail: 'careers@aiaccessinitiative.org',
    },
  });
  const [c] = await createCandidates(store, [{ name: 'A', email: 'a@example.com' }]);
  const res = await handle(store, { action: 'state', token: c.token }, T0, cfg);

  assert.equal(res.intro.blurb, 'A note before the rules.');
  assert.equal(res.intro.sections[0].heading, 'What we are looking for');
  assert.equal(res.intro.closing, 'Please do not share this task.');
  assert.equal(res.intro.contactEmail, 'careers@aiaccessinitiative.org');
  // Last, so the rules the engine actually enforces are read first.
  assert.equal(leads(res)[leads(res).length - 1], 'Part 1 needs a spreadsheet.');
});

test('a contact address that is not an address is dropped rather than linked', async () => {
  const store = memStore();
  const cfg = make({ intro: { contactEmail: 'javascript:alert(1)' } });
  const [c] = await createCandidates(store, [{ name: 'A', email: 'a@example.com' }]);
  const res = await handle(store, { action: 'state', token: c.token }, T0, cfg);
  assert.equal(res.intro.contactEmail, null);
});

test('the instructions are not sent once the test is under way', async () => {
  const store = memStore();
  const cfg = make();
  const token = await started(store, cfg);
  const res = await handle(store, { action: 'state', token }, T0 + 1000, cfg);
  assert.equal(res.phase, 'running');
  assert.equal(res.intro, undefined);
});

/* ------------------------------------------------------------ paste ---------------- */

test('paste blocking is a test-wide setting a question can override', async () => {
  const spec = [
    { id: 'open', section: 'p1', type: 'rich', prompt: 'Open' },
    { id: 'closed', section: 'p1', type: 'rich', prompt: 'Closed', blockPaste: true, next: null },
  ];
  const cfg = config({ sections: SECTIONS, questions: spec });
  const store = memStore();
  const token = await started(store, cfg);

  const first = await handle(store, { action: 'state', token }, T0 + 500, cfg);
  assert.equal(first.question.blockPaste, false);

  await handle(store, { action: 'answer', token, index: 0, value: rich('x') }, T0 + 1000, cfg);
  const second = await handle(store, { action: 'state', token }, T0 + 1500, cfg);
  assert.equal(second.question.blockPaste, true, 'the per-question override was ignored');
});

test('blocking paste for the whole test reaches every question', async () => {
  const cfg = make({ integrity: { blockPaste: true } });
  const store = memStore();
  const token = await started(store, cfg);
  const res = await handle(store, { action: 'state', token }, T0 + 500, cfg);
  assert.equal(res.blockPaste, true);
  assert.equal(res.question.blockPaste, true);
});
