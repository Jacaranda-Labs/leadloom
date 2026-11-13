// The store as an explicit interface, implemented twice.
//
// Business logic never contains SQL. That is deliberate: it means the same logic runs in
// tests against an in-memory store and in production against D1, and a SQL bug can only
// hide in `d1Store` — which is exercised by the live smoke tests rather than being assumed
// correct because the unit tests passed.

const JSON_COLS = {
  consent: ["purposes_json", "basis_json", "context_json"],
  submissions: ["data_json", "personal_json", "click_ids_json"],
  deliveries: ["requires_json", "request_json", "response_json"],
  audit: ["detail_json"],
};

function parse(row, table) {
  if (!row) return null;
  const out = { ...row };
  for (const col of JSON_COLS[table] || []) {
    if (out[col] !== null && out[col] !== undefined) {
      try { out[col] = JSON.parse(out[col]); } catch { /* keep the raw string */ }
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// D1
// --------------------------------------------------------------------------- //

export function d1Store(db) {
  const run = (sql, params = []) => db.prepare(sql).bind(...params).run();
  const all = async (sql, params = []) => (await db.prepare(sql).bind(...params).all()).results || [];
  const first = async (sql, params = []) => (await db.prepare(sql).bind(...params).first()) || null;

  return {
    engine: "d1",

    putForm: (f) => run(
      `INSERT INTO forms (form_id, version, schema_json, digest, created_at, active)
       VALUES (?,?,?,?,?,1)`, [f.form_id, f.version, f.schema_json, f.digest, f.created_at]),
    getFormRow: async (id, version) => parse(version
      ? await first(`SELECT * FROM forms WHERE form_id=? AND version=?`, [id, version])
      : await first(`SELECT * FROM forms WHERE form_id=? ORDER BY version DESC LIMIT 1`, [id]),
      "forms"),
    listForms: () => all(
      `SELECT form_id, MAX(version) AS version FROM forms GROUP BY form_id ORDER BY form_id`),

    putNotice: (n) => run(
      `INSERT INTO notices (notice_id, digest, version, text, purposes_json, created_at)
       VALUES (?,?,?,?,?,?)`,
      [n.notice_id, n.digest, n.version, n.text, n.purposes_json, n.created_at]),
    getNoticeByDigest: async (d) => parse(
      await first(`SELECT * FROM notices WHERE digest=?`, [d]), "notices"),
    getNotice: async (id) => parse(await first(`SELECT * FROM notices WHERE notice_id=?`, [id]),
      "notices"),

    appendConsent: (e) => run(
      `INSERT INTO consent_events (seq, subject_id, kind, notice_id, purposes_json,
        basis_json, context_json, at, prev, digest, mac)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [e.seq, e.subject_id, e.kind, e.notice_id, e.purposes_json, e.basis_json,
        e.context_json, e.at, e.prev, e.digest, e.mac]),
    lastConsent: async () => {
      const r = await first(
        `SELECT seq, digest FROM consent_events ORDER BY seq DESC LIMIT 1`);
      return r && r.seq ? { seq: r.seq, digest: r.digest } : null;
    },
    consentForSubject: async (s) => (await all(
      `SELECT * FROM consent_events WHERE subject_id=? ORDER BY seq`, [s]))
      .map((r) => parse(r, "consent")),
    allConsent: async () => (await all(`SELECT * FROM consent_events ORDER BY seq`))
      .map((r) => parse(r, "consent")),

    putSubmission: (s) => run(
      `INSERT INTO submissions (submission_id, form_id, form_version, form_digest,
        subject_id, notice_id, consent_seq, data_json, personal_json, click_ids_json,
        idempotency_key, created_at, retention_until, redacted_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
      [s.submission_id, s.form_id, s.form_version, s.form_digest, s.subject_id,
        s.notice_id, s.consent_seq, s.data_json, s.personal_json, s.click_ids_json,
        s.idempotency_key, s.created_at, s.retention_until]),
    getSubmission: async (id) => parse(
      await first(`SELECT * FROM submissions WHERE submission_id=?`, [id]), "submissions"),
    submissionsForSubject: async (s) => (await all(
      `SELECT * FROM submissions WHERE subject_id=? ORDER BY created_at`, [s]))
      .map((r) => parse(r, "submissions")),
    submissionsDue: async (at) => (await all(
      `SELECT submission_id FROM submissions WHERE retention_until<=? AND redacted_at IS NULL`,
      [at])),
    submissionsWithClicks: async () => (await all(
      `SELECT submission_id, click_ids_json FROM submissions
        WHERE click_ids_json NOT IN ('{}','') AND redacted_at IS NULL`))
      .map((r) => parse(r, "submissions")),
    redactSubmission: (id, at, { clearClicks = false } = {}) => run(
      `UPDATE submissions SET data_json=?, personal_json=?, click_ids_json=?, redacted_at=?
        WHERE submission_id=?`,
      [JSON.stringify({ redacted: true }), "{}", clearClicks ? "{}" : undefined, at, id]),
    clearClicks: (id) => run(`UPDATE submissions SET click_ids_json='{}' WHERE submission_id=?`,
      [id]),
    countSubmissions: async () => (await first(`SELECT COUNT(*) AS n FROM submissions`)).n,

    getIdem: async (formId, key) => first(
      `SELECT submission_id FROM idempotency WHERE form_id=? AND key=?`, [formId, key]),
    putIdem: (formId, key, id, at) => run(
      `INSERT INTO idempotency (form_id, key, submission_id, created_at) VALUES (?,?,?,?)`,
      [formId, key, id, at]),

    putDelivery: (d) => run(
      `INSERT INTO deliveries (delivery_id, submission_id, destination, kind, dedup_key,
        requires_json, status, reason, request_json, response_code, response_json,
        attempts, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [d.delivery_id, d.submission_id, d.destination, d.kind, d.dedup_key,
        d.requires_json, d.status, d.reason, d.request_json, d.response_code,
        d.response_json, d.attempts, d.created_at, d.updated_at]),
    deliveriesForSubmission: async (id) => (await all(
      `SELECT * FROM deliveries WHERE submission_id=? ORDER BY created_at`, [id]))
      .map((r) => parse(r, "deliveries")),
    countDeliveries: async () => (await first(`SELECT COUNT(*) AS n FROM deliveries`)).n,

    addAudit: (a) => run(
      `INSERT INTO audit_events (submission_id, subject_id, at, kind, detail_json)
       VALUES (?,?,?,?,?)`,
      [a.submission_id, a.subject_id, a.at, a.kind, a.detail_json]),
    auditForSubmission: async (id) => (await all(
      `SELECT * FROM audit_events WHERE submission_id=? ORDER BY id`, [id]))
      .map((r) => parse(r, "audit")),
    auditForSubject: async (id) => (await all(
      `SELECT * FROM audit_events WHERE subject_id=? ORDER BY id`, [id]))
      .map((r) => parse(r, "audit")),

    reset: async () => {
      for (const t of ["audit_events", "deliveries", "idempotency", "submissions",
        "consent_events", "notices", "forms"]) {
        await run(`DELETE FROM ${t}`);
      }
    },
  };
}

// --------------------------------------------------------------------------- //
// memory (tests)
// --------------------------------------------------------------------------- //

export function memoryStore() {
  const t = {
    forms: [], notices: [], consent_events: [], submissions: [],
    idempotency: [], deliveries: [], audit_events: [],
  };
  let auditId = 0;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  return {
    engine: "memory",
    putForm: async (f) => { t.forms.push(clone(f)); },
    getFormRow: async (id, version) => {
      const rows = t.forms.filter((f) => f.form_id === id)
        .sort((a, b) => a.version - b.version);
      if (!rows.length) return null;
      const row = version ? rows.find((r) => r.version === Number(version)) : rows.at(-1);
      return row ? clone(row) : null;
    },
    listForms: async () => {
      const seen = new Map();
      for (const f of t.forms) {
        seen.set(f.form_id, Math.max(seen.get(f.form_id) || 0, f.version));
      }
      return [...seen].map(([form_id, version]) => ({ form_id, version }))
        .sort((a, b) => a.form_id.localeCompare(b.form_id));
    },
    putNotice: async (n) => { t.notices.push(clone(n)); },
    getNoticeByDigest: async (d) => clone(t.notices.find((n) => n.digest === d) || null),
    getNotice: async (id) => clone(t.notices.find((n) => n.notice_id === id) || null),
    appendConsent: async (e) => { t.consent_events.push(clone(e)); },
    lastConsent: async () => {
      const rows = t.consent_events.slice().sort((a, b) => a.seq - b.seq);
      return rows.length ? { seq: rows.at(-1).seq, digest: rows.at(-1).digest } : null;
    },
    consentForSubject: async (s) =>
      t.consent_events.filter((e) => e.subject_id === s)
        .sort((a, b) => a.seq - b.seq).map(clone),
    allConsent: async () => t.consent_events.slice().sort((a, b) => a.seq - b.seq).map(clone),
    putSubmission: async (s) => { t.submissions.push(clone(s)); },
    getSubmission: async (id) => clone(t.submissions.find((s) => s.submission_id === id) || null),
    submissionsForSubject: async (s) =>
      t.submissions.filter((x) => x.subject_id === s).map(clone),
    submissionsDue: async (at) =>
      t.submissions.filter((s) => s.retention_until <= at && !s.redacted_at)
        .map((s) => ({ submission_id: s.submission_id })),
    submissionsWithClicks: async () =>
      t.submissions.filter((s) => s.click_ids_json && s.click_ids_json !== "{}" && !s.redacted_at)
        .map((s) => ({ submission_id: s.submission_id, click_ids_json: s.click_ids_json })),
    redactSubmission: async (id, at, { clearClicks = false } = {}) => {
      const s = t.submissions.find((x) => x.submission_id === id);
      if (!s) return;
      s.data_json = JSON.stringify({ redacted: true });
      s.personal_json = "{}";
      if (clearClicks) s.click_ids_json = "{}";
      s.redacted_at = at;
    },
    clearClicks: async (id) => {
      const s = t.submissions.find((x) => x.submission_id === id);
      if (s) s.click_ids_json = "{}";
    },
    countSubmissions: async () => t.submissions.length,
    getIdem: async (formId, key) =>
      clone(t.idempotency.find((i) => i.form_id === formId && i.key === key) || null),
    putIdem: async (formId, key, id, at) => {
      t.idempotency.push({ form_id: formId, key, submission_id: id, created_at: at });
    },
    putDelivery: async (d) => { t.deliveries.push(clone(d)); },
    deliveriesForSubmission: async (id) =>
      t.deliveries.filter((d) => d.submission_id === id).map(clone),
    countDeliveries: async () => t.deliveries.length,
    addAudit: async (a) => { t.audit_events.push({ id: ++auditId, ...clone(a) }); },
    auditForSubmission: async (id) =>
      t.audit_events.filter((a) => a.submission_id === id).map(clone),
    auditForSubject: async (id) =>
      t.audit_events.filter((a) => a.subject_id === id).map(clone),
    reset: async () => {
      for (const k of Object.keys(t)) t[k] = [];
    },
  };
}
