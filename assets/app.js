/**
 * Candidate client. Deliberately thin: it renders whatever the server says and nothing else.
 *
 * It holds no copy of the questions, does not decide the deadline, and has no code path that
 * moves backwards. If someone edits this file in devtools the worst they achieve is a broken
 * page, because every response is re-validated server-side (see functions/_lib/wt-engine.mjs).
 *
 * The clock shown here is cosmetic. `deadline` comes from the server and every response
 * carries `serverNow`, which we use to correct for a wrong device clock. A candidate who
 * changes their system time sees a wrong countdown but gets no extra seconds.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const app = $('#app');
const params = new URLSearchParams(location.search);

/**
 * A token can arrive three ways, in order of trust: an admin-issued link, a session we
 * already started in this browser, or self-registration with a name and email. The stored
 * copy only saves a returning candidate from retyping their email; the server would hand back
 * the same session either way.
 */
const STORE_KEY = 'work-test-token';
let token = params.get('t') || params.get('token') || localStorage.getItem(STORE_KEY) || '';

let clockOffset = 0; // serverNow - clientNow
let deadline = null;
let ticker = null;
let inFlight = false;
let signals = { pastes: 0, blurs: 0 }; // reset at the start of each question
let guarded = false;
let currentIndex = -1;
// The id of the question on screen. Since questions branch, position is no longer enough to say
// which one a submission is for, and the server checks the two against each other.
let currentQid = null;
// Mirrors INTEGRITY.blockPaste from the server. Kept at module scope so a paste handler can ask
// the current answer rather than one captured when its question was built.
let serverBlockPaste = false;

// Counted for the whole session and attributed to whichever question is open. Candidates are
// told they may use AI and a spreadsheet, so this is activity data for context, not evidence
// of anything: leaving the tab is exactly what we asked them to do.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && currentIndex >= 0) signals.blurs += 1;
});

const now = () => Date.now() + clockOffset;

/**
 * Every failure the server can produce comes back as JSON, so the only thing this has to add is
 * what happens when there is no response at all. An offline moment used to reject here and take
 * the whole click handler with it: `inFlight` stayed true, the button sat on "Saving..." forever,
 * and the candidate was left on a dead page with the clock still running. Now it becomes an
 * ordinary error object, and the caller decides what to do about it.
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
  if (typeof data.blockPaste === 'boolean') serverBlockPaste = data.blockPaste;
  if (data.token) {
    token = data.token;
    try { localStorage.setItem(STORE_KEY, token); } catch { /* private mode; the email still resumes it */ }
  }
  return data;
}

/**
 * Failures that mean "press it again", as opposed to "this session is over". The difference
 * matters more here than in most apps: redrawing the screen on one of these would throw away an
 * answer the candidate is part-way through typing, on a clock they cannot get back. So every
 * caller that has unsaved work on screen checks this FIRST and leaves the page untouched.
 */
const TRANSIENT = new Set(['network', 'bad_response', 'store_unavailable']);
const isTransient = (res) => !!res && !res.ok && TRANSIENT.has(res.error);

/** Said whenever we could not reach the server. The reassurance is the important half. */
const RETRY_MSG = 'We could not reach the server. Nothing has been lost. Check your connection '
  + 'and press the button again, and do not reload or start over.';

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

/* -------------------------------------------------------------- back-nav guard ------- */

/**
 * The browser back button must not take a candidate out of a question. There is no earlier
 * state to return to, so we keep a sentinel history entry and immediately re-push it if it is
 * popped. Combined with the server refusing any index that is not the next one, this makes
 * "go back and change my answer" impossible rather than merely hidden.
 */
function guardNavigation() {
  if (guarded) return;
  guarded = true;
  history.pushState({ lock: 1 }, '');
  addEventListener('popstate', () => {
    if (!deadline || now() >= deadline) return;
    history.pushState({ lock: 1 }, '');
    // Back used to do nothing, which reads as a broken page. It is also the obvious gesture for
    // "let me see what I already wrote", so give them exactly that, read-only.
    openReview();
  });
  addEventListener('beforeunload', (e) => {
    if (deadline && now() < deadline) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

/* --------------------------------------------------------------------- screens ------- */

function renderInvalid() {
  stopClock();
  screen('invalid');
}

/** Self-serve entry: the candidate tells us who they are before anything starts. */
function renderIdentify(state) {
  screen('identify');
  const nameEl = $('#cand-name');
  const emailEl = $('#cand-email');
  const go = hook('go');
  nameEl.focus();

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
  // Enter should submit from either field; it is the obvious thing to press.
  for (const el of [nameEl, emailEl]) {
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  if (state && state.durationSec) {
    hook('go').closest('.bar').querySelector('.small').textContent =
      `Nothing has started yet. The task takes ${humanDuration(state.durationSec)} once you begin.`;
  }
}

function renderInstructions(state) {
  screen('instructions');
  const first = (state.candidate.name || '').trim().split(/\s+/)[0];
  if (first) hook('greeting').textContent = `${first}, before you start`;
  hook('duration').textContent = humanDuration(state.durationSec);
  // A branching test has no single length until the branches resolve, so say the honest range
  // rather than pick a number that will turn out to be wrong for most people.
  const range = state.totalRange;
  hook('count').textContent = state.total != null ? String(state.total)
    : range && range.min !== range.max ? `${range.min} to ${range.max}`
    : range ? String(range.max)
    : 'several';
  hook('who').textContent = state.candidate.name ? `Submitting as ${state.candidate.name}` : '';
  // Show the shape of the task before they commit to starting it, not only once the clock runs.
  renderProgress(state.progress, { preview: true });

  const btn = hook('begin');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Starting…';
    guardNavigation();
    render(await api('start', { userAgent: navigator.userAgent }));
  });
}

/**
 * The progress bar, segmented by part and weighted by how long each part is expected to take
 * rather than by how many questions it holds. Part 1 is two thirds of the recommended time, so
 * it gets two thirds of the width, and finishing it genuinely means two thirds done.
 */
/** How many questions a part holds, or an honest refusal when the branch decides. */
function countOf(s) {
  if (s.total == null) return 'a number of questions that depends on your answers';
  return `${s.total} question${s.total === 1 ? '' : 's'}`;
}

function renderProgress(progress, { preview = false } = {}) {
  const track = hook('track');
  const note = hook('tracknote');
  if (!track || !progress) return;

  track.replaceChildren();
  for (const s of progress.sections) {
    // A part this candidate's branch routes around is not drawn at all. The server has already
    // taken it out of the shares, so drawing it would leave a slice of the bar that nothing can
    // ever fill, which reads as being permanently behind.
    if (s.state === 'skipped') continue;

    const seg = document.createElement('div');
    seg.className = `seg ${s.state}`;
    seg.style.flexGrow = String(s.recommendedMin);
    seg.title = `${s.label}: ${s.summary}. About ${s.recommendedMin} minutes, ${countOf(s)}.`;

    const fill = document.createElement('div');
    fill.className = 'seg-fill';
    // Worked out server-side: when the total is unknown the honest denominator is the shortest
    // route still ahead, and the page has deliberately not been told what that is.
    fill.style.width = `${s.fill}%`;
    seg.append(fill);

    const tag = document.createElement('span');
    tag.className = 'seg-tag';
    // Percentages read as effort, which is the question a candidate is actually asking.
    tag.textContent = `${s.label} · ${s.share}%`;
    seg.append(tag);

    track.append(seg);
  }

  if (preview) {
    // Before the clock starts, describe the shape rather than a position within it.
    note.textContent = progress.sections
      .filter((s) => s.state !== 'skipped')
      .map((s) => `${s.label}, ${s.summary.toLowerCase()}: ${countOf(s)}, about ${s.recommendedMin} minutes (${s.share}% of the work)`)
      .join('. ') + '. Those timings are a suggestion, not a rule; the only hard limit is the total.';
    return;
  }

  const here = progress.sections[progress.sectionNumber - 1];
  const rest = progress.sections.slice(progress.sectionNumber).filter((s) => s.state !== 'skipped');
  const parts = [];
  if (here) {
    const where = here.total == null
      ? `Question ${progress.inSection} in this part`
      : `Question ${progress.inSection} of ${here.total} in this part`;
    const planned = progress.sections
      .filter((s) => s.state !== 'skipped')
      .reduce((n, s) => n + s.recommendedMin, 0);
    parts.push(`${here.label} of ${progress.sectionTotal}: ${here.summary}. `
      + `${where}, and this part is about ${here.recommendedMin} minutes of the ${planned}.`);
  }
  parts.push(rest.length
    ? `Still to come: ${rest.map((s) => `${s.label} (${s.summary.toLowerCase()}, about ${s.recommendedMin} min)`).join(', ')}.`
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
    } else if (block.type === 'link') {
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
 *
 * A style can also *clear* a mark, and that is not a nicety. Google Docs wraps its entire
 * clipboard payload in `<b style="font-weight:normal">`, so honouring the tag but ignoring the
 * style would bold every pasted document in its entirety.
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
        // A soft break inside a block becomes a newline, preserved on render and in the CSV.
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
 * whether it is a real block element like a <div> of paragraphs or an inline wrapper like the
 * <b> Google Docs puts around a whole document. `marks` carries formatting down through those
 * wrappers so a clearing style on the wrapper still applies to what it contains.
 */
function walkBlocks(node, blocks, marks, listType) {
  let pending = null; // inline nodes accumulating into one paragraph
  const flush = () => {
    if (pending) pushBlock(blocks, listType || 'p', pending);
    pending = null;
  };

  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (!child.nodeValue.trim()) continue; // whitespace between tags, not content
      pending = pending || [];
      collectRuns({ childNodes: [child] }, marks, pending);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName;
    if (SKIP_TAGS.has(tag)) continue;
    if (tag === 'BR') { flush(); continue; }
    if (tag === 'HR') { flush(); continue; }

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
      // A <div> or <td> holding further blocks is structure, not a paragraph.
      if (wrapsBlocks(child)) walkBlocks(child, blocks, childMarks, listType);
      else pushBlock(blocks, type, collectRuns(child, childMarks, []));
      continue;
    }

    // Inline element. If it wraps blocks it is a transparent container; otherwise it is text.
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
  if (wrapsBlocks(li)) {
    walkBlocks(li, blocks, marks, type);
  } else {
    pushBlock(blocks, type, collectRuns(li, marks, []));
  }
}

/** Walks the editor and produces the normalized block array. */
function serializeEditor(root) {
  const blocks = [];
  walkBlocks(root, blocks, {}, null);
  while (blocks.length && !blocks[blocks.length - 1].runs.length) blocks.pop();
  return blocks;
}

const richChars = (blocks) => blocks.reduce((n, b) => n + b.runs.reduce((m, r) => m + r.t.length, 0), 0);

/* ------------------------------------------------------------------- review ---------- */

/**
 * Read-only view of everything already submitted.
 *
 * Going back to look is a reasonable thing to want: by Part 2 a candidate is replying to a
 * manager about numbers they wrote forty minutes earlier, and making them remember exactly what
 * they said tests memory rather than judgment. Going back to *change* is the thing the whole
 * design refuses.
 *
 * So this is a dialog, not a screen: the question underneath keeps its state, nothing typed is
 * lost, and there is no control here that can submit. The server enforces the rest, since
 * `answer` only ever accepts the next index.
 */
let reviewOpen = false;

/** Renders a stored answer, plain string or block array, as text nodes only. */
function renderStoredAnswer(container, value) {
  if (typeof value === 'string' || value == null) {
    const p = document.createElement('p');
    p.textContent = String(value || '').trim() || '(left blank)';
    if (!String(value || '').trim()) p.className = 'muted';
    container.append(p);
    return;
  }
  if (!Array.isArray(value) || !value.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '(left blank)';
    container.append(p);
    return;
  }

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
    if (!el.childNodes.length) el.innerHTML = '&nbsp;';
    (wantList ? list : container).append(el);
  }
}

async function openReview() {
  if (reviewOpen) return;
  reviewOpen = true;

  const dlg = document.createElement('dialog');
  dlg.className = 'review';
  dlg.innerHTML = '<p class="muted">Loading your answers&hellip;</p>';
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
  note.textContent = 'These are final and cannot be changed. This is here so you can check what you already said.';
  head.append(h, note);
  dlg.append(head);

  const answers = (res && res.review) || [];
  if (isTransient(res)) {
    // Saying "you have not submitted anything yet" here would be a lie, and an alarming one to
    // read forty minutes into a test. Say what actually happened.
    const p = document.createElement('p');
    p.className = 'err';
    p.textContent = 'We could not load your answers just now. They are safely stored; close this '
      + 'and open it again in a moment.';
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
    renderStoredAnswer(body, a.value);
    wrap.append(q, body);
    dlg.append(wrap);
  }

  const foot = document.createElement('div');
  foot.className = 'review-foot';
  const back = document.createElement('button');
  back.className = 'primary';
  back.textContent = 'Back to the question';
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
  b.textContent = `Review your ${n} submitted answer${n === 1 ? '' : 's'}`;
  b.addEventListener('click', () => openReview());
  return b;
}

/* --------------------------------------------------------------- paste blocking ------ */

/**
 * Whether pasting into an answer is currently refused. Two independent sources, either of which
 * turns it on: `INTEGRITY.blockPaste` in the questions file, and the internal testing toggle that
 * the demo site shows in its banner (assets/testing-toggle.js).
 *
 * Read at the moment of the paste rather than captured when the question renders, so flipping the
 * toggle takes effect immediately without reloading or losing what has been typed.
 *
 * What this actually achieves, stated plainly so nobody over-reads the results:
 *
 *   - It stops casual pasting. The `paste` event fires for Ctrl/Cmd+V, the right-click menu and
 *     middle-click, so all three are covered, and `drop` covers dragging text in.
 *   - It CANNOT tell where the clipboard came from. A candidate pasting their own figures back
 *     from the spreadsheet Part 1 sends them to build is blocked exactly like anything else.
 *   - It is trivially defeated by devtools, by turning off JavaScript, or by retyping from a
 *     second screen. Treat it as friction, never as proof that an answer was written here.
 */
const PASTE_TOGGLE_KEY = 'work-test-block-paste';

function pasteBlocked() {
  if (serverBlockPaste) return true;
  try {
    return localStorage.getItem(PASTE_TOGGLE_KEY) === 'on';
  } catch {
    return false; // private mode, or storage disabled
  }
}

/** Wires refusal onto one editable element. Always records the attempt, blocked or not. */
function guardPaste(el, onBlocked) {
  el.addEventListener('paste', (e) => {
    signals.pastes += 1;
    if (!pasteBlocked()) return;
    e.preventDefault();
    onBlocked();
  });
  // Dragging text in is the same act by another route.
  el.addEventListener('drop', (e) => {
    if (!pasteBlocked()) return;
    e.preventDefault();
    onBlocked();
  });
}

/** True for an unanswered question, whatever the answer's shape. Mirrors richIsEmpty server-side. */
const isBlank = (v) => v === null || v === '' || typeof v === 'undefined'
  || (Array.isArray(v) && !v.some((b) => b.runs.some((r) => r.t.trim() !== '')));

const TOOLS = [
  { cmd: 'bold', label: 'B', title: 'Bold (Ctrl+B)', style: 'font-weight:800' },
  { cmd: 'italic', label: 'I', title: 'Italic (Ctrl+I)', style: 'font-style:italic' },
  { cmd: 'underline', label: 'U', title: 'Underline (Ctrl+U)', style: 'text-decoration:underline' },
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
    b.className = 'rt-btn';
    b.title = t.title;
    b.textContent = t.label;
    if (t.style) b.setAttribute('style', t.style);
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
  // Prefer <b>/<i>/<u> tags over inline styles. Our serializer reads both, so this is only to
  // keep what the browser generates a little closer to what we emit.
  try { document.execCommand('styleWithCSS', false, false); } catch { /* not supported, fine */ }

  editor.addEventListener('input', onInput);
  guardPaste(editor, () => {
    showError('Pasting is switched off for this exercise. Please type your answer.');
    setTimeout(() => showError(''), 4000);
  });
  // A permitted paste still needs the counter and the serializer to catch up with the new content.
  editor.addEventListener('paste', () => setTimeout(onInput, 0));
  editor.focus();

  return { read: () => serializeEditor(editor), editor };
}

/**
 * Reads a file as base64 without blowing the stack.
 *
 * The obvious `btoa(String.fromCharCode(...bytes))` throws on anything of real size, because
 * spreading a multi-megabyte array exceeds the argument limit. readAsDataURL hands back an
 * already-encoded string, so the encoding never passes through JavaScript at all.
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

const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1000))} KB`;

/**
 * The file half of an answer. Any question can carry one now, so this sits alongside whatever
 * field the question's type produces rather than replacing it.
 *
 * The file is sent the moment it is chosen rather than when the answer is submitted. An upload
 * takes time and the grace window after the deadline is only a few seconds, so attaching a file
 * near the buzzer must not be the thing that loses it. By the time the candidate presses
 * continue the file is already stored, and all that travels with the answer is the text.
 *
 * Returns `{ has }` so the caller can fold the file into whatever the question requires.
 */
function attachmentField(q, state, field, next) {
  let attached = state.upload || (state.given && state.given.upload) || null;

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
      paint();
      return showError(`That file is ${(chosen.size / 1_000_000).toFixed(1)} MB. The limit is ${(q.maxBytes / 1_000_000).toFixed(1)} MB.`);
    }

    showError('');
    status.textContent = `Uploading ${chosen.name}…`;
    next.disabled = true;
    file.disabled = true;

    let data;
    try {
      data = await fileToBase64(chosen);
    } catch {
      next.disabled = false;
      file.disabled = false;
      file.value = '';
      paint();
      return showError('That file could not be read. Try choosing it again.');
    }

    const res = await api('upload', {
      questionId: q.id, filename: chosen.name, contentType: chosen.type, data,
    });
    next.disabled = false;
    file.disabled = false;

    if (!res.ok || !res.uploaded) {
      file.value = '';
      paint();
      return showError(res.detail || RETRY_MSG);
    }
    attached = res.uploaded;
    paint();
  });

  box.append(file, status);
  field.append(box);
  paint();

  return { has: () => !!attached };
}

/** What a question insists on, said the way a candidate would want to hear it. */
function requirementNote(q) {
  if (q.require === 'either') return 'Answer in writing or attach a file, whichever suits. One is enough.';
  if (q.require === 'both') return 'Both a file and a short written answer are needed here.';
  if (q.require === 'file') return 'A file is needed here.';
  if (q.require === 'optional') return 'This one is optional. You can continue without answering.';
  return null;
}

function renderQuestion(state) {
  const q = state.question;
  deadline = state.deadline || null;
  currentIndex = q.index;
  currentQid = q.id;
  signals = { pastes: 0, blurs: 0 };
  screen('question');

  // Looking at something already submitted, rather than at the newest question.
  const past = state.given || null;
  const canEdit = past ? !!state.editable : true;

  const p = state.progress;
  hook('section').textContent = p ? `${p.sections[p.sectionNumber - 1].label} of ${p.sectionTotal} · ` : '';
  const inPart = p && p.inSectionTotal == null
    ? `Question ${p.inSection} in this part`
    : p ? `Question ${p.inSection} of ${p.inSectionTotal} in this part` : '';
  hook('progress').textContent = p
    ? `${inPart} · ${p.percentDone}% done`
    : q.total == null ? `Question ${q.number}` : `Question ${q.number} of ${q.total}`;
  hook('prompt').textContent = q.prompt;
  if (q.context) {
    const c = hook('context');
    c.textContent = q.context;
    c.hidden = false;
  }
  renderProgress(p);
  renderBrief(q.brief);

  const field = hook('field');
  const next = hook('next');
  // isLast comes from the server, which is the only thing that knows whether every route out of
  // this question ends here. Comparing a number against a total cannot answer that any more.
  const nextLabel = past
    ? (canEdit ? 'Save this change' : 'Back to where I was')
    : q.isLast ? 'Submit final answer' : 'Lock in and continue';
  next.textContent = nextLabel;

  // Looking back is allowed; changing is not, unless the test says so. The dialog leaves this
  // question untouched either way.
  const review = reviewButton(state);
  if (review) next.parentNode.insertBefore(review, next);

  if (state.navigation && state.navigation.back) navButtons(state, next);
  if (past) {
    const banner = document.createElement('p');
    banner.className = 'looking-back';
    banner.textContent = canEdit
      ? 'You are looking at an answer you already submitted. Changing it here replaces it.'
      : 'You are looking at an answer you already submitted. It cannot be changed.';
    field.parentNode.insertBefore(banner, field);
  }

  let read; // returns what we send as `value`

  if (q.type === 'rich') {
    const counter = document.createElement('p');
    counter.className = 'counter';
    let over = false;

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
      next.disabled = over;
    };

    const ed = richEditor(q, field, paint);
    field.append(counter);
    paint();
    read = ed.read;
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
    const firstOpt = list.querySelector('input');
    if (firstOpt) firstOpt.focus();
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
    if (q.placeholder) input.placeholder = q.placeholder;
    if (q.type === 'upload' && !q.placeholder) input.placeholder = 'e.g. Portfolio model, final version';
    input.autocomplete = 'off';
    input.spellcheck = true;
    field.append(input);

    const counter = document.createElement('p');
    counter.className = 'counter';
    const words = () => input.value.trim() ? input.value.trim().split(/\s+/).length : 0;
    const paint = () => {
      counter.textContent = q.type === 'long'
        ? `${words()} words · ${input.value.length} / ${q.maxLength} characters`
        : `${input.value.length} / ${q.maxLength}`;
    };
    paint();
    input.addEventListener('input', paint);
    field.append(counter);

    guardPaste(input, () => {
      showError('Pasting is switched off for this exercise. Please type your answer.');
      setTimeout(() => showError(''), 4000);
    });

    input.focus();
    read = () => input.value.trim();
  }

  // Any question can take a file, so the widget is appended after whatever field its type made.
  let attachment = null;
  if (q.attachment && q.attachment !== 'none') attachment = attachmentField(q, state, field, next);

  const note = requirementNote(q);
  if (note) {
    const p2 = document.createElement('p');
    p2.className = 'muted small';
    p2.textContent = note;
    field.append(p2);
  }

  // One gate over both halves of an answer, because 'either' cannot be expressed as two
  // independent checks: neither is required alone, but leaving both empty is not an answer.
  const requirementCheck = () => {
    const hasFile = attachment ? attachment.has() : false;
    const hasText = !isBlank(read());
    switch (q.require) {
      case 'file': return hasFile ? null : 'Attach a file before continuing.';
      case 'both': return !hasFile ? 'Attach a file before continuing.'
        : !hasText ? 'Add a short written answer as well.' : null;
      case 'either': return hasFile || hasText
        ? null
        : 'Write an answer or attach a file. Either one is enough.';
      case 'optional': return null;
      default: return hasText ? null : null; // plain text is handled by the blank check below
    }
  };

  const submit = async (confirmDiscard = false) => {
    if (inFlight) return;

    // Looking at an old answer on a test that does not allow editing: the button is just a way
    // back to where they were, so it must not try to submit anything.
    if (past && !canEdit) return render(await api('forward'));

    const value = read();
    const blocked = requirementCheck();
    if (blocked) return showError(blocked);
    if (q.require === undefined && q.required && isBlank(value)) {
      showError(q.type === 'choice'
        ? 'Choose one option to continue.'
        : 'Write something to continue. You cannot come back to this question, so if you are short of time, say what you would have done instead.');
      return;
    }
    inFlight = true;
    next.disabled = true;
    next.textContent = 'Saving…';
    const res = await api('answer', {
      index: q.index, questionId: q.id, value, confirmDiscard, ...signals,
    });
    inFlight = false;

    if (isTransient(res)) {
      // The server recorded nothing and the editor still holds every word of the answer, so the
      // whole recovery is to put the button back and let them press it again. Re-rendering would
      // be the one unrecoverable mistake available at this point.
      next.disabled = false;
      next.textContent = nextLabel;
      showError(res.detail || RETRY_MSG);
      return;
    }

    // Changing this answer sends them down a different branch, so what they wrote after it no
    // longer belongs to any question they will be asked. The server refuses once and says how
    // much is at stake; nothing is destroyed until this is answered.
    if (res.rejected === 'would_discard') {
      next.disabled = false;
      next.textContent = nextLabel;
      const n = res.wouldDiscard;
      const ok = confirm(`Changing this answer sends you down a different path, so the ${n} answer${n === 1 ? '' : 's'} you gave after it will be deleted. Continue?`);
      if (ok) return submit(true);
      return showError('Left as it was. Nothing was deleted.');
    }
    render(res);
  };

  next.addEventListener('click', () => submit(false));

  if (past) prefill(q, past, field, canEdit);
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
      renderStoredAnswer(editor, given.value);
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

/**
 * Back and forward, shown only when the test allows looking at earlier answers. Moving between
 * questions this way changes nothing: the server treats it as a cursor and the frontier is
 * exactly where it was.
 */
function navButtons(state, next) {
  const bar = next.parentNode;
  const move = (action, label, enabled) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost-btn nav-btn';
    b.textContent = label;
    b.disabled = !enabled;
    b.addEventListener('click', async () => {
      if (inFlight) return;
      inFlight = true;
      const res = await api(action);
      inFlight = false;
      if (isTransient(res)) return showError(res.detail || RETRY_MSG);
      render(res);
    });
    bar.insertBefore(b, next);
  };
  move('back', '\u2190 Previous', !!state.canGoBack);
  if (state.canGoForward) move('forward', 'Next \u2192', true);
}

function renderDone(state) {
  stopClock();
  deadline = null;
  currentIndex = -1;
  currentQid = null;
  screen('done');
  const n = state.answered;
  if (state.phase === 'expired' || state.ranOut) {
    hook('title').textContent = 'Time is up';
    hook('body').textContent = `Your time has run out, so the task has closed. We have saved the ${n} answer${n === 1 ? '' : 's'} you submitted and those are what we will read.`;
  } else {
    hook('title').textContent = 'Thank you, that is submitted';
    hook('body').textContent = `All ${n} answers are recorded against your name and email.`;
  }

  // Reading back what they submitted is still allowed once the task has closed.
  const review = reviewButton(state);
  if (review) hook('body').after(review);

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
    // re-rendering in place. A reload clears the nav guards, the stored token and any ?t= in the
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
 * `getDraft` lets us make a best-effort save of whatever is typed when the clock hits zero,
 * which the server accepts inside its small grace window. If the request loses that race the
 * answer is simply blank, which is what the instructions told the candidate to expect.
 */
function startClock(getDraft) {
  stopClock();
  const el = hook('clock');
  let ended = false;

  // An untimed test draws no clock at all. Showing a dash where a countdown belongs invites the
  // question "is it broken", so the element goes rather than sits there empty.
  if (!deadline) {
    if (el) el.hidden = true;
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
    currentIndex = -1;
    currentQid = null;

    // The clock has run out whether or not we can say so, and this is the worst possible moment
    // to show someone "this link is not valid". Retry a few times before falling back to the
    // offline screen, which at least tells them the truth and offers a button.
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
  screen('offline');
  if (state && state.detail) hook('detail').textContent = state.detail;
  const btn = hook('retry');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Trying again...';
    // The deadline is held on the server, so nothing here can buy time by reconnecting late.
    render(await api(token ? 'state' : 'hello'));
  });
}

function render(state) {
  if (!state || !state.ok) {
    // A connection that dropped is not a dead session, and telling someone mid-test that their
    // link is invalid would send them looking for a new one, which is the one thing that cannot
    // help: the session is keyed to them either way.
    if (isTransient(state)) return renderOffline(state);
    // A stored token that the server no longer recognises should not strand a candidate on a
    // dead end; drop it and let them identify themselves again.
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
  if (state.phase === 'running') {
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
