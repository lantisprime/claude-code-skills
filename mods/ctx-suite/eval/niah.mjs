#!/usr/bin/env node
/**
 * Multi-haystack needle-in-a-haystack corpus for ctx-suite live evals.
 *
 * One session reads several unrelated haystacks spanning pi's three approaches,
 * so relevance-aware compaction is measurable:
 *   platform/  code + hybrid (pi smart-compaction/eval/generate.mjs --approach hybrid)
 *              — the session's TASK is about this haystack ("relevant")
 *   ops/       prose: Postgres operations runbooks          ("unrelated")
 *   kitchen/   prose: fermentation and baking notes          ("unrelated")
 *   astro/     prose: comet and astrophotography logs        ("unrelated")
 *   filler/    prose with no needles, read last so no needle sits in the
 *              recent tail a compaction keeps verbatim
 *
 * eval-set.json tags every question with approach and relevance; it stays
 * compatible with pi's score.mjs (id, kind, ask, expect).
 *
 * Usage: node niah.mjs --out <dir> [--seed 20261005] [--pi <pi generate.mjs>]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const out = path.resolve(opt("out", "./niah-corpus"));
const seedArg = Number(opt("seed", "20261005"));
const piGen = opt("pi", path.join(os.homedir(), "pi-extensions/smart-compaction/eval/generate.mjs"));

let seed = seedArg;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
const write = (rel, text) => {
	const p = path.join(out, rel);
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, text);
};

// --- code + hybrid: pi's generator, verbatim ---
const platform = path.join(out, "platform");
execFileSync("node", [piGen, "--approach", "hybrid", "--out", platform, "--seed", String(seedArg)], { stdio: "inherit" });
const piSet = JSON.parse(fs.readFileSync(path.join(platform, "eval-set.json"), "utf8"));
fs.rmSync(path.join(platform, "eval-set.json")); // the bank lives at the corpus root, out of the model's reach

// --- prose haystacks: unrelated topics, two needles per file ---
const TOPICS = {
	ops: ["deploy", "rollback", "alert", "oncall", "ticket", "runbook", "incident", "queue", "socket", "cluster"],
	kitchen: ["sourdough", "starter", "brine", "chili", "dutch oven", "ferment", "miso", "galangal", "crumb", "glaze"],
	astro: ["comet", "perihelion", "guide camera", "exposure", "photometry", "occultation", "declination", "sky flat", "seeing", "ephemeris"],
	filler: ["trellis", "mulch", "compost", "seedling", "pruning", "irrigation", "cutting", "bed", "loam", "harvest"],
};
// [id, sentence planted in the haystack, question, expected tokens]; no answer collides with a code constant
const NEEDLES = {
	ops: [
		["O1", "The primary Postgres write replica listens on port 5434, not the default.", "Which port does the primary Postgres write replica listen on?", ["5434"]],
		["O2", "Incident INC-2271 was opened on 2026-08-14 for the replication lag spike.", "Which incident number was opened for the replication lag spike?", ["2271"]],
		["O3", "The failover service account is named THROTTLEMAN.", "What is the failover service account named?", ["throttleman"]],
		["O4", "Grafana lives at 10.42.7.19 behind the ops VLAN.", "At what IP address does Grafana live?", ["10.42.7.19"]],
		["O5", "Snapshot maintenance runs every Tuesday at 03:40 UTC.", "At what time (UTC) does snapshot maintenance run?", ["03:40"]],
		["O6", "The on-call escalation owner is Priya Raghunathan.", "Who is the on-call escalation owner?", ["priya raghunathan"]],
	],
	kitchen: [
		["K1", "The rye starter is fed at a 1:7:7 ratio every eleven hours.", "At what ratio is the rye starter fed?", ["1:7:7"]],
		["K2", "The miso batch labelled MB-38 must age 214 days before tasting.", "How many days must miso batch MB-38 age?", ["214"]],
		["K3", "The chili brine is held at exactly 3.6 percent salt.", "What salt percentage is the chili brine held at?", ["3.6"]],
		["K4", "The dutch oven preheats to 262 C for the country loaf.", "To what temperature (C) does the dutch oven preheat for the country loaf?", ["262"]],
		["K5", "The galangal paste supplier is Wiraputri Foods.", "Who supplies the galangal paste?", ["wiraputri"]],
		["K6", "The glaze sets after 17 minutes under the salamander.", "After how many minutes does the glaze set under the salamander?", ["17"]],
	],
	astro: [
		["A1", "Comet C/2026 K3 reaches perihelion on 2026-11-02.", "On what date does comet C/2026 K3 reach perihelion?", ["2026-11-02"]],
		["A2", "The guide camera exposure is fixed at 2.7 seconds.", "What is the guide camera exposure fixed at (seconds)?", ["2.7"]],
		["A3", "Sky flats are shot at an ADU target of 31000.", "What ADU target are sky flats shot at?", ["31000"]],
		["A4", "The occultation of star TYC 1391-02 was timed at 04:17:33 UT.", "At what time (UT) was the occultation of TYC 1391-02 timed?", ["04:17:33"]],
		["A5", "The mount's meridian flip is set to 4.5 degrees past the meridian.", "How many degrees past the meridian is the meridian flip set?", ["4.5"]],
		["A6", "The photometry pipeline uses an aperture radius of 7.25 pixels.", "What aperture radius (pixels) does the photometry pipeline use?", ["7.25"]],
	],
};

function proseFile(topic, needles, sections) {
	const t = TOPICS[topic];
	const L = [];
	for (let s = 0; s < sections; s++) {
		L.push(`Section ${s + 1}.`);
		for (let p = 0; p < 3; p++) {
			L.push(
				`${pick(t)} review ${100 + Math.floor(rnd() * 900)}: the ${pick(t)} workflow was checked against the ${pick(t)} baseline and ${pick(t)} follow-ups were noted for the next rotation. ` +
					`Notes covered ${pick(t)} hygiene, ${pick(t)} drift and ${pick(t)} ownership; nothing beyond routine ${pick(t)} bookkeeping was needed.`,
			);
		}
		// needles sit mid-file, never at the head or tail
		if (s === Math.floor(sections / 3) && needles[0]) L.push(needles[0][1]);
		if (s === Math.floor((2 * sections) / 3) && needles[1]) L.push(needles[1][1]);
	}
	return L.join("\n") + "\n";
}

const SECTIONS = 40;
for (const topic of ["ops", "kitchen", "astro"]) {
	const n = NEEDLES[topic];
	for (let f = 0; f < 3; f++) write(`${topic}/${topic}-${f + 1}.txt`, proseFile(topic, n.slice(f * 2, f * 2 + 2), SECTIONS));
}
for (let f = 0; f < 6; f++) write(`filler/garden-${f + 1}.txt`, proseFile("filler", [], SECTIONS));

// --- question bank ---
const RELEVANT = new Set(["fact", "location", "crossref", "detail"]); // every pi question is about the platform
const questions = [
	...piSet.questions.map((q) => ({ ...q, approach: q.id.startsWith("X-") ? "hybrid" : "code", relevant: RELEVANT.has(q.kind) })),
	...Object.entries(NEEDLES).flatMap(([topic, ns]) =>
		ns.map(([id, , ask, expect]) => ({ id, kind: "fact", ask, expect, approach: "prose", topic, relevant: false })),
	),
];
const evalSet = {
	meta: { generator: "ctx-suite/eval/niah.mjs", seed: seedArg, piGenerator: piGen, generated: new Date().toISOString(), approaches: ["code", "hybrid", "prose"] },
	task: "Implement the ingest-platform requirements REQ-077, REQ-114, REQ-233 and REQ-056 in platform/src (codec-lzw, auth-jwt, net-ratelimit, archive-tar)",
	questions,
};
fs.writeFileSync(path.join(out, "eval-set.json"), JSON.stringify(evalSet, null, 2));
const count = (f) => questions.filter(f).length;
console.log(`niah corpus → ${out}: ${questions.length} questions (code ${count((q) => q.approach === "code")}, hybrid ${count((q) => q.approach === "hybrid")}, prose ${count((q) => q.approach === "prose")}; relevant ${count((q) => q.relevant)})`);
