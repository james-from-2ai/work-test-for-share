/**
 * Picks the backing store from whatever the environment provides, so the two Pages Functions do
 * not each repeat the decision.
 *
 * Airtable wins when configured, because that is where the team reads submissions. KV is kept as
 * a working alternative rather than deleted: it is faster and it is the only option with a true
 * single-operation write, so it is the thing to switch to if Airtable's rate limit or latency
 * ever becomes a problem during a live sitting.
 *
 * Airtable needs, in the Pages project settings:
 *   AIRTABLE_TOKEN     - REQUIRED, Secret. The same token the internal site's tech request form
 *                        uses. It must have data.records:read and data.records:write on the base
 *                        below. `AirtablePAT` is accepted too, which is the name that form uses
 *                        in master-mega-badass-site; there is no such form in this repo.
 *   AIRTABLE_WT_BASE   - optional, defaults to the base holding Tech Requests.
 *   AIRTABLE_WT_TABLE  - optional, defaults to the Work Test Sessions table in that base.
 *   AIRTABLE_WT_FILES  - optional, the name of the attachment column candidate uploads land in.
 *                        Defaults to `Files`. The column has to exist and be an Attachment
 *                        field; Airtable will not create one on demand.
 *
 * Base and table ids are identifiers, not credentials, so they are defaulted here to keep setup
 * to zero new secrets. Only the token has to already exist.
 */

import { airtableStore } from './wt-airtable.mjs';
import { kvStore } from './wt-kv.mjs';

const BASE = 'app3qxyas11wjYIhe';

/**
 * The EVP table: `Work Test Sessions (EVP)`. This matters more than any other line in this repo.
 *
 * This deployment serves the Evidence Action EVP, Evidence take-home exercise to real candidates,
 * so this table holds real names, emails, answers and uploaded files. It is deliberately NOT the
 * public demo's table (`Work Test Sessions (Demo)`, tbl6PEZ6JQGtolN9N), which anyone holding the
 * demo link can read back through the demo admin page, and it is not the 2AI PM test's table
 * either. Three tests, three tables, and the default lives here rather than in a variable so a
 * deployer cannot forget to set it and quietly write candidates into the wrong one.
 *
 * The table needs an Attachment column named `Files` (or set AIRTABLE_WT_FILES), because this
 * test accepts PDF and Word uploads.
 */
const TABLE = 'tblGlPl5hThtcGkTu';

/** Returns { store, backend } or throws with a message worth showing an admin. */
export function storeFor(env) {
  const token = env.AIRTABLE_TOKEN || env.AirtablePAT;
  if (token) {
    return {
      backend: 'airtable',
      store: airtableStore({
        token,
        baseId: env.AIRTABLE_WT_BASE || BASE,
        tableId: env.AIRTABLE_WT_TABLE || TABLE,
        fileField: env.AIRTABLE_WT_FILES || 'Files',
      }),
    };
  }
  if (env.TESTS) return { backend: 'kv', store: kvStore(env.TESTS) };
  return { backend: null, store: null };
}
