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

import { handle, createCandidates, config, requireOf, attachmentOf, introFor } from '../functions/_lib/wt-engine.mjs';

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

/* ------------------------------------------------------------ at a glance ----------- */

test('an untimed test carries the author\'s suggested time on the timing rule and the glance tile', () => {
  const intro = introFor(make({ timing: { mode: 'none' }, intro: { estimate: 'We suggest about 4 hours.' } }));
  assert.equal(intro.rules[0].lead, 'There is no time limit.');
  assert.match(intro.rules[0].text, /We suggest about 4 hours\./);
  assert.equal(intro.glance[0].label, 'Time');
  assert.match(intro.glance[0].text, /^Not timed\. We suggest about 4 hours\./);
});

test('a timed test ignores the estimate: the clock is the estimate', () => {
  const intro = introFor(make({ durationSec: 3600, intro: { estimate: 'We suggest about 4 hours.' } }));
  assert.ok(!intro.rules.some((r) => /suggest about 4 hours/.test(r.text)));
  assert.match(intro.glance[0].text, /^60 minutes on one clock/);
});

test('structure is the author\'s when given, and written from the parts when not', () => {
  const own = introFor(make({ intro: { structure: 'Two stages, then a closing question.' } }));
  assert.equal(own.glance[1].label, 'Structure');
  assert.equal(own.glance[1].text, 'Two stages, then a closing question.');
  const generated = introFor(make({}));
  assert.match(generated.glance[1].text, /^2 parts, one question at a time\. Answers are final once submitted\./);
  const revisable = introFor(make({ navigation: { back: true, edit: true } }));
  assert.match(revisable.glance[1].text, /You can go back and change answers\./);
});

test('the last question of a part names the part it leads into, and nothing else does', async () => {
  const store = memStore();
  const cfg = make({
    questions: [
      { id: 'pick', section: 'p1', type: 'choice', prompt: 'Pick', options: [{ label: 'A', next: 'a' }, { label: 'B', next: 'b' }] },
      { id: 'a', section: 'p1', type: 'short', prompt: 'A', next: 'end' },
      { id: 'b', section: 'p1', type: 'short', prompt: 'B', next: 'end' },
      { id: 'end', section: 'p2', type: 'short', prompt: 'End', next: null },
    ],
  });
  const token = await started(store, cfg);
  const first = await handle(store, { action: 'state', token }, T0 + 1000, cfg);
  assert.equal(first.question.nextPart, null, 'both options stay in Part 1, so no part is named');
  const second = await handle(store, { action: 'answer', token, index: 0, questionId: 'pick', value: 1 }, T0 + 2000, cfg);
  assert.equal(second.question.id, 'b');
  assert.equal(second.question.nextPart, 'Part 2', 'the write-up closes Part 1 and leads into Part 2');
  const last = await handle(store, { action: 'answer', token, index: 1, questionId: 'b', value: 'x' }, T0 + 3000, cfg);
  assert.equal(last.question.nextPart, null, 'the final question leads nowhere');
  assert.equal(last.question.isLast, true);
});

test('format says what the questions actually accept', () => {
  const typed = introFor(make({}));
  assert.equal(typed.glance[2].label, 'Format');
  assert.equal(typed.glance[2].text, 'Typed answers.');
  const withPdf = introFor(make({
    questions: [{ id: 'a', section: 'p1', type: 'rich', require: 'either', accept: ['pdf'], prompt: 'A', next: null }],
  }));
  assert.match(withPdf.glance[2].text, /^Type or paste your answer, or attach a PDF up to 4\.5 MB\.$/);
  assert.ok(!/Word/.test(withPdf.glance[2].text), 'a PDF-only question must not promise Word');
});

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
  assert.equal(leads(without).includes('How to submit your answers.'), false);
  assert.equal(leads(without).includes('You can format your answers.'), false, 'plain text questions need no formatting rule');

  const withFiles = memStore();
  const cfg = config({
    sections: SECTIONS,
    questions: [{ id: 'a', section: 'p1', type: 'rich', require: 'either', accept: ['pdf'], prompt: 'A', next: null }],
  });
  const [b] = await createCandidates(withFiles, [{ name: 'B', email: 'b@example.com' }]);
  const res = await handle(withFiles, { action: 'state', token: b.token }, T0, cfg);
  const rule = res.intro.rules.find((r) => r.lead === 'How to submit your answers.');
  assert.match(rule.text, /PDF/);
  assert.match(rule.text, /enough on its own/, 'did not explain what "either" means');
  assert.match(rule.text, /headings, subheadings, bold/, 'formatting is folded into the same rule');
  assert.equal(leads(res).includes('You can format your answers.'), false, 'formatting must not be a second rule');
});

test('the author\'s submit note rides on the submit rule', async () => {
  const store = memStore();
  const cfg = config({
    sections: SECTIONS,
    questions: [{ id: 'a', section: 'p1', type: 'rich', require: 'either', accept: ['pdf'], prompt: 'A', next: null }],
    intro: { submitNote: 'Draft in Word first.' },
  });
  const [c] = await createCandidates(store, [{ name: 'A', email: 'a@example.com' }]);
  const res = await handle(store, { action: 'state', token: c.token }, T0, cfg);
  const rule = res.intro.rules.find((r) => r.lead === 'How to submit your answers.');
  assert.match(rule.text, /Draft in Word first\.$/);
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

/* ------------------------------------------------- the client's clock is cosmetic ---- */

/**
 * The page calls `finish` when its countdown reaches zero. What that means is the server's call,
 * because the page's clock is cosmetic and the page is not trusted. These pin down all three
 * modes, and the one that mattered most: on per-part timing, a part's countdown reaching zero
 * used to END THE WHOLE TEST, the exact opposite of what the setting promises.
 */
test('on per-part timing, finishing a part does not end the sitting', async () => {
  const store = memStore();
  const cfg = make({ timing: { mode: 'section' } });
  const token = await started(store, cfg);

  // Part 1 is 30 minutes. Come back at 31 with the page saying "time's up".
  const res = await handle(store, { action: 'finish', token }, T0 + 31 * 60 * 1000, cfg);
  assert.equal(res.phase, 'running', 'the sitting was ended by a single part running out');
  assert.equal(res.question.id, 'c', 'not moved on into Part 2');
  assert.equal(res.ranOut, false);
});

test('on one clock, the page cannot end a sitting before the deadline', async () => {
  const store = memStore();
  const cfg = make({ durationSec: 3600 });
  const token = await started(store, cfg);

  const early = await handle(store, { action: 'finish', token }, T0 + 5 * 60 * 1000, cfg);
  assert.equal(early.rejected, 'not_yet');
  assert.equal(early.phase, 'running');

  const late = await handle(store, { action: 'finish', token }, T0 + 61 * 60 * 1000, cfg);
  assert.equal(late.phase, 'done');
  assert.equal(late.ranOut, true);
});

test('on an untimed test, finish does nothing at all', async () => {
  const store = memStore();
  const cfg = make({ timing: { mode: 'none' } });
  const token = await started(store, cfg);
  const res = await handle(store, { action: 'finish', token }, T0 + 400 * 24 * 3600 * 1000, cfg);
  assert.equal(res.phase, 'running');
  assert.equal(res.ranOut, false);
});

/* ----------------------------------------------------- what the first screen hears --- */

test('hello describes the clock the way the test is actually set', async () => {
  const untimed = await handle(memStore(), { action: 'hello' }, T0, make({ timing: { mode: 'none' } }));
  assert.equal(untimed.durationSec, null, 'an untimed test reported a duration');
  assert.equal(untimed.timing.mode, 'none');

  const timed = await handle(memStore(), { action: 'hello' }, T0, make({ durationSec: 1800 }));
  assert.equal(timed.durationSec, 1800);
  assert.equal(timed.timing.mode, 'total');
});

/* ------------------------------------------------------------- resume ------------- */

test('resume jumps back to the newest question however far back they stepped', async () => {
  const store = memStore();
  const cfg = make({ navigation: { back: true } });
  const token = await started(store, cfg);
  await handle(store, { action: 'answer', token, index: 0, value: 'a' }, T0 + 1000, cfg);
  await handle(store, { action: 'answer', token, index: 1, value: 'b' }, T0 + 2000, cfg);
  await handle(store, { action: 'back', token }, T0 + 3000, cfg);
  const twoBack = await handle(store, { action: 'back', token }, T0 + 4000, cfg);
  assert.equal(twoBack.viewingIndex, 0);

  // "Back to where I was" has to mean the frontier, not one step forward.
  const res = await handle(store, { action: 'resume', token }, T0 + 5000, cfg);
  assert.equal(res.viewingIndex, null);
  assert.equal(res.question.id, 'c');
});

test('resume is refused on a test with no going back', async () => {
  const store = memStore();
  const cfg = make();
  const token = await started(store, cfg);
  const res = await handle(store, { action: 'resume', token }, T0 + 1000, cfg);
  assert.equal(res.rejected, 'no_back');
});

/* ------------------------------------------------- files on a revisable test ------- */

test('on a revisable test, the file of an earlier answer can be replaced too', async () => {
  // Before this, a candidate could change an earlier answer's words but never its file: uploads
  // were accepted only for the newest question.
  const spec = [
    { id: 'work', section: 'p1', type: 'rich', require: 'either', accept: ['pdf'], prompt: 'Working' },
    { id: 'notes', section: 'p1', type: 'short', required: false, prompt: 'Notes', next: null },
  ];
  const cfg = config({ sections: SECTIONS, questions: spec, navigation: { back: true, edit: true } });
  const store = memStore();
  const token = await started(store, cfg);

  await handle(store, { action: 'answer', token, index: 0, value: rich('first version') }, T0 + 1000, cfg);
  await handle(store, { action: 'answer', token, index: 1, value: 'n' }, T0 + 2000, cfg);
  await handle(store, { action: 'back', token }, T0 + 3000, cfg);
  const looking = await handle(store, { action: 'back', token }, T0 + 4000, cfg);
  assert.equal(looking.question.id, 'work');

  const up = await handle(store, {
    action: 'upload', token, questionId: 'work',
    filename: 'better.pdf', contentType: 'application/pdf', data: PDF,
  }, T0 + 5000, cfg);
  assert.equal(up.ok, true, `upload while revising was refused: ${up.rejected || up.error}`);
  assert.equal(store.files.length, 1);

  const saved = await handle(store, { action: 'answer', token, index: 0, value: rich('first version') }, T0 + 6000, cfg);
  assert.equal(saved.revised, true);
  const review = await handle(store, { action: 'review', token }, T0 + 7000, cfg);
  assert.equal(review.review[0].upload.filename, 'better.pdf', 'the saved revision did not carry the new file');
});

/* ------------------------------------------------------- the closing screen -------- */

test('the closing screen counts what was given, not what was reached', async () => {
  // Section mode, come back after Part 1 has expired: two questions skipped, one left to answer.
  const store = memStore();
  const cfg = make({ timing: { mode: 'section' } });
  const token = await started(store, cfg);
  const later = T0 + 60 * 60 * 1000;
  await handle(store, { action: 'answer', token, index: 2, value: 'c' }, later, cfg);
  const res = await handle(store, { action: 'state', token }, later + 1000, cfg);

  assert.equal(res.phase, 'done');
  // "All 3 answers are recorded" would be the old, overstated claim. One was given; two were not.
  assert.match(res.outro.body, /1 answer/);
  assert.match(res.outro.body, /2 questions were not reached/);
  assert.equal(res.outro.body.includes('All 3'), false);
});

test('the closing screen does not promise the link is dead when revising is allowed', async () => {
  const closed = memStore();
  const plain = make();
  const t1 = await started(closed, plain);
  await handle(closed, { action: 'answer', token: t1, index: 0, value: 'a' }, T0 + 1000, plain);
  await handle(closed, { action: 'answer', token: t1, index: 1, value: 'b' }, T0 + 2000, plain);
  const fin = await handle(closed, { action: 'answer', token: t1, index: 2, value: 'c' }, T0 + 3000, plain);
  assert.equal(fin.phase, 'done');
  assert.match(fin.outro.note, /the task itself is finished/);
  assert.equal(fin.canRevise, false);

  const open = memStore();
  const editable = make({ navigation: { back: true, edit: true } });
  const t2 = await started(open, editable);
  await handle(open, { action: 'answer', token: t2, index: 0, value: 'a' }, T0 + 1000, editable);
  await handle(open, { action: 'answer', token: t2, index: 1, value: 'b' }, T0 + 2000, editable);
  const fin2 = await handle(open, { action: 'answer', token: t2, index: 2, value: 'c' }, T0 + 3000, editable);
  assert.equal(fin2.phase, 'done');
  assert.match(fin2.outro.note, /lets you change what you submitted/);
  assert.equal(fin2.canRevise, true);
});

test('stepping back after finishing serves the question, so revising is reachable', async () => {
  // Before this, the engine accepted a revision after the route ended but `back` served no
  // question to revise, so the setting was switched on and impossible to use.
  const store = memStore();
  const cfg = make({ navigation: { back: true, edit: true } });
  const token = await started(store, cfg);
  await handle(store, { action: 'answer', token, index: 0, value: 'a' }, T0 + 1000, cfg);
  await handle(store, { action: 'answer', token, index: 1, value: 'b' }, T0 + 2000, cfg);
  await handle(store, { action: 'answer', token, index: 2, value: 'c' }, T0 + 3000, cfg);

  const back = await handle(store, { action: 'back', token }, T0 + 4000, cfg);
  assert.equal(back.phase, 'done', 'stepping back should not un-finish the test by itself');
  assert.ok(back.question, 'no question was served to revise');
  assert.equal(back.question.id, 'c');
  assert.equal(back.given.value, 'c');
  assert.equal(back.editable, true);

  const rev = await handle(store, { action: 'answer', token, index: 2, value: 'c, improved' }, T0 + 5000, cfg);
  assert.equal(rev.revised, true);
  const check = await handle(store, { action: 'review', token }, T0 + 6000, cfg);
  assert.equal(check.review[2].value, 'c, improved');
});

test('looking back after finishing describes the part on screen, not a frontier that is gone', async () => {
  // The client draws "Part N of M" from progress.sectionNumber. Built against the frontier, which
  // is null once the route has ended, that number was 0, the page indexed sections[-1], and the
  // whole question screen threw before filling a single hook. Anchoring on the question being
  // looked at fixes it and is also simply more truthful.
  const store = memStore();
  const cfg = make({ navigation: { back: true, edit: true } });
  const token = await started(store, cfg);
  await handle(store, { action: 'answer', token, index: 0, value: 'a' }, T0 + 1000, cfg);
  await handle(store, { action: 'answer', token, index: 1, value: 'b' }, T0 + 2000, cfg);
  await handle(store, { action: 'answer', token, index: 2, value: 'c' }, T0 + 3000, cfg);

  const back = await handle(store, { action: 'back', token }, T0 + 4000, cfg);
  assert.ok(back.progress, 'no progress sent with the question');
  const here = back.progress.sections[back.progress.sectionNumber - 1];
  assert.ok(here, `sectionNumber ${back.progress.sectionNumber} points at no part`);
  assert.equal(here.id, 'p2', 'the part described is not the one the question belongs to');
});

test('once the clock has run out, nothing can be revised and the screen says so', async () => {
  const store = memStore();
  const cfg = make({ durationSec: 60, navigation: { back: true, edit: true } });
  const token = await started(store, cfg);
  await handle(store, { action: 'answer', token, index: 0, value: 'a' }, T0 + 1000, cfg);

  const late = T0 + 10 * 60 * 1000;
  const res = await handle(store, { action: 'state', token }, late, cfg);
  assert.equal(res.phase, 'expired');
  assert.equal(res.canRevise, false);
  assert.equal(res.outro.title, 'Time is up');
  const rev = await handle(store, { action: 'answer', token, index: 0, value: 'too late' }, late + 1000, cfg);
  assert.equal(rev.rejected, 'expired');
});

test('the author’s closing words and contact address come through', async () => {
  const store = memStore();
  const cfg = make({ outro: { closing: 'We review within 5 business days.', contactEmail: 'careers@aiaccessinitiative.org' } });
  const token = await started(store, cfg);
  await handle(store, { action: 'answer', token, index: 0, value: 'a' }, T0 + 1000, cfg);
  await handle(store, { action: 'answer', token, index: 1, value: 'b' }, T0 + 2000, cfg);
  const res = await handle(store, { action: 'answer', token, index: 2, value: 'c' }, T0 + 3000, cfg);
  assert.equal(res.outro.closing, 'We review within 5 business days.');
  assert.equal(res.outro.contactEmail, 'careers@aiaccessinitiative.org');
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
  // Paste blocking travels on the question, and only there. A top-level copy used to exist and
  // the page read that one instead, so a per-question override was silently ignored.
  assert.equal(res.question.blockPaste, true);
  assert.equal('blockPaste' in res, false, 'a test-wide flag is sent that the page could mistake for the question’s');
});

/* ------------------------------------------------------------ decision --------------- */

const DECIDE = [
  {
    id: 'd', section: 'p1', type: 'decision', require: 'either', accept: ['pdf'], prompt: 'Decide and write it up',
    options: [{ label: 'Hold', next: 'hold' }, { label: 'Grow', next: 'grow' }],
  },
  { id: 'hold', section: 'p2', type: 'short', prompt: 'Why hold?', next: null },
  { id: 'grow', section: 'p2', type: 'short', prompt: 'Why grow?', next: null },
];

test('a decision question needs an option, then routes on it and keeps the write-up', async () => {
  const store = memStore();
  const cfg = config({ sections: SECTIONS, questions: DECIDE, timing: { mode: 'none' } });
  const token = await started(store, cfg);
  const shown = await handle(store, { action: 'state', token }, T0 + 500, cfg);
  assert.equal(shown.question.type, 'decision');
  assert.deepEqual(shown.question.options, ['Hold', 'Grow'], 'labels only, never destinations');
  assert.equal(shown.question.nextPart, 'Part 2');

  const noPick = await handle(store, { action: 'answer', token, index: 0, questionId: 'd', value: { text: rich('words') } }, T0 + 1000, cfg);
  assert.equal(noPick.rejected, 'no_choice');
  const noText = await handle(store, { action: 'answer', token, index: 0, questionId: 'd', value: { option: 1, text: [] } }, T0 + 1000, cfg);
  assert.equal(noText.rejected, 'need_one', 'an option alone is not an answer on an either question');

  const ok = await handle(store, { action: 'answer', token, index: 0, questionId: 'd', value: { option: 1, text: rich('because growth') } }, T0 + 2000, cfg);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.question.id, 'grow', 'the option decided the route');

  const review = await handle(store, { action: 'review', token }, T0 + 3000, cfg);
  assert.equal(review.review[0].choice, 'Grow');
  assert.equal(review.review[0].value[0].runs[0].t, 'because growth');
});

test('a decision question accepts a file instead of text, like any either question', async () => {
  const store = memStore();
  const cfg = config({ sections: SECTIONS, questions: DECIDE, timing: { mode: 'none' } });
  const token = await started(store, cfg);
  const up = await handle(store, { action: 'upload', token, questionId: 'd', filename: 'memo.pdf', contentType: 'application/pdf', data: PDF }, T0 + 500, cfg);
  assert.equal(up.ok, true, JSON.stringify(up));
  const ok = await handle(store, { action: 'answer', token, index: 0, questionId: 'd', value: { option: 0, text: [] } }, T0 + 1000, cfg);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.question.id, 'hold');
  const review = await handle(store, { action: 'review', token }, T0 + 2000, cfg);
  assert.equal(review.review[0].uploads.length, 1);
  assert.equal(review.review[0].choice, 'Hold');
});

test('a bogus option index is refused rather than routed anywhere', async () => {
  const store = memStore();
  const cfg = config({ sections: SECTIONS, questions: DECIDE, timing: { mode: 'none' } });
  const token = await started(store, cfg);
  const res = await handle(store, { action: 'answer', token, index: 0, questionId: 'd', value: { option: 7, text: rich('x') } }, T0 + 1000, cfg);
  assert.equal(res.rejected, 'no_choice');
});

/* ------------------------------------------------------------ several files ---------- */

test('a question with maxFiles collects files up to the cap and hands them all to the answer', async () => {
  const store = memStore();
  const cfg = config({
    sections: SECTIONS,
    questions: [{ id: 't', section: 'p1', type: 'rich', require: 'either', accept: ['pdf'], maxFiles: 2, prompt: 'Transcripts', next: null }],
    timing: { mode: 'none' },
  });
  const token = await started(store, cfg);
  const one = await handle(store, { action: 'upload', token, questionId: 't', filename: 'a.pdf', contentType: 'application/pdf', data: PDF }, T0 + 500, cfg);
  assert.equal(one.uploads.length, 1);
  assert.equal(one.uploaded.filename, 'a.pdf');
  const two = await handle(store, { action: 'upload', token, questionId: 't', filename: 'b.pdf', contentType: 'application/pdf', data: PDF }, T0 + 600, cfg);
  assert.deepEqual(two.uploads.map((f) => f.filename), ['a.pdf', 'b.pdf'], 'the second file was added, not swapped in');
  const three = await handle(store, { action: 'upload', token, questionId: 't', filename: 'c.pdf', contentType: 'application/pdf', data: PDF }, T0 + 700, cfg);
  assert.equal(three.ok, false);
  assert.equal(three.error, 'too_many_files');
  assert.equal(store.files.length, 2, 'the refused file must not reach the store');

  const back = await handle(store, { action: 'state', token }, T0 + 800, cfg);
  assert.equal(back.uploads.length, 2, 'a refresh shows every file already attached');

  const ok = await handle(store, { action: 'answer', token, index: 0, questionId: 't', value: [] }, T0 + 1000, cfg);
  assert.equal(ok.phase, 'done');
  const review = await handle(store, { action: 'review', token }, T0 + 2000, cfg);
  assert.deepEqual(review.review[0].uploads.map((f) => f.filename), ['a.pdf', 'b.pdf']);
  assert.equal(review.review[0].upload.filename, 'a.pdf', 'the single-file field still points at the first for older readers');
});

test('a single-file question still replaces rather than accumulates', async () => {
  const store = memStore();
  const cfg = config({
    sections: SECTIONS,
    questions: [{ id: 'f', section: 'p1', type: 'rich', require: 'either', accept: ['pdf'], prompt: 'One file', next: null }],
    timing: { mode: 'none' },
  });
  const token = await started(store, cfg);
  await handle(store, { action: 'upload', token, questionId: 'f', filename: 'a.pdf', contentType: 'application/pdf', data: PDF }, T0 + 500, cfg);
  const two = await handle(store, { action: 'upload', token, questionId: 'f', filename: 'b.pdf', contentType: 'application/pdf', data: PDF }, T0 + 600, cfg);
  assert.deepEqual(two.uploads.map((f) => f.filename), ['b.pdf']);
  assert.equal(two.upload.filename, 'b.pdf');
});
