/**
 * Cloudflare KV wrapped in the tiny store interface wt-engine.mjs expects: get / put / delete
 * over JSON values. Local development swaps in a file-backed store with the same three
 * methods (see tools/dev-server.mjs).
 *
 * KV is eventually consistent across regions, which is fine here: a candidate reads and
 * writes their own key from one place, and the value we care most about (startedAt) is
 * written once and then only read.
 */
export function kvStore(ns) {
  return {
    async get(key) {
      return await ns.get(key, { type: 'json' });
    },
    async put(key, value) {
      await ns.put(key, JSON.stringify(value));
    },
    async delete(key) {
      await ns.delete(key);
    },
  };
}

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** Reads a JSON body without throwing on garbage input. */
export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

/**
 * Constant-time-ish comparison for the admin key, so a wrong key does not leak its correct
 * prefix through response timing.
 */
export function secretEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
