/**
 * All test rules live here. Storage is injected so the same code runs on Cloudflare KV in
 * production and on a file-backed store in tools/dev-server.mjs locally. If a rule is not
 * enforced in this file, it is not enforced at all: the client is treated as hostile.
 *
 * THREE OF THE RULES BELOW ARE NOW SETTINGS. An author can turn on back navigation and editing
 * of submitted answers in the builder. Both default to OFF, and both genuinely change what the
 * test measures rather than just how it feels: a forward-only test asks "what is your judgment
 * with what you have now", and one you can revise asks something else. Where a rule is
 * conditional it says so, and where it is absolute it still is.
 *
 * The three guarantees the client cannot break, and how:
 *
 *   1. The timer cannot be reset. `startedAt` is written once, on the first `start` call,
 *      and never rewritten. A refresh, a new browser, incognito, another device, or a
 *      cleared cache all read back the same `startedAt` and therefore the same deadline.
 *      The client is told the deadline; it does not decide it.
 *   2. Answers cannot be revisited, UNLESS the test says they can. By default the server works
 *      out the single question the candidate is on and refuses a submission for anything else,
 *      and going back is not a UI state we hide but an operation that does not exist. With
 *      `navigation.edit` on, an answer at an earlier index can be replaced, and if that
 *      replacement changes the route, every answer after it is discarded rather than left
 *      stranded on a branch nobody took. The client cannot decide any of this: it asks, and
 *      the server checks the setting.
 *   3. Questions cannot be read ahead. Only the current question is ever serialized to the
 *      client, QUESTIONS is never sent as a whole, and an option's destination is stripped
 *      before options reach the page, so making a choice is never also a preview of where each
 *      choice would have led.
 *
 * What this does NOT prevent, stated plainly: a candidate can still read the question and
 * ask someone else, or paste in an answer written elsewhere. Pastes and tab switches are
 * recorded as signals in the export, not blocked. Treat the result as evidence, not proof.
 */

import {
  QUESTIONS, BRIEFS, SECTIONS, DURATION_SEC, GRACE_SEC, INTEGRITY, TIMING, NAVIGATION, INTRO,
} from './wt-questions.mjs';
import { sanitizeRich, richIsEmpty, richToText, richWordCount } from './wt-rich.mjs';
import {
  currentQuestionId, questionById, firstQuestionId, optionLabels,
  remainingRange, sectionOutlook,
} from './wt-flow.mjs';
import { checkUpload, acceptAttribute, describeAllowed, MAX_UPLOAD_BYTES } from './wt-files.mjs';
import { nextIdAfter } from './wt-flow.mjs';

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
  // Cloudflare's variable editor is a textarea, so a value can easily carry a trailing newline
  // or space that nobody can see in the dashboard. Comparing raw strings would then silently
  // ignore the setting, which for OPEN_REGISTRATION would fail OPEN. Trim and lowercase first.
  const flag = (v) => String(v ?? '').trim().toLowerCase();
  return {
    durationSec: Number.isFinite(d) && d > 0 ? Math.floor(d) : DURATION_SEC,
    graceSec: Number.isFinite(g) && g >= 0 ? Math.floor(g) : GRACE_SEC,
    // When open registration is on, anyone with the unlisted URL can enter their own name and
    // start. Turn it off (OPEN_REGISTRATION=off) to accept only admin-issued links.
    openRegistration: flag(overrides.openRegistration) !== 'off',
    // Lets whoever is sitting at the candidate page wipe their own session and start again.
    // This exists for internal testing and DESTROYS the central guarantee: with it on, the
    // clock is restartable by anyone holding the link. It defaults to off and has to be turned
    // on deliberately (ALLOW_SELF_RESET=on), so forgetting about it fails safe.
    allowSelfReset: flag(overrides.allowSelfReset) === 'on',
    // The whole test definition travels in the config, defaulting to the one compiled into
    // wt-questions.mjs. Two things need this. Tests drive branching fixtures through the real
    // engine rather than through a copy of it, and the dev server can run a draft spec exported
    // from the builder, so "try it live" is the actual engine rather than a simulation of it.
    //
    // Production sets none of these. The deployed test is the compiled one, which is what keeps
    // the question set out of reach of anything a request can influence.
    questions: Array.isArray(overrides.questions) && overrides.questions.length
      ? overrides.questions
      : QUESTIONS,
    sections: Array.isArray(overrides.sections) && overrides.sections.length
      ? overrides.sections
      : SECTIONS,
    briefs: overrides.briefs && typeof overrides.briefs === 'object' ? overrides.briefs : BRIEFS,
    timing: normalizeTiming({ timing: TIMING, ...overrides }, sectionList(overrides)),
    // Both default to false, so a spec that says nothing behaves exactly as every earlier one
    // did. Neither is a UI preference: see the note at the top of this file.
    navigation: {
      back: (overrides.navigation || NAVIGATION).back === true,
      edit: (overrides.navigation || NAVIGATION).edit === true,
    },
    integrity: {
      blockPaste: overrides.integrity
        ? overrides.integrity.blockPaste === true
        : INTEGRITY.blockPaste === true,
    },
    intro: overrides.intro && typeof overrides.intro === 'object' ? overrides.intro : (INTRO || {}),
  };
}

/**
 * The rules shown on the instructions page, worked out from what the test is actually set to do.
 *
 * These used to be hardcoded in index.html, which meant the page could promise things that were
 * no longer true: it told every candidate "you cannot go back" and "the clock does not stop"
 * regardless of the settings, and named a number of parts that was simply the number the original
 * task happened to have. That is the worst place in the whole product to be wrong, because it is
 * where we make promises to someone who is about to be assessed on them.
 *
 * So the engine authors them. It is the thing that enforces these rules, so it is the only thing
 * that can describe them without drifting. Anything task-specific ("Part 1 needs a spreadsheet")
 * is the author's to add, and comes from `intro.rules` in the spec.
 */
export function introFor(cfg) {
  const rules = [];
  const t = cfg.timing;

  if (t.mode === 'none') {
    rules.push({
      lead: 'There is no time limit.',
      text: 'Take the time you need. Nothing expires while you are working and there is no countdown.',
    });
  } else if (t.mode === 'section') {
    rules.push({
      lead: 'Each part has its own time limit.',
      text: 'When a part runs out of time you move on to the next one, and anything you did not reach in '
        + 'that part is recorded as not reached. The clocks run on our server, so refreshing the page, '
        + 'closing the tab or opening this on another device will not give you more time.',
    });
  } else {
    rules.push({
      lead: 'The clock does not stop or restart.',
      text: 'It runs on our server, so refreshing the page, closing the tab, or opening this on another '
        + 'device will not give you more time.',
    });
  }

  if (cfg.navigation.edit) {
    rules.push({
      lead: 'You can go back and change your answers.',
      text: 'Earlier answers can be revised for as long as you have time left. If a change sends you down '
        + 'a different path, the answers you gave after it are discarded, and we will ask you before that '
        + 'happens.',
    });
  } else if (cfg.navigation.back) {
    rules.push({
      lead: 'You can look back, but not change anything.',
      text: 'You can re-read what you have already submitted, which helps when a later question refers to '
        + 'an earlier one. Submitted answers are final.',
    });
  } else {
    rules.push({
      lead: 'You cannot go back.',
      text: 'One question at a time. Once you continue, that answer is final and the next question appears. '
        + 'Do your thinking first, then write your answer.',
    });
  }

  rules.push({
    lead: 'We only accept your first submission.',
    text: 'Coming back with the same email address returns you to this same session rather than starting a '
      + 'new one.',
  });

  const anyRich = cfg.questions.some((q) => q.type === 'rich');
  if (anyRich && !cfg.integrity.blockPaste) {
    rules.push({
      lead: 'You can format your answers.',
      text: 'The answer boxes take headings, subheadings, bold, italic, underline and lists. Pasting from a '
        + 'document keeps the formatting we support and drops the rest.',
    });
  } else if (anyRich) {
    rules.push({
      lead: 'You can format your answers.',
      text: 'The answer boxes take headings, subheadings, bold, italic, underline and lists.',
    });
  }

  if (cfg.integrity.blockPaste) {
    rules.push({
      lead: 'Pasting is switched off.',
      text: 'Answers have to be typed, including anything you worked out somewhere else.',
    });
  }

  const withFiles = cfg.questions.filter((q) => attachmentOf(q) !== 'none');
  if (withFiles.length) {
    const kinds = new Set(withFiles.flatMap((q) => acceptOf(q)));
    const eitherOr = withFiles.some((q) => requireOf(q) === 'either');
    rules.push({
      lead: 'Some answers take a file.',
      text: `You can attach a ${describeAllowed([...kinds])}, up to `
        + `${(MAX_UPLOAD_BYTES / 1_000_000).toFixed(1)} MB.`
        + (eitherOr ? ' Where a question accepts either, writing it out or attaching a file is enough on its own.' : ''),
    });
  }

  // Author additions last, so the rules the engine actually enforces are read first.
  const extra = Array.isArray(cfg.intro.rules) ? cfg.intro.rules : [];
  for (const r of extra) {
    if (!r) continue;
    const lead = clamp(typeof r === 'string' ? '' : r.lead, 120).trim();
    const text = clamp(typeof r === 'string' ? r : r.text, 600).trim();
    if (lead || text) rules.push({ lead, text });
  }

  return {
    blurb: clamp(cfg.intro.blurb, 800).trim() || null,
    rules,
    sections: (Array.isArray(cfg.intro.sections) ? cfg.intro.sections : [])
      .map((s) => ({ heading: clamp(s && s.heading, 120).trim(), text: clamp(s && s.text, 2000).trim() }))
      .filter((s) => s.heading || s.text),
    closing: clamp(cfg.intro.closing, 1000).trim() || null,
    // Kept as a field rather than left inside the closing text, because it has to become a real
    // mailto link and no author-supplied text is ever rendered as markup. Validated here so the
    // page can build the href without having to think about what is in it.
    contactEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(cfg.intro.contactEmail || '').trim())
      ? String(cfg.intro.contactEmail).trim()
      : null,
    startLabel: t.mode === 'none' ? 'I understand, begin' : 'I understand, start the clock',
  };
}

const sectionList = (o) => (Array.isArray(o.sections) && o.sections.length ? o.sections : SECTIONS);

/**
 * Resolves how the clock works. Three modes, and they are genuinely different tests:
 *
 *   'total'   one clock for the whole thing. What this has always done.
 *   'section' a clock per part. Running out of one part does NOT end the test: the unanswered
 *             questions in that part are recorded as skipped and the candidate moves on to the
 *             next part with a fresh clock. That is the point of per-part limits, to stop one
 *             part eating another rather than to end the sitting early.
 *   'none'    untimed. There is no deadline, nothing expires, and the client shows no clock.
 *
 * `durationSec` is still read for 'total' so every spec written before this existed keeps
 * working without being touched.
 */
function normalizeTiming(o, sections) {
  const raw = o.timing && typeof o.timing === 'object' ? o.timing : {};
  const mode = ['total', 'section', 'none'].includes(raw.mode) ? raw.mode : 'total';

  const d = Number(o.durationSec);
  const totalSec = Number.isFinite(d) && d > 0 ? Math.floor(d) : DURATION_SEC;

  const limits = {};
  for (const s of sections) {
    const mins = Number(s.limitMin);
    if (Number.isFinite(mins) && mins > 0) limits[s.id] = Math.floor(mins * 60);
  }
  return { mode, totalSec, limits };
}

/* ------------------------------------------------------------ per-question rules ---- */

/**
 * Whether a question takes a file, and whether it insists on one.
 *
 * The old `type: 'upload'` still means "a name for the file, and the file is required", so no
 * existing spec changes meaning. Everything written since can put an attachment on any question
 * type instead, which is what makes "text only", "file only" and "both" one setting rather than
 * three question types.
 */
export function attachmentOf(q) {
  if (!q) return 'none';
  const req = requireOf(q);
  if (req === 'file' || req === 'both') return 'required';
  if (req === 'either') return 'optional';
  return q.attachment === 'required' || q.attachment === 'optional' ? q.attachment : 'none';
}

const REQUIREMENTS = ['text', 'file', 'either', 'both', 'optional'];

/**
 * What a question insists on before it will let the candidate continue.
 *
 *   'text'      a written answer
 *   'file'      an attachment
 *   'either'    one or the other, whichever suits the answer. This is the one worth having:
 *               "give us your reasoning as a short write-up or as a PDF" asks for the thinking
 *               and lets the candidate pick the medium, rather than making the medium the test.
 *   'both'      a file AND something written about it, which is what the old 'upload' type was
 *   'optional'  neither
 *
 * Derived from the older `required` and `attachment` fields when a spec does not say, so
 * nothing written before this existed changes meaning.
 */
export function requireOf(q) {
  if (!q) return 'optional';
  if (REQUIREMENTS.includes(q.require)) return q.require;

  if (q.type === 'upload') return q.required === false ? 'file' : 'both';
  const attachment = q.attachment === 'required' || q.attachment === 'optional' ? q.attachment : 'none';
  const wantsText = q.required !== false;
  if (attachment === 'required') return wantsText ? 'both' : 'file';
  return wantsText ? 'text' : 'optional';
}

/** Paste blocking, per question, falling back to the test-wide setting. */
const pasteBlockedFor = (q, cfg) => (typeof q.blockPaste === 'boolean' ? q.blockPaste : cfg.integrity.blockPaste);

/** Which part a question belongs to, defaulting to the first. */
const sectionIdOf = (q, cfg) => (q && q.section) || cfg.sections[0].id;

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
function publicQuestion(id, answers, cfg) {
  const q = questionById(id, cfg.questions);
  if (!q) return null;
  const answered = answers.length;
  const ahead = remainingRange(id, cfg.questions, answers.map((a) => a.id));
  return {
    id: q.id,
    index: answered,
    number: answered + 1,
    // Only ever a certainty. When the routes ahead differ in length there is no honest total to
    // give, and a guessed one would move under the candidate as they answer, which is the exact
    // thing a progress indicator exists to prevent.
    total: ahead.certain ? answered + ahead.max : null,
    isLast: ahead.max <= 1,
    type: q.type,
    prompt: q.prompt,
    context: q.context || null,
    // Labels only. optionLabels is what stops a branching option from telling the candidate
    // where it leads.
    options: optionLabels(q),
    maxLength: q.maxLength || (q.type === 'long' ? 2000 : 300),
    placeholder: q.placeholder || null,
    required: q.required !== false,
    brief: q.brief ? cfg.briefs[q.brief] || null : null,
    section: sectionIdOf(q, cfg),
    blockPaste: pasteBlockedFor(q, cfg),
    attachment: attachmentOf(q),
    require: requireOf(q),
    ...(attachmentOf(q) !== 'none' ? {
      accept: acceptOf(q),
      acceptAttr: acceptAttribute(acceptOf(q)),
      acceptText: `Upload a ${describeAllowed(acceptOf(q))}, up to ${(MAX_UPLOAD_BYTES / 1_000_000).toFixed(1)} MB.`,
      maxBytes: MAX_UPLOAD_BYTES,
    } : {}),
  };
}

/** Which file types one upload question takes. PDF and Word unless the author narrowed it. */
const acceptOf = (q) => (Array.isArray(q.accept) && q.accept.length ? q.accept : ['pdf', 'docx']);

/**
 * Where the candidate is, measured in effort rather than in questions.
 *
 * Counting questions would mislead: question 4 of 6 is two thirds of the way through the list
 * but only just past halfway through the work, because Part 1 carries twice the recommended
 * time of Part 2. Weighting by `recommendedMin` means the bar matches how long is actually left,
 * which is the thing a candidate on a clock is trying to judge.
 *
 * Safe to send in full. It describes the shape of the task, which the instructions page already
 * states outright, and never the content of a question the candidate has not reached.
 */
function progressOf(answers, currentId, cfg) {
  const questions = cfg.questions;
  const allSections = cfg.sections;
  const inSection = (q) => sectionIdOf(q, cfg);
  const answeredIds = answers.map((a) => a.id);
  const ahead = sectionOutlook(currentId, questions, answeredIds, inSection, allSections.map((s) => s.id));
  const hereId = currentId == null ? null : inSection(questionById(currentId, questions));

  let current = -1;
  const sections = allSections.map((s, i) => {
    const done = answers.filter((a) => inSection(questionById(a.id, questions)) === s.id).length;
    const up = ahead.get(s.id) || { min: 0, max: 0, certain: true };
    const holdsCurrent = hereId === s.id;
    if (holdsCurrent) current = i;

    // A branch can route around an entire part. Calling that part 'todo' would be a lie, and
    // calling it 'done' would be a different one, so it gets its own state.
    const state = holdsCurrent ? 'current'
      : up.max > 0 ? 'todo'
      : done ? 'done'
      : 'skipped';

    return {
      id: s.id,
      label: s.label,
      summary: s.summary,
      recommendedMin: s.recommendedMin,
      // Only set in section mode, and it is what the client draws a per-part clock from.
      limitMin: cfg.timing.mode === 'section' && cfg.timing.limits[s.id]
        ? Math.round(cfg.timing.limits[s.id] / 60)
        : null,
      total: up.certain ? done + up.max : null,
      done,
      state,
      // Worked out here rather than in the page, because when the total is uncertain the honest
      // denominator is the shortest route still ahead, and that is not the client's business.
      fill: state === 'done' ? 100
        : state === 'skipped' ? 0
        : Math.round((done / Math.max(1, done + up.min)) * 100),
    };
  });

  // Shares cover only the parts this candidate will actually sit, so a part their branch skipped
  // does not hold a slice of the bar that nothing can ever fill.
  const plannedMin = sections.reduce((n, s) => n + (s.state === 'skipped' ? 0 : s.recommendedMin), 0) || 1;
  for (const s of sections) s.share = Math.round((s.recommendedMin / plannedMin) * 100);

  const effortDone = sections.reduce((n, s) => {
    if (s.state === 'skipped') return n;
    if (s.state === 'done') return n + s.recommendedMin;
    return n + (s.fill / 100) * s.recommendedMin;
  }, 0);
  const here = sections[current];

  return {
    sections,
    sectionNumber: current + 1,
    sectionTotal: sections.length,
    inSection: here ? here.done + 1 : null,
    inSectionTotal: here ? here.total : null,
    percentDone: Math.round((effortDone / plannedMin) * 100),
    minutesLeft: sections
      .filter((s) => s.state === 'current' || s.state === 'todo')
      .reduce((n, s) => n + s.recommendedMin, 0),
  };
}

/**
 * When the clock the candidate is currently under runs out, or null when nothing is running.
 * In section mode that is the deadline for the part they are in, not for the sitting.
 */
function deadlineOf(rec, cfg, sectionId) {
  if (!rec.startedAt) return null;
  const t = cfg.timing;
  if (t.mode === 'none') return null;
  if (t.mode === 'total') return rec.startedAt + t.totalSec * 1000;

  const limit = t.limits[sectionId];
  if (!limit) return null; // a part with no limit set simply is not timed
  const from = (rec.sectionStarts && rec.sectionStarts[sectionId]) || rec.startedAt;
  return from + limit * 1000;
}

/**
 * Brings a session up to date with the clock before anything else looks at it.
 *
 * Only section mode needs this, and it is the part of per-part limits that actually does the
 * work: when a part's time is gone, its unanswered questions are recorded as skipped and the
 * candidate is moved into the next part on a fresh clock. Doing it here, on every request,
 * means a candidate who closes the tab over a break comes back to the right place rather than
 * to a part whose time ran out while they were away.
 *
 * Returns true when it changed something, so the caller knows to save.
 */
function settleSections(rec, now, cfg) {
  if (cfg.timing.mode !== 'section' || !rec.startedAt || rec.finishedAt) return false;
  let changed = false;

  // Bounded by the question count: every pass either records an answer or stops.
  for (let guard = 0; guard <= cfg.questions.length; guard++) {
    const id = currentQuestionId(rec.answers, cfg.questions);
    if (!id) break;
    const q = questionById(id, cfg.questions);
    const section = sectionIdOf(q, cfg);

    rec.sectionStarts = rec.sectionStarts || {};
    if (!rec.sectionStarts[section]) {
      // A part starts when the previous answer was given, not when the sitting did.
      rec.sectionStarts[section] = rec.answers.length
        ? rec.answers[rec.answers.length - 1].at
        : rec.startedAt;
      changed = true;
    }

    const deadline = deadlineOf(rec, cfg, section);
    if (deadline == null || now <= deadline + cfg.graceSec * 1000) break;

    // Out of time on this part. Record the question as skipped rather than silently dropping it,
    // so a reviewer can see what was never reached and why.
    rec.answers.push({
      id: q.id,
      index: rec.answers.length,
      prompt: q.prompt,
      value: '',
      format: 'text',
      at: now,
      msSpent: 0,
      skipped: true,
      pastes: 0,
      blurs: 0,
    });
    changed = true;
  }

  if (!currentQuestionId(rec.answers, cfg.questions) && !rec.finishedAt) {
    rec.finishedAt = now;
    rec.ranOut = true;
    changed = true;
  }
  return changed;
}

/** Single place that decides where a candidate stands, so every endpoint agrees. */
function phaseOf(rec, now, cfg) {
  if (rec.finishedAt) return 'done';
  if (!rec.startedAt) return 'ready';
  // Finished means "this candidate's route has no next question", which with branching can
  // happen at very different answer counts for two people sitting the same test.
  if (!currentQuestionId(rec.answers, cfg.questions)) return 'done';
  // Only a whole-test clock can expire a sitting. An untimed test never does, and in section
  // mode a spent clock moves the candidate on rather than ending things, which settleSections
  // has already applied by the time anything asks.
  if (cfg.timing.mode === 'total') {
    const deadline = deadlineOf(rec, cfg, null);
    if (deadline != null && now > deadline + cfg.graceSec * 1000) return 'expired';
  }
  return 'running';
}

/** The response shape the client renders from. Deliberately small. */
function view(rec, now, cfg, extra = {}) {
  const phase = phaseOf(rec, now, cfg);
  const frontierId = currentQuestionId(rec.answers, cfg.questions);
  const ahead = remainingRange(frontierId, cfg.questions, rec.answers.map((a) => a.id));
  const answered = rec.answers.length;

  // Where the candidate is LOOKING, which is the newest question unless they have stepped back.
  // The frontier is unaffected by browsing: stepping back does not un-answer anything.
  const looking = cfg.navigation.back && Number.isInteger(rec.cursor) && rec.cursor >= 0 && rec.cursor < answered
    ? rec.cursor
    : null;
  const shownId = looking === null ? frontierId : rec.answers[looking].id;
  const shownSection = sectionIdOf(questionById(shownId, cfg.questions), cfg);

  const out = {
    ok: true,
    phase,
    serverNow: now,
    candidate: { name: rec.name || null },
    // Null when there is no single whole-test clock, so the page knows not to draw one.
    durationSec: cfg.timing.mode === 'total' ? cfg.timing.totalSec : null,
    timing: { mode: cfg.timing.mode },
    navigation: { back: cfg.navigation.back, edit: cfg.navigation.edit },
    viewingIndex: looking,
    canGoBack: cfg.navigation.back && (looking === null ? answered > 0 : looking > 0),
    canGoForward: looking !== null,
    // Null when the routes ahead differ in length. The range is sent alongside so a page can
    // still say something true, like "between 5 and 7 questions", instead of inventing a number.
    total: ahead.certain ? answered + ahead.max : null,
    totalRange: { min: answered + ahead.min, max: answered + ahead.max, certain: ahead.certain },
    answered,
    ranOut: !!rec.ranOut,
    blockPaste: cfg.integrity.blockPaste,
    allowSelfReset: cfg.allowSelfReset,
    ...extra,
  };

  const deadline = deadlineOf(rec, cfg, shownSection);
  if (deadline != null) out.deadline = deadline;
  if (cfg.timing.mode === 'section') out.clockFor = shownSection;

  if (phase === 'running') {
    if (looking === null) {
      out.question = publicQuestion(frontierId, rec.answers, cfg);
      // A file already uploaded for this question, so refreshing or coming back on another
      // device shows what is attached rather than an empty field they would upload to twice.
      if (rec.uploads && rec.uploads[frontierId]) out.upload = rec.uploads[frontierId];
    } else {
      // Looking back at something already submitted. The question is rebuilt from the answers
      // that preceded it, so its numbering and its brief are what they were at the time.
      const past = rec.answers[looking];
      out.question = {
        ...publicQuestion(past.id, rec.answers.slice(0, looking), cfg),
        index: looking,
        number: looking + 1,
        isLast: false,
      };
      out.given = {
        value: past.value,
        format: past.format || 'text',
        choiceIndex: Number.isInteger(past.choiceIndex) ? past.choiceIndex : null,
        upload: past.upload || null,
        skipped: !!past.skipped,
      };
      out.editable = cfg.navigation.edit;
    }
    out.progress = progressOf(rec.answers, frontierId, cfg);
  }
  // On the instructions screen there is no current question, but the shape of the task is
  // exactly what someone deciding whether to press start wants to see.
  if (phase === 'ready') {
    out.progress = progressOf([], firstQuestionId(cfg.questions), cfg);
    out.intro = introFor(cfg);
  }
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
    const ahead = remainingRange(firstQuestionId(cfg.questions), cfg.questions, []);
    return {
      ok: true,
      phase: 'anonymous',
      serverNow: now,
      openRegistration: cfg.openRegistration,
      allowSelfReset: cfg.allowSelfReset,
      durationSec: cfg.durationSec,
      total: ahead.certain ? ahead.max : null,
      totalRange: { min: ahead.min, max: ahead.max, certain: ahead.certain },
    };
  }
  if (body.action === 'register') return register(store, body, now, cfg);

  const token = body && body.token;
  const rec = await load(store, token);
  if (!rec) return { ok: false, error: 'invalid_link', status: 404 };

  // Per-part clocks are applied before anything reads the record, so every action below sees a
  // session that already reflects the time that has passed since the last request.
  if (settleSections(rec, now, cfg)) await store.put(KEY(token), rec);

  switch (body.action) {
    case 'state':
      return view(rec, now, cfg);

    case 'back':
    case 'forward': {
      // Browsing is only ever browsing. It moves a cursor and touches nothing else, so even with
      // this on, an answer is still only changed by `answer`, and only when editing is allowed.
      if (!cfg.navigation.back) return view(rec, now, cfg, { rejected: 'no_back' });
      const answered = rec.answers.length;
      const at = Number.isInteger(rec.cursor) && rec.cursor < answered ? rec.cursor : answered;
      const moved = body.action === 'back' ? at - 1 : at + 1;
      rec.cursor = moved < 0 ? 0 : moved >= answered ? null : moved;
      await store.put(KEY(token), rec);
      return view(rec, now, cfg);
    }

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

      // The server decides which question may be answered; the client only gets to agree with
      // it. Submitting at the frontier is the ordinary case. Submitting at an earlier index is
      // a revision, which exists only when the test allows it.
      const at = Number(body.index);
      const revising = Number.isInteger(at) && at >= 0 && at < rec.answers.length;

      // A new answer needs a question open. A revision does not: on a test that allows editing,
      // reaching the end of the route is not the same as being finished with it, and a candidate
      // who answers everything and then wants to improve an earlier answer should be able to,
      // right up until the clock stops. Nothing survives expiry either way.
      if (phase === 'expired') return view(rec, now, cfg, { rejected: phase });
      if (!revising && phase !== 'running') return view(rec, now, cfg, { rejected: phase });

      if (revising && !cfg.navigation.edit) return view(rec, now, cfg, { rejected: 'no_edit' });

      const currentId = currentQuestionId(rec.answers, cfg.questions);
      if (!revising) {
        if (!currentId) return view(rec, now, cfg, { rejected: 'done' });
        if (at !== rec.answers.length) return view(rec, now, cfg, { rejected: 'out_of_order' });
      }

      const targetId = revising ? rec.answers[at].id : currentId;
      if (body.questionId && String(body.questionId) !== targetId) {
        return view(rec, now, cfg, { rejected: 'out_of_order' });
      }

      const q = questionById(targetId, cfg.questions);
      if (!q) return view(rec, now, cfg, { rejected: 'out_of_order' });
      const rich = q.type === 'rich';
      const max = q.maxLength || (rich || q.type === 'long' ? 2000 : 300);

      let value;
      let choiceIndex;
      if (rich) {
        // Formatted answers arrive as blocks, never as HTML. See wt-rich.mjs for why.
        value = sanitizeRich(body.value, max).blocks;
      } else if (q.type === 'upload') {
        // The file is already stored. What is being submitted here is the name the candidate
        // gave it, which is the thing that makes a list of attachments readable to a reviewer.
        value = clamp(body.value, q.maxLength || 120).trim();
      } else if (q.type === 'choice') {
        // Never trust a client-sent label; accept only an index into our own options. The index
        // is then kept alongside the label, because with branching it is the index that decides
        // the route: an author fixing a typo in an option's wording must not silently reroute a
        // candidate who is part-way through.
        const labels = optionLabels(q) || [];
        const pick = Number(body.value);
        if (Number.isInteger(pick) && labels[pick] != null) {
          value = labels[pick];
          choiceIndex = pick;
        } else {
          value = '';
        }
      } else {
        value = clamp(body.value, max);
      }

      // The client blocks this too, but a required question must not be skippable by anyone
      // hand-rolling a request. Optional questions accept an empty answer and move on.
      // Text and file are checked against one requirement rather than two independent flags,
      // because 'either' is not expressible as a pair of them: neither half is required on its
      // own, but leaving both empty is not an answer.
      const hasFile = !!(rec.uploads && rec.uploads[q.id]);
      const hasText = !richIsEmpty(value);
      const need = requireOf(q);
      if ((need === 'file' || need === 'both') && !hasFile) return view(rec, now, cfg, { rejected: 'no_file' });
      if ((need === 'text' || need === 'both') && !hasText) return view(rec, now, cfg, { rejected: 'empty' });
      if (need === 'either' && !hasFile && !hasText) return view(rec, now, cfg, { rejected: 'need_one' });

      if (revising) {
        const previous = rec.answers[at];
        const updated = {
          ...previous,
          value,
          ...(choiceIndex === undefined ? {} : { choiceIndex }),
          ...(rec.uploads && rec.uploads[q.id] ? { upload: rec.uploads[q.id] } : {}),
          skipped: false,
          revisedAt: now,
          revisions: (previous.revisions || 0) + 1,
        };

        // A revision that changes the route cannot leave the answers after it standing: they
        // belong to a branch this candidate is no longer on. Discarding them is the honest
        // outcome, and it is destructive, so it needs saying yes to first.
        const followed = rec.answers[at + 1] ? rec.answers[at + 1].id : null;
        const nowLeadsTo = nextIdAfter(q, updated, cfg.questions);
        if (followed && nowLeadsTo !== followed) {
          if (!body.confirmDiscard) {
            return view(rec, now, cfg, {
              rejected: 'would_discard',
              wouldDiscard: rec.answers.length - at - 1,
            });
          }
          rec.answers = rec.answers.slice(0, at).concat(updated);
          // Answers after this one are gone, so anything they had attached is stale too.
          for (const key of Object.keys(rec.uploads || {})) {
            if (!rec.answers.some((a) => a.id === key) && key !== q.id) delete rec.uploads[key];
          }
        } else {
          rec.answers[at] = updated;
        }

        // Discarding answers can reopen a test that had finished.
        if (currentQuestionId(rec.answers, cfg.questions)) {
          rec.finishedAt = null;
          rec.ranOut = false;
        }
        rec.cursor = at + 1 < rec.answers.length ? at + 1 : null;
        await store.put(KEY(token), rec);
        return view(rec, now, cfg, { revised: true });
      }

      const prevAt = rec.answers.length ? rec.answers[rec.answers.length - 1].at : rec.startedAt;
      rec.answers.push({
        id: q.id,
        index: rec.answers.length,
        prompt: q.prompt,
        value,
        // Only present on a choice, and the reason the route survives an edit to the wording.
        ...(choiceIndex === undefined ? {} : { choiceIndex }),
        // Copied onto the answer rather than only living in rec.uploads, so the CSV and the
        // admin page can read one row without cross-referencing anything.
        ...(rec.uploads && rec.uploads[q.id] ? { upload: rec.uploads[q.id] } : {}),
        // Lets the admin page and the CSV know how to read `value` without re-deriving it from
        // the question list, which may have been edited since this answer was written.
        format: rich ? 'rich' : 'text',
        at: now,
        msSpent: now - prevAt,
        // Integrity signals, recorded not enforced. See the note at the top of this file.
        pastes: Math.max(0, Math.min(99, Number(body.pastes) || 0)),
        blurs: Math.max(0, Math.min(99, Number(body.blurs) || 0)),
      });
      // That answer may have carried the candidate into a new part, and a part's clock starts
      // when they arrive in it. Registering it here, before the save, is what stops Part 2's
      // limit being measured from the beginning of the sitting.
      settleSections(rec, now, cfg);

      // The route decides when the test is over, not a count: two candidates sitting the same
      // test can finish after different numbers of questions.
      if (!currentQuestionId(rec.answers, cfg.questions)) rec.finishedAt = now;
      await store.put(KEY(token), rec);
      return view(rec, now, cfg);
    }

    case 'upload': {
      // Files are stored the moment they are chosen, NOT when the answer is submitted. An upload
      // takes time, the grace window after the deadline is a few seconds, and a candidate on a
      // slow connection should not lose a file because they attached it near the buzzer.
      const phase = phaseOf(rec, now, cfg);
      if (phase !== 'running') return view(rec, now, cfg, { rejected: phase });

      const currentId = currentQuestionId(rec.answers, cfg.questions);
      if (!currentId) return view(rec, now, cfg, { rejected: 'done' });
      if (body.questionId && String(body.questionId) !== currentId) {
        return view(rec, now, cfg, { rejected: 'out_of_order' });
      }

      const q = questionById(currentId, cfg.questions);
      if (!q || attachmentOf(q) === 'none') return view(rec, now, cfg, { rejected: 'not_an_upload' });

      // KV has no concept of an attachment. Refusing clearly beats a stack trace, though the
      // real defence is the startup check that stops a spec with uploads running on such a store.
      if (typeof store.putFile !== 'function') {
        return {
          ok: false,
          error: 'uploads_unavailable',
          status: 503,
          detail: 'This deployment cannot accept files. Tell us and we will send you another way to submit it.',
        };
      }

      const check = checkUpload({
        filename: body.filename,
        contentType: body.contentType,
        base64: body.data,
        allow: acceptOf(q),
      });
      if (!check.ok) return { ok: false, error: check.error, detail: check.detail, status: 400 };

      // Every file for a session lands in one Airtable cell, so the question id in the name is
      // what tells a reviewer which answer each attachment belongs to.
      const stored = await store.putFile(KEY(token), {
        filename: `${q.id}--${check.filename}`,
        contentType: check.contentType,
        base64: String(body.data).replace(/\s/g, ''),
      });

      rec.uploads = rec.uploads || {};
      rec.uploads[q.id] = {
        filename: check.filename,
        size: check.size,
        kind: check.kind,
        at: now,
        attachmentId: (stored && stored.attachmentId) || null,
        recordId: (stored && stored.recordId) || null,
      };
      await store.put(KEY(token), rec);
      return view(rec, now, cfg, { uploaded: rec.uploads[q.id] });
    }

    case 'review': {
      // Everything already submitted, to look at. Reading an old answer can only become editing
      // it when the test allows editing, and that goes through `answer` with its own checks, so
      // nothing here needs to be defensive beyond sending only what was actually reached.
      //
      // The attachment is part of the answer and has to travel with it. Leaving it out meant a
      // candidate who submitted a PDF and no text was shown "(left blank)" against their own
      // work, which is alarming in exactly the situation where being alarmed is most costly.
      return view(rec, now, cfg, {
        review: rec.answers.map((a) => ({
          number: a.index + 1,
          prompt: a.prompt,
          value: a.value,
          format: a.format || 'text',
          msSpent: a.msSpent,
          upload: a.upload || null,
          skipped: !!a.skipped,
        })),
      });
    }

    case 'reset': {
      // Internal testing only. Deliberately a full delete rather than a rewind: it also releases
      // the email claim, so the tester can register again from scratch, and it leaves no
      // half-reset record that would be confusing to review later.
      if (!cfg.allowSelfReset) return { ok: false, error: 'reset_disabled', status: 403 };
      await deleteCandidate(store, token);
      return {
        ok: true,
        phase: 'anonymous',
        serverNow: now,
        openRegistration: cfg.openRegistration,
        allowSelfReset: true,
        durationSec: cfg.durationSec,
        total: remainingRange(firstQuestionId(cfg.questions), cfg.questions, []).certain
          ? remainingRange(firstQuestionId(cfg.questions), cfg.questions, []).max
          : null,
        wasReset: true,
      };
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

/**
 * Whether this deployment can actually run this test. Called by the API so that a spec asking
 * for files on a store with nowhere to put them fails at the door, loudly, instead of halfway
 * through a candidate's sitting.
 */
export function readiness(store, cfg = config()) {
  const needsFiles = cfg.questions.some((q) => attachmentOf(q) !== 'none');
  if (needsFiles && typeof store.putFile !== 'function') {
    return {
      ok: false,
      error: 'uploads_unconfigured',
      detail: 'This test has a file upload question, but the configured store cannot hold files. '
        + 'Uploads need the Airtable backend: set AIRTABLE_TOKEN, add an Attachment column named '
        + 'Files (or set AIRTABLE_WT_FILES), and redeploy.',
    };
  }
  return { ok: true };
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
  // A store that can read a whole prefix in one go says so, because walking the roster key by
  // key is a request per candidate. The roster path stays for stores that cannot.
  let records;
  if (typeof store.listByPrefix === 'function') {
    records = await store.listByPrefix('c:');
  } else {
    const roster = (await store.get(ROSTER)) || { tokens: [] };
    records = [];
    for (const token of roster.tokens) {
      const rec = await store.get(KEY(token));
      if (rec) records.push(rec);
    }
  }

  const rows = [];
  for (const rec of records) {
    const token = rec && rec.token;
    // Skip anything that is not a session record rather than throwing: one bad row must not stop
    // a reviewer from seeing every other submission.
    if (!token || !Array.isArray(rec.answers)) continue;
    // With branching the total is per candidate, and null whenever their remaining routes differ
    // in length. The admin page renders that as "3 / ?" rather than guessing.
    const aheadOf = remainingRange(
      currentQuestionId(rec.answers, cfg.questions),
      cfg.questions,
      rec.answers.map((a) => a.id),
    );
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
      total: aheadOf.certain ? rec.answers.length + aheadOf.max : null,
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
  // question_id is what makes a branching test readable in a spreadsheet: two candidates can
  // both have a fourth answer without it being the same question, so the position alone no
  // longer identifies what was asked.
  const head = [
    'name', 'email', 'status', 'started_utc', 'finished_utc', 'ran_out',
    'question', 'question_id', 'prompt', 'answer', 'file_name', 'file_size_kb',
    'seconds_on_question', 'words', 'pastes', 'tab_switches',
  ];
  const lines = [head.map(esc).join(',')];
  for (const r of rows) {
    if (!r.answers.length) {
      lines.push([r.name, r.email, r.phase, iso(r.startedAt), iso(r.finishedAt), r.ranOut ? 'yes' : 'no', '', '', '', '', '', '', '', '', '', ''].map(esc).join(','));
      continue;
    }
    for (const a of r.answers) {
      lines.push([
        r.name, r.email, r.phase, iso(r.startedAt), iso(r.finishedAt), r.ranOut ? 'yes' : 'no',
        // Formatted answers flatten to text with `##` and `-` markers kept, so the structure the
        // candidate chose survives into a spreadsheet cell.
        a.index + 1, a.id || '', a.prompt,
        a.skipped ? '(not reached: time ran out on this part)' : richToText(a.value),
        a.upload ? a.upload.filename : '', a.upload ? Math.round(a.upload.size / 1000) : '',
        Math.round(a.msSpent / 1000), richWordCount(a.value),
        a.pastes, a.blurs,
      ].map(esc).join(','));
    }
  }
  return lines.join('\r\n');
}
