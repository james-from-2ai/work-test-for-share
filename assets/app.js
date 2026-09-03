/**
 * Candidate client. Deliberately thin: it renders whatever the server says and nothing else.
 *
 * It holds no copy of the questions and does not decide the deadline. Where the test allows
 * going back, that too is the server's decision: this page asks, and draws what it is given. If
 * someone edits this file in devtools the worst they achieve is a broken page, because every
 * response is re-validated server-side (see functions/_lib/wt-engine.mjs).
 *
 * The clock shown here is cosmetic. `deadline` comes from the server and every response carries
 * `serverNow`, which corrects for a wrong device clock. A candidate who changes their system time
 * sees a wrong countdown but gets no extra seconds.
 *
 * One rule governs every failure path below: a server response that is not a fresh screen must
 * never redraw the screen. Redrawing throws away whatever is typed, on a clock nobody gets back,
 * so rejections and dropped connections restore the button and say what happened instead.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const params = new URLSearchParams(location.search);

/**
 * A token can arrive three ways, in order of trust: an admin-issued link, a session we already
 * started in this browser, or self-registration with a name and email. The stored copy only saves
 * a returning candidate from retyping their email; the server would hand back the same session
 * either way.
 */
const STORE_KEY = 'work-test-token';
let token = params.get('t') || params.get('token') || localStorage.getItem(STORE_KEY) || '';

let clockOffset = 0; // serverNow - clientNow
let deadline = null;
let ticker = null;
let inFlight = false;
let signals = { pastes: 0, blurs: 0 }; // reset at the start of each question
let guarded = false;

// What is on screen right now. `onQuestion` is what the navigation guards key on: a candidate
// mid-answer must not lose it to the browser's Back button or a reload, timed or not.
let onQuestion = false;
let currentIndex = -1;
let currentQid = null;
// Paste blocking for the question on screen, as the server said. A test-wide setting and any
// per-question override are already folded together server-side, so this is the only source.
let pasteBlockedHere = false;

// Counted for the whole session and attributed to whichever question is open. Candidates are told
// they may use AI and a spreadsheet, so this is activity data for context, not evidence of
// anything: leaving the tab is exactly what we asked them to do.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && onQuestion) signals.blurs += 1;
});

const now = () => Date.now() + clockOffset;

/* ------------------------------------------------------------------- transport ------- */

/**
 * Every failure the server can produce comes back as JSON, so the only thing this adds is what
 * happens when there is no response at all: it becomes an ordinary error object, and the caller
 * decides what to do about it rather than a rejection escaping a click handler.
 */
async function api(action, extra = {}) {
  let data;
  try {
    const res = await fetch('/api/work-test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, token, ...extra }),
    });
    data = await res.json().catch(() => ({ ok: false, error: 'bad_response' }));
  } catch {
    return { ok: false, error: 'network' };
  }
  if (typeof data.serverNow === 'number') clockOffset = data.serverNow - Date.now();
  if (data.token) {
    token = data.token;
    try { localStorage.setItem(STORE_KEY, token); } catch { /* private mode; the email still resumes it */ }
  }
  return data;
}

/** Failures that mean "press it again", as opposed to "this session is over". */
const TRANSIENT = new Set(['network', 'bad_response', 'store_unavailable']);
const isTransient = (res) => !!res && !res.ok && TRANSIENT.has(res.error);

/** Said whenever we could not reach the server. The reassurance is the important half. */
const RETRY_MSG = 'We could not reach the server. Nothing has been lost. Check your connection '
  + 'and press the button again, and do not reload or start over.';

/**
 * What to tell a candidate when the server refuses an answer. These are the refusals a working
 * page can still meet, because the server is the authority and re-checks everything. Anything
 * not listed here is a state change (the test finished, or expired) and is rendered, not said.
 */
const REJECTIONS = {
  empty: 'Write something to continue.',
  no_file: 'Attach a file before continuing.',
  need_one: 'Write an answer or attach a file. Either one is enough.',
  out_of_order: 'That question has moved on. The page has been refreshed to where you are.',
  no_edit: 'This test does not allow changing an answer once it is submitted.',
  no_back: 'This test does not allow going back.',
  not_an_upload: 'This question does not take a file.',
};

/* --------------------------------------------------------------------- helpers ------- */

function screen(id) {
  app.replaceChildren($(`#tpl-${id}`).content.cloneNode(true));
  return app;
}

const hook = (name) => $(`[data-hook="${name}"]`, app);

function showError(msg) {
  const el = hook('err');
  if (!el) return;
  el.textContent = msg;
  el.hidden = !msg;
}

function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function humanDuration(sec) {
  const mins = Math.round(sec / 60);
  if (mins < 60) return mins === 1 ? '1 minute' : `${mins} minutes`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hPart = h === 1 ? '1 hour' : `${h} hours`;
  return m ? `${hPart} ${m} minutes` : hPart;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1000))} KB`;

/** A button that does one server round trip, restoring itself if the server cannot be reached. */
function actionButton(label, className, action) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  b.addEventListener('click', async () => {
    if (inFlight) return;
    inFlight = true;
    b.disabled = true;
    const res = await api(action);
    inFlight = false;
    if (isTransient(res)) {
      b.disabled = false;
      return showError(res.detail || RETRY_MSG);
    }
    render(res);
  });
  return b;
}

/* ---------------------------------------------------------------- navigation guard ---- */

/**
 * The browser's Back button and a reload must not take a candidate off a question they are in
 * the middle of answering. Keyed on whether a question is on screen rather than on the clock, so
 * an untimed test is protected exactly as a timed one is: the thing being protected is the
 * unsaved answer, not the seconds.
 *
 * Back opens the read-only review, which is the obvious gesture for "let me see what I already
 * wrote". Where the test allows going back for real, the Previous button does that.
 */
function guardNavigation() {
  if (guarded) return;
  guarded = true;
  history.pushState({ lock: 1 }, '');
  addEventListener('popstate', () => {
    if (!onQuestion) return;
    history.pushState({ lock: 1 }, '');
    openReview();
  });
  addEventListener('beforeunload', (e) => {
    if (!onQuestion) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

/* --------------------------------------------------------------------- screens ------- */

function renderInvalid() {
  stopClock();
  onQuestion = false;
  screen('invalid');
}

/** Self-serve entry: the candidate tells us who they are before anything starts. */
function renderIdentify(state) {
  stopClock();
  onQuestion = false;
  screen('identify');
  const nameEl = $('#cand-name');
  const emailEl = $('#cand-email');
  const go = hook('go');
  nameEl.focus();

  // The footer used to promise a clock regardless of the test. Say what is actually true.
  const mode = state && state.timing ? state.timing.mode : 'total';
  hook('startnote').textContent = mode === 'none'
    ? 'Nothing has started yet. This task is not timed.'
    : mode === 'section'
      ? 'Nothing has started yet. Each part has its own time limit, and the first clock starts only when you say so.'
      : state && state.durationSec
        ? `Nothing has started yet. The task takes ${humanDuration(state.durationSec)} once you begin, and the clock starts only when you say so.`
        : 'Nothing has started yet. The clock starts later, and only when you say so.';

  const submit = async () => {
    if (inFlight) return;
    const name = nameEl.value.trim();
    const email = emailEl.value.trim();
    if (name.length < 2) return showError('Please enter your full name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('Please enter a valid email address.');

    inFlight = true;
    go.disabled = true;
    go.textContent = 'Checking…';
    const res = await api('register', { name, email });
    inFlight = false;

    if (!res.ok) {
      go.disabled = false;
      go.textContent = 'Continue';
      if (isTransient(res)) return showError(res.detail || RETRY_MSG);
      return showError(res.error === 'registration_closed'
        ? 'This task is now invitation only. Please use the link we emailed you.'
        : 'We could not start the task. Check your name and email, then try again.');
    }
    render(res);
  };

  go.addEventListener('click', submit);
  for (const el of [nameEl, emailEl]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
}

/**
 * The opening sentence: how long, how many questions, how many parts. A branching test has no
 * single length until the branches resolve, so where that is the case it says the honest range
 * rather than picking a number that will be wrong for most candidates.
 */
function summarySentence(state) {
  const range = state.totalRange;
  const count = state.total != null ? String(state.total)
    : range && range.min !== range.max ? `${range.min} to ${range.max}`
    : range ? String(range.max)
    : 'several';

  const parts = state.progress ? state.progress.sections.filter((s) => s.state !== 'skipped').length : 0;
  const partsBit = parts > 1 ? ` across ${parts} parts` : '';

  const timing = state.timing && state.timing.mode;
  if (timing === 'none') {
    return `This task has ${count} questions${partsBit} and is not timed. Read this page properly before you begin.`;
  }
  if (timing === 'section') {
    return `This task has ${count} questions${partsBit}, and each part has its own time limit. `
      + 'Read this page properly. The first clock starts when you press the button at the bottom.';
  }
  return `This task is ${humanDuration(state.durationSec)} long and has ${count} questions${partsBit}. `
    + 'Read this page properly. The clock starts when you press the button at the bottom, and it does not stop.';
}

/**
 * The rules and the prose around them, all sent by the server. The rules describe what the
 * engine enforces, so the engine writes them: a page that hardcodes "you cannot go back" carries
 * on saying it long after someone has turned that setting on.
 */
function renderIntro(intro) {
  if (!intro) return;

  if (intro.blurb) {
    hook('blurb').textContent = intro.blurb;
    hook('blurb').hidden = false;
  }

  const list = hook('rules');
  list.replaceChildren();
  for (const rule of intro.rules || []) {
    const li = document.createElement('li');
    if (rule.lead) {
      const strong = document.createElement('strong');
      strong.textContent = rule.lead;
      li.append(strong, document.createTextNode(rule.text ? ` ${rule.text}` : ''));
    } else {
      li.textContent = rule.text || '';
    }
    list.append(li);
  }

  const prose = hook('prose');
  prose.replaceChildren();
  for (const section of intro.sections || []) {
    if (section.heading) {
      const h = document.createElement('h2');
      h.className = 'sub';
      h.textContent = section.heading;
      prose.append(h);
    }
    for (const para of String(section.text || '').split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const p = document.createElement('p');
      p.textContent = para.trim();
      prose.append(p);
    }
  }

  renderClosing(hook('closing'), intro.closing, intro.contactEmail);
}

/** Small print plus a contact address rendered as a real link, never parsed out of the text. */
function renderClosing(el, closing, contactEmail) {
  if (!el || (!closing && !contactEmail)) return;
  el.textContent = closing || '';
  if (contactEmail) {
    const a = document.createElement('a');
    a.href = `mailto:${contactEmail}`;
    a.textContent = contactEmail;
    if (closing) el.append(document.createTextNode(' '));
    el.append(a);
  }
  el.hidden = false;
}

function renderInstructions(state) {
  stopClock();
  onQuestion = false;
  screen('instructions');
  const first = (state.candidate.name || '').trim().split(/\s+/)[0];
  if (first) hook('greeting').textContent = `${first}, before you start`;
  hook('summary').textContent = summarySentence(state);
  renderIntro(state.intro);
  hook('who').textContent = state.candidate.name ? `Submitting as ${state.candidate.name}` : '';
  renderProgress(state, { preview: true });

  const btn = hook('begin');
  if (state.intro && state.intro.startLabel) btn.textContent = state.intro.startLabel;
  btn.addEventListener('click', async () => {
    if (inFlight) return;
    inFlight = true;
    btn.disabled = true;
    btn.textContent = 'Starting…';
    guardNavigation();
    const res = await api('start', { userAgent: navigator.userAgent });
    inFlight = false;
    if (isTransient(res)) {
      btn.disabled = false;
      btn.textContent = (state.intro && state.intro.startLabel) || 'I understand, begin';
      return showError(res.detail || RETRY_MSG);
    }
    render(res);
  });
}

/* -------------------------------------------------------------------- progress ------- */

/** How many questions a part holds, or an honest refusal when the branch decides. */
function countOf(s) {
  if (s.total == null) return 'a number of questions that depends on your answers';
  return plural(s.total, 'question');
}

/**
 * The progress bar, segmented by part and weighted by how long each part is expected to take
 * rather than by how many questions it holds. The note under it is written from the timing mode,
 * because "the only hard limit is the total" is untrue on a test with per-part limits or none.
 */
function renderProgress(state, { preview = false } = {}) {
  const progress = state.progress;
  const track = hook('track');
  const note = hook('tracknote');
  if (!track || !progress) return;
  const mode = state.timing ? state.timing.mode : 'total';

  track.replaceChildren();
  for (const s of progress.sections) {
    // A part this candidate's branch routes around is not drawn at all. The server has already
    // taken it out of the shares, so drawing it would leave a slice nothing can ever fill.
    if (s.state === 'skipped') continue;

    const seg = document.createElement('div');
    seg.className = `seg ${s.state}`;
    seg.style.flexGrow = String(s.recommendedMin);
    seg.title = `${s.label}: ${s.summary}. About ${s.recommendedMin} minutes, ${countOf(s)}.`;

    const fill = document.createElement('div');
    fill.className = 'seg-fill';
    fill.style.width = `${s.fill}%`;
    seg.append(fill);

    const tag = document.createElement('span');
    tag.className = 'seg-tag';
    tag.textContent = `${s.label} · ${s.share}%`;
    seg.append(tag);
    track.append(seg);
  }

  const live = progress.sections.filter((s) => s.state !== 'skipped');
  const minutesOf = (s) => (mode === 'section' && s.limitMin ? `${s.limitMin} minutes, timed` : `about ${s.recommendedMin} minutes`);

  if (preview) {
    const tail = mode === 'none' ? 'Those timings are a guide; nothing here is timed.'
      : mode === 'section' ? 'Each part is timed separately, and running one out moves you on to the next.'
      : 'Those timings are a suggestion, not a rule; the only hard limit is the total.';
    note.textContent = live
      .map((s) => `${s.label}, ${s.summary.toLowerCase()}: ${countOf(s)}, ${minutesOf(s)} (${s.share}% of the work)`)
      .join('. ') + `. ${tail}`;
    return;
  }

  const here = progress.sections[progress.sectionNumber - 1];
  const rest = progress.sections.slice(progress.sectionNumber).filter((s) => s.state !== 'skipped');
  const parts = [];
  if (here) {
    const where = here.total == null
      ? `Question ${progress.inSection} in this part`
      : `Question ${progress.inSection} of ${here.total} in this part`;
    const planned = live.reduce((n, s) => n + s.recommendedMin, 0);
    const budget = mode === 'section' && here.limitMin
      ? `this part has its own ${here.limitMin} minute limit`
      : `this part is about ${here.recommendedMin} minutes of the ${planned}`;
    parts.push(`${here.label} of ${progress.sectionTotal}: ${here.summary}. ${where}, and ${budget}.`);
  }
  parts.push(rest.length
    ? `Still to come: ${rest.map((s) => `${s.label} (${s.summary.toLowerCase()}, ${minutesOf(s)})`).join(', ')}.`
    : 'This is the last part.');
  note.textContent = parts.join(' ');
}

/** Reference material that stays on screen for every question in a part. */
function renderBrief(brief) {
  const panel = hook('brief');
  if (!brief) return;
  panel.hidden = false;

  if (brief.heading) {
    const h = document.createElement('h2');
    h.className = 'brief-h';
    h.textContent = brief.heading;
    panel.append(h);
  }

  for (const block of brief.blocks || []) {
    if (block.type === 'p') {
      const p = document.createElement('p');
      p.textContent = block.text;
      panel.append(p);
    } else if (block.type === 'quote') {
      const fig = document.createElement('figure');
      fig.className = 'quote';
      if (block.label) {
        const cap = document.createElement('figcaption');
        cap.textContent = block.label;
        fig.append(cap);
      }
      const p = document.createElement('p');
      p.textContent = block.text;
      fig.append(p);
      if (block.list) {
        const ol = document.createElement('ol');
        for (const item of block.list) {
          const li = document.createElement('li');
          li.textContent = item;
          ol.append(li);
        }
        fig.append(ol);
      }
      if (block.after) {
        const tail = document.createElement('p');
        tail.textContent = block.after;
        fig.append(tail);
      }
      panel.append(fig);
    } else if (block.type === 'link' && /^https?:\/\//i.test(block.url || '')) {
      // The scheme check is belt and braces: the builder and spec-apply refuse anything else, but
      // a hand-edited questions file could still carry a javascript: URL and this is a real href.
      const a = document.createElement('a');
      a.className = 'datalink';
      a.href = block.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = block.label || block.url;
      panel.append(a);
    }
  }
}

/* ------------------------------------------------------------- rich text editor ------ */

/**
 * A small formatting editor over a contenteditable div. Returns { read } where read() produces
 * the block array described in functions/_lib/wt-rich.mjs.
 *
 * This uses document.execCommand, which is deprecated but still works everywhere and is by far
 * the least code for this job. Its output is notoriously untidy, and normally that would be the
 * reason to avoid it. Here it does not matter: nothing the browser produces is ever stored. We
 * walk the DOM ourselves and emit our own normalized blocks, so messy spans, stray divs, and
 * whatever Google Docs pastes in all collapse to the same small shape.
 */
const BLOCK_TAGS = new Set(['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI',
  'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'FIGURE']);
const BLOCK_SELECTOR = [...BLOCK_TAGS].join(',').toLowerCase();

/** Elements whose contents are not text a candidate meant to write. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'TITLE',
  'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE']);

/**
 * Marks carried by a tag or an inline style, since pasted content uses styles as often as tags.
 * A style can also *clear* a mark: Google Docs wraps its entire clipboard payload in
 * `<b style="font-weight:normal">`, so honouring the tag but ignoring the style would bold every
 * pasted document in its entirety.
 */
function marksOf(el, inherited) {
  const m = { ...inherited };
  const tag = el.tagName;
  if (tag === 'B' || tag === 'STRONG') m.b = 1;
  if (tag === 'I' || tag === 'EM') m.i = 1;
  if (tag === 'U' || tag === 'INS') m.u = 1;

  const s = el.style;
  if (s && s.length) {
    const w = s.fontWeight;
    const wn = Number(w);
    if (w === 'bold' || w === 'bolder' || wn >= 600) m.b = 1;
    else if (w === 'normal' || w === 'lighter' || (wn && wn < 600)) delete m.b;

    const fs = s.fontStyle;
    if (fs === 'italic' || fs === 'oblique') m.i = 1;
    else if (fs === 'normal') delete m.i;

    const td = s.textDecoration || s.textDecorationLine || '';
    if (td.includes('underline')) m.u = 1;
    else if (td.includes('none')) delete m.u;
  }
  return m;
}

/** True when this element wraps block-level content, so it must be walked as structure. */
const wrapsBlocks = (el) => !!(el.querySelector && el.querySelector(BLOCK_SELECTOR));

/** Collects the inline runs inside a node, merging neighbours that share the same marks. */
function collectRuns(node, marks, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      // Collapse whitespace the way HTML rendering does, so indentation and newlines between
      // pasted tags do not survive as line breaks. Real breaks come from <br>, handled below.
      const t = child.nodeValue.replace(/ /g, ' ').replace(/\s+/g, ' ');
      if (!t) continue;
      const last = out[out.length - 1];
      if (last && !!last.b === !!marks.b && !!last.i === !!marks.i && !!last.u === !!marks.u) {
        last.t += t;
      } else {
        out.push({ t, ...(marks.b ? { b: 1 } : {}), ...(marks.i ? { i: 1 } : {}), ...(marks.u ? { u: 1 } : {}) });
      }
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (SKIP_TAGS.has(child.tagName)) continue;
      if (child.tagName === 'BR') {
        const last = out[out.length - 1];
        if (last) last.t += '\n';
        else out.push({ t: '\n' });
        continue;
      }
      collectRuns(child, marksOf(child, marks), out);
    }
  }
  return out;
}

/** Appends one block, dropping empties unless they are spacing between real content. */
function pushBlock(blocks, type, runs) {
  while (runs.length && runs[runs.length - 1].t === '') runs.pop();
  const hasText = runs.some((r) => r.t.trim() !== '');
  if (hasText || blocks.length) blocks.push({ type, runs: hasText ? runs : [] });
}

/**
 * Walks one container, emitting blocks. Recurses through anything that wraps block-level content,
 * whether a real block element like a <div> of paragraphs or an inline wrapper like the <b>
 * Google Docs puts around a whole document. `marks` carries formatting down through wrappers so
 * a clearing style on the wrapper still applies to what it contains.
 */
function walkBlocks(node, blocks, marks, listType) {
  let pending = null; // inline nodes accumulating into one paragraph
  const flush = () => {
    if (pending) pushBlock(blocks, listType || 'p', pending);
    pending = null;
  };

  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (!child.nodeValue.trim()) continue;
      pending = pending || [];
      collectRuns({ childNodes: [child] }, marks, pending);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName;
    if (SKIP_TAGS.has(tag)) continue;
    if (tag === 'BR' || tag === 'HR') { flush(); continue; }

    const childMarks = marksOf(child, marks);

    if (tag === 'UL' || tag === 'OL') {
      flush();
      const type = tag === 'UL' ? 'bullet' : 'number';
      for (const kid of child.children) {
        if (kid.tagName === 'LI') walkListItem(kid, blocks, marksOf(kid, childMarks), type);
        else walkBlocks(kid, blocks, childMarks, type);
      }
      continue;
    }

    if (tag === 'LI') { flush(); walkListItem(child, blocks, childMarks, listType || 'bullet'); continue; }

    if (BLOCK_TAGS.has(tag)) {
      flush();
      const type = (tag === 'H1' || tag === 'H2') ? 'h2'
        : (tag === 'H3' || tag === 'H4' || tag === 'H5' || tag === 'H6') ? 'h3'
        : listType || 'p';
      if (wrapsBlocks(child)) walkBlocks(child, blocks, childMarks, listType);
      else pushBlock(blocks, type, collectRuns(child, childMarks, []));
      continue;
    }

    if (wrapsBlocks(child)) {
      flush();
      walkBlocks(child, blocks, childMarks, listType);
    } else {
      pending = pending || [];
      collectRuns(child, childMarks, pending);
    }
  }
  flush();
}

/** A list item, which may itself contain a nested list. Nested items flatten to one level. */
function walkListItem(li, blocks, marks, type) {
  if (wrapsBlocks(li)) walkBlocks(li, blocks, marks, type);
  else pushBlock(blocks, type, collectRuns(li, marks, []));
}

/** Walks the editor and produces the normalized block array. */
function serializeEditor(root) {
  const blocks = [];
  walkBlocks(root, blocks, {}, null);
  while (blocks.length && !blocks[blocks.length - 1].runs.length) blocks.pop();
  return blocks;
}

const richChars = (blocks) => blocks.reduce((n, b) => n + b.runs.reduce((m, r) => m + r.t.length, 0), 0);

/** True for an unanswered question, whatever the answer's shape. Mirrors richIsEmpty server-side. */
const isBlank = (v) => v === null || v === '' || typeof v === 'undefined'
  || (Array.isArray(v) && !v.some((b) => b.runs.some((r) => r.t.trim() !== '')));

/* ------------------------------------------------------------------ paste guard ------ */

/**
 * Refuses paste and drag-drop into an answer when the question on screen says so. What this
 * achieves, stated plainly so nobody over-reads the results: it stops casual pasting, it cannot
 * tell an outside source from the candidate's own spreadsheet, and devtools defeat it. It is
 * friction, never proof of who wrote what. Every attempt is counted either way.
 */
function guardPaste(el) {
  const refused = () => {
    showError('Pasting is switched off for this question. Please type your answer.');
    setTimeout(() => showError(''), 4000);
  };
  el.addEventListener('paste', (e) => {
    signals.pastes += 1;
    if (!pasteBlockedHere) return;
    e.preventDefault();
    refused();
  });
  el.addEventListener('drop', (e) => {
    if (!pasteBlockedHere) return;
    e.preventDefault();
    refused();
  });
}

const TOOLS = [
  { cmd: 'bold', label: 'B', title: 'Bold (Ctrl+B)', cls: 'rt-b' },
  { cmd: 'italic', label: 'I', title: 'Italic (Ctrl+I)', cls: 'rt-i' },
  { cmd: 'underline', label: 'U', title: 'Underline (Ctrl+U)', cls: 'rt-u' },
  { cmd: 'formatBlock', arg: 'h2', label: 'Heading', title: 'Heading' },
  { cmd: 'formatBlock', arg: 'h3', label: 'Subheading', title: 'Subheading' },
  { cmd: 'insertUnorderedList', label: '• List', title: 'Bulleted list' },
  { cmd: 'insertOrderedList', label: '1. List', title: 'Numbered list' },
  { cmd: 'formatBlock', arg: 'p', label: 'Normal', title: 'Back to normal text' },
];

function richEditor(q, field, onInput) {
  const bar = document.createElement('div');
  bar.className = 'rt-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Formatting');

  const editor = document.createElement('div');
  editor.className = 'rt-edit';
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-multiline', 'true');
  editor.spellcheck = true;
  if (q.placeholder) editor.dataset.placeholder = q.placeholder;

  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `rt-btn${t.cls ? ` ${t.cls}` : ''}`;
    b.title = t.title;
    b.textContent = t.label;
    // mousedown, not click: the editor must not lose its selection before the command runs.
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      editor.focus();
      document.execCommand(t.cmd, false, t.arg ? `<${t.arg}>` : undefined);
      onInput();
    });
    bar.append(b);
  }

  field.append(bar, editor);
  try { document.execCommand('styleWithCSS', false, false); } catch { /* not supported, fine */ }

  editor.addEventListener('input', onInput);
  guardPaste(editor);
  // A permitted paste still needs the counter and the serializer to catch up with the new content.
  editor.addEventListener('paste', () => setTimeout(onInput, 0));

  return { read: () => serializeEditor(editor), editor };
}

/* ------------------------------------------------------------------- attachments ----- */

/**
 * Reads a file as base64 without blowing the stack. The obvious `btoa(String.fromCharCode(...))`
 * throws on anything of real size; readAsDataURL hands back an already-encoded string.
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      const out = String(reader.result || '');
      const comma = out.indexOf(',');
      resolve(comma >= 0 ? out.slice(comma + 1) : '');
    };
    reader.readAsDataURL(file);
  });
}

/**
 * The file half of an answer. Any question can carry one, so this sits alongside whatever field
 * the question's type produced. The file is sent the moment it is chosen rather than when the
 * answer is submitted: an upload takes time and the grace window after the deadline is only a few
 * seconds, so attaching a file near the buzzer must not be the thing that loses it.
 *
 * Returns { has, busy }: whether a file is attached, and whether one is mid-upload.
 */
function attachmentField(q, state, field, onChange) {
  let attached = state.upload || (state.given && state.given.upload) || null;
  let busy = false;

  const box = document.createElement('div');
  box.className = 'upload';
  const file = document.createElement('input');
  file.type = 'file';
  file.className = 'upload-input';
  if (q.acceptAttr) file.accept = q.acceptAttr;
  const status = document.createElement('p');
  status.className = 'muted small upload-status';

  const paint = () => {
    status.textContent = attached
      ? `Attached: ${attached.filename} (${kb(attached.size)}). Choosing another file replaces it.`
      : q.acceptText || 'No file chosen yet.';
    status.classList.toggle('ok', !!attached);
  };

  file.addEventListener('change', async () => {
    const chosen = file.files && file.files[0];
    if (!chosen) return;

    // Checked here purely so an obviously oversized file fails instantly instead of after a long
    // upload. The server checks the same thing, and its check is the one that counts.
    if (q.maxBytes && chosen.size > q.maxBytes) {
      file.value = '';
      return showError(`That file is ${(chosen.size / 1_000_000).toFixed(1)} MB. The limit is ${(q.maxBytes / 1_000_000).toFixed(1)} MB.`);
    }

    showError('');
    status.textContent = `Uploading ${chosen.name}…`;
    busy = true;
    file.disabled = true;
    onChange();

    let res;
    try {
      const data = await fileToBase64(chosen);
      res = await api('upload', { questionId: q.id, filename: chosen.name, contentType: chosen.type, data });
    } catch {
      res = { ok: false, detail: 'That file could not be read. Try choosing it again.' };
    }

    busy = false;
    file.disabled = false;
    if (!res.ok || !res.uploaded) {
      file.value = '';
      paint();
      onChange();
      return showError(res.detail || (res.error && REJECTIONS[res.error]) || RETRY_MSG);
    }
    attached = res.uploaded;
    paint();
    onChange();
  });

  box.append(file, status);
  field.append(box);
  paint();

  return { has: () => !!attached, busy: () => busy };
}

/** What a question insists on, said the way a candidate would want to hear it. */
function requirementNote(q) {
  if (q.require === 'either') return 'Answer in writing or attach a file, whichever suits. One is enough.';
  if (q.require === 'both') return 'Both a file and a short written answer are needed here.';
  if (q.require === 'file') return 'A file is needed here.';
  if (q.require === 'optional') return 'This one is optional. You can continue without answering.';
  return null;
}

/* --------------------------------------------------------------------- question ------ */

function renderQuestion(state) {
  const q = state.question;
  deadline = state.deadline || null;
  onQuestion = true;
  currentIndex = q.index;
  currentQid = q.id;
  pasteBlockedHere = !!q.blockPaste;
  signals = { pastes: 0, blurs: 0 };
  screen('question');

  // Looking at something already submitted, rather than at the newest question.
  const past = state.given || null;
  const canEdit = past ? !!state.editable : true;
  const canRevise = !!(state.navigation && state.navigation.edit);

  const p = state.progress;
  const herePart = p && p.sections[p.sectionNumber - 1];
  hook('section').textContent = herePart ? `${herePart.label} of ${p.sectionTotal} · ` : '';
  hook('progress').textContent = p
    ? `${p.inSectionTotal == null ? `Question ${p.inSection} in this part` : `Question ${p.inSection} of ${p.inSectionTotal} in this part`} · ${p.percentDone}% done`
    : q.total == null ? `Question ${q.number}` : `Question ${q.number} of ${q.total}`;
  hook('prompt').textContent = q.prompt;
  if (q.context) {
    hook('context').textContent = q.context;
    hook('context').hidden = false;
  }
  // In per-part mode the countdown belongs to a part, and saying which one is the difference
  // between a clock and a mystery number.
  if (state.clockFor && herePart) hook('clocklabel').textContent = `${herePart.label} clock`;
  renderProgress(state);
  renderBrief(q.brief);

  const field = hook('field');
  const next = hook('next');
  const nextLabel = past
    ? (canEdit ? 'Save this change' : 'Back to where I was')
    : q.isLast ? 'Submit final answer' : 'Lock in and continue';
  next.textContent = nextLabel;

  // The footer used to state "Answers are final once you continue" whatever the test allowed.
  hook('finality').textContent = past ? ''
    : canRevise ? 'You can come back and change this later.'
    : 'Answers are final once you continue.';

  // Secondary actions, left of the primary button: review, and where allowed, Previous / Next.
  const actions = hook('actions');
  const review = reviewButton(state);
  if (review) actions.append(review);
  if (state.navigation && state.navigation.back) {
    if (state.canGoBack) actions.append(actionButton('← Previous', 'secondary', 'back'));
    if (state.canGoForward) actions.append(actionButton('Next →', 'secondary', 'forward'));
  }

  if (past) {
    const banner = document.createElement('p');
    banner.className = 'looking-back';
    banner.textContent = canEdit
      ? 'You are looking at an answer you already submitted. Changing it here replaces it.'
      : 'You are looking at an answer you already submitted. It cannot be changed.';
    field.parentNode.insertBefore(banner, field);
  }

  // The primary button has two independent reasons to be disabled, an over-long answer and an
  // upload in progress, and each used to toggle it without regard for the other. One function
  // owns the decision so neither can re-enable it while the other still has grounds not to.
  let over = false;
  let attachment = null;
  const refreshNext = () => { next.disabled = over || (attachment ? attachment.busy() : false); };

  let read; // returns what we send as `value`

  if (q.type === 'rich') {
    const counter = document.createElement('p');
    counter.className = 'counter';
    const paint = () => {
      const blocks = ed.read();
      const chars = richChars(blocks);
      const text = blocks.map((b) => b.runs.map((r) => r.t).join('')).join(' ').trim();
      const words = text ? text.split(/\s+/).length : 0;
      over = chars > q.maxLength;
      counter.textContent = over
        ? `${chars - q.maxLength} characters over the limit of ${q.maxLength}`
        : `${words} words · ${chars} / ${q.maxLength} characters`;
      counter.classList.toggle('over', over);
      // Refuse to continue rather than silently truncating someone's answer. The server clamps
      // anyway, but losing a paragraph without being told would be worse than being blocked.
      refreshNext();
    };
    const ed = richEditor(q, field, paint);
    field.append(counter);
    paint();
    read = ed.read;
    if (!past) ed.editor.focus();
  } else if (q.type === 'choice') {
    const list = document.createElement('div');
    list.className = 'opts';
    q.options.forEach((opt, i) => {
      const label = document.createElement('label');
      label.className = 'opt';
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'choice';
      input.value = String(i);
      const span = document.createElement('span');
      span.textContent = opt;
      label.append(input, span);
      input.addEventListener('change', () => {
        list.querySelectorAll('.opt').forEach((el) => el.classList.remove('sel'));
        label.classList.add('sel');
      });
      list.append(label);
    });
    field.append(list);
    read = () => {
      const sel = list.querySelector('input:checked');
      return sel ? Number(sel.value) : null;
    };
    if (!past) list.querySelector('input')?.focus();
  } else {
    if (q.type === 'upload') {
      const lbl = document.createElement('label');
      lbl.className = 'lbl';
      lbl.textContent = 'What is this file? Give it a short name.';
      field.append(lbl);
    }
    const input = document.createElement(q.type === 'long' ? 'textarea' : 'input');
    if (q.type !== 'long') input.type = 'text';
    input.maxLength = q.maxLength;
    input.placeholder = q.placeholder || (q.type === 'upload' ? 'e.g. Portfolio model, final version' : '');
    input.autocomplete = 'off';
    input.spellcheck = true;
    field.append(input);

    const counter = document.createElement('p');
    counter.className = 'counter';
    const paint = () => {
      const words = input.value.trim() ? input.value.trim().split(/\s+/).length : 0;
      counter.textContent = q.type === 'long'
        ? `${words} words · ${input.value.length} / ${q.maxLength} characters`
        : `${input.value.length} / ${q.maxLength}`;
    };
    paint();
    input.addEventListener('input', paint);
    field.append(counter);
    guardPaste(input);
    if (!past) input.focus();
    read = () => input.value.trim();
  }

  if (q.attachment && q.attachment !== 'none') attachment = attachmentField(q, state, field, refreshNext);

  const note = requirementNote(q);
  if (note) {
    const p2 = document.createElement('p');
    p2.className = 'muted small';
    p2.textContent = note;
    field.append(p2);
  }

  /**
   * One gate over both halves of an answer, because 'either' cannot be expressed as two
   * independent checks: neither half is required alone, but leaving both empty is not an answer.
   * The server re-checks all of this; this exists so the candidate hears why before the round trip.
   */
  const requirementCheck = () => {
    const hasFile = attachment ? attachment.has() : false;
    const hasText = !isBlank(read());
    const blankMsg = q.type === 'choice' ? 'Choose one option to continue.'
      : canRevise ? 'Write something to continue.'
      : 'Write something to continue. You cannot come back to this question, so if you are short of time, say what you would have done instead.';
    switch (q.require) {
      case 'file': return hasFile ? null : REJECTIONS.no_file;
      case 'both': return !hasFile ? REJECTIONS.no_file : !hasText ? 'Add a short written answer as well.' : null;
      case 'either': return hasFile || hasText ? null : REJECTIONS.need_one;
      case 'optional': return null;
      default: return hasText ? null : blankMsg;
    }
  };

  const restore = () => {
    next.textContent = nextLabel;
    refreshNext();
  };

  const submit = async (confirmDiscard = false) => {
    if (inFlight) return;

    // Looking at an old answer on a test that does not allow editing: the button is a way back to
    // the newest question, so it must not try to submit anything.
    if (past && !canEdit) {
      inFlight = true;
      const res = await api('resume');
      inFlight = false;
      if (isTransient(res)) return showError(res.detail || RETRY_MSG);
      return render(res);
    }

    const value = read();
    const blocked = requirementCheck();
    if (blocked) return showError(blocked);

    inFlight = true;
    next.disabled = true;
    next.textContent = 'Saving…';
    const res = await api('answer', { index: q.index, questionId: q.id, value, confirmDiscard, ...signals });
    inFlight = false;

    if (isTransient(res)) {
      // The server recorded nothing and the editor still holds every word, so the whole recovery
      // is to put the button back and let them press it again.
      restore();
      return showError(res.detail || RETRY_MSG);
    }

    // Changing this answer sends them down a different branch, so what they wrote after it no
    // longer belongs to any question they will be asked. The server refuses once and says how
    // much is at stake; nothing is destroyed until this is answered.
    if (res.rejected === 'would_discard') {
      restore();
      const n = res.wouldDiscard;
      const ok = confirm(`Changing this answer sends you down a different path, so the ${plural(n, 'answer')} you gave after it will be deleted. Continue?`);
      if (ok) return submit(true);
      return showError('Left as it was. Nothing was deleted.');
    }

    // Any other refusal the server can voice about THIS answer: keep the screen and say why. Only
    // a genuine change of state (finished, expired) is allowed to replace what is on screen.
    if (res.rejected && REJECTIONS[res.rejected]) {
      restore();
      showError(REJECTIONS[res.rejected]);
      if (res.rejected === 'out_of_order') setTimeout(() => render(res), 1500);
      return;
    }
    render(res);
  };

  next.addEventListener('click', () => submit(false));

  if (past) prefill(q, past, field, canEdit);
  refreshNext();
  startClock(read);
}

/**
 * Puts a submitted answer back on screen. Read-only unless the test allows editing, in which
 * case the fields stay live and saving replaces the answer.
 */
function prefill(q, given, field, canEdit) {
  if (q.type === 'choice') {
    const inputs = field.querySelectorAll('.opt input');
    if (Number.isInteger(given.choiceIndex) && inputs[given.choiceIndex]) {
      inputs[given.choiceIndex].checked = true;
      inputs[given.choiceIndex].closest('.opt').classList.add('sel');
    }
  } else if (q.type === 'rich') {
    const editor = field.querySelector('.rt-edit');
    if (editor) {
      editor.replaceChildren();
      renderStoredAnswer(editor, given.value, { blank: null });
    }
  } else {
    const input = field.querySelector('input[type=text], textarea');
    if (input) input.value = typeof given.value === 'string' ? given.value : '';
  }

  if (canEdit) return;
  for (const el of field.querySelectorAll('input, textarea, button, [contenteditable]')) {
    el.setAttribute('disabled', '');
    if (el.hasAttribute('contenteditable')) el.setAttribute('contenteditable', 'false');
  }
}

/* ---------------------------------------------------------------------- review ------- */

/**
 * Renders a stored answer, plain string or block array, as text nodes only. `blank` is what to
 * say when there is no text; null says nothing, which matters when refilling an editor.
 */
function renderStoredAnswer(container, value, { blank = '(left blank)' } = {}) {
  const nothing = () => {
    if (!blank) return;
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = blank;
    container.append(p);
  };

  if (typeof value === 'string' || value == null) {
    const text = String(value || '').trim();
    if (!text) return nothing();
    const p = document.createElement('p');
    p.textContent = text;
    container.append(p);
    return;
  }
  if (!Array.isArray(value) || !value.length) return nothing();

  let list = null;
  for (const b of value) {
    const wantList = b.type === 'bullet' ? 'ul' : b.type === 'number' ? 'ol' : null;
    if (!wantList) list = null;
    else if (!list || list.tagName.toLowerCase() !== wantList) {
      list = document.createElement(wantList);
      container.append(list);
    }
    const tag = b.type === 'h2' ? 'h3' : b.type === 'h3' ? 'h4' : wantList ? 'li' : 'p';
    const el = document.createElement(tag);
    for (const run of b.runs || []) {
      let node = document.createTextNode(run.t);
      for (const [flag, mark] of [['b', 'strong'], ['i', 'em'], ['u', 'u']]) {
        if (!run[flag]) continue;
        const w = document.createElement(mark);
        w.append(node);
        node = w;
      }
      el.append(node);
    }
    if (!el.childNodes.length) el.append(document.createTextNode(' '));
    (wantList ? list : container).append(el);
  }
}

/** Says which file was submitted. On a file-only answer, this line IS the answer. */
function fileLine(upload) {
  const p = document.createElement('p');
  p.className = 'review-file';
  const tag = document.createElement('strong');
  tag.textContent = 'File submitted: ';
  p.append(tag, document.createTextNode(`${upload.filename} (${kb(upload.size)})`));
  return p;
}

let reviewOpen = false;

/**
 * Everything already submitted, in a dialog rather than a screen, so the question underneath keeps
 * whatever has been typed into it. Nothing here can submit.
 */
async function openReview() {
  if (reviewOpen) return;
  reviewOpen = true;

  const dlg = document.createElement('dialog');
  dlg.className = 'review';
  const loading = document.createElement('p');
  loading.className = 'muted';
  loading.textContent = 'Loading your answers…';
  dlg.append(loading);
  document.body.append(dlg);
  dlg.showModal();

  const close = () => {
    reviewOpen = false;
    dlg.close();
    dlg.remove();
  };
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });

  const res = await api('review');
  dlg.replaceChildren();

  const head = document.createElement('div');
  head.className = 'review-head';
  const h = document.createElement('h2');
  h.textContent = 'Your answers so far';
  const note = document.createElement('p');
  note.className = 'muted small';
  note.textContent = res && res.navigation && res.navigation.edit
    ? 'You can go back and change any of these while you still have time. This is here so you can check what you already said.'
    : 'These are final and cannot be changed. This is here so you can check what you already said.';
  head.append(h, note);
  dlg.append(head);

  const answers = (res && res.review) || [];
  if (isTransient(res)) {
    const p = document.createElement('p');
    p.className = 'err';
    p.textContent = 'We could not load your answers just now. They are safely stored; close this and open it again in a moment.';
    dlg.append(p);
  } else if (!answers.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = 'You have not submitted anything yet.';
    dlg.append(p);
  }
  for (const a of answers) {
    const wrap = document.createElement('section');
    wrap.className = 'review-item';
    const q = document.createElement('p');
    q.className = 'review-q';
    q.textContent = `Question ${a.number}. ${a.prompt}`;
    const body = document.createElement('div');
    body.className = 'review-a';
    renderStoredAnswer(body, a.value, {
      blank: a.skipped ? 'Not reached: the time for this part ran out.' : a.upload ? null : '(left blank)',
    });
    if (a.upload) body.append(fileLine(a.upload));
    wrap.append(q, body);
    dlg.append(wrap);
  }

  const foot = document.createElement('div');
  foot.className = 'review-foot';
  const back = document.createElement('button');
  back.className = 'primary';
  back.textContent = onQuestion ? 'Back to the question' : 'Close';
  back.addEventListener('click', close);
  foot.append(back);
  dlg.append(foot);
  back.focus();
}

/** The button that opens it, shown wherever there is something to look at. */
function reviewButton(state) {
  const n = state.answered || 0;
  if (!n) return null;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'review-open';
  b.textContent = `Review your ${plural(n, 'submitted answer')}`;
  b.addEventListener('click', () => openReview());
  return b;
}

/* ------------------------------------------------------------------------ done ------- */

function renderDone(state) {
  stopClock();
  onQuestion = false;
  deadline = null;
  currentIndex = -1;
  currentQid = null;
  screen('done');

  // Written by the server, because what to say depends on what actually happened: whether the
  // time ran out, whether any questions went unreached, and whether anything can still change.
  const outro = state.outro || {};
  hook('title').textContent = outro.title || 'Submitted';
  hook('body').textContent = outro.body || '';
  if (outro.note) hook('note').textContent = outro.note;
  renderClosing(hook('closing'), outro.closing, outro.contactEmail);

  const actions = hook('actions');
  const review = reviewButton(state);
  if (review) actions.append(review);
  // On a test that allows revising there has to be a way back to the answers, or the server would
  // accept a revision that nothing could ever ask for.
  if (state.canRevise) actions.append(actionButton('Go back and change an answer', 'secondary', 'back'));

  // Only ever shown when the server says ALLOW_SELF_RESET is on, and the server refuses the
  // action regardless of what this page renders. Hiding a button is not a security control.
  if (!state.allowSelfReset) return;
  const box = hook('resetbox');
  const btn = hook('reset');
  box.hidden = false;
  btn.addEventListener('click', async () => {
    if (!confirm('Delete this session and start again from a fresh clock? The answers submitted so far are destroyed.')) return;
    btn.disabled = true;
    btn.textContent = 'Resetting…';
    const res = await api('reset');
    if (!res.ok) {
      btn.disabled = false;
      btn.textContent = 'Wipe this session and start over';
      return;
    }
    // The token is gone server-side, so drop the local copy too, then reload rather than
    // re-rendering in place: a reload clears the nav guards, the stored token and any ?t= in the
    // URL in one go, which is far harder to get subtly wrong than unpicking them by hand.
    try { localStorage.removeItem(STORE_KEY); } catch { /* nothing to clear */ }
    deadline = null;
    location.replace(location.pathname);
  });
}

/* ----------------------------------------------------------------------- clock ------- */

function stopClock() {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

/**
 * `getDraft` lets us make a best-effort save of whatever is typed when the clock hits zero, which
 * the server accepts inside its small grace window. Then `finish` is asked for, and the server
 * decides what that means: on a whole-test clock the sitting ends, on a per-part clock the
 * candidate moves to the next part, and on an untimed test nothing at all. This page never ends a
 * test on its own authority.
 */
function startClock(getDraft) {
  stopClock();
  const el = hook('clock');
  const label = hook('clocklabel');
  let ended = false;

  // An untimed test draws no clock at all. A dash where a countdown belongs reads as "is it
  // broken", so the element goes rather than sitting there empty.
  if (!deadline) {
    if (el) el.hidden = true;
    if (label) label.hidden = true;
    return;
  }
  if (el) el.hidden = false;

  const tick = async () => {
    if (!deadline) return;
    const left = deadline - now();
    if (el) {
      el.textContent = mmss(left);
      el.classList.toggle('warn', left <= 300000 && left > 60000);
      el.classList.toggle('danger', left <= 60000);
    }
    if (left > 0 || ended) return;

    ended = true;
    stopClock();
    inFlight = true;
    const draft = getDraft ? getDraft() : null;
    if (!isBlank(draft) && currentIndex >= 0) {
      await api('answer', { index: currentIndex, questionId: currentQid, value: draft, ...signals });
    }
    inFlight = false;

    // Retry a few times before falling back to the offline screen: this is the worst possible
    // moment to show someone "this link is not valid".
    let res = await api('finish');
    for (let attempt = 0; isTransient(res) && attempt < 5; attempt += 1) {
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      res = await api('finish');
    }
    render(res);
  };

  tick();
  ticker = setInterval(tick, 250);
}

/* ---------------------------------------------------------------------- router ------- */

/**
 * Shown only when the server could not be reached at all. Safe to draw over whatever was on
 * screen, because every caller holding unsaved work intercepts a transient failure before it
 * reaches the router.
 */
function renderOffline(state) {
  stopClock();
  onQuestion = false;
  screen('offline');
  if (state && state.detail) hook('detail').textContent = state.detail;
  const btn = hook('retry');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Trying again…';
    render(await api(token ? 'state' : 'hello'));
  });
}

function render(state) {
  if (!state || !state.ok) {
    if (isTransient(state)) return renderOffline(state);
    // A stored token the server no longer recognises should not strand a candidate on a dead end;
    // drop it and let them identify themselves again.
    if (state && state.error === 'invalid_link' && !params.get('t') && localStorage.getItem(STORE_KEY)) {
      localStorage.removeItem(STORE_KEY);
      token = '';
      return boot();
    }
    return renderInvalid();
  }
  if (state.phase === 'anonymous') {
    return state.openRegistration ? renderIdentify(state) : renderInvalid();
  }
  // A question is served either because the test is still running, or because they stepped back
  // to revise one on a test that allows it. Both render the same screen.
  if (state.question) {
    guardNavigation();
    return renderQuestion(state);
  }
  if (state.phase === 'ready') return renderInstructions(state);
  return renderDone(state);
}

async function boot() {
  render(await api(token ? 'state' : 'hello'));
}

boot();
