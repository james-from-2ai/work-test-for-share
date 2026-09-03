/**
 * Dumps the test that is currently compiled into wt-questions.mjs as a builder spec.
 *
 * This is the "open the live test in the builder" direction. Without it the builder could only
 * ever start from blank or from the example, so the first thing anyone wanted to do, tweak the
 * real test, would mean retyping it and hoping the transcription was faithful.
 *
 *   node tools/spec-export.mjs > current-test.json
 *   node tools/spec-export.mjs --out=current-test.json
 *
 * Then load that file into builder.html with Import JSON. tools/spec-apply.mjs goes the other
 * way, and the two round-trip: exporting, importing and applying should produce no diff.
 */

import { writeFileSync } from 'node:fs';
import {
  QUESTIONS, SECTIONS, BRIEFS, DURATION_SEC, GRACE_SEC, INTEGRITY, TIMING, NAVIGATION, INTRO, OUTRO,
} from '../functions/_lib/wt-questions.mjs';

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
};

const json = JSON.stringify({
  durationSec: DURATION_SEC,
  graceSec: GRACE_SEC,
  timing: TIMING,
  navigation: NAVIGATION,
  integrity: { blockPaste: INTEGRITY.blockPaste },
  intro: INTRO,
  outro: OUTRO,
  // Not recoverable from the module, since a comment is not a value. Whoever exports an existing
  // file should paste the provenance from its header in here before applying it back, or the
  // regeneration will drop it.
  notes: '',
  sections: SECTIONS,
  briefs: BRIEFS,
  questions: QUESTIONS,
}, null, 2);

const out = arg('out');
if (out) {
  writeFileSync(out, `${json}\n`);
  console.log(`Wrote ${out} (${QUESTIONS.length} questions, ${SECTIONS.length} parts).`);
} else {
  process.stdout.write(`${json}\n`);
}
