// The Worker, exercised end-to-end through its `fetch` handler, against a real SQLite
// engine (see tests/sqlite_bridge.py). Request in, HTTP response out — the same path the
// public will hit, so a routing or D1-SQL bug shows up here rather than in production.

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TOKEN = "test-admin-token";
const KEY = "consent-key-for-tests-".padEnd(48, "x");

let bridge;
let baseUrl;
let worker;

/** Minimal D1 surface over the bridge: prepare().bind().first()/all()/run(). */
function d1OverHttp(url) {
  const call = async (kind, sql, params) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, sql, params }) });
    const body = await res.json();
    if (!body.ok) throw new Error(`sql failed: ${body.error}\n${sql}\n${JSON.stringify(params)}`);
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

function envFor() {
  return {
    DB: d1OverHttp(baseUrl),
    LEADLOOM_CONSENT_KEY: KEY,
    LEADLOOM_ADMIN_TOKEN: TOKEN,
    LEADLOOM_TRANSPORT: "dry-run",
    WEBHOOK_URL: "https://client.example/lead",
    META_PIXEL_ID: "1234567890",
    META_ACCESS_TOKEN: "fake",
    DEFAULT_COUNTRY: "US",
  };
}

const DEFINITION = {
  form_id: "amarcco-lead", version: 1, title: "Amarcco finance lead",
  retention_days: 180,
  destinations: [{ name: "client-webhook", kind: "webhook" },
    { name: "meta-capi", kind: "meta" }],
  purposes: [
    { key: "service_delivery", label: "Delivering your request",
      description: "We send your details to a licensed specialist.", basis: "contract",
      required: true },
    { key: "advertising_measurement", label: "Measuring advertising",
      description: "Hashed matching so we know which ad worked.", basis: "consent",
      required: false },
  ],
  fields: [
    { name: "full_name", type: "text", required: true, max_length: 120 },
    { name: "email", type: "email", required: true },
    { name: "phone", type: "phone", required: true },
    { name: "vertical", type: "select", required: true,
      options: ["Mortgage refinance", "Credit card debt"] },
  ],
};

const GOOD = { full_name: "Ada Lovelace", email: "ada@example.com", phone: "+14155550100",
  vertical: "Mortgage refinance" };

const req = (method, url, body, headers = {}) => new Request(`http://form.local${url}`, {
  method, headers: { "content-type": "application/json", ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const admin = (method, url, body) => worker.fetch(req(method, url, body,
  { authorization: `Bearer ${TOKEN}` }), envFor(), {});

test.before(async () => {
  bridge = spawn("python3", [path.join(HERE, "sqlite_bridge.py"), "--schema",
    path.join(ROOT, "schema.sql")], { cwd: ROOT });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bridge did not start")), 10_000);
    bridge.stdout.on("data", (buf) => {
      const m = String(buf).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    });
    bridge.stderr.on("data", (b) => process.stderr.write(b));
  });
  baseUrl = `http://127.0.0.1:${port}`;
  worker = (await import("../src/worker.js")).default;

  // The deployment seeds its form through the admin API, so the tests do the same thing an
  // operator does — no back door that only tests can reach.
  const seeded = await worker.fetch(req("POST", "/admin/forms", DEFINITION,
    { authorization: `Bearer ${TOKEN}` }), envFor(), {});
  const seedBody = await seeded.json();
  assert.equal(seeded.status, 201, JSON.stringify(seedBody));
  assert.match(seedBody.notice_id, /^ntc_/);
});

test.after(() => { if (bridge) bridge.kill(); });

test("an unconfigured deployment refuses to serve rather than starting silently", async () => {
  const env = envFor();
  delete env.LEADLOOM_CONSENT_KEY;
  const res = await worker.fetch(req("GET", "/"), env, {});
  assert.equal(res.status, 500);
  assert.equal((await res.json()).code, "misconfigured");
});

test("the form page renders the notice, both bases, and no external requests", async () => {
  const res = await worker.fetch(req("GET", "/"), envFor(), {});
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Amarcco Leads &amp; Marketing LLC/);
  assert.match(html, /Delivering your request/);
  assert.match(html, /basis: contract/, "a contract purpose is shown as locked, not a checkbox");
  assert.equal((html.match(/<input type="checkbox"[^>]*name="purpose"/g) || []).length, 1,
    "only the consent purpose is a checkbox");
  assert.match(html, /https:\/\/www\.amarccollc\.com\/privacypolicy/);
  assert.match(html, /dry-run/i);
  assert.ok(!/<script src=|<link /.test(html), "no external assets: this form must work offline");
});

test("a submission is stored, gated, and answered with per-destination receipts", async () => {
  const res = await worker.fetch(req("POST", "/submit", {
    form_id: "amarcco-lead", data: GOOD, consent: { advertising_measurement: true },
    click_ids: { gclid: "G-ABC" },
  }, { "cf-connecting-ip": "203.0.113.9" }), envFor(), {});
  const body = await res.json();
  assert.equal(res.status, 201, JSON.stringify(body));
  assert.match(body.submission_id, /^sub_/);
  assert.equal(body.replayed, false);
  const by = Object.fromEntries(body.deliveries.map((d) => [d.destination, d]));
  assert.equal(by["client-webhook"].status, "not_sent");
  assert.equal(by["meta-capi"].status, "not_sent");
});

test("without advertising consent the same submission reaches nobody but the client",
  async () => {
    const res = await worker.fetch(req("POST", "/submit", {
      form_id: "amarcco-lead", data: { ...GOOD, email: "no-ads@example.com" },
      consent: { advertising_measurement: false },
    }), envFor(), {});
    const body = await res.json();
    const by = Object.fromEntries(body.deliveries.map((d) => [d.destination, d]));
    assert.equal(by["client-webhook"].status, "not_sent");
    assert.equal(by["meta-capi"].status, "blocked");
  });

test("invalid input is a 422 with per-field detail and stores nothing", async () => {
  const before = (await (await admin("GET", "/admin/health")).json()).submissions;
  const res = await worker.fetch(req("POST", "/submit", {
    form_id: "amarcco-lead", data: { ...GOOD, email: "nope", extra: "x" }, consent: {},
  }), envFor(), {});
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.code, "validation_failed");
  assert.ok(body.details.email);
  assert.ok(body.details.extra);
  const after = (await (await admin("GET", "/admin/health")).json()).submissions;
  assert.equal(after, before);
});

test("admin routes are closed without the token and open with it", async () => {
  const anon = await worker.fetch(req("GET", "/admin/health"), envFor(), {});
  assert.equal(anon.status, 401);
  const bad = await worker.fetch(req("GET", "/admin/health", undefined,
    { authorization: "Bearer nope" }), envFor(), {});
  assert.equal(bad.status, 401);
  const ok = await admin("GET", "/admin/health");
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.consent_chain.ok, true);
  assert.ok(body.submissions >= 1);
  assert.equal(body.transport, "dry-run");
});

test("a cross-origin post is refused", async () => {
  const res = await worker.fetch(req("POST", "/submit", { form_id: "amarcco-lead",
    data: GOOD, consent: {} }, { origin: "https://evil.example" }), envFor(), {});
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "bad_origin");
});

test("the same idempotency key does not create a second lead", async () => {
  const payload = { form_id: "amarcco-lead", data: { ...GOOD, email: "idem@example.com" },
    consent: {} };
  const hdr = { "idempotency-key": "key-123" };
  const a = await (await worker.fetch(req("POST", "/submit", payload, hdr), envFor(), {})).json();
  const b = await (await worker.fetch(req("POST", "/submit", payload, hdr), envFor(), {})).json();
  assert.equal(a.submission_id, b.submission_id);
  assert.equal(b.replayed, true);
});

test("withdrawal takes effect and is visible to the gate", async () => {
  const sub = await (await worker.fetch(req("POST", "/submit", {
    form_id: "amarcco-lead", data: { ...GOOD, email: "withdraw@example.com" },
    consent: { advertising_measurement: true },
  }), envFor(), {})).json();
  const w = await worker.fetch(req("POST", "/withdraw",
    { submission_id: sub.submission_id }), envFor(), {});
  assert.equal(w.status, 200);
  const wb = await w.json();
  assert.equal(wb.withdrawn, true);
  const state = await (await admin("GET", `/admin/consent?subject_id=${wb.subject_id}`)).json();
  assert.equal(state.state.advertising_measurement, false);
  assert.equal(state.state.service_delivery, false);
});

test("the consent chain verifies after all of the above", async () => {
  const body = await (await admin("GET", "/admin/verify")).json();
  assert.equal(body.ok, true, JSON.stringify(body.problems));
  assert.ok(body.events >= 4);
});

test("retention purge redacts the person and keeps the trail", async () => {
  const sub = await (await worker.fetch(req("POST", "/submit", {
    form_id: "amarcco-lead", data: { ...GOOD, email: "purge@example.com" }, consent: {},
  }), envFor(), {})).json();
  const res = await admin("POST", "/admin/purge?at=2100-01-01T00:00:00Z");
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.ok(out.purged >= 1);
  const detail = await (await admin("GET",
    `/admin/submissions?submission_id=${sub.submission_id}`)).json();
  assert.equal(detail.submission.has_personal, false);
  assert.equal(detail.submission.has_click_ids, false);
  assert.ok(detail.audit.some((a) => a.kind === "retention_purged"));
});

test("erasure is available to an operator and records itself", async () => {
  const sub = await (await worker.fetch(req("POST", "/submit", {
    form_id: "amarcco-lead", data: { ...GOOD, email: "erase@example.com" }, consent: {},
  }), envFor(), {})).json();
  const info = await (await admin("GET",
    `/admin/submissions?submission_id=${sub.submission_id}`)).json();
  const subjectId = info.submission.subject_id;
  const res = await admin("POST", "/admin/erase", { subject_id: subjectId });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).submissions_redacted, 1);
});

test("unknown routes are a 404 page, not a stack trace", async () => {
  const res = await worker.fetch(req("GET", "/nope"), envFor(), {});
  assert.equal(res.status, 404);
  assert.match(await res.text(), /No such page/);
});

test("a live-transport deployment with no credentials still sends nothing", async () => {
  const env = { ...envFor(), LEADLOOM_TRANSPORT: "live" };
  delete env.META_PIXEL_ID;
  delete env.META_ACCESS_TOKEN;
  delete env.WEBHOOK_URL;
  const res = await worker.fetch(req("POST", "/submit", {
    form_id: "amarcco-lead", data: { ...GOOD, email: "live@example.com" },
    consent: { advertising_measurement: true },
  }), env, {});
  const body = await res.json();
  const meta = body.deliveries.find((d) => d.destination === "meta-capi");
  assert.equal(meta.status, "skipped");
  assert.equal(meta.reason, "no_credential");
});
