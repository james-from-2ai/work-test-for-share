/**
 * A shared-password gate and a deployment banner, both off unless their variable is set.
 *
 * This exists so the same branch can serve two things: the real test, on the hostname
 * candidates use, with neither variable set and therefore not a line of this running; and an
 * internal copy for the team to walk end to end, gated by one password everybody knows and
 * labelled so nobody mistakes it for the live assessment.
 *
 * PREVIEW_PASSWORD  A shared secret, type Secret. When set, every request needs it once and
 *                   then carries a cookie. This is a shared password, not identity: it keeps
 *                   the internal copy off the open internet, and it does not tell you who
 *                   walked it. For per-person sign-in, put Cloudflare Access in front instead.
 * DEPLOYMENT_BANNER Text. When set, it is shown at the top of every page in this deployment.
 *
 * The cookie carries an HMAC of a fixed string keyed by the password, so the password itself
 * never sits in a cookie, and changing the password logs everybody out.
 */

const COOKIE = 'wt_gate';
const CLAIM = 'unlocked/v1';

const enc = new TextEncoder();

/** Hex HMAC-SHA256 of the claim, keyed by the password. */
export async function tokenFor(password) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(String(password)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(CLAIM));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** One cookie out of a Cookie header, without a regex over attacker-controlled input. */
export function cookieValue(header, name = COOKIE) {
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return '';
}

/** Length-independent compare, so a wrong value cannot be narrowed by timing. */
export function sameSecret(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i += 1) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** True when this request already carries a good cookie for this password. */
export async function isUnlocked(cookieHeader, password) {
  if (!password) return true;
  const got = cookieValue(cookieHeader);
  if (!got) return false;
  return sameSecret(got, await tokenFor(password));
}

/** The Set-Cookie for a successful unlock. Session cookie: closing the browser ends it. */
export function setCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * The unlock page. Deliberately plain and says nothing about what is behind it: someone who
 * finds the hostname should not learn whose assessment this is before they are through.
 */
export function loginPage({ next = '/', error = '', label = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Sign in</title>
<style>
  :root { color-scheme: light; --ink:#20253a; --muted:#5d6577; --bg:#f8f8fa; --surface:#fff;
          --border:#c6ced6; --accent:#05545a; --red:#b42318; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg);
         color:var(--ink); font:15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  form { width:min(24rem, calc(100vw - 2rem)); background:var(--surface); padding:1.6rem;
         border:1px solid var(--border); border-radius:10px;
         box-shadow:0 1px 2px rgba(16,24,40,.05), 0 4px 12px rgba(16,24,40,.06); }
  h1 { margin:0 0 0.3rem; font-size:1.15rem; }
  p { margin:0 0 1.1rem; color:var(--muted); font-size:0.9rem; }
  label { display:block; font-weight:600; font-size:0.85rem; margin-bottom:0.35rem; }
  input { width:100%; padding:0.6rem 0.7rem; font:inherit; border:1px solid var(--border);
          border-radius:6px; background:var(--surface); color:inherit; }
  input:focus { outline:2px solid #d5f4f7; border-color:var(--accent); }
  button { margin-top:1rem; width:100%; padding:0.62rem; font:inherit; font-weight:600;
           color:#fff; background:var(--accent); border:0; border-radius:6px; cursor:pointer; }
  button:hover { background:#033f44; }
  .err { margin:0 0 0.9rem; padding:0.55rem 0.7rem; border-radius:6px; font-size:0.87rem;
         color:var(--red); background:#fef3f2; border:1px solid #fecdca; }
  .label { margin:1rem 0 0; font-size:0.78rem; color:var(--muted); text-align:center; }
</style>
</head>
<body>
<form method="post" action="/__unlock?next=${encodeURIComponent(next)}">
  <h1>Sign in</h1>
  <p>This page needs the shared password.</p>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Sign in</button>
  ${label ? `<p class="label">${esc(label)}</p>` : ''}
</form>
</body>
</html>`;
}

/**
 * The banner markup, injected at the top of the body of every HTML page. Fixed and full width,
 * with a spacer pushing the page down, so it stays visible while scrolling: the entire point is
 * that somebody who walks in halfway through cannot mistake this for the real assessment.
 */
export function bannerHtml(text) {
  return `<div class="wt-deployment-banner" role="note">${esc(text)}</div>
<style>
/* The bar's height and the spacer under it are the same declared value, so no combination of
   font metrics can leave the bar sitting over the first line of the page. */
.wt-deployment-banner {
  position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
  box-sizing: border-box; height: 2rem;
  display: flex; align-items: center; justify-content: center;
  padding: 0 1rem;
  background: #b42318; color: #fff;
  font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  letter-spacing: 0.06em; text-transform: uppercase; text-align: center;
  box-shadow: 0 1px 3px rgba(0,0,0,.25);
}
body { padding-top: 2rem !important; }
/* The page's own fixed furniture does not move with the body's padding, so push the one control
   that lives in the top right clear of the bar rather than letting the bar sit over it. */
.theme-toggle { top: 2.6rem !important; }
@media print { .wt-deployment-banner { position: static; height: auto; } body { padding-top: 0 !important; } }
</style>`;
}
