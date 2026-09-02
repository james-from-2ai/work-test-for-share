# 2AI work test, public demo

A deployable copy of the timed work test with **no password**, for showing people outside 2AI how
it works. The test is at `/` and the results board at `/admin.html`.

The internal, real version lives in the `master-mega-badass-site` repo under `work-test/`, behind
Cloudflare Access. This is a snapshot of it, configured for a public audience.

## What makes this copy safe to publish

Three things, and all three matter:

- **It writes to a different Airtable table.** `functions/_lib/wt-store.mjs` defaults to
  `Work Test Sessions (Demo)` (`tbl6PEZ6JQGtolN9N`), not the real one. Real candidates' names,
  emails, and answers are in a separate table this deployment never reads. Do not change that
  default.
- **This repo contains no confidential data.** That is why the demo cannot simply be the existing
  site with the gate removed: that site serves `/data/*.json` with real donor names and amounts
  from the same hostname.
- **Nothing here is a secret.** The admin key for a public demo is not protecting anything, since
  the only data behind it is demo data. Pick something short, and expect it to be shared.

Everything a visitor types goes into a table anyone else with the link can read, which the banner
on every page says outright.

## Deploying it

You need a **new Cloudflare Pages project**, separate from `master-mega-badass-site`.

1. Push this folder to its own repo, public or private, it makes no difference to the result.
2. Cloudflare: **Workers & Pages > Create > Pages > Connect to Git**, pointing at that repo.
   Leave the build command **empty** and the output directory `/`.
3. **Settings > Variables and secrets**, all on Production:

   | Name | Type | Value | Why |
   | --- | --- | --- | --- |
   | `AIRTABLE_TOKEN` | Secret | the same PAT the internal site uses | Needs `data.records:read` and `data.records:write` on base `app3qxyas11wjYIhe` |
   | `ADMIN_KEY` | Secret | something short, e.g. `demo` | Not protecting anything here; you will put it in the link |
   | `ALLOW_SELF_RESET` | Text | `on` | So visitors can retry without asking you |
   | `DURATION_SEC` | Text | `900` | 15 minutes, so a demo does not need 90 |

4. **Do not add a Cloudflare Access application.** That is the entire point of this copy.
5. Deploy, then **redeploy once** after saving the variables. Pages does not apply variable
   changes to a deployment that already exists.

## The two links to send

Once it is live at `https://<project>.pages.dev`:

- **Take the test:** `https://<project>.pages.dev/`
- **See the results board:** `https://<project>.pages.dev/admin.html?k=demo`

The `?k=` prefills the admin key and loads immediately, so the person you send it to does not
have to be told what to paste where. It clears itself out of the address bar on arrival. Use it
only with a throwaway key like this one, never with the key guarding real answers.

## Keeping it in step with the real one

This is a snapshot, so it drifts. To refresh it, copy these from `master-mega-badass-site` and
redo the three edits below:

| From | To |
| --- | --- |
| `work-test/index.html`, `admin.html`, `assets/*` | repo root |
| `work-test/tools/*` | `tools/` |
| `functions/_lib/wt-*.mjs`, `functions/api/work-test*.js` | same paths |

The three differences to reapply, all deliberate:

1. `wt-store.mjs` points at the **demo** table.
2. `TEST_PATH` is `/` rather than `/work-test/`, in `work-test-admin.js` and `tools/dev-server.mjs`.
3. `index.html` and `admin.html` carry the demo banner, and the test imports are one level
   shallower.

## Writing a test without touching code

`/builder.html` is the authoring tool. Someone who does not write code can build a whole test in
it: the questions, the options and where each one branches to, the parts and their recommended
minutes, and the scenario briefs. Four panels sit alongside the editor:

- **Branch map**, drawing every route, labelled with the option that takes it. A branch pointing
  at a question that does not exist is drawn in red, which is the mistake worth catching early:
  it is otherwise invisible until a candidate walks into it, on a clock.
- **Walk it through**, clicking the draft the way a candidate would, using the same routing code
  the server runs.
- **Problems**, updated as you type.
- **Spec file**, which is what you download.

The builder **cannot publish**, on purpose. It has no password, and what it would be publishing is
a live hiring assessment. Shipping is a reviewed diff instead:

```bash
node tools/dev-server.mjs --spec=work-test-spec.json   # try the draft for real
node tools/spec-apply.mjs work-test-spec.json          # write it into the questions file
git diff                                               # read what changed, then commit and deploy
```

`tools/spec-export.mjs` goes the other way, turning the test that is currently live back into a
spec so it can be opened in the builder rather than retyped. Anything that has to survive a
regeneration, above all where the task came from, belongs in the spec's `notes` field: it is
written into the header of the generated file, and everything else in that file is overwritten.

## Branching

A question falls through to the next one in the list unless it says otherwise, so a test with no
branching behaves exactly as a flat list does. `next: 'some_id'` jumps, `next: null` ends the
test, and each option on a multiple choice can carry its own `next`.

Three things follow from that, and they are worth knowing before wiring one:

- **An option never reveals where it leads.** Destinations are stripped server-side, so choosing
  is not also a preview of what each choice costs.
- **Where routes differ in length there is no total**, so a candidate sees "Question 3" rather
  than "Question 3 of 6". Keep every route the same length if you want the count back.
- **Do not edit the flow while somebody is sitting the test.** The route is derived from the spec
  on every request, which is what keeps sessions and spec from ever disagreeing, but it means a
  change mid-sitting can move where that candidate's next answer lands.

## File uploads

A question of type `upload` takes one PDF or Word document, up to 4.5 MB, and asks the candidate
to give it a short name so a reviewer can tell what it is. For a second attachment, add a second
upload question.

The file is stored the moment it is chosen, not when the answer is submitted, so attaching
something near the buzzer cannot be the thing that loses it.

**Uploads need the Airtable backend.** Add an **Attachment** column named `Files` to the sessions
table (or set `AIRTABLE_WT_FILES` to another name); Airtable will not create one on demand. A test
with an upload question refuses to start on a store that cannot hold files, rather than failing on
one candidate mid-sitting. The 4.5 MB cap is Airtable's 5 MB upload limit with headroom.

What the type check does and does not prove, because the difference matters:

- **A PDF is verified properly**, byte by byte. A file renamed to `.pdf` is refused.
- **A `.docx` is not.** It is a ZIP, so the check establishes "a zip archive, named .docx, with a
  matching content type" and no more. Proving it is a real Word document means opening the
  archive, which is more than belongs in a request on a candidate's clock.

Either way this stops ordinary mistakes, not someone acting in bad faith. **A hostile PDF is a
risk to whoever opens it**, and nothing in this repo changes that. The admin page links to the
Airtable row and says to download rather than preview.

## Running it locally

```bash
node tools/dev-server.mjs --duration=120
```

Then `http://localhost:8788/`, admin at `/admin.html` with key `dev`, builder at `/builder.html`.
Add `--port=8899` if that port is busy, and `--spec=file.json` to run a draft. Uploads are written
to `tools/.dev-uploads/`, which is gitignored. Tests:

```bash
node --test tools/engine.test.mjs tools/airtable.test.mjs tools/flow.test.mjs tools/files.test.mjs
```
