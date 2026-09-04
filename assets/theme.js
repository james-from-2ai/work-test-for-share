/**
 * Light or dark, chosen by the person reading, remembered in this browser.
 *
 * Without a choice the page follows the device setting, as it always has. A click on the toggle
 * sets data-theme on <html>, which the stylesheet treats as final in both directions. The choice is
 * applied here, synchronously, before the body paints, so a candidate who chose dark does not get a
 * white flash on every screen change or reload. Nothing about the choice reaches the server.
 */
(function theme() {
  const KEY = 'work-test-theme';
  const root = document.documentElement;

  const stored = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  if (stored === 'dark' || stored === 'light') root.setAttribute('data-theme', stored);

  const effective = () => root.getAttribute('data-theme')
    || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  function mount() {
    if (document.querySelector('.theme-toggle')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    const ico = document.createElement('span');
    ico.className = 'ico';
    ico.setAttribute('aria-hidden', 'true');
    const lbl = document.createElement('span');
    lbl.className = 'lbl-text';
    btn.append(ico, lbl);

    const paint = () => {
      const dark = effective() === 'dark';
      ico.textContent = dark ? '☀' : '☾';
      lbl.textContent = dark ? 'Light mode' : 'Dark mode';
      btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      btn.setAttribute('aria-pressed', String(dark));
    };
    btn.addEventListener('click', () => {
      const next = effective() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch { /* private mode: the choice lasts this page */ }
      paint();
    });
    // If nothing was chosen, keep following the device when it changes.
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (!root.getAttribute('data-theme')) paint();
      });
    }
    paint();
    document.body.append(btn);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
