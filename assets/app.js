/**
 * Candidate client. Deliberately thin: it renders whatever the server says and nothing else.
 *
 * It holds no copy of the questions, does not decide the deadline, and has no code path that
 * moves backwards. If someone edits this file in devtools the worst they achieve is a broken
 * page, because every response is re-validated server-side (see functions/_lib/engine.js).
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

// Counted for the whole session and attributed to whichever question is open. Candidates are
// told they may use AI and a spreadsheet, so this is activity data for context, not evidence
// of anything: leaving the tab is exactly what we asked them to do.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && currentIndex >= 0) signals.blurs += 1;
});

const now = () => Date.now() + clockOffset;

async function api(action, extra = {}) {
  const res = await fetch('/api/work-test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, token, ...extra }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'bad_response' }));
  if (typeof data.serverNow === 'number') clockOffset = data.serverNow - Date.now();
  if (data.token) {
    token = data.token;
    try { localStorage.setItem(STORE_KEY, token); } catch { /* private mode; the email still resumes it */ }
  }
  return data;
}

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
    if (deadline && now() < deadline) history.pushState({ lock: 1 }, '');
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
  hook('count').textContent = String(state.total);
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
function renderProgress(progress, { preview = false } = {}) {
  const track = hook('track');
  const note = hook('tracknote');
  if (!track || !progress) return;

  track.replaceChildren();
  for (const s of progress.sections) {
    const seg = document.createElement('div');
    seg.className = `seg ${s.state}`;
    seg.style.flexGrow = String(s.recommendedMin);
    seg.title = `${s.label}: ${s.summary}. About ${s.recommendedMin} minutes, ${s.total} question${s.total === 1 ? '' : 's'}.`;

    const fill = document.createElement('div');
    fill.className = 'seg-fill';
    fill.style.width = `${s.total ? (s.done / s.total) * 100 : 0}%`;
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
      .map((s) => `${s.label}, ${s.summary.toLowerCase()}: ${s.total} question${s.total === 1 ? '' : 's'}, about ${s.recommendedMin} minutes (${s.share}% of the work)`)
      .join('. ') + '. Those timings are a suggestion, not a rule; the only hard limit is the total.';
    return;
  }

  const here = progress.sections[progress.sectionNumber - 1];
  const rest = progress.sections.slice(progress.sectionNumber);
  const parts = [];
  if (here) {
    parts.push(`${here.label} of ${progress.sectionTotal}: ${here.summary}. `
      + `Question ${progress.inSection} of ${here.total} in this part, and this part is about `
      + `${here.recommendedMin} minutes of the ${progress.sections.reduce((n, s) => n + s.recommendedMin, 0)}.`);
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
  editor.addEventListener('paste', () => { signals.pastes += 1; setTimeout(onInput, 0); });
  editor.focus();

  return { read: () => serializeEditor(editor), editor };
}

function renderQuestion(state) {
  const q = state.question;
  deadline = state.deadline;
  currentIndex = q.index;
  signals = { pastes: 0, blurs: 0 };
  screen('question');

  const p = state.progress;
  hook('section').textContent = p ? `${p.sections[p.sectionNumber - 1].label} of ${p.sectionTotal} · ` : '';
  hook('progress').textContent = p
    ? `Question ${p.inSection} of ${p.inSectionTotal} in this part · ${p.percentDone}% done`
    : `Question ${q.number} of ${q.total}`;
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
  next.textContent = q.number === q.total ? 'Submit final answer' : 'Lock in and continue';

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
    const input = document.createElement(q.type === 'long' ? 'textarea' : 'input');
    if (q.type !== 'long') input.type = 'text';
    input.maxLength = q.maxLength;
    if (q.placeholder) input.placeholder = q.placeholder;
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

    input.addEventListener('paste', () => { signals.pastes += 1; });

    input.focus();
    read = () => input.value.trim();
  }

  if (!q.required) {
    const opt = document.createElement('p');
    opt.className = 'muted small';
    opt.textContent = 'This one is optional. You can continue without answering.';
    field.append(opt);
  }

  next.addEventListener('click', async () => {
    if (inFlight) return;
    const value = read();
    if (q.required && isBlank(value)) {
      showError(q.type === 'choice'
        ? 'Choose one option to continue.'
        : 'Write something to continue. You cannot come back to this question, so if you are short of time, say what you would have done instead.');
      return;
    }
    inFlight = true;
    next.disabled = true;
    next.textContent = 'Saving…';
    const res = await api('answer', { index: q.index, value, ...signals });
    inFlight = false;
    render(res);
  });

  startClock(read);
}

function renderDone(state) {
  stopClock();
  deadline = null;
  currentIndex = -1;
  screen('done');
  const n = state.answered;
  if (state.phase === 'expired' || state.ranOut) {
    hook('title').textContent = 'Time is up';
    hook('body').textContent = `Your time has run out, so the task has closed. We have saved the ${n} answer${n === 1 ? '' : 's'} you submitted and those are what we will read.`;
  } else {
    hook('title').textContent = 'Thank you, that is submitted';
    hook('body').textContent = `All ${n} answers are recorded against your name and email.`;
  }

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
      await api('answer', { index: currentIndex, value: draft, ...signals }).catch(() => {});
    }
    inFlight = false;
    currentIndex = -1;
    render(await api('finish'));
  };

  tick();
  ticker = setInterval(tick, 250);
}

/* ---------------------------------------------------------------------- router ------- */

function render(state) {
  if (!state || !state.ok) {
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
