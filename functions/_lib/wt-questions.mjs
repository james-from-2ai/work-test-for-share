/**
 * The test itself. This is the ONLY file you edit to change the assessment.
 *
 * Content is adapted from "2AI Work Task | PM / Performance Task 2026"
 * (Drive: 00_Operations / 02 People and Culture / 01 Hiring / 02 Program Manager / 01 Work
 * Test / Performance Task_vEXTERNAL). The wording of the scenario, the manager's Slack, and
 * the manager's reply email is kept close to the original on purpose, including its
 * deliberate messiness. Two things were dropped because they do not apply to a timed page:
 * the email-a-PDF submission instructions, and the 5-business-day deadline.
 *
 * These questions live server-side on purpose. The candidate's browser is only ever sent the
 * question it is currently on, plus the brief for the part it belongs to, so nobody can read
 * Part 2's email before submitting Part 1.
 */

/** Total time for the WHOLE test, in seconds. The source task recommends 90 minutes. */
export const DURATION_SEC = 90 * 60;

/**
 * Seconds of slack allowed after the deadline before an answer is refused. Covers network
 * latency so an answer sent a moment before the buzzer is not lost. Keep small.
 */
export const GRACE_SEC = 5;

/**
 * Candidates are told they may use AI and a calculator, so paste counts are not evidence of
 * anything and are not presented as such. Time per question is still recorded because it is
 * genuinely informative about prioritization. blockPaste stays false: it would break the
 * "you may use AI" promise.
 */
export const INTEGRITY = { blockPaste: false };

/**
 * The parts of the task, in order, with how long each is expected to take.
 *
 * `recommendedMin` is not decoration. It drives the weighting of the progress bar, so a
 * candidate can see that Part 1 is two thirds of the work rather than counting questions and
 * assuming the halfway question is the halfway point. The numbers come from the source task,
 * which recommends about 60 minutes for Part 1 and about 30 for Part 2, and they should keep
 * summing to DURATION_SEC so the bar and the clock tell the same story.
 */
export const SECTIONS = [
  { id: 'part1', label: 'Part 1', summary: 'Analyse the data and write up', recommendedMin: 60 },
  { id: 'part2', label: 'Part 2', summary: 'Reply to your manager', recommendedMin: 30 },
];

/**
 * Reference material that stays on screen for every question in a part. Block types the
 * client knows how to render: 'p' (paragraph), 'quote' (a Slack or email, with a label),
 * 'list' (numbered points inside a quote), 'link' (a button out to the data).
 */
export const BRIEFS = {
  part1: {
    section: 'Part 1 of 2',
    heading: 'The situation',
    blocks: [
      { type: 'p', text: 'As you may know, we are thinking about launching a program in agriculture, specifically focused on weather. Below is a scenario we could imagine you facing in your day-to-day work with the Program Lead (your boss).' },
      { type: 'p', text: 'We have just secured a fixed budget of $190,000 to conduct a pilot of a technical weather intervention, using the government registry to deliver agronomy advice to impoverished farmers’ phones in a specific country in Africa. The local Ministry has provided us with their most recent farmer engagement data and our Operations team has provided a separate dataset on logistics and costs. The next step is getting back to the government with a list of states we are interested in entering into so that we can request formal approval.' },
      {
        type: 'quote',
        label: 'Slack from your manager, 9:05am',
        text: 'Hey! Can you spend an hour with this data we got from govt and ops and see what you can do. I want to get the ministry a list of states in 2-3 days ideally; can you take a look and come up with a portfolio of counties to prioritize? (heads up their files might be a bit messy) Just a) remember we need to keep it under $205k (w/ $15k saved for a baseline), b) FYI on the call with the donor, their terms specifically asked us to keep the weighted average poverty rate of the pilot above 70%, c) the ops team is v nervous about doing anywhere they flagged as a red zone.',
      },
      { type: 'link', label: 'Open the data from government and ops', url: 'https://docs.google.com/spreadsheets/d/1kmqSBXvvBXPU2G2a9JId2zhj1kF80LZzrgCXE8DFOe8/edit?usp=sharing' },
      { type: 'p', text: 'Treat cost-effectiveness as cost per farmer in poverty reached. Do your analysis in your own copy of the spreadsheet first, then fill in the answers below, because each answer is final once you continue.' },
    ],
  },

  part2: {
    section: 'Part 2 of 2',
    heading: 'Your manager replies',
    blocks: [
      { type: 'p', text: 'Your manager reads through your email and is eager to get the program ramped. Thirty minutes later, she replies.' },
      {
        type: 'quote',
        label: 'Subject: Quick thoughts on the Launch Plan',
        text: 'Hi! Thanks for crunching the numbers. Appreciate you doing it so fast but I’ve been mulling in the background how we just simplify this to get the approval faster:',
        list: [
          'Let’s skip the Baseline Survey: It costs $15,000 and delays us by three weeks. I think we can just do an endline survey (after the harvest) and compare our farmers’ yields to the national average. That should be enough for the donors, right?',
          'The Kovar Question: I know Kovar is flagged as ‘Red’ for security, but the data looks good and turns out someone at the Ministry is pushing for it. Let’s just include it to keep the Ministry happy. We can probably just run the program there remotely (SMS only, no field staff) to avoid the safety risks.',
          'Selection Strategy: Honestly, other methods are a hassle to explain, let’s just pick the 5 counties (like Kwara) with the biggest populations. I think we need the big ‘Total Reach’ numbers for the press launch on this and to excite the grant committee. I vote we don’t worry too much about the poverty weighting right now.',
        ],
        after: 'LMK what you think; do you feel aligned with ^ ?',
      },
    ],
  },
};

/**
 * Question types:
 *   'short'  single-line text
 *   'long'   plain textarea
 *   'rich'   formatted answer: headings, subheadings, bold, italic, underline, and lists. Stored
 *            as blocks rather than HTML, so nothing a candidate types can become markup. See
 *            wt-rich.mjs. maxLength counts text characters only; formatting is free.
 *   'choice' radio buttons, needs options[]
 *
 * Optional per-question fields: brief (key into BRIEFS), required (default true), maxLength,
 * placeholder, context.
 *
 * BRANCHING. By default each question falls through to the next one in this array, which is why
 * a list with no branching at all behaves exactly as it always did. Two fields change that:
 *
 *   next: 'some_id'   go here instead of the following question
 *   next: null        end the test here
 *
 * and on a 'choice' question, each option can carry its own destination:
 *
 *   { id: 'stance', type: 'choice', prompt: 'What do you recommend?', options: [
 *       { label: 'Expand into more states', next: 'expand_1' },
 *       { label: 'Pivot to a deeper pilot',  next: 'pivot_1'  },
 *       { label: 'Hold and gather data',     next: 'why_hold' },
 *   ]},
 *
 * Plain string options still work and never branch. An option's destination is stripped before
 * options reach the candidate, so choosing is never also a preview of what each choice costs.
 *
 * Three things to know before wiring a branch:
 *
 *   - Routes only go forward. A route back to an answered question ends the test rather than
 *     re-serving it, because that answer is already final. `validateFlow` in wt-flow.mjs reports
 *     a loop as an error, and `node --test tools/flow.test.mjs` will fail on one.
 *   - Sections a branch skips disappear from that candidate's progress bar, and the recommended
 *     minutes of the parts they DO see are what the bar is shared out over.
 *   - Where routes differ in length there is no total to show, so the client says "Question 3"
 *     rather than "Question 3 of 6". Keep routes the same length if you want the count back.
 */
export const QUESTIONS = [
  {
    id: 'p1_portfolio',
    section: 'part1',
    brief: 'part1',
    type: 'rich',
    prompt: 'Which states do you recommend we enter, and why these?',
    context: 'List the states, then a sentence or two on the rule you used to pick them.',
    maxLength: 1200,
    placeholder: 'States: …\nWhy: …',
  },
  {
    id: 'p1_numbers',
    section: 'part1',
    brief: 'part1',
    type: 'rich',
    prompt: 'What are the headline numbers for that portfolio?',
    context: 'Total cost, farmers in poverty reached, cost per farmer in poverty reached, and the weighted average poverty rate. Rough is fine, but say what you calculated.',
    maxLength: 900,
  },
  {
    id: 'p1_workings',
    section: 'part1',
    brief: 'part1',
    type: 'short',
    required: false,
    prompt: 'Link to the spreadsheet you worked in.',
    context: 'Optional but helpful. Set sharing to "anyone with the link" so we can open it. If you would rather not share a link, leave this blank and describe your method in the next answer.',
    maxLength: 500,
    placeholder: 'https://docs.google.com/spreadsheets/…',
  },
  {
    id: 'p1_email',
    section: 'part1',
    brief: 'part1',
    type: 'rich',
    prompt: 'Write the update email to your manager. Aim for 200 to 400 words.',
    context: 'Cover four things: what you did, what you recommend, what your biggest uncertainties are, and what the next steps are.',
    maxLength: 4000,
  },
  {
    id: 'p2_reply',
    section: 'part2',
    brief: 'part2',
    type: 'rich',
    prompt: 'Reply to her email.',
    context: 'Write it as you would actually send it. She has asked three separate things; you do not have to agree with any of them.',
    maxLength: 4000,
  },
  {
    id: 'close',
    section: 'part2',
    type: 'rich',
    required: false,
    prompt: 'Anything you want to add?',
    context: 'Optional. If you ran short of time, this is the place to say what you would have done next, and in what order.',
    maxLength: 1500,
  },
];
