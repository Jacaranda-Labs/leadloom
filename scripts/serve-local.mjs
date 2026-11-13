#!/usr/bin/env node
// Run the Worker locally, unmodified, over real SQLite.
//
// `wrangler dev` is the normal tool, but it cannot be installed in this sandbox. This
// shim starts the Python sqlite3 bridge (D1 is SQLite) and translates Node's http server
// into `worker.fetch(Request)`. The Worker code has no idea any of this is happening: same
// module, same D1 surface, same handler.
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = Number(process.env.PORT || 8080);

function d1OverHttp(url) {
  const call = async (kind, sql, params) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, sql, params }) });
    const body = await res.json();
    if (!body.ok) throw new Error(`sql failed: ${body.error}\n${sql}`);
    return body;
  };
  const stmt = (sql, params = []) => ({
    bind: (...p) => stmt(sql, p),
    first: async () => (await call("first", sql, params)).row,
    all: async () => ({ results: (await call("all", sql, params)).rows }),
    run: async () => call("run", sql, params),
  });
  return { prepare: (sql) => stmt(sql) };
}

// Port 0: let the OS choose. A fixed port collides with any earlier run that has not been
// reaped yet, and the failure ("bridge did not start") looks like a bug in the Worker.
const bridge = spawn("python3", [path.join(HERE, "..", "tests", "sqlite_bridge.py"),
  "--schema", path.join(ROOT, "schema.sql"), "--port", "0"], { cwd: ROOT });
const bridgePort = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("sqlite bridge did not start")), 10_000);
  bridge.stdout.on("data", (b) => {
    const m = String(b).match(/:(\d+)/);
    if (m) { clearTimeout(timer); resolve(Number(m[1])); }
  });
  bridge.stderr.on("data", (b) => process.stderr.write(b));
});

const env = {
  DB: d1OverHttp(`http://127.0.0.1:${bridgePort}`),
  LEADLOOM_CONSENT_KEY: process.env.LEADLOOM_CONSENT_KEY || "local-preview-key-".padEnd(48, "x"),
  LEADLOOM_ADMIN_TOKEN: process.env.LEADLOOM_ADMIN_TOKEN || "local-preview-admin",
  LEADLOOM_FORM_ID: "amarcco-lead",
  LEADLOOM_TRANSPORT: process.env.LEADLOOM_TRANSPORT || "dry-run",
  DEFAULT_COUNTRY: "US",
  ALLOW_LEAD_RESALE: process.env.ALLOW_LEAD_RESALE || "false",
  WEBHOOK_URL: process.env.WEBHOOK_URL || "",
};

const worker = (await import("../src/worker.js")).default;
const { amarccoLead } = await import("../src/forms/amarcco.js");

// Seed the client form the way an operator would, through the admin API.
const seed = await worker.fetch(new Request("http://local/admin/forms", {
  method: "POST",
  headers: { "content-type": "application/json",
    authorization: `Bearer ${env.LEADLOOM_ADMIN_TOKEN}` },
  body: JSON.stringify(amarccoLead),
}), env, {});
console.log("seed:", seed.status, JSON.stringify(await seed.json()));

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(`http://${req.headers.host || `localhost:${PORT}`}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : body,
  });
  try {
    const out = await worker.fetch(request, env, {});
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`local shim error: ${e.message}`);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`leadloom worker on http://0.0.0.0:${PORT}`);
  console.log(`admin token: ${env.LEADLOOM_ADMIN_TOKEN}`);
});

const shutdown = () => { bridge.kill(); server.close(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
