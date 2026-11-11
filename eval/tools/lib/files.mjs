import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's `eval/` folder, found from this file so the tools run from any working directory. */
export const EVAL_DIR = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

/**
 * Reads the `--eval <dir>` option, which points a tool at a copy of the `eval/` folder (for
 * example a scratch copy with a label broken on purpose). Any other argument stops the tool, so a
 * typo never falls back to checking the committed files by accident.
 */
export function parseArgs(argv, flags = []) {
  const out = { evalDir: EVAL_DIR, flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--eval" && i + 1 < argv.length) out.evalDir = path.resolve(argv[++i]);
    else if (flags.includes(a)) out.flags.add(a);
    else throw new Error(`unknown argument ${a}; usage: [--eval <dir>]${flags.map((f) => ` [${f}]`).join("")}`);
  }
  return out;
}

/** One JSON object per line. A line that is not JSON stops the tool instead of being skipped. */
export function readJsonl(evalDir, rel) {
  const text = fs.readFileSync(path.join(evalDir, rel), "utf8");
  return text.split("\n").filter((l) => l.trim()).map((l, i) => {
    try { return JSON.parse(l); } catch { throw new Error(`${rel} line ${i + 1} is not JSON`); }
  });
}
