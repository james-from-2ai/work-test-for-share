/**
 * The formatted-answer format, and its validator.
 *
 * Candidates write in a small rich text editor, so their answers can carry headings, sections,
 * bold, italic, underline, and lists. What travels over the wire and lands in KV is NOT HTML.
 * It is this deliberately tiny shape:
 *
 *   [ { type: 'h2' | 'h3' | 'p' | 'bullet' | 'number',
 *       runs: [ { t: 'some text', b?: 1, i?: 1, u?: 1 } ] }, ... ]
 *
 * Why not just store HTML. Answers are rendered back on /work-test/admin.html, a page that
 * holds every candidate's submission and carries the admin key in its DOM. Storing candidate
 * HTML would mean the safety of that page rests on a sanitizer being airtight against a
 * hand-rolled POST. With this shape there is no markup anywhere in the pipeline: the admin page
 * builds elements and sets textContent, so a candidate cannot express a tag, an attribute, or a
 * URL, let alone a script. The risk is removed by construction rather than filtered.
 *
 * The client's serializer is free to be messy about what the browser's editing commands produce,
 * because everything is normalized here before it is trusted, and again on the way in.
 */

/** The only block types that exist. Anything else becomes a plain paragraph. */
export const BLOCK_TYPES = ['h2', 'h3', 'p', 'bullet', 'number'];

/**
 * A hostile client could post a hundred thousand blocks, and an honest one could paste a very
 * large document. Both are capped rather than rejected, so nobody loses an answer to an error.
 */
export const MAX_BLOCKS = 400;
const MAX_RUNS_PER_BLOCK = 200;

/**
 * Runs are the expensive part of the stored JSON: each one costs about 20 characters of
 * structure to carry a little text. A client that alternated formatting every character could
 * turn a 4,000 character answer into 80,000 characters of JSON, which matters because the
 * Airtable store keeps this in a long text field with a hard size limit. Adjacent runs sharing
 * the same marks are merged, and past this budget the rest of an answer keeps its text but loses
 * its formatting rather than the answer failing to save.
 */
const MAX_RUNS_TOTAL = 1200;

/** Merges neighbouring runs that carry identical marks, which is most of them in practice. */
function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    const last = out[out.length - 1];
    if (last && !!last.b === !!r.b && !!last.i === !!r.i && !!last.u === !!r.u) last.t += r.t;
    else out.push(r);
  }
  return out;
}

const isObj = (v) => v !== null && typeof v === 'object';

/**
 * Normalizes untrusted input into the shape above and clamps its total text to `maxChars`.
 * Returns { blocks, chars, truncated }. Never throws: bad input degrades to fewer blocks.
 */
export function sanitizeRich(value, maxChars = 4000) {
  const out = [];
  let chars = 0;
  let spent = 0; // runs used so far, against MAX_RUNS_TOTAL
  let truncated = false;

  // A plain string is accepted as a single paragraph. That keeps a question switching from
  // 'long' to 'rich' from silently discarding answers, and means a caller that is not our editor
  // still gets its text stored rather than treated as blank.
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() ? [{ type: 'p', runs: [{ t: value }] }] : []);
  for (const raw of list) {
    if (out.length >= MAX_BLOCKS) { truncated = true; break; }
    if (!isObj(raw)) continue;

    const type = BLOCK_TYPES.includes(raw.type) ? raw.type : 'p';
    const runs = [];
    const rawRuns = Array.isArray(raw.runs) ? raw.runs.slice(0, MAX_RUNS_PER_BLOCK) : [];

    for (const r of rawRuns) {
      if (!isObj(r)) continue;
      // Normalize line endings so a stray \r never reaches the renderer or the CSV.
      let t = String(r.t == null ? '' : r.t).replace(/\r\n?/g, '\n');
      if (!t) continue;

      if (chars + t.length > maxChars) {
        t = t.slice(0, Math.max(0, maxChars - chars));
        truncated = true;
      }
      if (!t) break;

      const run = { t };
      // Only these three flags exist, and only ever as 1. No colors, sizes, fonts, or links:
      // a work test answer does not need them and each one is another thing to validate.
      if (r.b) run.b = 1;
      if (r.i) run.i = 1;
      if (r.u) run.u = 1;
      runs.push(run);
      chars += t.length;
      if (chars >= maxChars) { truncated = true; break; }
    }

    let merged = mergeRuns(runs);
    // Past the run budget, keep every character but drop the formatting on what remains.
    if (spent + merged.length > MAX_RUNS_TOTAL) {
      const text = merged.map((r) => r.t).join('');
      merged = text ? [{ t: text }] : [];
      truncated = true;
    }
    spent += merged.length;

    // Keep an empty block only if it is a spacer between content, never as leading padding.
    if (merged.length || out.length) out.push({ type, runs: merged });
    if (chars >= maxChars) { truncated = true; break; }
  }

  // Drop trailing empties so a candidate pressing Enter a few times does not store blank blocks.
  while (out.length && !out[out.length - 1].runs.length) out.pop();

  return { blocks: out, chars, truncated };
}

/** True when there is no non-whitespace text anywhere in the value. */
export function richIsEmpty(value) {
  if (typeof value === 'string') return value.trim() === '';
  if (!Array.isArray(value)) return true;
  return !value.some((b) => isObj(b) && Array.isArray(b.runs)
    && b.runs.some((r) => isObj(r) && String(r.t || '').trim() !== ''));
}

/**
 * Flattens to plain text for the CSV and for word counts. Headings keep a `##` marker so the
 * structure a candidate chose is still visible in a spreadsheet cell, and list items keep their
 * bullet, but no bold or underline markers: they would be noise in Excel.
 */
export function richToText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  const lines = [];
  let n = 0;
  for (const b of value) {
    if (!isObj(b)) continue;
    const text = (Array.isArray(b.runs) ? b.runs : [])
      .map((r) => (isObj(r) ? String(r.t || '') : '')).join('');
    if (b.type === 'number') n += 1; else n = 0;
    if (b.type === 'h2') lines.push(`## ${text}`);
    else if (b.type === 'h3') lines.push(`### ${text}`);
    else if (b.type === 'bullet') lines.push(`- ${text}`);
    else if (b.type === 'number') lines.push(`${n}. ${text}`);
    else lines.push(text);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Word count over the flattened text, used in the CSV and the admin summary. */
export function richWordCount(value) {
  const t = richToText(value).trim();
  return t ? t.split(/\s+/).length : 0;
}
