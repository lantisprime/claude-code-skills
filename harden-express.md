# Harden an Express application

Apply security best practices to an existing Express app.

## Instructions

Find all Express server.js/app.js files in the project and apply these hardening steps:

### 1. Install security dependencies
```bash
npm install helmet cors
```

### 2. Apply middleware (in this order)
```js
import helmet from "helmet";
import cors from "cors";

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || "http://localhost:3000" }));
app.use(express.json({ limit: "100kb" }));
```

### 3. Protect all routes
- Every route must have authentication middleware
- Write routes (POST/PUT/DELETE) must additionally check admin role
- Only login/signup endpoints should be public

### 4. Secure error handling
```js
// Don't leak stack traces
app.use((err, req, res, _next) => {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === "production" ? "Internal server error" : err.message
  });
});
```

### 5. File serving protection
For any route that serves files from disk, add path traversal protection:
```js
import { resolve } from "path";
const resolved = resolve(BASE_DIR, userInput);
if (!resolved.startsWith(resolve(BASE_DIR))) {
  return res.status(403).json({ error: "Forbidden" });
}
```

### 6. Disable source maps in production
In vite.config.js or webpack config, set `sourcemap: false` for production builds.

### 7. Verify .gitignore
Ensure these are excluded: .env, *.db, *.db-shm, *.db-wal, node_modules/, dist/, *.pem, *.key

### 8. Check for credential leaks
```bash
git log -p --all -S "api_key\|secret\|password\|token" --diff-filter=A
```

Report what was changed and any issues that need manual attention.
