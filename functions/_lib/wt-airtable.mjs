/**
 * Airtable as the work test's store, exposing the same get / put / delete interface the engine
 * expects, so nothing in wt-engine.mjs knows or cares which backing store is in use.
 *
 * Chosen over Cloudflare KV because submissions land somewhere the team already reads and can
 * filter, rather than behind a CSV download. The cost of that is honest and worth stating:
 *
 *   - **It is slower.** Every action is one or two HTTPS round trips to Airtable, so submitting
 *     an answer takes a noticeable fraction of a second rather than being instant.
 *   - **There is no compare-and-set.** KV writes are single operations; here a read and a write
 *     are separate requests. Two truly simultaneous `start` calls could both see an unstarted
 *     session and both write a start time, and the later write wins. The exposure is the few
 *     hundred milliseconds between the two requests, so the worst case is a candidate gaining
 *     that much time by double clicking. Everything else that matters (forward-only answers,
 *     one session per email) is protected by the index check in the engine, which cannot be
 *     satisfied twice with the same value.
 *   - **It is rate limited** to a few requests per second per base, shared with anything else
 *     using this base. Requests that hit the limit are retried with a short backoff.
 *
 * Every row keeps the authoritative JSON in `Data`. The other fields are a readable mirror,
 * rewritten on each save purely so a human opening the base can see what happened. Nothing ever
 * reads them back, so someone editing a mirror field by hand changes nothing but their own view.
 */

const API = 'https://api.airtable.com/v0';

/**
 * Uploading bytes goes to a different host from the rest of the API, and caps at 5 MB per file.
 * wt-files.mjs refuses anything over 4.5 MB so a file we accepted can never then be rejected
 * here, which would fail in front of a candidate who had already waited for the upload.
 */
const CONTENT = 'https://content.airtable.com/v0';

/** Airtable formula strings are single quoted, so a quote in a value has to be escaped. */
const quote = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

/**
 * Escapes the characters Airtable's rich text reads as formatting, so a candidate who typed
 * `#`, `*` or `- ` sees exactly that rather than a heading, italics or a bullet they did not ask
 * for. Only the markers are escaped, and only where they mean something: a hyphen mid-sentence is
 * left alone, so the escaping is invisible even with rich text switched off.
 */
const mdEscape = (s) => String(s == null ? '' : s)
  .replace(/([\\`*_~\[\]])/g, '\\$1')
  .replace(/^([#>])/, '\\$1')
  .replace(/^([-+])(\s)/, '\\$1$2')
  .replace(/^(\d+)\.(\s)/, '$1\\.$2');

/**
 * Long text tops out at 100,000 characters. If a session's JSON ever approached that, the write
 * would fail and the candidate would see a broken page mid-test, so we refuse earlier and loudly.
 * wt-rich.mjs caps answers well below this; this is the backstop, not the mechanism.
 */
const MAX_DATA = 90_000;

export function airtableStore({ token, baseId, tableId, fileField = 'Files', fetchImpl = fetch }) {
  // Maps a key to the Airtable record id, so a get followed by a put costs one request, not two.
  // Scoped to this store instance, which lives for one request, so it cannot go stale.
  const ids = new Map();

  async function call(path, init = {}, attempt = 0) {
    const res = await fetchImpl(`${API}/${baseId}/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    });

    // 429 is the documented rate limit and Airtable asks for a 30 second pause; that is far too
    // long to hold a candidate's request open, so back off briefly and give up after two tries.
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      return call(path, init, attempt + 1);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`airtable ${init.method || 'GET'} ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res.json();
  }

  /**
   * Human-readable mirror of a candidate session. Never read back, only written.
   *
   * Written as Markdown, because the `Answers` column is a rich text field: Airtable parses
   * headings, bold and lists out of Markdown and renders them, so a reviewer sees the candidate's
   * own structure rather than a wall of one-line-per-paragraph text. Nothing here depends on that
   * setting being on. With rich text off the same string is still readable, it just shows its
   * markers.
   */
  function mirror(key, value) {
    if (!key.startsWith('c:') || !value || typeof value !== 'object') return {};
    const answers = Array.isArray(value.answers) ? value.answers : [];
    const readable = answers.map((a) => {
      const text = richMarkdown(a.value);
      // A decision question records which option was picked as well as the write-up.
      const picked = a.choice ? `**Recommended:** ${mdEscape(a.choice)}` : '';
      // A file-only answer is not blank: say which attachments in the Files column it is, so a
      // reviewer scanning this column knows to open the files rather than assume nothing came in.
      const files = Array.isArray(a.uploads) ? a.uploads : a.upload ? [a.upload] : [];
      const fileLines = files.filter((f) => f && f.filename).map((f) =>
        `**File submitted:** ${mdEscape(f.filename)}${f.size ? ` (${Math.max(1, Math.round(f.size / 1024))} KB)` : ''}, in the Files column as ${mdEscape(`${a.id}--${f.filename}`)}`);
      // Bare URLs, on their own lines: Airtable turns them into links, and a candidate's share
      // link is the one thing in this column a reviewer is going to click.
      const links = (Array.isArray(a.links) ? a.links : []).filter(Boolean);
      const linkLines = links.length ? [`**Links shared:**`, ...links.map((l) => `- ${l}`)] : [];
      const body = [picked, text, ...linkLines, ...fileLines].filter(Boolean).join('\n\n');
      return `# Q${(a.index ?? 0) + 1}. ${mdEscape(a.prompt || '')}\n\n${body || (a.skipped ? '_(not reached)_' : '_(blank)_')}`;
    }).join('\n\n');

    return {
      Candidate: value.name || '',
      Email: value.email || '',
      Answered: answers.length,
      Started: iso(value.startedAt),
      Finished: iso(value.finishedAt),
      'Ran out of time': !!value.ranOut,
      Answers: readable.slice(0, MAX_DATA),
      Updated: new Date().toISOString(),
    };
  }

  /**
   * Flattens a stored answer into Markdown for the mirror. Deliberately a local copy of the small
   * part of wt-rich.mjs that is needed, so the store has no reason to import question logic.
   *
   * Block types map onto the Markdown that Airtable's rich text understands. Runs carry bold,
   * italic and underline; Airtable rich text has no underline, so an underlined run keeps its text
   * and loses only the underline rather than being dressed up as something it is not.
   */
  function richMarkdown(value) {
    if (typeof value === 'string') return mdEscape(value);
    if (!Array.isArray(value)) return '';
    let n = 0;
    const lines = [];
    for (const b of value) {
      if (!b || typeof b !== 'object') continue;
      const t = (Array.isArray(b.runs) ? b.runs : []).map(runMarkdown).join('');
      if (b.type === 'number') n += 1; else n = 0;
      const list = b.type === 'bullet' || b.type === 'number';
      lines.push({
        list,
        text: b.type === 'h2' ? `## ${t}`
          : b.type === 'h3' ? `### ${t}`
          : b.type === 'bullet' ? `- ${t}`
          : b.type === 'number' ? `${n}. ${t}`
          : t,
      });
    }
    // A blank line separates blocks, which is what makes Airtable treat them as separate
    // paragraphs, except between consecutive list items: those have to stay adjacent to read as
    // one list rather than a run of one-item lists.
    return lines.map((l, i) => (i === 0 ? '' : l.list && lines[i - 1].list ? '\n' : '\n\n') + l.text).join('');
  }

  /** One run of text with its marks, as Markdown. */
  function runMarkdown(r) {
    if (!r || typeof r !== 'object') return '';
    const raw = mdEscape(r.t || '');
    // Emphasis markers have to sit against the text: `** bold **` is not bold in any parser, so
    // whitespace at either end is kept outside the marks.
    const [, lead, core, tail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
    if (!core) return raw;
    let out = core;
    if (r.b) out = `**${out}**`;
    if (r.i) out = `_${out}_`;
    return `${lead}${out}${tail}`;
  }

  async function findRecord(key) {
    const params = new URLSearchParams({
      filterByFormula: `{Key}=${quote(key)}`,
      maxRecords: '1',
      // Only the fields we actually read. The mirror columns are write-only.
      'fields[]': 'Data',
    });
    const data = await call(`${tableId}?${params}`);
    const rec = data.records && data.records[0];
    if (rec) ids.set(key, rec.id);
    return rec || null;
  }

  return {
    async get(key) {
      const rec = await findRecord(key);
      if (!rec) return null;
      const raw = rec.fields && rec.fields.Data;
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch {
        // A hand-edited Data cell. Treating it as missing would silently start the candidate
        // over with a fresh clock, so fail loudly instead.
        throw new Error(`airtable: Data for ${key} is not valid JSON. It has probably been edited by hand.`);
      }
    },

    async put(key, value) {
      const json = JSON.stringify(value);
      if (json.length > MAX_DATA) {
        throw new Error(`airtable: session ${key} is ${json.length} characters, over the ${MAX_DATA} limit`);
      }
      const fields = { Key: key, Data: json, ...mirror(key, value) };

      let id = ids.get(key);
      if (!id) {
        const rec = await findRecord(key);
        id = rec && rec.id;
      }

      // The mirror columns are a convenience; `Key` and `Data` are the test. If someone renames or
      // deletes a mirror column in the base, Airtable rejects the whole write for an unknown field
      // name, which would show a candidate a broken page mid-answer. So a rejection on that
      // specific ground is retried with the two fields that matter, and the mirror is what is lost.
      const write = async (body) => {
        try {
          return await call(tableId, body(fields));
        } catch (err) {
          if (!/UNKNOWN_FIELD_NAME/.test(String(err && err.message))) throw err;
          return call(tableId, body({ Key: key, Data: json }));
        }
      };

      if (id) {
        await write((f) => ({ method: 'PATCH', body: JSON.stringify({ records: [{ id, fields: f }] }) }));
      } else {
        const created = await write((f) => ({
          method: 'POST',
          body: JSON.stringify({ records: [{ fields: f }], typecast: true }),
        }));
        const made = created.records && created.records[0];
        if (made) ids.set(key, made.id);
      }
    },

    async delete(key) {
      let id = ids.get(key);
      if (!id) {
        const rec = await findRecord(key);
        id = rec && rec.id;
      }
      if (!id) return;
      await call(`${tableId}/${id}`, { method: 'DELETE' });
      ids.delete(key);
    },

    /**
     * Attaches one file to the session's row, in the attachment column named by `fileField`.
     *
     * Every file a candidate uploads lands in that one cell, which is why the caller prefixes
     * the question id onto the filename: in a cell holding three attachments, the name is the
     * only thing saying which question each one answers.
     *
     * The record has to exist already, and it does: it is written at registration, long before
     * anyone can reach a question. Throwing rather than creating one keeps this from quietly
     * inventing a session that the rest of the engine knows nothing about.
     */
    async putFile(key, { filename, contentType, base64 }) {
      let id = ids.get(key);
      if (!id) {
        const rec = await findRecord(key);
        id = rec && rec.id;
      }
      if (!id) throw new Error(`airtable: no record for ${key}, so there is nothing to attach a file to`);

      const res = await fetchImpl(`${CONTENT}/${baseId}/${id}/${encodeURIComponent(fileField)}/uploadAttachment`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ contentType, file: base64, filename }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`airtable upload ${res.status}: ${detail.slice(0, 300)}`);
      }
      const data = await res.json().catch(() => ({}));
      const list = (data.fields && data.fields[fileField]) || [];
      const made = list[list.length - 1] || {};
      // The url is recorded but never relied on: Airtable's attachment urls expire, so the admin
      // page links to the row instead and treats this as a convenience only.
      return { attachmentId: made.id || null, recordId: id, url: made.url || null, filename };
    },

    /**
     * Every session in one paged request. Without this the admin page would read the roster and
     * then fetch each candidate individually, which is a request per candidate and would trip
     * the rate limit on a normal sized shortlist.
     */
    async listByPrefix(prefix) {
      const out = [];
      let offset;
      do {
        const params = new URLSearchParams({
          filterByFormula: `LEFT({Key},${prefix.length})=${quote(prefix)}`,
          pageSize: '100',
          'fields[]': 'Data',
        });
        if (offset) params.set('offset', offset);
        const page = await call(`${tableId}?${params}`);
        for (const rec of page.records || []) {
          const raw = rec.fields && rec.fields.Data;
          if (!raw) continue;
          try {
            out.push(JSON.parse(raw));
          } catch {
            // One unreadable row must not hide every other submission from the reviewer.
          }
        }
        offset = page.offset;
      } while (offset);
      return out;
    },
  };
}
