/**
 * Tests for the Airtable store, against a fake Airtable rather than the real API.
 *
 * These matter because the real thing cannot be exercised from here without a token, and a store
 * bug does not look like a bug: it looks like a candidate's timer resetting or their answers
 * vanishing. So the fake checks the parts that are easy to get wrong and impossible to notice by
 * eye: that a read filters on the right field, that a second write updates instead of inserting a
 * duplicate, that the round trip preserves the record the engine handed over, and that a rate
 * limit is retried rather than surfaced to someone mid-test.
 *
 * Run with: node --test work-test/tools/airtable.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { airtableStore } from '../functions/_lib/wt-airtable.mjs';
import { handle, createCandidates, listCandidates } from '../functions/_lib/wt-engine.mjs';
import { QUESTIONS } from '../functions/_lib/wt-questions.mjs';

const BASE = 'appFAKE0000000000';
const TABLE = 'tblFAKE0000000000';

/** A minimal stand-in for Airtable: one table, records with fields, filterByFormula on Key. */
function fakeAirtable({ failFirst = 0, failStatus = 429 } = {}) {
  const records = new Map(); // id -> fields
  let seq = 0;
  const calls = [];
  let failures = failFirst;

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, url: u.pathname + '?' + u.searchParams.toString() });

    if (failures > 0) {
      failures -= 1;
      return { ok: false, status: failStatus, text: async () => `simulated ${failStatus}` };
    }
    assert.equal(init.headers.authorization, 'Bearer tok', 'the token was not sent');

    const ok = (body) => ({ ok: true, status: 200, json: async () => body });

    if (method === 'GET') {
      const formula = u.searchParams.get('filterByFormula') || '';
      let matched = [...records.entries()];

      const exact = formula.match(/^\{Key\}='(.*)'$/);
      const prefix = formula.match(/^LEFT\(\{Key\},(\d+)\)='(.*)'$/);
      if (exact) {
        const want = exact[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\');
        matched = matched.filter(([, f]) => f.Key === want);
      } else if (prefix) {
        matched = matched.filter(([, f]) => String(f.Key).startsWith(prefix[2]));
      }
      const max = Number(u.searchParams.get('maxRecords') || 0);
      if (max) matched = matched.slice(0, max);
      return ok({ records: matched.map(([id, f]) => ({ id, fields: { Data: f.Data } })) });
    }

    if (method === 'POST') {
      const body = JSON.parse(init.body);
      const made = body.records.map((r) => {
        const id = `rec${++seq}`;
        records.set(id, { ...r.fields });
        return { id, fields: r.fields };
      });
      return ok({ records: made });
    }

    if (method === 'PATCH') {
      const body = JSON.parse(init.body);
      for (const r of body.records) {
        assert.ok(records.has(r.id), 'patched a record that does not exist');
        records.set(r.id, { ...records.get(r.id), ...r.fields });
      }
      return ok({ records: body.records });
    }

    if (method === 'DELETE') {
      const id = u.pathname.split('/').pop();
      records.delete(id);
      return ok({ deleted: true, id });
    }

    throw new Error(`unexpected ${method}`);
  };

  const store = airtableStore({ token: 'tok', baseId: BASE, tableId: TABLE, fetchImpl });
  return { store, records, calls, fetchImpl };
}

const T0 = 1_800_000_000_000;
const answerFor = (i) => (QUESTIONS[i].type === 'rich'
  ? [{ type: 'p', runs: [{ t: `answer ${i + 1}` }] }]
  : QUESTIONS[i].type === 'choice' ? 0 : `answer ${i + 1}`);

test('a value survives the round trip unchanged', async () => {
  const { store } = fakeAirtable();
  const value = { token: 'abc', name: 'Amina', answers: [], nested: { deep: [1, 2, null] } };
  await store.put('c:abc', value);
  assert.deepEqual(await store.get('c:abc'), value);
});

test('a missing key reads as null, not an error', async () => {
  const { store } = fakeAirtable();
  assert.equal(await store.get('c:nope'), null);
});

test('writing twice updates one record instead of inserting a duplicate', async () => {
  const { store, records } = fakeAirtable();
  await store.put('c:abc', { token: 'abc', name: 'First', answers: [] });
  await store.put('c:abc', { token: 'abc', name: 'Second', answers: [] });
  assert.equal(records.size, 1, 'a duplicate row was created');
  assert.equal((await store.get('c:abc')).name, 'Second');
});

test('a read then write costs one lookup, not two', async () => {
  const { store, calls } = fakeAirtable();
  await store.put('c:abc', { token: 'abc', answers: [] });
  calls.length = 0;
  await store.get('c:abc');
  await store.put('c:abc', { token: 'abc', answers: [], again: true });
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1, 'the record id was not reused');
});

test('the lookup filters on Key, so it cannot match the wrong row', async () => {
  const { store, calls } = fakeAirtable();
  await store.put('c:aaa', { token: 'aaa', answers: [] });
  await store.put('c:bbb', { token: 'bbb', answers: [] });
  assert.equal((await store.get('c:aaa')).token, 'aaa');
  assert.equal((await store.get('c:bbb')).token, 'bbb');
  assert.ok(calls.some((c) => c.url.includes('filterByFormula')), 'no filter was sent');
});

test('an email containing a quote does not break the formula', async () => {
  const { store } = fakeAirtable();
  const key = "e:o'brien@example.com";
  await store.put(key, 'tok123');
  assert.equal(await store.get(key), 'tok123');
});

test('a rate limited request is retried rather than failing the candidate', async () => {
  const { store, calls } = fakeAirtable({ failFirst: 1 });
  await store.put('c:abc', { token: 'abc', answers: [] });
  assert.ok(calls.length >= 2, 'the request was not retried');
  assert.equal((await store.get('c:abc')).token, 'abc');
});

test('a persistent failure throws, so the endpoint can report it', async () => {
  const { store } = fakeAirtable({ failFirst: 99 });
  await assert.rejects(() => store.get('c:abc'), /airtable GET 429/);
});

test('a permission failure carries its status code into the message', async () => {
  // work-test-admin.js turns a 401/403 into "the token needs data.records:read", which is the
  // most likely setup mistake because the token that writes tech requests never needed to read.
  // That hint keys off the status code appearing in the message, so pin it here.
  const { store } = fakeAirtable({ failFirst: 99, failStatus: 403 });
  await assert.rejects(() => store.get('c:abc'), (err) => {
    assert.match(err.message, /\b403\b/, 'the status code is missing, so the admin hint will not fire');
    return true;
  });
});

test('a 403 is not retried, since permission will not change in 400ms', async () => {
  const { store, calls } = fakeAirtable({ failFirst: 99, failStatus: 403 });
  await store.get('c:abc').catch(() => {});
  assert.equal(calls.length, 1, 'a permission error was retried');
});

test('hand-edited JSON throws instead of silently restarting the candidate', async () => {
  const { store, records } = fakeAirtable();
  await store.put('c:abc', { token: 'abc', answers: [] });
  const id = [...records.keys()][0];
  records.set(id, { ...records.get(id), Data: '{ not json' });
  await assert.rejects(() => store.get('c:abc'), /edited by hand/);
});

test('a session too large to store is refused loudly', async () => {
  const { store } = fakeAirtable();
  const huge = { token: 'abc', answers: [{ value: 'x'.repeat(120_000) }] };
  await assert.rejects(() => store.put('c:abc', huge), /over the 90000 limit/);
});

test('the readable mirror is written alongside the JSON', async () => {
  const { store, records } = fakeAirtable();
  await store.put('c:abc', {
    token: 'abc',
    name: 'Amina Yusuf',
    email: 'amina@example.com',
    startedAt: T0,
    finishedAt: null,
    ranOut: false,
    answers: [{
      index: 0,
      prompt: 'Which states?',
      value: [{ type: 'h2', runs: [{ t: 'Recommendation' }] }, { type: 'bullet', runs: [{ t: 'Kwara' }] }],
    }],
  });
  const fields = [...records.values()][0];
  assert.equal(fields.Candidate, 'Amina Yusuf');
  assert.equal(fields.Email, 'amina@example.com');
  assert.equal(fields.Answered, 1);
  assert.equal(fields.Started, new Date(T0).toISOString());
  assert.equal(fields['Ran out of time'], false);
  assert.ok(fields.Answers.includes('## Recommendation'), 'headings are not readable in the mirror');
  assert.ok(fields.Answers.includes('- Kwara'), 'list items are not readable in the mirror');
});

test('bookkeeping rows get no candidate mirror fields', async () => {
  const { store, records } = fakeAirtable();
  await store.put('roster', { tokens: ['abc'] });
  const fields = [...records.values()][0];
  assert.equal(fields.Candidate, undefined);
  assert.equal(fields.Answered, undefined);
  assert.equal(JSON.parse(fields.Data).tokens[0], 'abc');
});

test('deleting a key removes the row', async () => {
  const { store, records } = fakeAirtable();
  await store.put('c:abc', { token: 'abc', answers: [] });
  await store.delete('c:abc');
  assert.equal(records.size, 0);
  assert.equal(await store.get('c:abc'), null);
});

test('the whole engine runs on this store, end to end', async () => {
  const { store } = fakeAirtable();
  const reg = await handle(store, { action: 'register', name: 'Amina Yusuf', email: 'amina@example.com' }, T0);
  assert.equal(reg.phase, 'ready');

  await handle(store, { action: 'start', token: reg.token }, T0);
  // The guarantee that matters most, exercised against Airtable rather than a Map.
  const again = await handle(store, { action: 'start', token: reg.token }, T0 + 60_000);
  assert.equal(again.deadline, reg.deadline || again.deadline);
  assert.equal(again.question.index, 0);

  let res;
  for (let i = 0; i < QUESTIONS.length; i++) {
    res = await handle(store, { action: 'answer', token: reg.token, index: i, value: answerFor(i) }, T0 + (i + 1) * 1_000);
  }
  assert.equal(res.phase, 'done');
  assert.equal(res.answered, QUESTIONS.length);

  const back = await handle(store, { action: 'register', name: 'Amina Yusuf', email: 'AMINA@example.com' }, T0 + 9_000_000);
  assert.equal(back.token, reg.token, 'a second attempt got a fresh session');
  assert.equal(back.answered, QUESTIONS.length);
});

test('listing every candidate is one paged read, not one read each', async () => {
  const { store, calls } = fakeAirtable();
  await createCandidates(store, [
    { name: 'A One', email: 'a@example.com' },
    { name: 'B Two', email: 'b@example.com' },
    { name: 'C Three', email: 'c@example.com' },
  ]);
  calls.length = 0;
  const rows = await listCandidates(store, T0);
  assert.equal(rows.length, 3);
  assert.equal(calls.filter((c) => c.method === 'GET').length, 1, 'the listing read one row at a time');
  assert.deepEqual(rows.map((r) => r.name).sort(), ['A One', 'B Two', 'C Three']);
});
