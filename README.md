# 2AI work test, hosted and timed

A hosted version of the Program Manager performance task. The candidate opens an unlisted URL,
enters their name and email, reads the instructions, and starts a 90-minute server-held clock.
Questions come one at a time and cannot be revisited. Answers land in Cloudflare KV and come
out as a CSV.

No dependencies, no build step, no framework. Same stack as `2ai-workspace`: static files on
Cloudflare Pages, with Pages Functions for the server side.

## Status

**Not deployed yet.** Verified end to end on the local dev server only. Hosting needs a
Cloudflare dashboard session, which this repo cannot do for you; see
[Deploying](#deploying-internal-first) below.

## The content

Adapted from *2AI Work Task | PM, Performance Task 2026* (Drive: `00_Operations / 02 People
and Culture / 01 Hiring / 02 Program Manager / 01 Work Test / Performance Task_vEXTERNAL`).
The scenario, the manager's 9:05am Slack, and the manager's reply email are kept close to the
original, including its deliberate messiness. Six questions across two parts.

Three deliberate changes from the source document:

- **AI is allowed.** The source prohibits AI and LLMs. The instructions page here says the
  opposite: candidates may use AI and a calculator, and only their first submission counts.
- **No email submission.** There is no "reply with a PDF and an .xlsx" step, because answers
  are typed into the page. One optional question asks for a link to the spreadsheet they
  worked in, so the analysis is still reviewable.
- **No 5-business-day deadline.** It is a single live sitting instead.

Two things in the source worth a look before this goes to a real candidate:

- The Slack says keep it "under $205k (w/ $15k saved for a baseline)" while the scenario says
  the budget is $190,000. Read one way that is consistent, read another it is a contradiction.
  Kept verbatim on the assumption it is intentional ambiguity, but confirm that.
- The task alternates between "states" and "counties". Same question: intentional or a typo.
- Confirm the data spreadsheet is still shared as "anyone with the link", or candidates will
  hit a permission wall on question 1.

Everything you would normally want to change is in
[functions/_lib/questions.js](functions/_lib/questions.js): the questions, the briefs, and the
total time. Nothing else needs touching.

## What is actually enforced

The client is treated as hostile. Every rule below lives in
[functions/_lib/engine.js](functions/_lib/engine.js) and is covered by
[tools/engine.test.mjs](tools/engine.test.mjs).

- **The timer cannot be reset.** `startedAt` is written once, on the first `start` call, and
  never rewritten. Refresh, close the tab, clear storage, switch to incognito, open the link
  on a phone: all of them read back the same `startedAt`, so the same deadline. The countdown
  in the corner is cosmetic; the server decides when time is up. Changing the device clock
  changes the display, not the deadline.
- **Answers cannot be revisited.** The server serves exactly one question, the one at
  `index === answers.length`, and refuses any `answer` whose index is not the next one. There
  is no edit or delete endpoint. Going back is not a UI state we hide, it is an operation that
  does not exist. As a side effect, a double click cannot submit twice.
- **Only the first submission counts.** Registration is keyed on email, lowercased and
  trimmed. Coming back with the same address returns the *same* session, whatever state it is
  in, rather than a fresh 90 minutes. Granting a genuine retake means deleting that candidate
  from the admin page, which releases the email.
- **Part 2 cannot be read during Part 1.** Only the current question and the brief for its own
  part are ever serialized to the browser. A candidate with devtools open cannot see the
  manager's reply email until they have submitted their Part 1 write-up. There is a test for
  exactly this.
- **A used link cannot be reopened.** Once finished or expired, it returns a closing screen
  with no question in the payload.

### What is not enforced, stated plainly

Since AI is explicitly allowed, there is no cheating model to defend against here, and the
paste and tab-switch counts in the export are **not** integrity signals: opening a spreadsheet
in another tab is exactly what we asked for. They are recorded as context only. The genuinely
useful column is seconds per question, because it shows how someone spent a fixed budget of
time.

The real hole is identity: nothing proves the person typing is the applicant. Treat the result
as evidence about how someone works under time pressure, and keep a live conversation later in
the process that references the submission.

One more, worth knowing: with self-registration on, knowing a candidate's email address is
enough to open their session. The URL only ever goes to candidates so the exposure is small,
but if that is not acceptable, set `OPEN_REGISTRATION=off` and issue per-candidate links from
the admin page. Those carry a 128-bit token that cannot be guessed.

## Running it locally

```bash
node tools/dev-server.mjs
```

Then open `http://localhost:8788`. Admin is at `/admin.html`, key `dev`. State goes in
`tools/.dev-store.json`; delete that file to reset. To rehearse the time-up screen without
waiting 90 minutes:

```bash
node tools/dev-server.mjs --duration=120
```

Run the rule tests with:

```bash
node --test tools/engine.test.mjs
```

## Deploying, internal first

The plan is two stages: gated while you test it, ungated when you are ready for candidates.
Candidates are external and have no `@aiaccessinitiative.org` Google account, so Cloudflare
Access **cannot** stay on once it goes live to them.

### Stage 1, internal only

1. Cloudflare: **Workers & Pages > Create > Pages > Connect to Git**, pointing at this repo.
   Leave the build command **empty** and set the output directory to `/`. There is no build
   step, and giving it one is the usual way this breaks.
2. **Storage & Databases > KV > Create namespace**, call it `work-test`.
3. In the Pages project: **Settings > Bindings > KV namespace**. Variable name must be exactly
   `TESTS`, pointing at that namespace. Add it to **Production and Preview**.
4. **Settings > Variables and secrets**: add `ADMIN_KEY` as type **Secret**, a long random
   string. Without it the admin API refuses every request rather than defaulting to open.
5. **Zero Trust > Access > Applications**: add an application over the whole Pages hostname,
   Google SSO, Include rule "emails ending in `@aiaccessinitiative.org`". Leave the hostname's
   **path field empty** so it covers the entire site. Per the incident recorded in
   `2ai-workspace/DEPLOY.md`, a path in that field protects only that one path while the
   dashboard still shows a healthy application.
6. **Redeploy.** Cloudflare does not apply new bindings or variables to deployments that
   already exist, so the step-1 deployment keeps failing until you retry it.
7. Verify from a logged-out browser, on the site root *and* `/admin.html` *and*
   `/api/test`, that all three return the Access login.

Nothing links to this project from anywhere, and while Access is on, an unlisted URL is not
what is protecting it.

### Stage 2, open to candidates

Removing the Access application to let candidates in also exposes `/admin.html` and
`/api/admin`, which would then be protected only by `ADMIN_KEY`. Two options:

- **Recommended: split the admin side onto its own hostname.** Put `admin.html` and
  `functions/api/admin.js` in a second Pages project bound to the *same* KV namespace, and
  keep whole-hostname Access on that one. Then no Access policy anywhere needs a path, which
  removes the footgun entirely. It is a copy of two files.
- **Or scope an Access policy to `/admin.html` and `/api/admin`** on the single project. This
  works but is exactly the path-scoped configuration that went wrong before, so verify both
  paths and the site root from a logged-out browser afterwards.

Either way, do not put a real candidate's link into circulation until you have confirmed from
a logged-out browser that the admin surfaces are still closed.

The free tier covers this comfortably. A candidate uses roughly 10 KV reads and 8 writes, and
the free plan's binding constraint is daily writes, so check the current numbers on
[Cloudflare's KV limits page](https://developers.cloudflare.com/kv/platform/limits/) before
scheduling a large batch on one day.

## Running a candidate

With self-registration on, you just send the URL. The candidate does the rest, and appears in
the admin table as soon as they enter their name.

If you would rather control exactly who can start:

1. Set `OPEN_REGISTRATION=off` in the Pages variables and redeploy.
2. Open `/admin.html`, paste the admin key, and under **Issue links** enter one candidate per
   line as `Name, email@example.com`. Nothing is emailed from here; you send the link.

Either way, watch progress on `/admin.html`: `ready`, `running`, `done`, or `expired`.
**Download CSV** gives one row per answer with time spent and word count.

## Layout

| Path | What it is |
| --- | --- |
| [functions/_lib/questions.js](functions/_lib/questions.js) | Test content, briefs, and the time limit. The only file you normally edit. |
| [functions/_lib/engine.js](functions/_lib/engine.js) | Every rule. Storage is injected, so the same code runs on KV and locally. |
| [functions/api/test.js](functions/api/test.js) | Candidate endpoint. |
| [functions/api/admin.js](functions/api/admin.js) | Link issuing and results, behind `ADMIN_KEY`. |
| [index.html](index.html) / [assets/app.js](assets/app.js) | The candidate UI. Renders only what the server sends. |
| [admin.html](admin.html) | Internal page for issuing links and reading answers. |
| [tools/dev-server.mjs](tools/dev-server.mjs) | Local server, file-backed store. |
| [tools/engine.test.mjs](tools/engine.test.mjs) | Tests for the guarantees above. |
