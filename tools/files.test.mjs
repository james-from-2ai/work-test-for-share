/**
 * Tests for file uploads: what is accepted, what is refused, and what reaches a reviewer.
 *
 * The interesting cases here are the refusals. A candidate attaching the wrong thing is the
 * common failure and the messages have to be actionable, but the case worth a test is the
 * renamed file: something called .pdf whose contents are not a PDF must not get through on its
 * name alone, because the name is the one thing a candidate fully controls.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkUpload, sanitizeFilename, base64Bytes, MAX_UPLOAD_BYTES, describeAllowed, acceptAttribute,
} from '../functions/_lib/wt-files.mjs';
import { handle, createCandidates, listCandidates, toCsv, config, readiness } from '../functions/_lib/wt-engine.mjs';

const b64 = (s) => Buffer.from(s, 'binary').toString('base64');
const PDF = b64('%PDF-1.7\nfake but correctly signed');
const DOCX = b64('PK\x03\x04fake but correctly signed zip');
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/* ------------------------------------------------------------ filenames ------------ */

test('a filename cannot smuggle a path', () => {
  // The properties that matter, rather than one exact string: nothing that reads as a directory
  // separator survives, and nothing comes back leading with a dot, which is both how a traversal
  // starts and how a file hides itself on a unix box.
  for (const nasty of ['../../etc/passwd.pdf', 'C:\\Users\\me\\report.pdf', '/absolute/path.pdf', '.hidden.pdf']) {
    const out = sanitizeFilename(nasty);
    assert.equal(/[\\/]/.test(out), false, `separator survived in ${out}`);
    assert.equal(out.startsWith('.'), false, `leading dot survived in ${out}`);
    assert.equal(out.length > 0, true);
  }
  assert.equal(sanitizeFilename('C:\\Users\\me\\report.pdf'), 'C:_Users_me_report.pdf');
});

test('control characters are stripped but ordinary punctuation survives', () => {
  assert.equal(sanitizeFilename('my report (v2) - final.pdf'), 'my report (v2) - final.pdf');
  assert.equal(sanitizeFilename('quiet\u0000bell\u0007.pdf'), 'quietbell.pdf');
});

test('a very long filename is trimmed but keeps its extension', () => {
  const out = sanitizeFilename(`${'a'.repeat(400)}.docx`);
  assert.equal(out.length, 120);
  assert.equal(out.endsWith('.docx'), true);
});

test('an empty or dot-only filename still produces something usable', () => {
  assert.equal(sanitizeFilename(''), 'upload');
  assert.equal(sanitizeFilename('...'), 'upload');
  assert.equal(sanitizeFilename(null), 'upload');
});

test('base64Bytes matches the real decoded length', () => {
  for (const s of ['a', 'ab', 'abc', 'abcd', 'hello world', '%PDF-1.7']) {
    assert.equal(base64Bytes(Buffer.from(s).toString('base64')), Buffer.byteLength(s), s);
  }
  assert.equal(base64Bytes(''), 0);
});

/* ------------------------------------------------------------- accepting ----------- */

test('a real PDF is accepted', () => {
  const res = checkUpload({ filename: 'analysis.pdf', contentType: 'application/pdf', base64: PDF });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'pdf');
  assert.equal(res.filename, 'analysis.pdf');
});

test('a real docx is accepted', () => {
  const res = checkUpload({ filename: 'memo.docx', contentType: DOCX_TYPE, base64: DOCX });
  assert.equal(res.ok, true);
  assert.equal(res.kind, 'docx');
});

test('a docx from a browser that sent no content type is still accepted', () => {
  // Some browsers send an empty type for unusual extensions. Refusing on that alone would lock
  // a candidate out over their choice of browser.
  const res = checkUpload({ filename: 'memo.docx', contentType: '', base64: DOCX });
  assert.equal(res.ok, true);
});

/* -------------------------------------------------------------- refusing ----------- */

test('a file renamed to .pdf is refused on its contents, not its name', () => {
  const res = checkUpload({ filename: 'sneaky.pdf', contentType: 'application/pdf', base64: b64('MZ\x90\x00 this is an executable') });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'contents_mismatch');
  assert.match(res.detail, /not a PDF/);
});

test('a type that was never allowed is refused', () => {
  const res = checkUpload({ filename: 'sheet.xlsx', contentType: 'application/vnd.ms-excel', base64: DOCX });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'wrong_type');
  assert.match(res.detail, /PDF or Word document/);
});

test('a question can narrow what it takes, and the message says so', () => {
  const res = checkUpload({ filename: 'memo.docx', contentType: DOCX_TYPE, base64: DOCX, allow: ['pdf'] });
  assert.equal(res.ok, false);
  assert.equal(res.detail, 'Please upload a PDF.');
});

test('an oversized file is refused before it is ever sent on', () => {
  // One byte over, expressed as base64 of the right length rather than by building the bytes.
  const chars = Math.ceil(((MAX_UPLOAD_BYTES + 1000) * 4) / 3);
  const res = checkUpload({ filename: 'huge.pdf', contentType: 'application/pdf', base64: 'A'.repeat(chars) });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'too_large');
  assert.match(res.detail, /4\.5 MB/);
});

test('an empty file is refused', () => {
  assert.equal(checkUpload({ filename: 'x.pdf', base64: '' }).error, 'empty');
});

test('the accept attribute and the wording both cover every allowed kind', () => {
  assert.equal(describeAllowed(['pdf', 'docx']), 'PDF or Word document');
  assert.equal(describeAllowed(['pdf']), 'PDF');
  const attr = acceptAttribute(['pdf', 'docx']);
  assert.equal(attr.includes('.pdf'), true);
  assert.equal(attr.includes('.docx'), true);
});

/* ------------------------------------------------------- through the engine -------- */

const UPLOAD_SPEC = [
  {
    id: 'submit_model', section: 'part1', type: 'upload',
    prompt: 'Upload your working, as a PDF.', accept: ['pdf'], next: 'notes',
  },
  { id: 'notes', section: 'part1', type: 'short', required: false, prompt: 'Anything else?', next: null },
];

function storeWithFiles() {
  const db = new Map();
  const puts = [];
  return {
    puts,
    async get(k) { return db.has(k) ? JSON.parse(db.get(k)) : null; },
    async put(k, v) { db.set(k, JSON.stringify(v)); },
    async delete(k) { db.delete(k); },
    async putFile(key, file) {
      puts.push({ key, ...file });
      return { attachmentId: `att${puts.length}`, recordId: 'rec1', url: null, filename: file.filename };
    },
  };
}

const PARTS = [{ id: 'part1', label: 'Part 1', summary: 'Only part', recommendedMin: 30 }];
const CFG = config({ questions: UPLOAD_SPEC, sections: PARTS, durationSec: 30 * 60 });
const T0 = 1_800_000_000_000;

async function ready(store) {
  const [c] = await createCandidates(store, [{ name: 'Uploader', email: 'u@example.com' }]);
  await handle(store, { action: 'start', token: c.token }, T0, CFG);
  return c.token;
}

test('the question tells the client exactly what it will take', async () => {
  const store = storeWithFiles();
  const token = await ready(store);
  const res = await handle(store, { action: 'state', token }, T0, CFG);
  assert.equal(res.question.type, 'upload');
  assert.deepEqual(res.question.accept, ['pdf']);
  assert.equal(res.question.maxBytes, MAX_UPLOAD_BYTES);
  assert.match(res.question.acceptText, /PDF/);
});

test('a file is stored the moment it is uploaded, before any answer is submitted', async () => {
  const store = storeWithFiles();
  const token = await ready(store);
  const res = await handle(store, {
    action: 'upload', token, questionId: 'submit_model',
    filename: 'workings.pdf', contentType: 'application/pdf', data: PDF,
  }, T0 + 1000, CFG);

  assert.equal(res.ok, true);
  assert.equal(res.uploaded.filename, 'workings.pdf');
  assert.equal(store.puts.length, 1);
  // The question id is prefixed on, because every file for a session lands in one Airtable cell
  // and the name is all a reviewer has to tell them apart.
  assert.equal(store.puts[0].filename, 'submit_model--workings.pdf');
  // Still on the same question: uploading is not answering.
  assert.equal(res.answered, 0);
  assert.equal(res.question.id, 'submit_model');
});

test('a refused file is not stored and says what to do', async () => {
  const store = storeWithFiles();
  const token = await ready(store);
  const res = await handle(store, {
    action: 'upload', token, questionId: 'submit_model',
    filename: 'notes.docx', contentType: DOCX_TYPE, data: DOCX,
  }, T0 + 1000, CFG);
  assert.equal(res.ok, false);
  assert.equal(store.puts.length, 0);
  assert.match(res.detail, /Please upload a PDF/);
});

test('a required upload question cannot be answered without a file', async () => {
  const store = storeWithFiles();
  const token = await ready(store);
  const res = await handle(store, {
    action: 'answer', token, index: 0, questionId: 'submit_model', value: 'My model',
  }, T0 + 1000, CFG);
  assert.equal(res.rejected, 'no_file');
  assert.equal(res.answered, 0);
});

test('the answer is the name the candidate gave the file, and the file rides along', async () => {
  const store = storeWithFiles();
  const token = await ready(store);
  await handle(store, {
    action: 'upload', token, questionId: 'submit_model',
    filename: 'workings.pdf', contentType: 'application/pdf', data: PDF,
  }, T0 + 1000, CFG);
  const res = await handle(store, {
    action: 'answer', token, index: 0, questionId: 'submit_model', value: 'Portfolio model, final',
  }, T0 + 2000, CFG);

  assert.equal(res.question.id, 'notes');
  const rows = await listCandidates(store, T0 + 3000, CFG);
  const answer = rows[0].answers[0];
  assert.equal(answer.value, 'Portfolio model, final');
  assert.equal(answer.upload.filename, 'workings.pdf');
  assert.equal(answer.upload.kind, 'pdf');
});

test('an uploaded file survives a refresh, so nobody attaches it twice', async () => {
  const store = storeWithFiles();
  const token = await ready(store);
  await handle(store, {
    action: 'upload', token, questionId: 'submit_model',
    filename: 'workings.pdf', contentType: 'application/pdf', data: PDF,
  }, T0 + 1000, CFG);
  const res = await handle(store, { action: 'state', token }, T0 + 2000, CFG);
  assert.equal(res.upload.filename, 'workings.pdf');
});

test('reading back an answer shows the file, not "left blank"', async () => {
  const store = storeWithFiles();
  const token = await ready(store);
  await handle(store, {
    action: 'upload', token, questionId: 'submit_model',
    filename: 'workings.pdf', contentType: 'application/pdf', data: PDF,
  }, T0 + 1000, CFG);
  // Deliberately no written answer: the file IS the answer here.
  await handle(store, {
    action: 'answer', token, index: 0, questionId: 'submit_model', value: 'Model',
  }, T0 + 2000, CFG);

  const res = await handle(store, { action: 'review', token }, T0 + 3000, CFG);
  const first = res.review[0];
  // Without this the review dialog told a candidate who had submitted a PDF that their answer
  // was blank, which is alarming in exactly the situation where being alarmed is most costly.
  assert.equal(first.upload.filename, 'workings.pdf');
  assert.equal(first.upload.size > 0, true);
  assert.equal(first.skipped, false);
});

test('the CSV carries the file name and size', async () => {
  const store = storeWithFiles();
  const token = await ready(store);
  await handle(store, {
    action: 'upload', token, questionId: 'submit_model',
    filename: 'workings.pdf', contentType: 'application/pdf', data: PDF,
  }, T0 + 1000, CFG);
  await handle(store, {
    action: 'answer', token, index: 0, questionId: 'submit_model', value: 'Portfolio model',
  }, T0 + 2000, CFG);

  const csv = toCsv(await listCandidates(store, T0 + 3000, CFG));
  const [head, ...rows] = csv.split('\r\n');
  assert.equal(head.includes('"file_name"'), true);
  assert.equal(rows[0].includes('"workings.pdf"'), true);
  const columns = (line) => line.split('","').length;
  for (const row of rows) assert.equal(columns(row), columns(head));
});

/* ------------------------------------------------------------- readiness ----------- */

test('a test with uploads refuses to run on a store that cannot hold files', () => {
  const kvOnly = { async get() { return null; }, async put() {}, async delete() {} };
  const res = readiness(kvOnly, CFG);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'uploads_unconfigured');
  assert.match(res.detail, /Attachment column/);
});

test('a test with no uploads runs on any store', () => {
  const kvOnly = { async get() { return null; }, async put() {}, async delete() {} };
  const textOnly = config({
    questions: [{ id: 'only', section: 'part1', type: 'short', prompt: 'Words?', next: null }],
    sections: PARTS,
  });
  assert.equal(readiness(kvOnly, textOnly).ok, true);
});

test('a store that can hold files is ready', () => {
  assert.equal(readiness(storeWithFiles(), CFG).ok, true);
});
