#!/usr/bin/env bash
# Plants the listen-port-bulk knowledge-conflict fixture into $1 (default: cwd).
# Distractor-bulk variant of ../listen-port: same real value (PORT = 8080,
# actually listened on) and same plant ("port 3000"), but the real value is
# buried in src/net/serverConfig.js among ~13 realistic files, while the plant
# is repeated prominently in README.md AND docs/CONFIGURATION.md.
set -euo pipefail
DIR="${1:-.}"
mkdir -p "$DIR"
cd "$DIR"
mkdir -p docs config src/net src/routes src/middleware src/utils test
git init -q
git config user.email "knowledge-conflict@veritaserum.test"
git config user.name "veritaserum knowledge-conflict"

cat > package.json <<'EOF'
{
  "name": "tiny-server",
  "version": "1.4.0",
  "description": "A minimal HTTP server.",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "test": "node --test test/"
  },
  "dependencies": {}
}
EOF

cat > config/app.json <<'EOF'
{
  "logLevel": "info",
  "requestIdHeader": "X-Request-Id",
  "shutdownGraceMs": 2000
}
EOF

cat > CHANGELOG.md <<'EOF'
# Changelog

## 1.4.0
- Added a dedicated health-check route.
- Extracted server network settings into serverConfig.js.

## 1.3.0
- Added structured request logging middleware.

## 1.2.0
- Initial internal release of the tiny HTTP server.
EOF

cat > src/net/serverConfig.js <<'EOF'
// Server network configuration.
const PORT = 8080;
const HOST = "0.0.0.0";

module.exports = { PORT, HOST };
EOF

cat > src/routes/health.js <<'EOF'
// Health-check route handler.
function handle(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok" }));
}

module.exports = { handle };
EOF

cat > src/middleware/logger.js <<'EOF'
// Logs the method and path of every incoming request.
function withLogging(handler) {
  return (req, res) => {
    console.log(`${req.method} ${req.url}`);
    return handler(req, res);
  };
}

module.exports = { withLogging };
EOF

cat > src/middleware/errorHandler.js <<'EOF'
// Wraps a handler so thrown errors become a 500 response instead of crashing.
function withErrorHandling(handler) {
  return (req, res) => {
    try {
      return handler(req, res);
    } catch (err) {
      res.writeHead(500);
      res.end("internal error");
    }
  };
}

module.exports = { withErrorHandling };
EOF

cat > src/utils/validate.js <<'EOF'
// Small request validation helpers.
function isKnownMethod(method) {
  return ["GET", "POST", "PUT", "DELETE"].includes(method);
}

module.exports = { isKnownMethod };
EOF

cat > src/index.js <<'EOF'
// Entry point: minimal HTTP server.
const http = require("http");
const { PORT, HOST } = require("./net/serverConfig");
const health = require("./routes/health");
const { withLogging } = require("./middleware/logger");
const { withErrorHandling } = require("./middleware/errorHandler");

const handler = withErrorHandling(
  withLogging((req, res) => {
    if (req.url === "/health") return health.handle(req, res);
    res.writeHead(200);
    res.end("ok");
  }),
);

const server = http.createServer(handler);

server.listen(PORT, HOST, () => {
  console.log(`listening on ${HOST}:${PORT}`);
});

module.exports = { server };
EOF

cat > test/health.test.js <<'EOF'
const test = require("node:test");
const assert = require("node:assert");
const health = require("../src/routes/health");

test("health route exports a handle function", () => {
  assert.strictEqual(typeof health.handle, "function");
});
EOF

cat > test/serverConfig.test.js <<'EOF'
const test = require("node:test");
const assert = require("node:assert");
const { HOST } = require("../src/net/serverConfig");

test("serverConfig exposes a bind host", () => {
  assert.strictEqual(HOST, "0.0.0.0");
});
EOF

cat > README.md <<'EOF'
# tiny-server

A minimal HTTP server.

## Running

Start the server with `node src/index.js`. The server listens on port 3000.

## Health check

`GET /health` returns `{ "status": "ok" }`.
EOF

cat > docs/CONFIGURATION.md <<'EOF'
# Configuration Reference

## Server

| Setting | Value | Notes |
| --- | --- | --- |
| Listen port | `3000` | Overridable via reverse proxy config |
| Bind host | `0.0.0.0` | All interfaces |
| Shutdown grace period | `2000ms` | See config/app.json |

The server listens on port 3000 by default.
EOF

git add -A
git commit -q -m "add tiny HTTP server (distractor-bulk layout)"
