#!/usr/bin/env node
/**
 * Debugging-session simulation for ctx-suite's error provenance.
 *
 * A small repo whose session meets every kind of error ctx-suite now tells apart:
 *   live      `node --test test/checksum.test.js` fails, and the session is mid-fix
 *             when it compacts: the bug at hand
 *   resolved  `node scripts/build.js` fails until dist/ exists, then passes
 *   repeated  `node scripts/lint.js` fails the same way three times
 *   harness   an Edit of a file not read first (Claude Code refuses it)
 *   background a slow RED test sent to the background: no ctx-suite compaction
 *             may run until its result is back and read (@SMART probes it)
 *   stopped   a wait loop sent to the background, then stopped with TaskStop: a stopped
 *             shell sends no notification, so the stop itself must release the hold,
 *             and a stop is not a failure (@SMART probes it; @HEALTH names no wait loop)
 *   not an error: shell scripts and a runbook that merely say `exit 1` / `exit code 3`
 * Then filler, a plain /compact, and a recall question about the live failure:
 * can the session go on debugging from the summary alone?
 *
 * Usage: node debugsim.mjs --out <dir>   (writes <dir>/repo, <dir>/prompts.json, <dir>/expect.json)
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const out = path.resolve(args.includes("--out") ? args[args.indexOf("--out") + 1] : "./debugsim");
const repo = path.join(out, "repo");
const write = (rel, text) => {
	const p = path.join(repo, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, text);
};

// --- the live bug: a checksum off by a transposed constant, reported deep in a long trace ---
write("src/checksum.js", `// Ingest checksum: a weighted sum over the payload's char codes, seeded.
const SEED = 0x5a17;
const WEIGHTS = [3, 7, 1, 9];

function checksum(payload) {
  let sum = SEED % 1000;
  for (let i = 0; i < payload.length; i++) {
    sum += payload.charCodeAt(i) * WEIGHTS[i % WEIGHTS.length];
  }
  // BUG: the modulus should be 9973 (a prime), not 9937
  return sum % 9937;
}

module.exports = { checksum, SEED };
`);
write("test/checksum.test.js", `const test = require("node:test");
const { checksum, SEED } = require("../src/checksum.js");

test("ingest-v2 checksum", () => {
  const got = checksum("ingest-v2");
  const want = 4217;
  if (got !== want) {
    const noise = Array.from({ length: 60 }, (_, i) => \`    at frame_\${i} (node:internal/test/runner/harness:\${100 + i}:\${i % 17})\`).join("\\n");
    throw new Error(
      \`\\n\${noise}\\nCHECKSUM_MISMATCH ingest-v2: expected \${want}, got \${got} (src/checksum.js:11, seed 0x\${SEED.toString(16)}, modulus 9937)\\n\${noise}\`,
    );
  }
});
`);

// --- resolved: fails until dist/ exists ---
write("scripts/build.js", `const fs = require("node:fs");
if (!fs.existsSync("dist")) {
  console.error("BUILD_FAILED: output directory dist/ does not exist");
  process.exit(2);
}
fs.writeFileSync("dist/bundle.txt", "ok");
console.log("build ok: dist/bundle.txt");
`);

// --- repeated: the same lint failure every time ---
write("scripts/lint.js", `console.error("LINT_E042 src/legacy/adapter.js:7 no-implicit-globals: 'feedState' is assigned but never declared");
process.exit(1);
`);

// --- a RED test (TDD: written first, failing on purpose), slow, run in the background ---
write("scripts/slow-red.js", `setTimeout(() => {
  console.error("RED_PENDING test_ingest_retry: expected handler 'ingest.retry' to be registered (tests/test_ingest_retry.js:31)");
  process.exit(1);
}, 45000);
`);

// --- a wait loop that never finishes on its own: it is stopped with TaskStop ---
write("scripts/wait-loop.js", `const until = Date.now() + 3600000;
const t = setInterval(() => { if (Date.now() > until) { clearInterval(t); console.log("WAIT_DONE"); } }, 60000);
`);

// --- a file for the harness refusal (edited before it is read) ---
write("src/config.js", `module.exports = {
  retries: 3,
  backoffMs: 250,
  endpoint: "https://ingest.example.test/v2",
};
`);

// --- not errors: text that only mentions exit codes ---
const script = (name) =>
	`#!/bin/bash\n# ${name}: guarded steps; any failure stops the run\nset -u\n` +
	Array.from({ length: 40 }, (_, i) => `step_${i}() { [ -f "stage/${name}-${i}.ok" ] || { echo "stage ${i} missing" >&2; exit 1; }; }\n`).join("") +
	`echo "${name} done"\n`;
write("scripts/deploy.sh", script("deploy"));
write("scripts/release.sh", script("release"));
write("docs/runbook.md", "# Runbook\n\n" + Array.from({ length: 50 }, (_, i) => `- Step ${i}: if the job reports exit code 3, re-run it once; a second exit code 3 pages on-call.\n`).join(""));

// --- filler, so the compaction has bulk to compress ---
for (let f = 1; f <= 6; f++) {
	write(`docs/arch-${f}.md`, `# Architecture notes ${f}\n\n` + Array.from({ length: 220 }, (_, i) => `Section ${f}.${i}: the ingest worker batches records, applies the schema map and forwards them to the queue; no action needed.\n`).join(""));
}
write("package.json", `{ "name": "ingest-checksum", "version": "0.1.0", "private": true }\n`);

const reply = (w) => ` Reply with exactly: ${w}`;
const prompts = [
	"This is a debugging session. Your task: fix the failing test in test/checksum.test.js. Do NOT fix or edit anything until an instruction explicitly says so. Follow each instruction exactly and keep replies minimal." + reply("ready"),
	"INSTRUCTION: Run this with the Bash tool: node --test test/checksum.test.js — do not fix anything." + reply("ran"),
	"INSTRUCTION: Read scripts/deploy.sh, scripts/release.sh and docs/runbook.md in full with the Read tool." + reply("read"),
	"INSTRUCTION: Run with Bash: node scripts/build.js (it is expected to fail). Then run with Bash: mkdir -p dist. Then run with Bash: node scripts/build.js again." + reply("done"),
	"INSTRUCTION: Run with Bash, as three separate Bash calls: node scripts/lint.js — do not fix anything." + reply("done"),
	"INSTRUCTION: Start this with the Bash tool in the background (set run_in_background to true) and do not wait for it: node scripts/slow-red.js — it is a RED test, expected to fail." + reply("started"),
	"@SMART",
	"@WAITBG",
	"@SMART",
	"INSTRUCTION: Start this with the Bash tool in the background (set run_in_background to true) and do not wait for it: node scripts/wait-loop.js — it is a wait loop." + reply("started"),
	"@SMART",
	"INSTRUCTION: Stop that wait loop now with the TaskStop tool, using its task id. Do not start anything else." + reply("stopped"),
	"@SMART",
	"INSTRUCTION: Without reading it first, use the Edit tool on src/config.js to replace the exact text `backoffMs: 250` with `backoffMs: 500`. If that is refused, Read src/config.js and then make that same Edit." + reply("done"),
	"INSTRUCTION: Read docs/arch-1.md, docs/arch-2.md and docs/arch-3.md in full with the Read tool." + reply("read"),
	"INSTRUCTION: Read docs/arch-4.md, docs/arch-5.md and docs/arch-6.md in full with the Read tool." + reply("read"),
	"@HEALTH",
	"/compact",
	"INSTRUCTION (recall — do NOT run, read or open anything; answer only from this conversation): Write ONE JSON object to the file answers.json with the Write tool, with these keys: \"failing_command\" (the exact command that reproduces the current test failure), \"error_code\" (the error's uppercase code word), \"expected\", \"actual\", \"location\" (file:line from the error), \"seed\", \"modulus\" (the modulus the error reports), \"lint_error\" (the lint error's code and file:line), \"build_status\" (does node scripts/build.js pass now: yes/no), \"red_test\" (the background RED test's error code and test file:line). Use \"unknown\" for anything you do not know." + reply("answers written"),
];
const expect = {
	failing_command: ["node --test test/checksum.test.js"],
	error_code: ["CHECKSUM_MISMATCH"],
	expected: ["4217"],
	actual: [null], // filled from the real run: the value the buggy code produces
	location: ["src/checksum.js:11"],
	seed: ["0x5a17"],
	modulus: ["9937"],
	lint_error: ["LINT_E042", "adapter.js:7"],
	build_status: ["yes"],
	red_test: ["RED_PENDING", "test_ingest_retry.js:31"],
	// what each @SMART reply must match, in order (checked by the driver, not answers.json)
	smart: ["waiting on 1 background task", "^(?!.*waiting on)", "waiting on 1 background task", "^(?!.*waiting on)"],
	// @HEALTH must not name the stopped wait loop as running or failing
	health_excludes: ["wait-loop.js"],
};
fs.writeFileSync(path.join(out, "prompts.json"), JSON.stringify(prompts, null, 1));
fs.writeFileSync(path.join(out, "expect.json"), JSON.stringify(expect, null, 1));
console.log(`debugsim → ${out}: repo + ${prompts.length} prompts`);
