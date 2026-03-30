# OWASP Top 10 security audit

Run a comprehensive security audit on the current project.

## Instructions

Check every source file (excluding node_modules) for these vulnerabilities:

### Credential exposure (check FIRST)
- Search for hardcoded keys: `grep -r "AIzaSy\|sk-\|api_key\|password\|secret\|token\|Bearer " --include="*.js" --include="*.ts" --include="*.json" --exclude-dir=node_modules`
- Check git history: `git log -p --all -S "api_key\|secret\|password" --diff-filter=A`
- Verify .gitignore excludes: .env, *.db, *.db-shm, *.db-wal, credentials, *.pem, *.key

### A01 Broken Access Control
- List ALL route handlers. Every one must have auth middleware.
- Only truly public endpoints: login, signup, password reset.
- Check admin routes are protected in BOTH backend and frontend.
- Check users can only access their own resources (self-or-admin pattern).

### A02 Cryptographic Failures
- No passwords stored in plaintext (must be hashed with bcrypt/argon2).
- No sensitive data in URLs or query strings.
- Check if PII (emails, names) is exposed in bulk list endpoints.

### A03 Injection
- Every SQL query must use parameterized queries (? or $1 placeholders).
- No string concatenation in SQL. Flag: `"SELECT" + variable` or template literals with variables in SQL.
- Check for command injection in exec/spawn/execFile calls.
- Check for path traversal in file-serving (must validate resolved path).
- Check for XSS via dangerouslySetInnerHTML or unsanitized user input in HTML.

### A04 Insecure Design
- Check for rate limiting on auth endpoints.
- Check input validation: required fields, types, lengths, formats.
- Check recursive/retry functions have depth limits.

### A05 Security Misconfiguration
- CORS must NOT be wildcard `cors()` — must have explicit origin.
- Security headers must be set (helmet or manual).
- Error responses must not leak stack traces or internal paths.
- Source maps must be disabled in production builds.
- express.json() must have a body size limit.

### A06 Vulnerable Components
- Run `npm audit` in each service directory.

### A07 Authentication/Session
- Check auth cannot be bypassed (e.g., missing middleware on a route).
- Check session/token validation is server-side, not client-only.

### A08 Data Integrity
- Check body parser has size limit.
- Check for prototype pollution (__proto__, constructor.prototype in input).

### A09 Logging
- Check for request logging.
- Check auth events are logged (login, failed login, permission denied).

### A10 SSRF
- Check for user-controlled URLs in fetch/axios/http.get calls.

### Report format
| Severity | OWASP | File:Line | Issue | Fix |
|----------|-------|-----------|-------|-----|

Fix CRITICAL and HIGH automatically. Ask before fixing MEDIUM/LOW.
