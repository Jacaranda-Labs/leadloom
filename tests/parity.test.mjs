// Parity with the Python reference implementation.
//
// Two runtimes computing "the same" digest is an assumption until something checks it.
// These tests shell out to the Python package in ../../leadloom and compare actual bytes:
// if the two implementations ever drift, a consent digest recorded by one is unverifiable
// by the other, and the audit trail silently stops meaning anything.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, digest, sha256Hex, normalizeEmail, normalizePhone, hashIdentifier,
  truncateIp } from "../src/crypto.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PY_ROOT = path.resolve(HERE, "../../leadloom");
const HAVE_PY = existsSync(path.join(PY_ROOT, "leadloom", "crypto.py"));

/** JSON as a *string* literal, so values cross into Python via json.loads rather than being
 *  spliced into Python source (where `true` is a NameError and a stray quote is an injection). */
const pyjson = (value) => `json.loads(${JSON.stringify(JSON.stringify(value))})`;

const py = (code) => {
  const out = execFileSync("python3", ["-c", code], { cwd: PY_ROOT, encoding: "utf8" });
  return JSON.parse(out);
};

const CASES = {
  emails: ["Jane.Doe@Example.com", "  spaced@Example.COM  ", "a.b+c@Gmail.com"],
  phones: ["+1 415 555 0100", "+44 7700 900123", "+263 77 123 4567"],
  ips: ["203.0.113.42", "2001:db8::1", "198.51.100.7"],
  submission_ids: ["sub_abc123", "sub_0f9e8d7c6b5a", "sub_zzz"],
};

test("python reference is present (otherwise this file would prove nothing)", () => {
  assert.ok(HAVE_PY, `missing python reference at ${PY_ROOT}; parity cannot be claimed`);
});

test("canonical JSON is byte-identical to the Python canonicaliser", () => {
  const samples = [
    { b: 1, a: 2 },
    { nested: { z: [1, 2, { y: true, x: null }] }, a: "é" },
    { list: ["a", "b"], n: 0 },
  ];
  const out = py(`
import json
from leadloom.crypto import canonical
samples = ${pyjson(samples)}
print(json.dumps([canonical(s).decode() for s in samples]))
`);
  // JS `canonical` returns the string, Python returns bytes; compare the text.
  assert.deepEqual(samples.map((v) => canonical(v)), out);
  // and prove the comparison is not vacuous: unicode survives unescaped in both
  assert.ok(out[1].includes('"a":"é"'), "python must emit the character, not a \\u escape");
});

test("the same consent event yields the same digest in both runtimes", async () => {
  const body = {
    seq: 1, subject_id: "subj_9f2", kind: "granted", notice_id: "ntc_abc",
    purposes: { advertising_measurement: true, resale: false },
    basis: { advertising_measurement: "consent", resale: "consent" },
    context: { form_id: "amarcco-lead", form_version: 1 },
    at: "2026-11-12T09:30:00Z", prev: "0".repeat(64),
  };
  const js = await digest(body);
  const [pyd] = py(`
import json
from leadloom.crypto import digest
print(json.dumps([digest(${pyjson(body)})]))
`);
  assert.equal(js, pyd, "consent digest must be identical across runtimes");
});

test("Meta event_id matches the Python connector exactly", async () => {
  const expected = py(`
import json
from leadloom.connectors import meta
print(json.dumps([meta.event_id(sid, "Lead") for sid in ${pyjson(CASES.submission_ids)}]))
`);
  const actual = [];
  for (const sid of CASES.submission_ids) {
    actual.push("lm_" + (await sha256Hex(`${sid}:Lead`)).slice(0, 32));
  }
  assert.deepEqual(actual, expected);
  assert.equal(actual[0], "lm_594161c3b79a7824953d4a89d3d5d826",
    "the documented sample from the Python test suite");
});

test("identifier normalisation matches, including the refusals", async () => {
  const out = py(`
import json
from leadloom.crypto import normalize_email, normalize_phone, hash_identifier, truncate_ip
res = {"email": [], "phone": [], "ip": [], "hashed": []}
for v in ${pyjson(CASES.emails)}:
    res["email"].append(normalize_email(v))
for v in ${pyjson(CASES.phones)}:
    res["phone"].append(normalize_phone(v))
for v in ${pyjson(CASES.ips)}:
    res["ip"].append(truncate_ip(v))
res["hashed"].append(hash_identifier("email", "Jane.Doe@Example.com")["sha256"])
res["hashed"].append(hash_identifier("phone", "+14155550100")["sha256"])
res["refused"] = []
for bad in ["555-0100", "not-an-email"]:
    try:
        (normalize_phone(bad) if "-" in bad else normalize_email(bad))
        res["refused"].append("accepted:" + bad)
    except Exception as e:
        res["refused"].append(type(e).__name__)
print(json.dumps(res))
`);

  assert.deepEqual(CASES.emails.map((v) => normalizeEmail(v)), out.email);
  assert.deepEqual(CASES.phones.map((v) => normalizePhone(v)), out.phone);
  assert.deepEqual(CASES.ips.map((v) => truncateIp(v)), out.ip);
  assert.deepEqual([
    (await hashIdentifier("email", "Jane.Doe@Example.com")).sha256,
    (await hashIdentifier("phone", "+14155550100")).sha256,
  ], out.hashed);
  assert.ok(out.refused.every((r) => r.includes("Error")), "python must refuse the same inputs");
  // and so must we
  assert.throws(() => normalizePhone("555-0100"));
  assert.throws(() => normalizeEmail("not-an-email"));
});

test("the notice digest agrees with Python for the actual generated notice text", async () => {
  const { noticeText, buildForm } = await import("../src/schema.js");
  const form = buildForm({
    form_id: "amarcco-lead", version: 1,
    title: "Amarcco finance lead", retention_days: 180,
    destinations: [{ name: "w", kind: "webhook" }],
    purposes: [{ key: "service_delivery", label: "Delivering your request",
      description: "We send your details on.", basis: "contract", required: true }],
    fields: [{ name: "email", type: "email", required: true }],
  });
  const text = noticeText(form);
  const purposes = form.purposes.map((p) => ({ key: p.key, basis: p.basis,
    required: p.required }));

  // The text comes *from* the JS implementation, so this compares digest agreement on real
  // output rather than on two hand-maintained copies of the wording.
  const out = py(`
import json
from leadloom.crypto import digest
print(json.dumps({"digest": digest({"text": ${pyjson(text)}, "purposes": ${pyjson(purposes)}})}))
`);
  assert.equal(await digest({ text, purposes }), out.digest);

  // and the wording carries the facts a notice must carry
  assert.match(text, /180 days/);
  assert.match(text, /withdraw consent/i);
  assert.match(text, /hashed identifiers/);
  assert.match(text, /lawful basis: contract/);
  assert.ok(!/GDPR/i.test(text), "no GDPR claim: this deployment does not target the EU");
});
