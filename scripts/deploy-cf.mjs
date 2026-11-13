#!/usr/bin/env node
// Deploy to Cloudflare through the REST API (no wrangler, no npm install).
//
// Steps, each idempotent enough to re-run:
//   1. create the D1 database (or reuse the one recorded in .deploy-state.json)
//   2. apply schema.sql (statements split on ";" at line ends)
//   3. upload the Worker as an ES-module bundle (every file under src/)
//   4. set plain-text bindings + secret_text bindings
//   5. enable the workers.dev subdomain
//   6. seed the client form, then verify /healthz and / over HTTPS
//
// Required environment:
//   CLOUDFLARE_API_TOKEN   token with Workers Scripts:Edit, D1:Edit (and Pages:Edit if used)
//   CLOUDFLARE_ACCOUNT_ID  account id
//   LEADLOOM_CONSENT_KEY   >=32 chars; MACs the consent chain. Store it somewhere real.
//   LEADLOOM_ADMIN_TOKEN   >=16 chars; operator access
// Optional: WORKER_NAME (default leadloom-amarcco), LEADLOOM_TRANSPORT (default dry-run),
//           WEBHOOK_URL, CRM_WEBHOOK_URL, LEAD_MAP, META_*, GOOGLE_*, DEFAULT_COUNTRY,
//           ALLOW_LEAD_RESALE.
//
// Nothing here prints a secret value. Errors fail the script rather than being swallowed.

import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { amarccoLead } from "../src/forms/amarcco.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.cloudflare.com/client/v4";
const STATE = path.join(ROOT, ".deploy-state.json");

const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const NAME = process.env.WORKER_NAME || "leadloom-amarcco";
const CONSENT_KEY = process.env.LEADLOOM_CONSENT_KEY;
const ADMIN_TOKEN = process.env.LEADLOOM_ADMIN_TOKEN;

function need(cond, msg) {
  if (!cond) {
    console.error(`refusing to deploy: ${msg}`);
    process.exit(2);
  }
}
need(TOKEN, "CLOUDFLARE_API_TOKEN is not set");
need(ACCOUNT, "CLOUDFLARE_ACCOUNT_ID is not set");
need(CONSENT_KEY && CONSENT_KEY.length >= 32, "LEADLOOM_CONSENT_KEY must be >= 32 chars");
need(ADMIN_TOKEN && ADMIN_TOKEN.length >= 16, "LEADLOOM_ADMIN_TOKEN must be >= 16 chars");

const log = (...a) => console.log(...a);

async function cf(method, endpoint, body, { raw = false } = {}) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body && !raw ? { "content-type": "application/json" } : {}),
    },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok || json.success === false) {
    const detail = JSON.stringify(json.errors || json).slice(0, 800);
    throw new Error(`${method} ${endpoint} -> ${res.status}: ${detail}`);
  }
  return json.result;
}

// ------------------------------------------------------------------ 1. D1 ----
log("→ account:"), await cf("GET", `/accounts/${ACCOUNT}`).then((a) => log("  ", a.name));

const state = JSON.parse(await readFile(STATE, "utf8").catch(() => "{}"));
let dbId = state.d1_id;

if (!dbId) {
  const dbs = await cf("GET", `/accounts/${ACCOUNT}/d1/database`);
  const found = dbs.find((d) => d.name === "leadloom-amarcco");
  if (found) {
    log("→ D1: reusing existing", found.uuid);
    dbId = found.uuid;
  } else {
    const created = await cf("POST", `/accounts/${ACCOUNT}/d1/database`, {
      name: "leadloom-amarcco", primary_location_hint: "eeur",
    });
    dbId = created.uuid;
    log("→ D1: created", dbId);
  }
} else {
  log("→ D1: from state file", dbId);
}

// ------------------------------------------------------------------ 2. schema
const schema = await readFile(path.join(ROOT, "schema.sql"), "utf8");
// Strip comment lines, then split on semicolons that end a statement.
const statements = schema
  .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  .split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean);

for (const sql of statements) {
  await cf("POST", `/accounts/${ACCOUNT}/d1/database/${dbId}/query`, { sql });
}
const check = await cf("POST", `/accounts/${ACCOUNT}/d1/database/${dbId}/query`, {
  sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
});
log("→ schema applied; tables:", check[0].results.map((r) => r.name).join(", "));

// Optional: wipe application data before deploying. Needed when the consent key changes —
// old events were MAC'd with a key we no longer hold, so the chain could never verify again.
if (process.env.LEADLOOM_RESET === "1") {
  for (const table of ["audit_events", "deliveries", "idempotency", "submissions",
    "consent_events", "notices", "forms"]) {
    await cf("POST", `/accounts/${ACCOUNT}/d1/database/${dbId}/query`,
      { sql: `DELETE FROM ${table}` });
  }
  log("→ data reset (LEADLOOM_RESET=1): all rows cleared, chain restarts from zero");
}

// ------------------------------------------------------------------ 3. bundle
async function collect(dir, prefix = "src") {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await collect(full, `${prefix}/${entry.name}`));
    else if (entry.name.endsWith(".js")) {
      out.push({ name: `${prefix}/${entry.name}`, body: await readFile(full, "utf8") });
    }
  }
  return out;
}
const modules = await collect(path.join(ROOT, "src"));
// scripts/seed.mjs and the form definition are not part of the Worker bundle; the form is
// registered through the admin API in step 6.
const bundle = modules.filter((m) => !m.name.includes("/forms/"));
const formModule = await readFile(path.join(ROOT, "src/forms/amarcco.js"), "utf8");
bundle.push({ name: "src/forms/amarcco.js", body: formModule });

const vars = {
  LEADLOOM_FORM_ID: "amarcco-lead",
  LEADLOOM_TRANSPORT: process.env.LEADLOOM_TRANSPORT || "dry-run",
  DEFAULT_COUNTRY: process.env.DEFAULT_COUNTRY || "US",
  ALLOW_LEAD_RESALE: process.env.ALLOW_LEAD_RESALE || "false",
};
for (const key of ["WEBHOOK_URL", "CRM_WEBHOOK_URL", "LEAD_MAP", "META_PIXEL_ID",
  "META_ACCESS_TOKEN", "GOOGLE_CUSTOMER_ID", "GOOGLE_CONVERSION_ACTION_ID",
  "GOOGLE_DEVELOPER_TOKEN", "LEADLOOM_EXTRA_ORIGINS"]) {
  if (process.env[key]) vars[key] = process.env[key];
}

const metadata = {
  main_module: "src/worker.js",
  compatibility_date: "2025-01-01",
  bindings: [
    { type: "d1", name: "DB", id: dbId },
    ...Object.entries(vars).map(([name, text]) => ({ type: "plain_text", name, text })),
    // secret_text: encrypted at rest by Cloudflare, never echoed back in the dashboard.
    { type: "secret_text", name: "LEADLOOM_CONSENT_KEY", text: CONSENT_KEY },
    { type: "secret_text", name: "LEADLOOM_ADMIN_TOKEN", text: ADMIN_TOKEN },
  ],
};

const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
for (const m of bundle) {
  form.append(m.name, new Blob([m.body], { type: "application/javascript+module" }), m.name);
}

const upload = await fetch(`${API}/accounts/${ACCOUNT}/workers/scripts/${NAME}`, {
  method: "PUT",
  headers: { authorization: `Bearer ${TOKEN}` },
  body: form,
});
const uploadText = await upload.text();
if (!upload.ok) throw new Error(`worker upload failed ${upload.status}: ${uploadText.slice(0, 800)}`);
log("→ worker uploaded:", NAME, `(${bundle.length} modules)`);

// ------------------------------------------------------------------ 5. route
await cf("POST", `/accounts/${ACCOUNT}/workers/scripts/${NAME}/subdomain`,
  { enabled: true, previews_enabled: false });
const sub = await cf("GET", `/accounts/${ACCOUNT}/workers/subdomain`);
const URL_BASE = `https://${NAME}.${sub.subdomain}.workers.dev`;
log("→ workers.dev route enabled:", URL_BASE);

await writeFile(STATE, JSON.stringify({ d1_id: dbId, worker: NAME, url: URL_BASE,
  deployed_at: new Date().toISOString() }, null, 2) + "\n");

// ------------------------------------------------------------------ 6. verify
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let health = null;
for (let i = 0; i < 12; i += 1) {
  await sleep(2000);
  const res = await fetch(`${URL_BASE}/healthz`);
  if (res.ok) { health = await res.json(); break; }
  log(`   waiting for propagation (${i + 1}/12)…`);
}
if (!health) throw new Error("deployed, but /healthz never answered");
log("→ health:", JSON.stringify(health));

const seeded = await fetch(`${URL_BASE}/admin/forms`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
  body: JSON.stringify(amarccoLead),
});
log("→ seed form:", seeded.status, (await seeded.text()).slice(0, 200));

const page = await fetch(`${URL_BASE}/`);
log("→ GET / :", page.status, `${(await page.text()).length} bytes`);
const admin = await fetch(`${URL_BASE}/admin/health`, {
  headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
});
log("→ admin health:", JSON.stringify(await admin.json()));

console.log(`
Deployed.
  form:        ${URL_BASE}/
  health:      ${URL_BASE}/healthz
  admin:       ${URL_BASE}/admin/health   (needs the admin token)
  transport:   ${vars.LEADLOOM_TRANSPORT}
`);
