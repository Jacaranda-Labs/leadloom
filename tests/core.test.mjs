import test from "node:test";
import assert from "node:assert/strict";
import { memoryStore } from "../src/db.js";
import { buildForm, SchemaError, validateSubmission } from "../src/schema.js";
import { publishNotice, appendConsent, currentState, gate, verifyConsentChain, withdrawAll }
  from "../src/consent.js";
import { registerForm, submit, purge, eraseSubject, IntakeError }
  from "../src/pipeline.js";
import { STATUS } from "../src/connectors.js";

const KEY = "k".repeat(48);

export const DEFINITION = {
  form_id: "amarcco-lead",
  version: 1,
  title: "Amarcco finance lead",
  retention_days: 180,
  destinations: [
    { name: "client-webhook", kind: "webhook" },
    { name: "meta-capi", kind: "meta" },
    { name: "google-ads", kind: "google" },
  ],
  purposes: [
    { key: "service_delivery", label: "Delivering your request",
      description: "We send your details to a licensed specialist who can contact you.",
      basis: "contract", required: true },
    { key: "advertising_measurement", label: "Measuring advertising",
      description: "We match a hashed version of your email to ad clicks so we know which ad worked.",
      basis: "consent", required: false },
    { key: "resale", label: "Sharing with other buyers",
      description: "We may share your details with other marketing partners who buy leads.",
      basis: "consent", required: false },
  ],
  fields: [
    { name: "full_name", type: "text", label: "Full name", required: true, max_length: 120 },
    { name: "email", type: "email", label: "Email", required: true },
    { name: "phone", type: "phone", label: "Phone", required: true },
    { name: "vertical", type: "select", label: "What do you need?",
      options: ["Mortgage refinance", "Credit card debt"], required: true },
    { name: "loan_amount", type: "number", label: "Amount", required: false },
  ],
};

export async function fixture(envOverrides = {}) {
  const store = memoryStore();
  const form = buildForm(DEFINITION);
  await registerForm(store, form);
  const env = { LEADLOOM_TRANSPORT: "dry-run", WEBHOOK_URL: "https://client.example/hook",
    META_PIXEL_ID: "1234", META_ACCESS_TOKEN: "t", DEFAULT_COUNTRY: "US",
    GOOGLE_CUSTOMER_ID: "555", GOOGLE_CONVERSION_ACTION_ID: "9",
    GOOGLE_DEVELOPER_TOKEN: "dt", ...envOverrides };
  return { store, form, env };
}

export const GOOD = {
  full_name: "Jane Doe", email: "Jane.Doe@Example.com", phone: "+1 415 555 0100",
  vertical: "Mortgage refinance", loan_amount: 250000,
};

test("form definition validation rejects the patterns that make notices untrue", () => {
  const bad = (patch) => assert.throws(() => buildForm({ ...DEFINITION, ...patch }), SchemaError);
  bad({ purposes: [{ ...DEFINITION.purposes[0] }, { ...DEFINITION.purposes[0] }] }); // duplicate key
  bad({ purposes: [{ ...DEFINITION.purposes[0], required: false }] }); // contract basis, optional
  bad({ purposes: [{ ...DEFINITION.purposes[0], basis: "made_up" }] });
  bad({ destinations: [] });
  bad({ form_id: "Bad ID" });
  bad({ fields: [{ name: "x", type: "nonsense" }] });
  bad({ fields: [{ name: "x", type: "text", purpose: "not_declared" }] });
  bad({ retention_days: 0 });
});

test("a non-consent purpose marked optional is refused", () => {
  assert.throws(() => buildForm({
    ...DEFINITION,
    purposes: [{ key: "service_delivery", label: "Delivery", description: "d",
      basis: "legitimate_interests", required: false }],
  }), /must be declared required|optional/);
});

test("submission validation refuses unknown fields instead of silently dropping them", () => {
  const form = buildForm(DEFINITION);
  const r = validateSubmission(form, { ...GOOD, ssn: "123-45-6789" });
  assert.match(r.errors.ssn, /unknown field/);
});

test("email and phone are normalised, and an unparseable phone is an error not a guess", () => {
  const form = buildForm(DEFINITION);
  const ok = validateSubmission(form, GOOD);
  assert.equal(ok.errors.phone, undefined);
  assert.equal(ok.cleaned.email, "jane.doe@example.com");
  assert.equal(ok.cleaned.phone, "14155550100",
    "E.164 without the plus — identical to the Python reference, which is what platforms hash");
  const bad = validateSubmission(form, { ...GOOD, phone: "555-0100" });
  assert.match(bad.errors.phone, /country|cannot/i);
});

test("the notice digest changes when the wording changes, and not otherwise", async () => {
  const { store, form } = await fixture();
  const a = await publishNotice(store, form);
  const b = await publishNotice(store, form);
  assert.equal(a.digest, b.digest, "same form must produce the same notice");
  const changed = buildForm({ ...DEFINITION, version: 2,
    purposes: DEFINITION.purposes.map((p) => p.key === "advertising_measurement"
      ? { ...p, description: "Different words." } : p) });
  const c = await publishNotice(store, changed);
  assert.notEqual(a.digest, c.digest);
});

test("the consent chain detects an edited event", async () => {
  const { store } = await fixture();
  await appendConsent(store, KEY, { subject_id: "s1", kind: "granted",
    notice_id: "n1", purposes: { advertising_measurement: true } });
  await appendConsent(store, KEY, { subject_id: "s1", kind: "withdrawn",
    notice_id: "n1", purposes: { advertising_measurement: false } });
  assert.equal((await verifyConsentChain(store, KEY)).ok, true);

  const events = await store.allConsent();
  events[0].purposes_json = '{"advertising_measurement":false}';
  const tampered = { ...store, allConsent: async () => events };
  const check = await verifyConsentChain(tampered, KEY);
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /digest/.test(p.problem)));
});

test("a wrong key fails the MAC check even when the chain hashes are intact", async () => {
  const { store } = await fixture();
  await appendConsent(store, KEY, { subject_id: "s1", kind: "granted", purposes: {} });
  const check = await verifyConsentChain(store, "z".repeat(48));
  assert.equal(check.ok, false);
  assert.ok(check.problems.some((p) => /MAC/.test(p.problem)));
});

test("the purpose gate: consent needs a record, contract does not, refusal always wins", () => {
  const form = buildForm(DEFINITION);
  const none = gate(form, { purposes: {} }, ["service_delivery", "advertising_measurement"]);
  assert.deepEqual(none.blocked, [{ purpose: "advertising_measurement",
    reason: "no_consent_record" }]);
  assert.equal(none.by_basis.service_delivery, "contract");

  const granted = gate(form, { purposes: { advertising_measurement: true } },
    ["service_delivery", "advertising_measurement"]);
  assert.deepEqual(granted.blocked, []);

  const refused = gate(form, { purposes: { service_delivery: false } }, ["service_delivery"]);
  assert.deepEqual(refused.blocked, [{ purpose: "service_delivery",
    reason: "withdrawn_or_denied" }]);

  const unknown = gate(form, { purposes: {} }, ["telepathy"]);
  assert.equal(unknown.blocked[0].reason, "not_declared_on_notice");
});

test("a submission with no advertising consent sends nothing to Meta but does reach the client",
  async () => {
    const { store, env } = await fixture();
    const r = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
      consent: { advertising_measurement: false }, env });
    const by = Object.fromEntries(r.deliveries.map((d) => [d.destination, d]));
    assert.equal(by["client-webhook"].status, STATUS.NOT_SENT);
    assert.equal(by["meta-capi"].status, STATUS.BLOCKED);
    assert.equal(by["meta-capi"].reason, "blocked_by_purpose_gate");
    assert.equal(by["google-ads"].status, STATUS.BLOCKED);
    assert.equal(JSON.parse(by["meta-capi"].request_json).url, undefined,
      "a blocked delivery must not carry a built request");
  });

test("advertising consent produces a deduplicated Meta payload in dry-run", async () => {
  const { store, env } = await fixture();
  const r = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { advertising_measurement: true }, env });
  const meta = r.deliveries.find((d) => d.destination === "meta-capi");
  assert.equal(meta.status, STATUS.NOT_SENT);
  const req = JSON.parse(meta.request_json);
  const ev = req.body.data[0];
  assert.match(ev.event_id, /^lm_[0-9a-f]{32}$/);
  assert.equal(ev.user_data.em.length, 1);
  assert.match(ev.user_data.em[0], /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(req.body).includes("Jane"), "raw PII must never be in the payload");
  assert.equal(req.body.access_token, "<redacted>");
});

test("Google is skipped, not failed, when the visitor arrived without a click id", async () => {
  const { store, env } = await fixture();
  const r = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { advertising_measurement: true }, env });
  const g = r.deliveries.find((d) => d.destination === "google-ads");
  assert.equal(g.status, STATUS.SKIPPED);
  assert.equal(g.reason, "nothing_to_send");
});

test("a connector with no credential is skipped, never reported as sent", async () => {
  const { store, env } = await fixture({ META_PIXEL_ID: undefined });
  const r = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { advertising_measurement: true }, env });
  const meta = r.deliveries.find((d) => d.destination === "meta-capi");
  assert.equal(meta.status, STATUS.SKIPPED);
  assert.equal(meta.reason, "no_credential");
});

test("resale is off unless the deployment says otherwise", async () => {
  const { store, env } = await fixture();
  const withResale = buildForm({ ...DEFINITION,
    destinations: [...DEFINITION.destinations, { name: "buyer-x", kind: "webhook",
      purposes: ["resale"] }] });
  await registerForm(store, withResale);
  const r = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { advertising_measurement: true, resale: true }, env });
  const buyer = r.deliveries.find((d) => d.destination === "buyer-x");
  assert.equal(buyer.status, STATUS.BLOCKED);
  assert.equal(buyer.reason, "customer_data_sharing_not_enabled");
});

test("consent for an undeclared purpose is refused outright", async () => {
  const { store, env } = await fixture();
  await assert.rejects(submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { sell_everything: true }, env }), /undeclared purpose/);
});

test("an invalid submission stores nothing and sends nothing", async () => {
  const { store, env } = await fixture();
  await assert.rejects(submit(store, KEY, { formId: "amarcco-lead",
    data: { ...GOOD, email: "not-an-email" }, consent: {}, env }), IntakeError);
  assert.equal(await store.countSubmissions(), 0);
  assert.equal(await store.countDeliveries(), 0);
});

test("a repeat with the same idempotency key is not a second lead", async () => {
  const { store, env } = await fixture();
  const a = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { advertising_measurement: true }, env, idempotencyKey: "abc" });
  const b = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { advertising_measurement: true }, env, idempotencyKey: "abc" });
  assert.equal(b.replayed, true);
  assert.equal(a.submission.submission_id, b.submission.submission_id);
  assert.equal(await store.countSubmissions(), 1);
});

test("the transport is dry-run unless live is asked for, explicitly", async () => {
  const { store, env } = await fixture();
  const r = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { advertising_measurement: true }, env, transport: "pretend" }).catch((e) => e);
  assert.ok(r instanceof IntakeError);
  assert.equal(r.code, "bad_transport");
});

test("withdrawal is honoured for everything not yet sent", async () => {
  const { store, env } = await fixture();
  const r = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { advertising_measurement: true }, env });
  const sub = await store.getSubmission(r.submission.submission_id);
  await withdrawAll(store, KEY, sub.subject_id, { context: { via: "test" } });
  const state = currentState(await store.consentForSubject(sub.subject_id));
  assert.equal(state.purposes.advertising_measurement, false);
  assert.equal(state.purposes.service_delivery, false);
  const after = gate(buildForm(DEFINITION), state, ["advertising_measurement",
    "service_delivery"]);
  assert.equal(after.blocked.length, 2);
});

test("retention purges the person but keeps the audit trail", async () => {
  const { store, env } = await fixture();
  const r = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { advertising_measurement: true }, env, clickIds: { gclid: "abc" } });
  const id = r.submission.submission_id;
  const res = await purge(store, { at: r.submission.retention_until });
  assert.equal(res.purged, 1);
  const sub = await store.getSubmission(id);
  assert.deepEqual(JSON.parse(sub.data_json), { redacted: true });
  assert.deepEqual(JSON.parse(sub.personal_json), {});
  assert.deepEqual(JSON.parse(sub.click_ids_json), {});
  const audit = await store.auditForSubmission(id);
  assert.ok(audit.some((a) => a.kind === "retention_purged"));
});

test("erasure removes the person's data and records that it happened", async () => {
  const { store, env } = await fixture();
  const r = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
    consent: { advertising_measurement: true }, env });
  const sub = await store.getSubmission(r.submission.submission_id);
  const out = await eraseSubject(store, sub.subject_id);
  assert.equal(out.submissions_redacted, 1);
  const after = await store.getSubmission(r.submission.submission_id);
  assert.deepEqual(JSON.parse(after.personal_json), {});
  assert.ok((await store.auditForSubject(sub.subject_id)).some((a) => a.kind === "erasure"));
});

test("live transport is exercised against a stub fetch, and a 200-with-error is a failure",
  async () => {
    const { store, env } = await fixture();
    const calls = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ error: { message: "invalid token" } }),
        { status: 200 });
    };
    try {
      const r = await submit(store, KEY, { formId: "amarcco-lead", data: GOOD,
        consent: { advertising_measurement: true }, env, transport: "live",
        clickIds: { gclid: "G123" } });
      const delivered = r.deliveries.filter((d) => d.attempts === 1);
      assert.ok(delivered.length >= 1);
      assert.ok(delivered.every((d) => d.status === STATUS.FAILED),
        "a 200 body naming an error must not be recorded as sent");
      const g = calls.find((c) => c.url.includes("googleads"));
      assert.ok(g, "google should have been called because a gclid was present");
      assert.equal(g.body.conversions[0].orderId, `leadloom:${r.submission.submission_id}`);
      assert.equal(g.body.partialFailure, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

test("a number field accepts the string an <input type=number> actually sends", () => {
  const form = buildForm(DEFINITION);
  const r = validateSubmission(form, { ...GOOD, loan_amount: "240000" });
  assert.equal(r.errors.loan_amount, undefined);
  assert.equal(r.cleaned.loan_amount, 240000);
  const bad = validateSubmission(form, { ...GOOD, loan_amount: "two hundred" });
  assert.match(bad.errors.loan_amount, /must be a number/);
});
