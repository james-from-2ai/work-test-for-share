# Evidence Action EVP work test

The take-home exercise for the **Executive Vice President, Evidence** role at Evidence Action,
"MMS Nigeria: The Expansion Gate", served as a hosted, two-stage work test. Candidates open a
link, read the Stage 1 case, and on one screen select the option they recommend and submit their
write-up (typed or as a PDF). The option routes them to one of three Stage 2 paths, then one closing
question on AI use with their transcripts attached. Stage 2 is not visible until Stage 1 is submitted, and Stage 1 cannot be
changed afterwards.

The test is at `/`, the results board at `/admin.html`, and the authoring tool at `/builder.html`.

## Three tests, three deployments, three tables

This repo started as the public demo of the 2AI PM work test and now carries the EVP test on its
own branch. Keep the three apart:

| Deployment | Repo and branch | Airtable table | Who can reach it |
| --- | --- | --- | --- |
| 2AI PM test, internal | `master-mega-badass-site`, `work-test/` | `Work Test Sessions` | 2AI staff, behind Cloudflare Access |
| Public demo | this repo, `main` | `Work Test Sessions (Demo)` | anyone; demo data only |
| **EVP test** | **this repo, the EVP branch** | **`Work Test Sessions (EVP)`** | candidates with a link; admin by key |

`functions/_lib/wt-store.mjs` on the EVP branch defaults to the EVP table (`tblGlPl5hThtcGkTu`).
That default is the single most important line in the repo: it is what keeps real candidates'
names, emails, answers and files out of the demo table that anyone holding the demo link can read.
Do not merge the EVP branch into `main`, and do not point the demo at this table.

## Deploying the EVP test

You need a **new Cloudflare Pages project**, separate from the demo and from the internal site.

1. Push the EVP branch to GitHub (this repo is private, which is where a live hiring assessment
   belongs).
2. Cloudflare: **Workers & Pages > Create > Pages > Connect to Git**, pick this repo, and set the
   **production branch** to the EVP branch, not `main`. Project name
   `evidence-action-evp-work-test` gives `https://evidence-action-evp-work-test.pages.dev`.
   Leave the build command **empty** and the output directory `/`.
3. **Settings > Variables and secrets**, all on Production:

   | Name | Type | Value | Why |
   | --- | --- | --- | --- |
   | `AIRTABLE_TOKEN` | Secret | the PAT the internal site uses | Needs `data.records:read` and `data.records:write` on base `app3qxyas11wjYIhe` |
   | `ADMIN_KEY` | Secret | a long random string, 32+ characters | The only thing between the internet and every candidate's answers. Never put it in a link. |
   | `OPEN_REGISTRATION` | Text | `off` | Only links issued from `/admin.html` work. Without this, anyone who finds the hostname can register and read the packet. |
   | `ALLOW_SELF_RESET` | leave unset | | It lets a candidate wipe and restart their own session. Internal testing only. |
   | `DURATION_SEC` | leave unset | | The test is untimed by design. Setting this does nothing useful on an untimed test. |

4. Deploy, then **redeploy once** after saving the variables. Pages does not apply variable
   changes to a deployment that already exists.
5. **Put Cloudflare Access in front of the admin paths.** Zero Trust > Access > Applications >
   Self-hosted, with two paths on the project's hostname: `/admin.html` and
   `/api/work-test-admin`. Allow Evidence Action and 2AI accounts. Leave `/` and `/api/work-test`
   out of the policy: external candidates have to reach them. The admin key is still required
   behind Access; this is a second layer, not a replacement.
6. **Custom domain** (optional): Pages project > Custom domains > Set up a custom domain, for
   example `evp-work-test.evidenceaction.org`. The zone has to be on Cloudflare DNS; Pages adds
   the CNAME for you. Until then the `.pages.dev` address works and carries the same headers.

Then open `/admin.html`, paste the admin key, and issue a link per candidate.

## Issuing links and reading results

- **Issue links** on `/admin.html`: one candidate per line as `Name, email@example.com`. Each gets
  a single-use link. Send it yourself; nothing is emailed from here.
- **Only a candidate's first submission counts**, keyed on their email. Deleting a candidate's
  row (Reset on the admin page, or delete the Airtable row) is how you grant a retake.
- **Files** land in the `Files` attachment column of the candidate's Airtable row, named with the
  question id. The readable `Answers` column says "**File submitted:** name" for a file-only
  answer. Download them rather than previewing: they came from outside.
- **`Answers` is a rich text column**, and the server writes Markdown into it, so a candidate's own
  headings, bold, italics and lists render in Airtable rather than showing their markers. Keep rich
  text switched on for that column; with it off the same text is still readable, it just shows the
  `##` and `-`. Airtable's API cannot turn rich text on for an existing column, which is why the
  plain column it replaced is still there as `Answers (plain, retired)`, holding text from sessions
  submitted before the switch and safe to delete. Underline is the one thing that does not survive:
  Airtable rich text has no underline, so an underlined run keeps its text and loses the underline
  rather than being dressed up as bold. The mirror columns are a convenience, not the record: if
  one is renamed or deleted, the server falls back to writing `Key` and `Data` alone rather than
  failing a candidate's save.
- **CSV** from the admin page carries every answer, the route taken, time on each question, and
  file names and sizes.

## What the test does

- **Untimed.** The source exercise says "please use the time you need" and estimates about 4
  hours across both stages (2 to 3 for Stage 1, 60 to 90 minutes for Stage 2). The progress bar
  shows those estimates; nothing counts down and nothing expires. Submitted answers are saved on
  the server, so a candidate can close the page and return to the same link.
- **Gated and branching.** Five screens, in this order: Stage 1, how AI was used in Stage 1,
  Stage 2, how AI was used in Stage 2, then review and submit. Stage 1 is one `decision` question:
  the whole case, the choice of Option 1, 2 or 3, and the write-up on a single screen, locked in
  together. The option routes to Path A, B or C for Stage 2, and the Stage 1 AI question is asked
  in between (`branchFrom` in the spec, so the wording lives in one place rather than being copied
  onto each path). Each AI question asks three bulleted points with a required written answer, then
  the conversations for that stage as labelled sections beneath it: public share links first (with
  the OpenAI and Anthropic help pages linked), PDFs as the fallback (up to 8), required if they
  used AI. A candidate never sees the destination of an option before choosing it.
- **Review and submit.** The last screen reads every answer back, including attachments and share
  links, and hands the exercise in on one deliberate red click. Nothing there can be changed and no
  answer is sent from it: what it does is close the sitting, which is the thing a candidate
  otherwise has no way to tell has happened.
- **Look back, not change.** Candidates can re-read their Stage 1 submission while working on
  Stage 2, since the memo they are answering refers to it. They cannot edit it.
- **Type it or attach it.** Each write-up question first asks how the candidate wants to respond,
  then shows only that input: the formatting editor, or a PDF upload (up to 4.5 MB, verified byte
  by byte). Word and Google Docs users are told to save as PDF, and everyone is advised to draft
  in a word processor so they keep their own copy. Word documents are not accepted on this test.
- **AI use is allowed.** The disclosure the source document asks for is a short question after
  each stage, about that stage, rather than a paragraph at the end of each response, so a reviewer
  finds it separated by stage with the transcripts attached alongside.
- **Nothing is a surprise.** The instructions open with three short tiles (time, structure,
  format) and six rules in one panel, and the progress bar is a numbered stepper ending on the
  review step. Sealing a stage takes two deliberate acts: a tick against a statement that the
  response covers every question in it (four in Stage 1, three in Stage 2), which the server
  enforces as well, and then a modal that repeats the statement and names what is about to be
  recorded, the option selected and the PDF attached or the word count typed, with "Not yet, take
  me back" alongside "Yes, lock it in". The final submission on the review screen turns red, and
  the closing screen greets the candidate by name. A light/dark toggle sits at the top right; without a choice the
  page follows the device setting, and a choice is remembered in that browser only.

## Which build is live

Cloudflare Pages gives **every deployment its own permanent hostname** (`https://<hash>.evidence-action-evp-work-test.pages.dev`), and those hostnames keep serving the build they were created from for as long as anyone uses them. The Cloudflare bot posts one on every commit, so it is easy to end up working from a bookmarked link that is several deployments behind, issuing candidate links from it, and seeing an older version of the test with no sign that anything is stale.

So the admin page says what it is talking to. Load results and the line under the key reads, for example:

> Serving 6 questions from https://evidence-action-evp-work-test.pages.dev/: s1 → ai_stage1 (after s1) → path_a_response → path_b_response → path_c_response → ai_stage2. Parts: Stage 1, Stage 2. Review screen: yes.

It is read back from the engine that enforces the route, so it cannot disagree with what a candidate will actually walk. If it does not match the test you expect, you are on an old deployment: open the project's own URL (no hash in front) and issue links from there. It is admin-only, because the ordered ids describe the branches.

Two things follow from how the route is derived. A session's route comes from the answers already recorded, and the answered prefix is never re-interpreted, so **a session that started before a flow change keeps the old route** and a newly inserted question is skipped for it. Deleting the row (Reset on the admin page) is how you give that person the current test. And do not publish the test while anyone is mid-sitting.

## Changing the test

The test is `tools/evp-spec.json`. `functions/_lib/wt-questions.mjs` is **generated** from it and
is overwritten on the next run, so edit the spec, not the generated file.

```bash
node tools/dev-server.mjs --spec=tools/evp-spec.json   # try it locally, admin key "dev"
node tools/spec-apply.mjs tools/evp-spec.json          # write it into the questions file
node --test tools/*.test.mjs                           # 170+ tests
git diff                                               # read what changed, then commit and deploy
```

Or open `/builder.html` (locally or on the deployed site), load `tools/evp-spec.json` from the
Load example menu, edit, download the spec, and run `spec-apply` on it. The builder cannot
publish, on purpose: shipping is a reviewed commit.

**Do not edit the flow while a candidate is mid-test.** The route is derived from the spec on
every request, so changing which question follows which can move where a sitting candidate's
next answer lands. Wording changes are safe.

Two things to know about text lengths. Rich answers are capped per question (24,000 characters
for the Stage 1 write-up, 12,000 for Stage 2, 4,000 for the closing AI question), and a
candidate's whole session has to fit in one Airtable long-text cell, so a very long typed response
is refused with a message rather than silently truncated. The instructions steer long or
table-heavy responses towards attaching a PDF, which has no such limit below 4.5 MB.

## What a test can be set to do

Six things, all set in the builder, all defaulting to what this engine has always done so a spec
that says nothing behaves exactly as every earlier one did.

| Setting | Options | Default | EVP test |
| --- | --- | --- | --- |
| **Time** | one clock for the whole test, a clock per part, or untimed | one clock | untimed |
| **Going back** | not at all, look but not change, or go back and change | not at all | look but not change |
| **Pasting** | allowed or blocked, per test or per question | allowed | allowed |
| **What they submit** | writing, a file, either one, both, or nothing | writing | either |
| **File types** | PDF, Word, or both | both | both |
| **Branching** | any multiple choice, or a decision (option plus write-up on one screen), can send each option somewhere different | none | 3 paths |
| **Files per question** | one, or `maxFiles` up to 10 | one | 8 on the transcripts question |

**A clock per part does not end the sitting.** When a part's time runs out, its unanswered
questions are recorded as *not reached* and the candidate moves into the next part on a fresh
clock. A part with no limit set is untimed, so set all of them or use one clock.

**Letting candidates change their answers changes what the test measures.** Forward-only asks
what their judgment is with what they have in front of them; revisable asks something else. If a
revision changes a branch, the answers after it are discarded, because they belong to a route the
candidate is no longer on. The server refuses once and says how many, and destroys nothing until
told to.

## Writing a test without touching code

`/builder.html` is the authoring tool. Someone who does not write code can build a whole test in
it: the questions, the options and where each one branches to, the parts and their recommended
minutes, and the reference briefs. Four panels sit alongside the editor:

- **Branch map**, drawing every route, labelled with the option that takes it. A branch pointing
  at a question that does not exist is drawn in red.
- **Walk it through**, clicking the draft the way a candidate would, using the same routing code
  the server runs.
- **Live preview**, the real candidate page running this draft, in a frame. It needs the local
  dev server: the deployed site has no `/api/dev-spec`, deliberately, so nothing in production
  can swap the running test out from under a sitting.
- **Problems**, updated as you type.
- **Spec file**, which is what you download.

Briefs are the reference material that stays on screen for every question in a part. Block types:
paragraph, subheading, bullet list, table (a header row plus data rows), cards (parallel items
with a title, text, points and a closing line, side by side for options or stacked for numbered
questions), note (a tinted callout with a title, text and bullets, for instructions about the
exercise itself so they read as ours rather than as part of the case), quoted message (a memo,
Slack or email, with a label and optional numbered points), and a link button out to data. Blank lines inside a paragraph or a quoted message render as
paragraph breaks, which is how the Stage 2 memos are written.

The instructions page also carries three "at a glance" tiles. Time and format are written from
the settings; the builder's "Suggested time" and "Structure" fields fill in what only an author
knows, and the suggested time is only shown on an untimed test. The rules about formatting, files
and the either/or are one rule, "How to submit your answers", and the spec's `intro.submitNote`
rides on it for the sentence only an author knows (which tool to draft in, how to make a PDF).

A `decision` question is a choice and a formatted write-up on one screen, stored as one answer
(`choiceIndex`, `choice`, and the write-up as `value`); its options branch exactly like a
`choice`. `optionPrompt` and `responsePrompt` label the two halves. Any `either` question can
carry `modes` to reword the type-or-attach chooser, and `maxFiles` to take several files. When the
file part is a section of its own, `attachmentPrompt` and `attachmentHelp` label it. A question can
carry `confirm: "..."`, a statement the candidate must tick before the answer is accepted (the
server refuses without `confirmed: true`, the tick is recorded on the answer, and the page shows a
modal repeating the statement and what is about to be recorded before it sends anything). A
question can carry `branchFrom: "<question id>"` to be asked between a branching question and the
routes its options choose between; the branch point's own `next`, and any `next` on the detour, are
then not used. The top-level `review` block turns the last screen on: `label`, `summary`,
`recommendedMin` place it in the progress bar, and `heading`, `body`, `note`, `button`, `confirm`
are its words. Remove the block and the exercise ends the moment the last answer lands. A question can
also ask for web links with `links: { prompt, help, max, docs: [{ label, url }] }`: one per line,
each checked to be an http(s) address (a bad line is refused so the candidate can fix it), stored
with the answer, listed in review, the admin view, the CSV and the Airtable mirror. The `docs` are
shown as help links and only http(s) addresses ever become hrefs. Spec-only for now: the builder
does not edit `links`, `modes`, `maxFiles` or the attachment labels.

Two things the candidate page does on its own. It keeps a draft of whatever is being typed in the
browser and restores it if the page is closed or crashes before the answer is submitted; nothing
about a draft ever reaches the server. And the last question asks once before it goes.

`tools/spec-export.mjs` turns the compiled test back into a spec. Anything that has to survive a
regeneration, above all where the task came from, belongs in the spec's `notes` field: it is
written into the header of the generated file, and everything else in that file is overwritten.

## Branching

A question falls through to the next one in the list unless it says otherwise. `next: 'some_id'`
jumps, `next: null` ends the test, and each option on a multiple choice can carry its own `next`.

- **An option never reveals where it leads.** Destinations are stripped server-side.
- **Where routes differ in length there is no total**, so a candidate sees "Question 3" rather
  than "Question 3 of 6". The EVP routes are all the same length, so the count shows.
- **Do not edit the flow while somebody is sitting the test.** See above.

## File uploads

A question with `require` set to `file`, `either` or `both` takes a PDF or Word document, up to
4.5 MB each (the EVP test restricts every upload to PDF with `accept: ["pdf"]`). Set `maxFiles`
for several files on one question; the transcripts question takes 8. On an `either` question the
candidate picks "type" or "attach" first and only the chosen half counts.

**4.5 MB is Airtable's limit, not ours.** Airtable's direct upload caps at 5 MB per file. A text
PDF of a few pages is well under 1 MB; one with embedded screenshots can exceed it. The chooser
tells candidates to export at reduced quality or paste the text if theirs is larger. If that ever
bites, the fix is a `putFile` implementation against Cloudflare R2, not a bigger limit here.

The file is stored the moment it is chosen, not when the answer is submitted.

**Uploads need the Airtable backend** and an **Attachment** column named `Files` on the sessions
table (or set `AIRTABLE_WT_FILES` to another name). The EVP table has one. A test with an upload
question refuses to start on a store that cannot hold files, rather than failing on one candidate
mid-sitting. The 4.5 MB cap is Airtable's 5 MB upload limit with headroom.

What the type check does and does not prove:

- **A PDF is verified properly**, byte by byte. A file renamed to `.pdf` is refused.
- **A `.docx` is not.** It is a ZIP, so the check establishes "a zip archive, named .docx, with a
  matching content type" and no more.

Either way this stops ordinary mistakes, not someone acting in bad faith. **A hostile PDF is a
risk to whoever opens it.** The admin page says to download rather than preview.

## Running it locally

```bash
node tools/dev-server.mjs
```

Then `http://localhost:8788/`, admin at `/admin.html` with key `dev`, builder at `/builder.html`.
Add `--port=8899` if that port is busy, `--spec=file.json` to run a draft, and `--duration=120`
to shorten the clock on a timed spec. Uploads are written to `tools/.dev-uploads/`, which is
gitignored, and sessions to `tools/.dev-store.json`; delete either to reset.

```bash
node --test tools/*.test.mjs
```

The suites by name: `engine` covers the guarantees that hold whatever the settings are, driven
against the PM test kept as a fixture in `tools/fixtures/pm-test.mjs`; `flow` covers branching;
`options` covers everything that is a setting; `files` covers uploads; `airtable` covers the
store; and `tooling` compiles what the builder produces and exercises the dev server.

## Keeping the engine in step with the internal copy

The engine, client and tools are shared with the 2AI PM test in `master-mega-badass-site`. To pull
a fix across, copy these and redo the EVP-specific edits:

| From | To |
| --- | --- |
| `work-test/index.html`, `admin.html`, `builder.html`, `assets/*` | repo root |
| `work-test/tools/*` | `tools/` |
| `functions/_lib/wt-*.mjs`, `functions/api/work-test*.js` | same paths |

The EVP-specific edits, all deliberate: `wt-store.mjs` points at the EVP table; `TEST_PATH` is
`/`; `index.html` and `admin.html` carry the Evidence Action wording and no demo banner;
`admin.html` does not accept the key from `?k=`; and `wt-questions.mjs` is generated from
`tools/evp-spec.json`.
