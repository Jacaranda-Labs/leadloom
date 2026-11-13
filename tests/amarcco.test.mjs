// The shipped client form, checked the way a client would break it.
import test from "node:test";
import assert from "node:assert/strict";
import { buildForm, validateSubmission, noticeText } from "../src/schema.js";
import { amarccoLead } from "../src/forms/amarcco.js";
import { memoryStore } from "../src/db.js";
import { registerForm, submit } from "../src/pipeline.js";

const KEY = "k".repeat(48);
const form = buildForm(amarccoLead);

test("the client form is valid under our own schema rules", () => {
  assert.equal(form.form_id, "amarcco-lead");
  assert.ok(form.purposes.length === 4);
  assert.equal(form.purposes.filter((p) => p.basis === "consent").length, 3);
});

test("the notice says what is actually done, and claims no regime it is not covered by", () => {
  const text = noticeText(form);
  assert.match(text, /phone, SMS or email/i);
  assert.match(text, /180 days/);
  assert.match(text, /withdraw/i);
  // Amarcco sells to US consumers from India. Claiming GDPR would be a false statement in
  // a notice, which is worse than saying less.
  assert.ok(!/GDPR|EEA|European Economic Area/i.test(text));
});

test("every vertical the client sells is offered, verbatim", () => {
  const v = form.fields.find((f) => f.name === "vertical").options;
  for (const want of ["Mortgage refinance", "New home purchase", "Reverse mortgage",
    "Credit card debt", "Tax debt", "Unsecured debt", "Legal enquiry", "Insurance enquiry"]) {
    assert.ok(v.includes(want), `missing vertical: ${want}`);
  }
});

test("submitting without the required contact consent is refused, not quietly gated", async () => {
  const store = memoryStore();
  await registerForm(store, form);
  await assert.rejects(submit(store, KEY, {
    formId: "amarcco-lead",
    data: { full_name: "Test Person", email: "t@example.com", phone: "+14155550100",
      vertical: "Mortgage refinance", consent_confirmed: true },
    consent: { service_delivery: true, contact_consent: false },
    env: {},
  }), (e) => {
    assert.equal(e.code, "validation_failed");
    assert.ok(e.details.consent_contact_consent);
    return true;
  });
});

test("age/ownership confirmation is a real field, so it is really required", async () => {
  const r = validateSubmission(form, {
    full_name: "Test Person", email: "t@example.com", phone: "+14155550100",
    vertical: "Tax debt",
  });
  assert.equal(r.errors.consent_confirmed, "required");
});

test("a full submission with all optional purposes declined reaches the client only", async () => {
  const store = memoryStore();
  await registerForm(store, form);
  const r = await submit(store, KEY, {
    formId: "amarcco-lead",
    data: { full_name: "Test Person", email: "t@example.com", phone: "+14155550100",
      vertical: "Reverse mortgage", consent_confirmed: true },
    consent: { contact_consent: true, advertising_measurement: false, resale: false },
    env: { WEBHOOK_URL: "https://intake.example/hook" },
  });
  const by = Object.fromEntries(r.deliveries.map((d) => [d.destination, d]));
  assert.equal(by["amarcco-intake"].status, "not_sent");
  assert.equal(by["amarcco-crm"].status, "skipped", "no LEAD_MAP configured, so nothing to map");
  assert.equal(by["meta-capi"].status, "blocked");
  assert.equal(by["google-ads"].status, "blocked");
  assert.equal(by["lead-buyers"].status, "blocked");
  assert.equal(by["lead-buyers"].reason, "customer_data_sharing_not_enabled");
});

test("a required consent purpose is labelled Required, not Optional", async () => {
  const { formPage } = await import("../src/pages.js");
  const { publishNotice } = await import("../src/consent.js");
  const store = memoryStore();
  await registerForm(store, form);
  const notice = await publishNotice(store, form);
  const html = formPage({ form, notice, env: {}, transport: "dry-run" });
  const contact = html.split('id="p_contact_consent"')[1].split("</div>")[0];
  const ads = html.split('id="p_advertising_measurement"')[1].split("</div>")[0];
  assert.match(contact, /Required · basis/);
  assert.match(ads, /Optional · basis/);
  assert.ok(!/Optional/.test(html.split('name="purpose" value="contact_consent"')[1]
    .split("</div>")[0]), "a required consent must never be described as optional");
});

test("a missing required consent is pointed at, not just called invalid", async () => {
  const { formPage } = await import("../src/pages.js");
  const { publishNotice } = await import("../src/consent.js");
  const store = memoryStore();
  await registerForm(store, form);
  const notice = await publishNotice(store, form);
  const html = formPage({ form, notice, env: {}, transport: "dry-run" });
  assert.match(html, /data-err="consent_contact_consent"/,
    "the consent error needs somewhere on the page to appear");
});
