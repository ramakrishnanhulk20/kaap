// The one line every attack case prints, and the exit code: 0 only when every case passed.
//   ATTACK <id>: <what it tries> -> EXPECTED <refusal> -> OBSERVED <what happened> -> PASS|FAIL
// A case that throws, for any reason, is a FAIL with the error as what was observed: an attack
// that could not run proves nothing.

let passed = 0;
let failed = 0;

// These lines are kept in a public file. An error text can carry the address of the node that
// was asked, which may hold a paid key, so every address but an explorer link is left out.
const clean = (text) => String(text).replace(/[^\x20-\x7e]/g, '?').replace(/https?:\/\/(?!testnet\.nearblocks\.io\/)[^\s"')]+/g, '(an address)');

/** Runs one case. `run` returns `{ observed, pass }`. */
export async function attack(id, tries, expected, run) {
  let observed;
  let pass = false;
  try {
    ({ observed, pass } = await run());
  } catch (e) {
    observed = `error: ${e?.message ?? e}`;
    pass = false;
  }
  if (pass) passed++;
  else failed++;
  console.log(`ATTACK ${id}: ${clean(tries)} -> EXPECTED ${clean(expected)} -> OBSERVED ${clean(observed)} -> ${pass ? 'PASS' : 'FAIL'}`);
}

/** Prints the count and exits, non-zero on any FAIL or when no case ran. */
export function finish(name) {
  console.log(`${name}: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 || passed === 0 ? 1 : 0);
}

/** Runs a whole attack file: setup errors are reported as a FAIL, never as a pass. */
export async function main(name, body) {
  try {
    await body();
  } catch (e) {
    failed++;
    console.log(`ATTACK setup: ${clean(name)} could not start -> EXPECTED a running suite -> OBSERVED error: ${clean(e?.message ?? e)} -> FAIL`);
  }
  finish(name);
}
