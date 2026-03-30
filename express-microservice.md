# Create an Express microservice

Scaffold a production-ready Express microservice with SQLite, authentication, and security hardening.

## Arguments
- $ARGUMENTS should contain: service name, port, and domain description

## Instructions

Create a microservice following these battle-tested patterns:

### Directory structure
```
{service-name}/
├── package.json          # type: "module", deps: express, better-sqlite3, cors, helmet
├── server.js             # Entry point with security middleware
├── db/
│   ├── database.js       # SQLite schema with WAL mode + foreign keys
│   └── seed.js           # Seed data script
├── routes/
│   └── {resource}.js     # Route handlers with auth guards
└── middleware/
    └── auth.js           # requireAuth + requireAdmin middleware
```

### Security checklist (apply all)
1. `helmet()` — security headers
2. `cors({ origin: "http://localhost:{frontend_port}" })` — no wildcard
3. `express.json({ limit: "100kb" })` — body size limit
4. `requireAuth` on ALL routes including health check
5. `requireAdmin` on all POST/PUT/DELETE (write) routes
6. Parameterized SQL queries only (? placeholders, never string concat)
7. Path traversal protection on any file-serving route (resolve + startsWith)
8. Auth cache with TTL to reduce inter-service calls

### Auth middleware pattern
```js
const authCache = new Map();
const CACHE_TTL = 60_000;

async function validateUser(userId) {
  const cached = authCache.get(userId);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.user;
  const res = await fetch(`${USER_SERVICE_URL}/api/users/${userId}`, {
    headers: { "x-user-id": userId },
  });
  if (!res.ok) return null;
  const user = await res.json();
  authCache.set(userId, { user, ts: Date.now() });
  return user;
}
```

### Database patterns
- WAL mode + foreign keys ON
- CREATE TABLE IF NOT EXISTS (idempotent)
- FOREIGN KEY with ON DELETE CASCADE
- Use db.transaction() for multi-table writes
- Seed script: clear tables in dependency order, then insert

### Route handler patterns
- Validate required fields → 400
- Use proper HTTP status: 200, 201, 400, 404, 409
- UNIQUE constraint catches → 409
- db.prepare().run/get/all with ? params
- Self-or-admin check: `if (req.userRole !== "admin" && req.userId !== id) return 403`

### After creation
1. npm install
2. Run seed script
3. Add Vite proxy rule (specific routes ABOVE generic /api fallback)
4. Add to start.sh with PID tracking
5. Test with curl: `curl -H "x-user-id: 1" http://localhost:{port}/api/{resource}`
