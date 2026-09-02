/**
 * Re-export of the flow rules, which live in assets/ rather than here for one reason: the
 * builder page has to validate a draft with exactly the code the engine will run, and
 * Cloudflare Pages does not serve the functions/ directory as static assets, so a browser
 * cannot fetch a module from it.
 *
 * Keeping the real file at assets/wt-flow.mjs and re-exporting it here means there is one
 * implementation of "where does this branch go", used by the server, the tests, and the
 * builder alike. A second copy for the browser would drift, and the failure mode of that drift
 * is the worst kind: an author sees a flow marked valid and candidates walk into a dead end.
 *
 * This is the only cross-directory import in the project. If a Pages build ever fails to
 * resolve it, the fix is to import '../../assets/wt-flow.mjs' directly where it is needed, not
 * to duplicate the file.
 */
export * from '../../assets/wt-flow.mjs';
