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
 *   AIRTABLE_TOKEN     - REQUIRED, Secret. The same token the tech request form uses. It must
 *                        have data.records:read and data.records:write on the base below.
 *                        `AirtablePAT` is accepted too, matching functions/api/request.js.
 *   AIRTABLE_WT_BASE   - optional, defaults to the base holding Tech Requests.
 *   AIRTABLE_WT_TABLE  - optional, defaults to the Work Test Sessions table in that base.
 *
 * Base and table ids are identifiers, not credentials, so they are defaulted here to keep setup
 * to zero new secrets. Only the token has to already exist.
 */

import { airtableStore } from './wt-airtable.mjs';
import { kvStore } from './wt-kv.mjs';

const BASE = 'app3qxyas11wjYIhe';

/**
 * The DEMO table, not the real one. This matters more than any other line in this repo.
 *
 * This copy of the work test is built to be deployed WITHOUT a password, so anyone with the URL
 * can take it and read the results board. Pointing it at the real `Work Test Sessions` table
 * would put actual candidates' names, emails, and answers on the open internet. The separation
 * between the two tables is the only thing preventing that, so it is the default here rather
 * than something a deployer has to remember to set.
 *
 * Do not "fix" this to match the internal copy. If you need this instance to read real
 * submissions, you need Cloudflare Access in front of it instead, at which point use the copy
 * that lives in the master-mega-badass-site repo.
 */
const TABLE = 'tbl6PEZ6JQGtolN9N';

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
      }),
    };
  }
  if (env.TESTS) return { backend: 'kv', store: kvStore(env.TESTS) };
  return { backend: null, store: null };
}
