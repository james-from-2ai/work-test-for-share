/**
 * The internal testing toggle shown in the demo banner, on both the test and the results board.
 *
 * This file exists ONLY in the public demo copy of the work test. The real instance in the
 * master-mega-badass-site repo has no toggle: there, paste blocking is decided once by
 * `INTEGRITY.blockPaste` in wt-questions.mjs, because a control a candidate can flip is not a
 * control at all. Here the point is the opposite, letting the team feel both settings quickly.
 *
 * State lives in localStorage under one key, so flipping it on the results board also applies to
 * the test in another tab, and it survives moving between questions. app.js reads that key at the
 * moment of each paste, so a change takes effect immediately with nothing typed so far lost.
 *
 * Be clear about what switching it on buys, because it is easy to over-read:
 *
 *   - It refuses paste and drag-drop into answer fields. The `paste` event covers Ctrl/Cmd+V,
 *     the right-click menu and middle-click, so all the ordinary routes are closed.
 *   - It cannot tell an external source from the candidate's own work. Someone pasting figures
 *     back from the spreadsheet Part 1 tells them to build is stopped just the same.
 *   - It is defeated by devtools, by disabling JavaScript, or by retyping off a second screen.
 *
 * So it is friction that changes behaviour at the margin, not evidence about who wrote what.
 * Every paste attempt is still counted and stored either way, which is the more honest signal.
 */

(function testingToggle() {
  const KEY = 'work-test-block-paste';
  const mount = document.querySelector('[data-testing-toggle]');
  if (!mount) return;

  const read = () => {
    try {
      return localStorage.getItem(KEY) === 'on';
    } catch {
      return false;
    }
  };

  const label = document.createElement('label');
  label.className = 'testing-toggle';

  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = read();

  const text = document.createElement('span');

  const paint = () => {
    text.textContent = box.checked
      ? 'Paste blocked: answers must be typed'
      : 'Paste allowed';
    label.classList.toggle('on', box.checked);
  };

  box.addEventListener('change', () => {
    try {
      if (box.checked) localStorage.setItem(KEY, 'on');
      else localStorage.removeItem(KEY);
    } catch {
      // Storage unavailable, so the setting cannot persist. Say so rather than pretending.
      text.textContent = 'Cannot save this setting in this browser';
      return;
    }
    paint();
  });

  // Another tab changed it. Keep the two views honest about a single shared setting.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    box.checked = read();
    paint();
  });

  const tag = document.createElement('strong');
  tag.className = 'testing-tag';
  tag.textContent = 'Internal testing';

  label.append(box, text);
  mount.append(tag, label);
  paint();
})();
