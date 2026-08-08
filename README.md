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

## Running it locally

```bash
node tools/dev-server.mjs --duration=120
```

Then `http://localhost:8788/`, admin at `/admin.html`, key `dev`. Tests:

```bash
node --test tools/engine.test.mjs tools/airtable.test.mjs
```
