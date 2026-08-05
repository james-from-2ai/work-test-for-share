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
  const res = await fetch('/api/test', {
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

  const btn = hook('begin');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Starting…';
    guardNavigation();
    render(await api('start', { userAgent: navigator.userAgent }));
  });
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

function renderQuestion(state) {
  const q = state.question;
  deadline = state.deadline;
  currentIndex = q.index;
  signals = { pastes: 0, blurs: 0 };
  screen('question');

  hook('section').textContent = q.brief && q.brief.section ? `${q.brief.section} · ` : '';
  hook('progress').textContent = `Question ${q.number} of ${q.total}`;
  hook('prompt').textContent = q.prompt;
  if (q.context) {
    const c = hook('context');
    c.textContent = q.context;
    c.hidden = false;
  }
  hook('track').style.width = `${((q.number - 1) / q.total) * 100}%`;
  renderBrief(q.brief);

  const field = hook('field');
  const next = hook('next');
  next.textContent = q.number === q.total ? 'Submit final answer' : 'Lock in and continue';

  let read; // returns what we send as `value`

  if (q.type === 'choice') {
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
    if (q.required && (value === null || value === '')) {
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
    if (draft !== null && draft !== '' && currentIndex >= 0) {
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
