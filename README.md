# Claude Code Skills

A curated collection of reusable slash command skills for [Claude Code](https://docs.anthropic.com/en/docs/claude-code), Anthropic's CLI for Claude. These skills encode production-tested patterns for building secure microservices, running security audits, and generating TTS audio.

**Author:** Charlton D. Ho ([@lantisprime](https://github.com/lantisprime))

## What are Claude Code skills?

Skills are markdown files that act as reusable prompts for Claude Code. When you type a slash command like `/express-microservice`, Claude Code reads the corresponding `.md` file and follows its instructions — giving you consistent, repeatable workflows.

## Skills included

| Skill | Command | Description |
|-------|---------|-------------|
| [Express Microservice](#express-microservice) | `/express-microservice` | Scaffold a production-ready Express + SQLite microservice |
| [OWASP Audit](#owasp-audit) | `/owasp-audit` | Run a comprehensive OWASP Top 10 security audit |
| [Harden Express](#harden-express) | `/harden-express` | Apply security best practices to an existing Express app |
| [Generate TTS](#generate-tts) | `/generate-tts` | Batch-generate text-to-speech audio using Edge TTS |

## Installation

### Global installation (available in all projects)

Copy the skill files to your Claude Code commands directory:

```bash
mkdir -p ~/.claude/commands
cp *.md ~/.claude/commands/
```

### Per-project installation (available only in one project)

Copy the skill files to your project's `.claude/commands` directory:

```bash
mkdir -p .claude/commands
cp *.md .claude/commands/
```

### Verify installation

Open Claude Code and type `/` — you should see the skills listed as available commands.

## Usage

### Express Microservice

Scaffolds a complete microservice with Express, SQLite, authentication middleware, and security hardening.

```
/express-microservice payment-service 3005 handles subscriptions and billing
```

**What it creates:**
```
payment-service/
├── package.json            # ES modules, Express, better-sqlite3, cors, helmet
├── server.js               # Hardened entry point with auth on all routes
├── db/
│   ├── database.js          # SQLite schema with WAL mode + foreign keys
│   └── seed.js              # Seed data script
├── routes/
│   └── payments.js          # CRUD endpoints with auth guards
└── middleware/
    └── auth.js              # requireAuth + requireAdmin with caching
```

**Security included out of the box:**
- `helmet` security headers
- CORS restricted to explicit origin (no wildcard)
- JSON body size limit (100kb)
- All routes authenticated via `x-user-id` header
- Write routes require admin role
- Parameterized SQL queries only
- Auth result caching (1min TTL)

---

### OWASP Audit

Runs a thorough security audit checking all OWASP Top 10 vulnerability categories.

```
/owasp-audit
```

**What it checks:**
- **Credential exposure** — searches code and git history for leaked API keys, passwords, tokens
- **A01 Broken Access Control** — verifies every route has auth middleware
- **A02 Cryptographic Failures** — checks for plaintext passwords, exposed PII
- **A03 Injection** — validates parameterized SQL, checks for command injection, path traversal, XSS
- **A04 Insecure Design** — checks rate limiting, input validation, recursion limits
- **A05 Security Misconfiguration** — CORS, helmet, error messages, source maps
- **A06 Vulnerable Components** — runs `npm audit`
- **A07 Auth Failures** — checks for bypassable auth
- **A08 Data Integrity** — body size limits, prototype pollution
- **A09 Logging** — request logging, auth event logging
- **A10 SSRF** — user-controlled URLs in server-side fetch calls

**Output format:**

| Severity | OWASP | File:Line | Issue | Fix |
|----------|-------|-----------|-------|-----|
| CRITICAL | A01 | routes/users.js:7 | No auth on user list endpoint | Add requireAuth middleware |

Automatically fixes CRITICAL and HIGH issues. Asks before fixing MEDIUM/LOW.

---

### Harden Express

Takes an existing Express application and applies security best practices.

```
/harden-express
```

**What it does:**
1. Installs `helmet` and `cors` if not present
2. Applies middleware in correct order: helmet → cors (explicit origin) → json (size limit)
3. Adds auth middleware to all unprotected routes
4. Secures error handling (no stack trace leaks)
5. Adds path traversal protection on file-serving routes
6. Disables source maps in production
7. Verifies `.gitignore` covers sensitive files
8. Scans git history for credential leaks

---

### Generate TTS

Batch-generates text-to-speech audio files using Edge TTS — completely free, no API key needed, no rate limits.

```
/generate-tts src/data/phrases.json public/audio ja-JP-NanamiNeural
```

**What it does:**
1. Installs `edge-tts` Python package if needed
2. Creates a Node.js generation script that:
   - Collects all text strings from the specified source
   - Generates MP3 files named by MD5 hash (deduplication)
   - Skips already-generated files (incremental builds)
   - Writes a `manifest.json` mapping text to filenames
3. Runs the script and reports results

**Available voices:**

| Language | Voice | Gender | Style |
|----------|-------|--------|-------|
| Japanese | `ja-JP-NanamiNeural` | Female | Natural, clear |
| Japanese | `ja-JP-KeitaNeural` | Male | Calm |
| Japanese | `ja-JP-DaichiNeural` | Male | Deep |
| English | `en-US-JennyNeural` | Female | Friendly |
| English | `en-GB-SoniaNeural` | Female | British |
| Chinese | `zh-CN-XiaoxiaoNeural` | Female | Natural |
| Korean | `ko-KR-SunHiNeural` | Female | Natural |
| Spanish | `es-ES-ElviraNeural` | Female | Natural |

List all voices: `edge-tts --list-voices`

**Key notes:**
- Free with no rate limits or API keys
- ~10-15KB per short phrase
- Rate parameter must use `=` format: `--rate=-10%`
- Prerequisites: Python 3 + `pip3 install edge-tts`

## Patterns and conventions

These skills encode patterns learned from building production microservice applications:

### Authentication
- All routes authenticated by default — public endpoints are the exception
- Auth validated via `x-user-id` header against a user service
- In-memory cache with TTL to avoid hitting user service on every request
- Write operations require admin role on top of basic auth

### Database
- SQLite with WAL mode for concurrent reads
- Foreign keys enforced (`PRAGMA foreign_keys = ON`)
- All schemas use `CREATE TABLE IF NOT EXISTS` (idempotent)
- Cascade deletes on foreign keys
- Transactions for multi-table writes

### Security
- Helmet for security headers
- CORS with explicit origin whitelist
- Body size limits on JSON parser
- Parameterized queries only (no string concatenation in SQL)
- Path traversal protection on file serving
- No secrets in git history
- Source maps disabled in production

## Contributing

Contributions welcome! If you have a useful Claude Code skill pattern, open a PR.

## License

MIT

---

Created by **Charlton D. Ho** ([@lantisprime](https://github.com/lantisprime))

Built with patterns from the [NihongoQuest](https://github.com/lantisprime/NihongoQuest) project.
