/**
 * Tests for the scripts that move a test between the builder and the repository.
 *
 * These exist because of a bug that everything else missed: spec-apply.mjs builds the questions
 * file out of a template literal, a stray backtick in one of its comments ended the string early,
 * and the whole script stopped parsing. Nothing caught it, because no test imported spec-apply
 * and the tests that did run were about the engine. A generator whose output is source code needs
 * its output compiled, or the first sign of trouble is a deploy that will not build.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;
const tmp = mkdtempSync(join(tmpdir(), 'wt-tooling-'));

const run = (args) => execFileSync(node, args, { cwd: ROOT, encoding: 'utf8' });

/** Generates the questions file from a spec, without writing over the real one. */
function generate(spec) {
  const specPath = join(tmp, `spec-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(specPath, JSON.stringify(spec, null, 2));
  return run(['tools/spec-apply.mjs', specPath, '--dry']);
}

/** Compiles a generated file, which is the only way to know the generator produced valid code. */
function checkParses(source, label) {
  const out = join(tmp, `gen-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(out, source);
  try {
    run(['--check', out]);
  } catch (err) {
    assert.fail(`${label} did not parse:\n${err.stderr || err.message}`);
  }
  return out;
}

const MINIMAL = {
  durationSec: 1800,
  sections: [{ id: 'p1', label: 'Part 1', summary: 'Only part', recommendedMin: 30 }],
  briefs: {},
  questions: [{ id: 'only', section: 'p1', type: 'rich', prompt: 'Say something', next: null }],
};

/* ------------------------------------------------------------- generation --------- */

test('the generated questions file is valid JavaScript', () => {
  checkParses(generate(MINIMAL), 'a minimal spec');
});

test('notes full of awkward characters cannot break the generated file', () => {
  // Every one of these has ended a string or a comment in some generator at some point.
  const spec = {
    ...MINIMAL,
    notes: 'Backticks `like this`, a ${dollar brace}, a comment ender */, a backslash \\ and '
      + 'a quote " and an apostrophe \'. None of it should escape the header comment.',
  };
  const source = generate(spec);
  checkParses(source, 'a spec with awkward notes');
  assert.equal(source.includes('comment ender * /'), true, 'the comment ender was not defused');
});

test('question text full of awkward characters survives too', () => {
  const spec = {
    ...MINIMAL,
    questions: [{
      id: 'only', section: 'p1', type: 'rich', next: null,
      prompt: 'What about `backticks`, ${braces}, "quotes" and a backslash \\ ?',
      context: 'Also */ and </script> for good measure.',
    }],
  };
  checkParses(generate(spec), 'a spec with awkward question text');
});

test('the generated file actually exports what the engine imports', async () => {
  const file = checkParses(generate({
    ...MINIMAL,
    timing: { mode: 'section' },
    navigation: { back: true, edit: false },
    integrity: { blockPaste: true },
  }), 'a spec with every setting');

  const mod = await import(`file://${file.replace(/\\/g, '/')}`);
  for (const name of ['DURATION_SEC', 'GRACE_SEC', 'INTEGRITY', 'TIMING', 'NAVIGATION', 'SECTIONS', 'BRIEFS', 'QUESTIONS']) {
    assert.ok(name in mod, `the generated file is missing ${name}`);
  }
  // The settings an author chose have to survive the trip, or applying a spec silently reverts
  // their decisions while the test still appears to work.
  assert.deepEqual(mod.TIMING, { mode: 'section' });
  assert.deepEqual(mod.NAVIGATION, { back: true, edit: false });
  assert.equal(mod.INTEGRITY.blockPaste, true);
  assert.equal(mod.DURATION_SEC, 1800);
});

/* --------------------------------------------------------------- refusals --------- */

/**
 * Runs spec-apply on a spec that should be refused, and hands back everything it printed.
 *
 * Both streams matter and they carry different halves: the reason for each problem goes to
 * stdout, and the "nothing written" summary to stderr. Asserting against only the thrown error's
 * message would check the summary and miss whether the reason was any use to the reader.
 */
function expectRefusal(spec, name) {
  const specPath = join(tmp, name);
  writeFileSync(specPath, JSON.stringify(spec));
  try {
    run(['tools/spec-apply.mjs', specPath, '--dry']);
  } catch (err) {
    return `${err.stdout || ''}${err.stderr || ''}`;
  }
  return assert.fail(`${name} was accepted when it should have been refused`);
}

test('a spec with a dangling branch is refused rather than written', () => {
  const out = expectRefusal({
    ...MINIMAL,
    questions: [{ id: 'only', section: 'p1', type: 'rich', prompt: 'Go', next: 'nowhere' }],
  }, 'broken.json');
  assert.match(out, /nowhere/, 'the message did not name the missing destination');
  assert.match(out, /Nothing written/i);
});

test('a spec with a link that is not a link is refused', () => {
  const out = expectRefusal({
    ...MINIMAL,
    briefs: { b: { heading: 'x', blocks: [{ type: 'link', label: 'Data', url: 'javascript:alert(1)' }] } },
  }, 'badlink.json');
  assert.match(out, /http/i, 'the message did not say what a link has to be');
  assert.match(out, /Nothing written/i);
});

/* ------------------------------------------------------------- round trip --------- */

test('exporting the live test produces a spec that applies back cleanly', () => {
  const exported = run(['tools/spec-export.mjs']);
  const spec = JSON.parse(exported);
  assert.ok(Array.isArray(spec.questions) && spec.questions.length, 'nothing exported');
  assert.ok(spec.timing && spec.navigation, 'the settings were not exported');
  checkParses(generate(spec), 'the round-tripped live test');
});

test('the shipped example specs are all valid', () => {
  for (const name of ['example-branching-spec.json', 'evp-demo-spec.json']) {
    const spec = JSON.parse(readFileSync(join(ROOT, 'tools', name), 'utf8'));
    checkParses(generate(spec), name);
  }
});
