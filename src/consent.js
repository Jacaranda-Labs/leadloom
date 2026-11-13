// Consent as an append-only, hash-chained, MAC'd event log — the Cloudflare port of
// `leadloom/consent.py`. Same rules, same digests, same refusal semantics.

import { canonical, digest, hmacHex, nowIso, newId, PIIError } from "./crypto.js";
import { noticeText } from "./schema.js";

const pjParse = (v) => {
  if (v === null || v === undefined) return {};
  return typeof v === "string" ? JSON.parse(v) : v;
};

export class ConsentError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || "consent_error";
  }
}

/** Publish a notice. Identity is the digest of its {text, purposes}: a wording change is a
 *  new notice, and the old one stays readable forever. */
export async function publishNotice(store, form, { created_at } = {}) {
  const text = noticeText(form);
  const purposes = form.purposes.map((p) => ({ key: p.key, basis: p.basis,
    required: p.required }));
  const d = await digest({ text, purposes });
  const existing = await store.getNoticeByDigest(d);
  if (existing) return existing;
  const row = {
    notice_id: "ntc_" + d.slice(0, 20), digest: d, version: form.version, text,
    purposes_json: JSON.stringify(purposes), created_at: created_at || nowIso(),
  };
  await store.putNotice(row);
  return row;
}

/**
 * Append a consent event. The chain is what makes the log tamper-evident: each event
 * commits to the previous digest, and each is MAC'd with a key the database does not hold.
 * Rewriting history requires the key, not just write access.
 */
export async function appendConsent(store, key, {
  subject_id, kind, notice_id, purposes, basis, context,
}) {
  if (!["granted", "denied", "withdrawn", "affirmed"].includes(kind)) {
    throw new ConsentError(`unknown consent event kind ${kind}`);
  }
  const prevRow = await store.lastConsent();
  const seq = prevRow ? prevRow.seq + 1 : 1;
  const prev = prevRow ? prevRow.digest : "0".repeat(64);
  const at = nowIso();
  const body = { seq, subject_id, kind, notice_id: notice_id || null,
    purposes: purposes || {}, basis: basis || {}, context: context || {}, at, prev };
  const d = await digest(body);
  const mac = await hmacHex(key, `consent:${d}`);
  const event = {
    seq, subject_id, kind, notice_id: notice_id || null,
    purposes_json: JSON.stringify(body.purposes),
    basis_json: JSON.stringify(body.basis),
    context_json: JSON.stringify(body.context),
    at, prev, digest: d, mac,
  };
  await store.appendConsent(event);
  return event;
}

export async function verifyConsentChain(store, key) {
  const events = await store.allConsent();
  const problems = [];
  let prev = "0".repeat(64);
  let expected = 1;
  for (const e of events) {
    if (e.seq !== expected) {
      problems.push({ seq: e.seq, problem: `expected seq ${expected}` });
    }
    if (e.prev !== prev) {
      problems.push({ seq: e.seq, problem: "prev digest does not match the previous event" });
    }
    const body = { seq: e.seq, subject_id: e.subject_id, kind: e.kind,
      notice_id: e.notice_id, purposes: pjParse(e.purposes_json),
      basis: pjParse(e.basis_json), context: pjParse(e.context_json), at: e.at,
      prev: e.prev };
    const d = await digest(body);
    if (d !== e.digest) problems.push({ seq: e.seq, problem: "digest does not match contents" });
    const mac = await hmacHex(key, `consent:${e.digest}`);
    if (mac !== e.mac) problems.push({ seq: e.seq, problem: "MAC does not verify" });
    prev = e.digest;
    expected = e.seq + 1;
  }
  return { ok: problems.length === 0, events: events.length, problems };
}

/** Fold a subject's events into current state. Later events win, per purpose. */
export function currentState(events) {
  const purposes = {};
  let last = null;
  for (const e of events) {
    const pj = pjParse(e.purposes_json);
    for (const [k, v] of Object.entries(pj || {})) purposes[k] = v;
    last = e;
  }
  return { purposes, last, granted: Object.entries(purposes)
    .filter(([, v]) => v === true).map(([k]) => k) };
}

/**
 * The basis rule. This is the whole compliance design in one function.
 *
 *  - consent basis            → a GRANTED record is required. Absent is not permission.
 *  - contract / legal / LI    → no grant required, but an explicit refusal is honoured.
 *  - purpose not in the notice → refuses, because nobody was told.
 */
export function gate(form, state, purposesWanted) {
  const blocked = [];
  const byBasis = {};
  for (const key of purposesWanted) {
    const purpose = form.purposes.find((p) => p.key === key);
    if (!purpose) {
      blocked.push({ purpose: key, reason: "not_declared_on_notice" });
      continue;
    }
    const v = state.purposes[key];
    if (v === false) {
      blocked.push({ purpose: key, reason: "withdrawn_or_denied" });
      continue;
    }
    if (purpose.basis === "consent") {
      if (v !== true) blocked.push({ purpose: key, reason: "no_consent_record" });
      else byBasis[key] = "consent";
    } else {
      byBasis[key] = purpose.basis;
    }
  }
  return { blocked, by_basis: byBasis };
}

export async function withdrawAll(store, key, subjectId, { notice_id, context } = {}) {
  const events = await store.consentForSubject(subjectId);
  if (!events.length) {
    throw new ConsentError("no consent record for this subject", "unknown_subject");
  }
  const state = currentState(events);
  const all = {};
  for (const k of Object.keys(state.purposes)) all[k] = false;
  return appendConsent(store, key, {
    subject_id: subjectId, kind: "withdrawn",
    notice_id: notice_id || events.at(-1).notice_id, purposes: all,
    basis: { withdrawal: "article_7_3" }, context,
  });
}

export { newId, PIIError };
