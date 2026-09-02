/**
 * Upload validation, and the contract a file store has to meet.
 *
 * Everything here is pure, so the rules that decide whether a candidate's file is accepted can
 * be tested without a network, and so the same checks run whatever the file eventually lands in.
 *
 * WHERE FILES GO. The store exposes an optional `putFile`, the same way it already exposes an
 * optional `listByPrefix`. Airtable implements it today; the whole reason it is a capability on
 * the store rather than code inline in the engine is that Airtable's direct upload caps at 5 MB,
 * and the day that becomes a problem the fix should be one new implementation of `putFile`
 * against R2, not a rewrite of how answers are recorded.
 *
 *   putFile(key, { filename, contentType, base64 }) -> { attachmentId, recordId, url }
 *
 * WHAT WE CAN AND CANNOT PROVE ABOUT A FILE. This distinction is deliberate and should survive
 * anyone editing this file:
 *
 *   - A PDF is provable. It begins with the five bytes `%PDF-`, and nothing else does by
 *     accident.
 *   - A DOCX is NOT provable here. It is a ZIP archive, so all the magic bytes establish is
 *     "this is a zip". Proving it is a well-formed Word document means reading
 *     `[Content_Types].xml` out of the archive, which is more work than belongs in a request
 *     handler on a candidate's clock. So a .docx is accepted on three weaker signals together:
 *     a zip header, a .docx extension, and a matching content type.
 *
 * That is worth being plain about rather than describing this as "file type validation" and
 * letting a reader assume more. It stops the ordinary mistakes: a candidate attaching the wrong
 * thing, or a 40 MB scan. It is not a defence against someone who means harm.
 *
 * AND THE RISK THAT REMAINS. A hostile PDF is a risk to whoever opens it, and nothing in this
 * file changes that. The admin page downloads rather than previews, and says so, but the residual
 * risk is a matter of how reviewers open files, not something this code can remove.
 */

/**
 * Airtable's direct-bytes upload accepts up to 5 MB. This sits under it so that a file which
 * passed our check cannot then be refused by Airtable, which would fail in front of a candidate
 * with the clock running, after they had already waited for the upload.
 */
export const MAX_UPLOAD_BYTES = 4_500_000;

/** Ten megabytes of base64 is about 7.5 MB of file, so this only ever catches nonsense. */
const MAX_BASE64_CHARS = 10_000_000;

export const ACCEPTED = {
  pdf: {
    ext: '.pdf',
    label: 'PDF',
    mimes: ['application/pdf'],
    magic: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
    proof: 'strong',
  },
  docx: {
    ext: '.docx',
    label: 'Word document',
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    magic: [0x50, 0x4b, 0x03, 0x04], // PK\x03\x04, i.e. any zip
    proof: 'weak',
  },
};

/** The `accept` attribute for a file input. A convenience for the candidate, never a control. */
export const acceptAttribute = (allow) => allow
  .filter((k) => ACCEPTED[k])
  .flatMap((k) => [ACCEPTED[k].ext, ...ACCEPTED[k].mimes])
  .join(',');

export const describeAllowed = (allow) => {
  const names = allow.filter((k) => ACCEPTED[k]).map((k) => ACCEPTED[k].label);
  if (names.length <= 1) return names[0] || 'no file types';
  return `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
};

/**
 * Strips a filename back to something safe to hand to a store and to show a reviewer.
 *
 * Directory separators go because a filename is not a path; control characters go because they
 * can hide what a file is actually called when it is rendered in a list. The extension is kept
 * deliberately: it is one of the three signals a .docx is accepted on.
 */
export function sanitizeFilename(name) {
  const raw = String(name == null ? '' : name)
    .replace(/[\\/]/g, '_')
    // Control characters only: they can hide what a file is really called when it is
    // rendered in a list. Ordinary spaces and punctuation are left alone.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (!raw) return 'upload';
  if (raw.length <= 120) return raw;
  // Trim the middle rather than the end, so the extension survives.
  const dot = raw.lastIndexOf('.');
  const ext = dot > 0 ? raw.slice(dot) : '';
  return `${raw.slice(0, 120 - ext.length)}${ext}`;
}

/** Exact byte length of the data a base64 string encodes, without decoding all of it. */
export function base64Bytes(b64) {
  const s = String(b64 || '').replace(/\s/g, '');
  if (!s) return 0;
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
}

/** Decodes just the first few bytes, which is all the signature check needs. */
function leadingBytes(b64, count = 8) {
  const chunk = String(b64 || '').replace(/\s/g, '').slice(0, Math.ceil((count * 4) / 3) + 4);
  try {
    const bin = atob(chunk);
    const out = new Uint8Array(Math.min(count, bin.length));
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null; // not valid base64
  }
}

const startsWith = (bytes, magic) => !!bytes && magic.every((b, i) => bytes[i] === b);

/**
 * Decides whether one uploaded file is acceptable. Returns { ok, kind, filename, size } or
 * { ok: false, error, detail }, where `detail` is written to be read by a candidate mid-test:
 * it says what to do, not what went wrong internally.
 */
export function checkUpload({ filename, contentType, base64, allow = ['pdf', 'docx'] }) {
  const kinds = allow.filter((k) => ACCEPTED[k]);
  if (!kinds.length) return { ok: false, error: 'no_types', detail: 'This question does not accept files.' };

  const raw = String(base64 || '').replace(/\s/g, '');
  if (!raw) return { ok: false, error: 'empty', detail: 'That file appeared to be empty. Choose it again.' };
  if (raw.length > MAX_BASE64_CHARS) {
    return { ok: false, error: 'too_large', detail: 'That file is far too large. The limit is 4.5 MB.' };
  }

  const size = base64Bytes(raw);
  if (size === 0) return { ok: false, error: 'empty', detail: 'That file appeared to be empty. Choose it again.' };
  if (size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      error: 'too_large',
      detail: `That file is ${(size / 1_000_000).toFixed(1)} MB. The limit is 4.5 MB, so please save a smaller version and try again.`,
    };
  }

  const clean = sanitizeFilename(filename);
  const lower = clean.toLowerCase();
  const bytes = leadingBytes(raw);
  if (!bytes) return { ok: false, error: 'unreadable', detail: 'That file could not be read. Choose it again.' };

  const wanted = describeAllowed(kinds);
  for (const kind of kinds) {
    const spec = ACCEPTED[kind];
    if (!lower.endsWith(spec.ext)) continue;
    if (!startsWith(bytes, spec.magic)) {
      // The name says one thing and the contents say another. Usually a renamed file rather
      // than anything sinister, and the fix is the same either way.
      return {
        ok: false,
        error: 'contents_mismatch',
        detail: `That file is named ${spec.ext} but its contents are not a ${spec.label}. Re-save it as a ${spec.label} rather than renaming it.`,
      };
    }
    // For docx the content type is the third of three weak signals, so a missing one is
    // tolerated (some browsers send nothing) but a contradictory one is not.
    if (contentType && spec.mimes.length && !spec.mimes.includes(String(contentType).split(';')[0].trim())
      && spec.proof === 'weak' && contentType !== 'application/octet-stream') {
      return {
        ok: false,
        error: 'contents_mismatch',
        detail: `That does not look like a ${spec.label}. Re-save it and try again.`,
      };
    }
    return { ok: true, kind, filename: clean, size, contentType: spec.mimes[0] };
  }

  return { ok: false, error: 'wrong_type', detail: `Please upload a ${wanted}.` };
}
