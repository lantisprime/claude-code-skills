// ctx-suite/hooks/lib/redact.ts — secret redaction battery.
//
// Ported from pi-extensions context-manager (Phase 4 M8). Deterministic, no
// network. Already-redacted text is left alone, so applying it twice is a no-op.

type Pattern = { kind: string; re: RegExp; repl?: (m: string, ...groups: string[]) => string };

const PATTERNS: Pattern[] = [
	{ kind: "openai", re: /sk-[A-Za-z0-9_-]{16,}/g },
	{ kind: "github", re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
	{ kind: "aws", re: /AKIA[0-9A-Z]{16}/g },
	{ kind: "slack", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
	{ kind: "jwt", re: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
	{ kind: "pem", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
	{ kind: "bearer", re: /bearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/=-]{20,}/gi },
	{
		kind: "assignment",
		// keeps the key name (GITHUB_TOKEN, access_token, "password" in JSON); quoted values of any length
		re: /\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|passwd))("?\s*[=:]\s*)("[^"]*"|'[^']*'|(?!\[REDACTED)[^\s"']{20,})/gi,
		repl: (_m, p1, p2) => `${p1}${p2}[REDACTED:assignment]`,
	},
];

/** Custom patterns scan only this many leading chars: a catastrophic regex must not hang a tool result. */
export const CUSTOM_SCAN_CAP = 65_536;
const CUSTOM_PATTERN_MAX = 200;

/** Compile operator patterns; invalid, over-long or empty-matching ones are skipped and returned in `invalid`. */
export function compilePatterns(sources: readonly string[]): { patterns: Pattern[]; invalid: string[] } {
	const patterns: Pattern[] = [];
	const invalid: string[] = [];
	for (const src of sources) {
		if (!src.trim()) continue;
		try {
			const re = new RegExp(src, "g");
			if (src.length > CUSTOM_PATTERN_MAX || re.test("")) throw new Error("rejected");
			patterns.push({ kind: "custom", re });
		} catch {
			invalid.push(src);
		}
	}
	return { patterns, invalid };
}

/** Apply the battery; returns the redacted text and per-kind hit counts. */
export function redactText(text: string, custom: Pattern[] = []): { text: string; kinds: Record<string, number> } {
	const kinds: Record<string, number> = {};
	let out = text;
	for (const { kind, re, repl } of [...PATTERNS, ...custom]) {
		const bounded = kind === "custom" && out.length > CUSTOM_SCAN_CAP;
		const head = bounded ? out.slice(0, CUSTOM_SCAN_CAP) : out;
		const tail = bounded ? out.slice(CUSTOM_SCAN_CAP) : "";
		re.lastIndex = 0;
		const scanned = head.replace(re, (...args: unknown[]) => {
			const m = args[0] as string;
			if (m.includes("[REDACTED")) return m;
			kinds[kind] = (kinds[kind] ?? 0) + 1;
			if (repl) return repl(m, ...(args.slice(1, repl.length) as string[]));
			return `[REDACTED:${kind}]`;
		});
		out = scanned + tail;
	}
	return { text: out, kinds };
}

type Block = { type: string; [field: string]: unknown };

/**
 * Redact the text inside a row's content blocks: text blocks and tool_result
 * content (a string or text blocks). Other blocks pass through untouched.
 * Returns null when nothing matched, so the caller can pass the row on as is.
 */
export function redactBlocks(content: readonly Block[], custom: Pattern[] = []): { content: Block[]; kinds: Record<string, number> } | null {
	const kinds: Record<string, number> = {};
	let hit = false;
	const scrub = (s: string): string => {
		const r = redactText(s, custom);
		for (const [k, n] of Object.entries(r.kinds)) {
			kinds[k] = (kinds[k] ?? 0) + n;
			hit = true;
		}
		return r.text;
	};
	const scrubTextBlocks = (blocks: readonly Block[]): Block[] =>
		blocks.map((b) => (b.type === "text" && typeof b.text === "string" ? { ...b, text: scrub(b.text) } : b));
	const out = content.map((b): Block => {
		if (b.type === "text" && typeof b.text === "string") return { ...b, text: scrub(b.text) };
		if (b.type === "tool_result") {
			if (typeof b.content === "string") return { ...b, content: scrub(b.content) };
			if (Array.isArray(b.content)) return { ...b, content: scrubTextBlocks(b.content as Block[]) };
		}
		return b;
	});
	return hit ? { content: out, kinds } : null;
}
