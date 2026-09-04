/**
 * Flow resolution: which question a candidate is on, given what they have already answered.
 *
 * Until branching existed this was one expression, `QUESTIONS[answers.length]`, and the
 * forward-only guarantee fell out of it for free. Branching means every candidate walks their own
 * route, so "the next question" has to be derived rather than indexed. The guarantee is kept the
 * same way it always was: the server computes the single question the candidate is on, and
 * `answer` accepts nothing else. Going back is still an operation that does not exist.
 *
 * The route is derived from the recorded answers rather than stored on the session, so the spec
 * in wt-questions.mjs stays the single source of truth and a session can never disagree with it.
 * The cost, stated plainly: editing the flow while somebody is mid-test can move where their next
 * answer lands. Publishing is a deploy, so that is a deliberate act, but do not do it during a
 * sitting.
 *
 * Two properties worth knowing before reading further:
 *
 *   - A question with no `next` falls through to the following one in the array. So a spec with
 *     no branching at all behaves exactly as the flat list did, which is what makes this safe to
 *     introduce under an existing test.
 *   - Nothing here ever returns a question that has already been answered. A flow that loops back
 *     ends the test instead, because re-serving a question whose answer is final and already
 *     recorded is the one thing the design refuses.
 */

/* ------------------------------------------------------------------ lookups --------- */

export const questionById = (id, questions) =>
  (id == null ? null : questions.find((q) => q.id === id) || null);

export const firstQuestionId = (questions) => (questions.length ? questions[0].id : null);

/**
 * Option labels, and ONLY the labels.
 *
 * This is the function that keeps branching from leaking the shape of the test. An option knows
 * where it leads; the candidate must not, or picking an answer would double as a preview of what
 * each choice costs them. Everything the client receives about options comes through here.
 */
export function optionLabels(q) {
  if (!q || !Array.isArray(q.options)) return null;
  return q.options.map((o) => (o && typeof o === 'object' ? String(o.label ?? '') : String(o)));
}

/** Where a question goes when nothing more specific applies: its own `next`, else the one after. */
function fallthroughId(q, questions) {
  if (q.next !== undefined) return q.next; // an explicit `null` means "this is the end"
  const at = questions.findIndex((x) => x.id === q.id);
  const following = at >= 0 ? questions[at + 1] : null;
  return following ? following.id : null;
}

/** Which option a recorded answer picked. The stored index wins; the label is the fallback. */
function pickedIndex(q, answer) {
  if (!answer) return -1;
  if (Number.isInteger(answer.choiceIndex)) return answer.choiceIndex;
  const labels = optionLabels(q) || [];
  return labels.indexOf(String(answer.value == null ? '' : answer.value));
}

/** The id that follows `q` once it has been answered this particular way. */
/** Which question types carry options that decide the route. */
export const branches = (q) => !!q && (q.type === 'choice' || q.type === 'decision');

export function nextIdAfter(q, answer, questions) {
  if (!q) return null;
  if (branches(q) && Array.isArray(q.options)) {
    const opt = q.options[pickedIndex(q, answer)];
    if (opt && typeof opt === 'object' && opt.next !== undefined) return opt.next;
  }
  return fallthroughId(q, questions);
}

/** Every id a question could lead to, across all of its options. Used to look ahead. */
export function outgoingIds(q, questions) {
  if (branches(q) && Array.isArray(q.options) && q.options.length) {
    const out = [];
    let anyFallsThrough = false;
    for (const o of q.options) {
      if (o && typeof o === 'object' && o.next !== undefined) out.push(o.next);
      else anyFallsThrough = true;
    }
    if (anyFallsThrough) out.push(fallthroughId(q, questions));
    return [...new Set(out)];
  }
  return [fallthroughId(q, questions)];
}

/* -------------------------------------------------------------- where they are ------ */

/**
 * The one question the candidate may answer next, or null when the test is over.
 *
 * Derived from the last answer rather than by replaying from the start, which matters when the
 * spec has been edited: what they actually answered is recorded on the answer itself, so the
 * answered prefix is never re-interpreted, only the step forward from it.
 */
export function currentQuestionId(answers, questions) {
  if (!answers || !answers.length) return firstQuestionId(questions);

  const last = answers[answers.length - 1];
  const q = questionById(last.id, questions);
  if (!q) return null; // the question they last answered has been deleted from the spec

  const next = nextIdAfter(q, last, questions);
  if (next == null) return null;
  if (answers.some((a) => a.id === next)) return null; // a loop; end rather than re-serve
  return questionById(next, questions) ? next : null;
}

/* ---------------------------------------------------------------- looking ahead ----- */

/**
 * Every route the candidate could still take from `startId`, as arrays of question ids.
 *
 * Specs are small, so enumerating is simpler and more obviously correct than trying to compute
 * lengths analytically. `maxRoutes` is a backstop against a spec with enough consecutive branches
 * to blow up combinatorially: past it we stop and say so, and every caller treats a truncated
 * answer as "unknown" rather than quietly reporting whatever it managed to count.
 */
export function routesFrom(startId, questions, answeredIds = [], maxRoutes = 200) {
  const answered = new Set(answeredIds);
  const routes = [];
  let truncated = false;

  const walk = (id, path, onPath) => {
    if (routes.length >= maxRoutes) { truncated = true; return; }
    if (id == null || answered.has(id) || onPath.has(id)) { routes.push(path); return; }
    const q = questionById(id, questions);
    if (!q) { routes.push(path); return; }

    const here = path.concat(id);
    onPath.add(id);
    for (const n of outgoingIds(q, questions)) walk(n, here, onPath);
    onPath.delete(id);
  };

  walk(startId, [], new Set());
  return { routes, truncated };
}

/**
 * How many questions are left, counting the one they are on.
 *
 * `certain` is the interesting field. When the routes ahead differ in length there is no honest
 * total to show a candidate, and a guessed one would move under them as they answer, which is
 * exactly the thing a progress indicator exists to avoid.
 */
export function remainingRange(startId, questions, answeredIds = []) {
  const { routes, truncated } = routesFrom(startId, questions, answeredIds);
  if (!routes.length) return { min: 0, max: 0, certain: true };
  const lengths = routes.map((r) => r.length);
  const min = Math.min(...lengths);
  const max = Math.max(...lengths);
  return { min, max, certain: !truncated && min === max };
}

/**
 * Per section, how many questions are still ahead. Same min/max/certain shape as above, because
 * a branch can skip a whole part of the test and the progress bar has to be able to say so.
 */
export function sectionOutlook(startId, questions, answeredIds, sectionIdOf, sectionIds) {
  const { routes, truncated } = routesFrom(startId, questions, answeredIds);
  const out = new Map();

  for (const id of sectionIds) {
    const counts = routes.map((route) => route.reduce(
      (n, qid) => n + (sectionIdOf(questionById(qid, questions)) === id ? 1 : 0),
      0,
    ));
    const min = counts.length ? Math.min(...counts) : 0;
    const max = counts.length ? Math.max(...counts) : 0;
    out.set(id, { min, max, certain: !truncated && min === max });
  }
  return out;
}

/* ------------------------------------------------------------------ validation ------ */

/**
 * Structural problems in a spec, worst first. Used by the tests, and it is what the builder UI
 * will show an author: every one of these is a mistake that is invisible until a candidate walks
 * into it, which is the worst time to find out.
 */
export function validateFlow(questions) {
  const problems = [];
  const say = (level, message) => problems.push({ level, message });

  if (!Array.isArray(questions) || !questions.length) {
    say('error', 'The test has no questions.');
    return problems;
  }

  const ids = new Set();
  for (const q of questions) {
    if (!q || !q.id) { say('error', 'Every question needs an id.'); continue; }
    if (ids.has(q.id)) say('error', `Two questions share the id "${q.id}".`);
    ids.add(q.id);
  }

  const exists = (id) => id == null || ids.has(id);
  for (const q of questions) {
    if (!q || !q.id) continue;
    if (!exists(q.next)) say('error', `"${q.id}" points at "${q.next}", which does not exist.`);

    if (branches(q)) {
      if (!Array.isArray(q.options) || !q.options.length) {
        say('error', `"${q.id}" is a ${q.type} question with no options.`);
      } else {
        q.options.forEach((o, i) => {
          if (o && typeof o === 'object' && !exists(o.next)) {
            say('error', `Option ${i + 1} of "${q.id}" points at "${o.next}", which does not exist.`);
          }
        });
      }
    } else if (Array.isArray(q.options) && q.options.some((o) => o && typeof o === 'object' && o.next !== undefined)) {
      // Branching on anything but a choice cannot work: there is no option to branch on.
      say('error', `"${q.id}" has options with destinations but is type "${q.type}", not "choice" or "decision".`);
    }
  }

  // Reachability. An unreachable question is not a candidate-facing bug, but it is almost always
  // an author who rewired a branch and forgot something, so it is worth surfacing.
  const reachable = new Set();
  const visit = (id) => {
    if (id == null || reachable.has(id) || !ids.has(id)) return;
    reachable.add(id);
    for (const n of outgoingIds(questionById(id, questions), questions)) visit(n);
  };
  visit(firstQuestionId(questions));
  for (const q of questions) {
    if (q && q.id && !reachable.has(q.id)) say('warning', `"${q.id}" cannot be reached from the start.`);
  }

  // Loops. Forward-only means a route back is always a mistake, and currentQuestionId would end
  // the test there rather than re-serve the question, so an author would see a test that just
  // stops early with no explanation.
  const onPath = new Set();
  const cleared = new Set();
  const findCycle = (id) => {
    if (id == null || !ids.has(id)) return;
    if (onPath.has(id)) { say('error', `The flow loops back to "${id}". Routes must only go forward.`); return; }
    if (cleared.has(id)) return;
    onPath.add(id);
    for (const n of outgoingIds(questionById(id, questions), questions)) findCycle(n);
    onPath.delete(id);
    cleared.add(id);
  };
  findCycle(firstQuestionId(questions));

  return problems;
}
