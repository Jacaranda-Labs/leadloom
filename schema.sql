-- LeadLoom (Cloudflare D1). SQLite dialect, which D1 speaks exactly.
--
-- Same shape as the Python reference implementation. Identifiers are TEXT, timestamps are
-- ISO-8601 UTC strings, and there is no AUTOINCREMENT where the application can assign the
-- value — so the DDL is portable and the audit trail cannot be renumbered by a migration.

CREATE TABLE IF NOT EXISTS forms (
  form_id     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  schema_json TEXT NOT NULL,
  digest      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (form_id, version)
);

CREATE TABLE IF NOT EXISTS notices (
  notice_id     TEXT PRIMARY KEY,
  digest        TEXT NOT NULL,
  version       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  purposes_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consent_events (
  seq           INTEGER PRIMARY KEY,
  subject_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  notice_id     TEXT,
  purposes_json TEXT NOT NULL,
  basis_json    TEXT NOT NULL,
  context_json  TEXT NOT NULL,
  at            TEXT NOT NULL,
  prev          TEXT NOT NULL,
  digest        TEXT NOT NULL,
  mac           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS submissions (
  submission_id   TEXT PRIMARY KEY,
  form_id         TEXT NOT NULL,
  form_version    INTEGER NOT NULL,
  form_digest     TEXT NOT NULL,
  subject_id      TEXT NOT NULL,
  notice_id       TEXT,
  consent_seq     INTEGER,
  data_json       TEXT NOT NULL,
  personal_json   TEXT NOT NULL,
  click_ids_json  TEXT NOT NULL,
  idempotency_key TEXT,
  created_at      TEXT NOT NULL,
  retention_until TEXT,
  redacted_at     TEXT
);

CREATE TABLE IF NOT EXISTS idempotency (
  form_id       TEXT NOT NULL,
  key           TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (form_id, key)
);

CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id   TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  destination   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  dedup_key     TEXT NOT NULL,
  requires_json TEXT NOT NULL,
  status        TEXT NOT NULL,
  reason        TEXT,
  request_json  TEXT NOT NULL,
  response_code INTEGER,
  response_json TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id TEXT,
  subject_id    TEXT,
  at            TEXT NOT NULL,
  kind          TEXT NOT NULL,
  detail_json   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_consent_subject ON consent_events(subject_id, seq);
CREATE INDEX IF NOT EXISTS idx_subs_subject ON submissions(subject_id);
CREATE INDEX IF NOT EXISTS idx_subs_retention ON submissions(retention_until);
CREATE INDEX IF NOT EXISTS idx_delivery_sub ON deliveries(submission_id);
CREATE INDEX IF NOT EXISTS idx_audit_sub ON audit_events(submission_id, id);
