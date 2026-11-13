// Submission intake → purpose gate → destinations → audit.
//
// The rule this file exists to enforce: a lead is stored only if it is valid, and it is
// sent only if a recorded consent event permits that specific purpose. Everything that is
// not sent has a reason, and that reason is written down.

import { canonical, digest, newId, nowIso, plusDays, truncateIp } from "./crypto.js";
import { appendConsent, currentState, gate, publishNotice } from "./consent.js";
import { connectorFor, REASONS, STATUS } from "./connectors.js";
import { formAsDict, personalFields, validateSubmission } from "./schema.js";

export const CLICK_ID_FIELDS = ["gclid", "gbraid", "wbraid", "fbclid", "ttclid", "msclkid"];
const CLICK_ID_RETENTION_DAYS = 30;

export class IntakeError extends Error {
  constructor(message, { code = "invalid", status = 400, details } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export async function registerForm(store, definition) {
  const c = await canonical(formAsDict(definition));
  const d = await digest(formAsDict(definition));
  await store.putForm({
    form_id: definition.form_id, version: definition.version,
    schema_json: c, digest: d, created_at: nowIso(),
  });
  return { digest: d, schema_json: c };
}

export async function loadForm(store, formId, version) {
  const row = await store.getFormRow(formId, version);
  if (!row) throw new IntakeError(`unknown form ${formId}`, { code: "unknown_form", status: 404 });
  return { form: JSON.parse(row.schema_json), digest: row.digest, version: row.version };
}

/**
 * Take one submission.
 *
 * @param opts.data        the field values, exactly as submitted
 * @param opts.consent     { purposeKey: true|false } as rendered and returned by the form
 * @param opts.clickIds    click identifiers found in the request (gclid, fbclid, …)
 * @param opts.transport   "dry-run" (default) or "live" — live must be requested explicitly
 */
export async function submit(store, key, opts) {
  const {
    formId, data, consent = {}, clickIds = {}, context = {},
    transport = "dry-run", idempotencyKey = null, allowResale = false, now = null,
  } = opts;

  if (!["dry-run", "live"].includes(transport)) {
    throw new IntakeError(`unknown transport ${transport}`, { code: "bad_transport" });
  }
  const { form, digest: formDigest, version } = await loadForm(store, formId, opts.formVersion);

  if (idempotencyKey) {
    const prior = await store.getIdem(formId, idempotencyKey);
    if (prior) {
      const existing = await store.getSubmission(prior.submission_id);
      if (existing) {
        return { submission: existing, deliveries: await store.deliveriesForSubmission(
          prior.submission_id), replayed: true, form, notice: null };
      }
    }
  }

  const { cleaned, errors } = validateSubmission(form, data);
  // A *required* consent purpose that was not granted is a validation failure, not a
  // silently-blocked delivery. The person has to tick it to send the form, and if a client
  // posts past the UI without it the API says so rather than accepting a dead lead.
  for (const p of form.purposes) {
    if (p.basis === "consent" && p.required && consent[p.key] !== true) {
      errors[`consent_${p.key}`] = "required: this purpose must be agreed to before submitting";
    }
  }
  if (Object.keys(errors).length) {
    throw new IntakeError("the submission is not valid for this form",
      { code: "validation_failed", details: errors });
  }

  // Consent must reference a notice that was actually published, and the purposes must be
  // a subset of what that notice declared. Self-asserted consent with no notice is exactly
  // the failure mode this design is meant to make impossible.
  const notice = await publishNotice(store, form);
  const declared = new Set(form.purposes.map((p) => p.key));
  for (const k of Object.keys(consent)) {
    if (!declared.has(k)) {
      throw new IntakeError(`consent given for undeclared purpose ${k}`,
        { code: "unknown_purpose", status: 422 });
    }
  }

  const subjectId = await subjectFor(form, cleaned);
  const submissionId = "sub_" + newId(10);
  const createdAt = now || nowIso();
  const ip = context.ip ? truncateIp(context.ip) : null;

  // One consent event per submission, recording exactly what was granted and refused.
  const grantState = {};
  for (const p of form.purposes) {
    if (p.basis !== "consent") { grantState[p.key] = consent[p.key] === false ? false : null; continue; }
    grantState[p.key] = consent[p.key] === true;
  }
  const event = await appendConsent(store, key, {
    subject_id: subjectId,
    kind: "granted",
    notice_id: notice.notice_id,
    purposes: grantState,
    basis: Object.fromEntries(form.purposes.map((p) => [p.key, p.basis])),
    context: { form_id: form.form_id, form_version: version, form_digest: formDigest,
      ip, user_agent: context.userAgent || null, ...context.extra },
  });

  const personal = personalFields(form);
  const personalData = {};
  for (const [k, v] of Object.entries(cleaned)) if (personal.has(k)) personalData[k] = v;

  const retention = plusDays(createdAt, form.retention_days);
  const submission = {
    submission_id: submissionId, form_id: form.form_id, form_version: version,
    form_digest: formDigest, subject_id: subjectId, notice_id: notice.notice_id,
    consent_seq: event.seq, data_json: JSON.stringify(cleaned),
    personal_json: JSON.stringify(personalData),
    click_ids_json: JSON.stringify(clickIds),
    idempotency_key: idempotencyKey, created_at: createdAt, retention_until: retention,
  };
  await store.putSubmission(submission);
  if (idempotencyKey) {
    await store.putIdem(formId, idempotencyKey, submissionId, createdAt);
  }

  await audit(store, { submission_id: submissionId, subject_id: subjectId, kind: "submission_received",
    detail: { form_id: form.form_id, form_version: version, form_digest: formDigest,
      consent_seq: event.seq, notice_id: notice.notice_id, retention_until: retention,
      personal_fields: [...personal], transport } });

  const state = currentState(await store.consentForSubject(subjectId));
  const deliveries = [];
  for (const dest of form.destinations) {
    deliveries.push(await deliver(store, key, {
      form, submission, data: cleaned, dest, clickIds, state, transport,
      allowResale, env: opts.env || {},
    }));
  }

  return { submission, deliveries, replayed: false, form, notice };
}

async function subjectFor(form, data) {
  const emailField = form.fields.find((f) => f.type === "email");
  const phoneField = form.fields.find((f) => f.type === "phone");
  const parts = [emailField && data[emailField.name], phoneField && data[phoneField.name]]
    .filter(Boolean);
  // A subject is a person, identified by the strongest identifiers the form collects —
  // not by the submission, so two submissions from one person share a consent history.
  if (!parts.length) return "sub_anon_" + newId(8);
  return "subj_" + (await digest(parts));
}

async function deliver(store, key, {
  form, submission, data, dest, clickIds, state, transport, allowResale, env,
}) {
  const connector = connectorFor(dest.kind);
  const purposes = dest.purposes || connector.defaultPurposes;
  const deliveryId = "dlv_" + newId(10);
  const base = {
    delivery_id: deliveryId, submission_id: submission.submission_id,
    destination: dest.name, kind: dest.kind,
    dedup_key: connector.dedupKey({ submission }), requires_json: JSON.stringify(purposes),
    attempts: 0, created_at: nowIso(), updated_at: nowIso(),
  };

  // Resale is not a side effect of "we also run ads". It is its own purpose with its own
  // notice, and it is off unless the deployment says otherwise.
  if (purposes.includes("resale") && !allowResale) {
    return save(store, { ...base, status: STATUS.BLOCKED,
      reason: REASONS.CUSTOMER_DATA_SHARING, request_json: "{}" });
  }

  const verdict = gate(form, state, purposes);
  if (verdict.blocked.length) {
    const rec = await save(store, { ...base, status: STATUS.BLOCKED,
      reason: REASONS.BLOCKED, request_json: "{}" });
    await audit(store, { submission_id: submission.submission_id,
      subject_id: submission.subject_id, kind: "destination_blocked",
      detail: { destination: dest.name, blocked: verdict.blocked } });
    return rec;
  }

  const built = await connector.build({ submission, data, form, env, clickIds });
  if (built.skip) {
    const status = built.skip === REASONS.NO_CREDENTIAL || built.skip === REASONS.NOTHING_TO_SEND
      ? STATUS.SKIPPED : STATUS.SKIPPED;
    return save(store, { ...base, status, reason: built.skip, request_json: "{}" });
  }

  const requestJson = JSON.stringify({ url: built.url, body: redactBody(built),
    headers: built.headers, basis: verdict.by_basis });

  if (transport === "dry-run") {
    return save(store, { ...base, status: STATUS.NOT_SENT, reason: REASONS.DRY_RUN,
      request_json: requestJson });
  }

  // live transport
  let response, code = null, body = null;
  try {
    response = await fetch(built.url, { method: "POST", headers: built.headers,
      body: JSON.stringify(built.body), signal: AbortSignal.timeout(15_000) });
    code = response.status;
    body = (await response.text()).slice(0, 2000);
  } catch (e) {
    await save(store, { ...base, status: STATUS.FAILED, reason: "transport_error",
      request_json: requestJson, response_json: JSON.stringify({ error: String(e) }) });
    throw new IntakeError("delivery failed; the lead was stored and the failure recorded",
      { code: "delivery_failed", status: 502,
        details: { destination: dest.name, submission_id: submission.submission_id } });
  }
  const ok = response.ok && !looksFailed(kindOf(dest.kind), body);
  const rec = await save(store, {
    ...base, status: ok ? STATUS.SENT : STATUS.FAILED,
    reason: ok ? REASONS.OK : "destination_rejected",
    request_json: requestJson, response_code: code, response_json: body.slice(0, 1000),
    attempts: 1,
  });
  if (!ok) {
    await audit(store, { submission_id: submission.submission_id,
      subject_id: submission.subject_id, kind: "destination_failed",
      detail: { destination: dest.name, status: code } });
  }
  return rec;
}

const kindOf = (k) => k;
const looksFailed = (kind, body) => {
  // Meta returns 200 with a partial-failure payload; Google's partialFailure is similar.
  // A 200 that names an error is a failure, and recording it as `sent` would be a lie.
  if (!body) return false;
  try {
    const j = JSON.parse(body);
    if (j.error) return true;
    if (Array.isArray(j.fbtrace_id) && j.error) return true;
  } catch { /* not JSON: trust the status code */ }
  return false;
};

const redactBody = (built) => {
  const body = JSON.parse(JSON.stringify(built.body));
  for (const k of built.redact || []) if (k in body) body[k] = "<redacted>";
  return body;
};

async function save(store, row) {
  const full = { reason: null, response_code: null, response_json: null, ...row };
  await store.putDelivery(full);
  return full;
}

export async function audit(store, { submission_id = null, subject_id = null, kind, detail }) {
  await store.addAudit({
    submission_id, subject_id, at: nowIso(), kind, detail_json: JSON.stringify(detail || {}),
  });
}

/** Retention. Personal data is destroyed; the fact that a lead existed, and who it was
 *  sent to, survives — that is what an audit needs and it contains no PII. */
export async function purge(store, { at = nowIso(), receipt = null } = {}) {
  const due = await store.submissionsDue(at);
  let purged = 0;
  for (const { submission_id } of due) {
    await store.redactSubmission(submission_id, at, { clearClicks: true });
    await audit(store, { submission_id, kind: "retention_purged",
      detail: { at, receipt: receipt || { method: "retention_sweep" } } });
    purged += 1;
  }
  const clicks = await store.submissionsWithClicks();
  let cleared = 0;
  for (const row of clicks) {
    const sub = await store.getSubmission(row.submission_id);
    if (!sub) continue;
    if (plusDays(sub.created_at, CLICK_ID_RETENTION_DAYS) <= at) {
      await store.clearClicks(row.submission_id);
      cleared += 1;
    }
  }
  return { purged, clicks_cleared: cleared };
}

export async function eraseSubject(store, subjectId, { reason = "erasure_request" } = {}) {
  const subs = await store.submissionsForSubject(subjectId);
  if (!subs.length) {
    const events = await store.consentForSubject(subjectId);
    if (!events.length) throw new IntakeError("no records for this subject",
      { code: "unknown_subject", status: 404 });
  }
  const at = nowIso();
  for (const s of subs) {
    await store.redactSubmission(s.submission_id, at, { clearClicks: true });
    await audit(store, { submission_id: s.submission_id, subject_id: subjectId,
      kind: "erasure", detail: { reason, at } });
  }
  return { subject_id: subjectId, submissions_redacted: subs.length };
}

export { REASONS, STATUS, CLICK_ID_RETENTION_DAYS };
