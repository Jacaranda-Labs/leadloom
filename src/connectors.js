// Destinations. Every connector answers one question the same way: given a submission,
// what would I send, to whom, and does the consent gate allow it?
//
// Nothing here ever guesses a credential. If a connector has no credential it reports
// `configured: false` and the pipeline records `not_sent` — it does not pretend.

import { hashIdentifier, sha256Hex, nowIso } from "./crypto.js";

export const REASONS = {
  OK: "ok",
  NO_CREDENTIAL: "no_credential",
  DRY_RUN: "dry_run",
  BLOCKED: "blocked_by_purpose_gate",
  NOTHING_TO_SEND: "nothing_to_send",
  CUSTOMER_DATA_SHARING: "customer_data_sharing_not_enabled",
};

/** Status vocabulary. These five are not interchangeable and never collapse into "ok". */
export const STATUS = {
  SENT: "sent",              // a real request left the building and was accepted
  NOT_SENT: "not_sent",      // dry-run: payload built, transport suppressed
  BLOCKED: "blocked",        // the purpose gate refused; nothing was built
  SKIPPED: "skipped",        // permitted, but there was nothing to send
  FAILED: "failed",          // we tried and the other side did not accept it
};

const pick = (data, names) => {
  const out = {};
  for (const n of names) if (data[n] !== undefined && data[n] !== "") out[n] = data[n];
  return out;
};

// --------------------------------------------------------------------------- //
// webhook
// --------------------------------------------------------------------------- //

export const webhook = {
  kind: "webhook",
  defaultPurposes: ["service_delivery"],
  configured: (env) => Boolean(env.WEBHOOK_URL),
  requires: () => ["service_delivery"],
  async build({ submission, data, form, env }) {
    if (!env.WEBHOOK_URL) return { skip: REASONS.NO_CREDENTIAL };
    return {
      url: env.WEBHOOK_URL,
      body: {
        leadloom: { version: 1, form_id: form.form_id, form_version: form.version,
          submission_id: submission.submission_id, received_at: submission.created_at },
        lead: data,
        personal_fields: [...new Set(form.fields.filter((f) => f.personal).map((f) => f.name))],
      },
      headers: { "content-type": "application/json",
        "x-leadloom-signature": "hmac-sha256 (see server)" },
    };
  },
  dedupKey: ({ submission }) => `webhook:${submission.submission_id}`,
};

// --------------------------------------------------------------------------- //
// Meta (Conversions API)
// --------------------------------------------------------------------------- //

export const meta = {
  kind: "meta",
  defaultPurposes: ["advertising_measurement"],
  configured: (env) => Boolean(env.META_PIXEL_ID && env.META_ACCESS_TOKEN),
  requires: () => ["advertising_measurement"],
  async build({ submission, data, env }) {
    if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) return { skip: REASONS.NO_CREDENTIAL };
    // Meta wants bare SHA-256 of the normalised value: no salt, no pepper. A salt here
    // would defeat the whole point, since Meta has the same list and must compute the
    // same digest. The normalisation rule is carried alongside for the audit record.
    const opts = { defaultCountry: env.DEFAULT_COUNTRY || "US" };
    const user = {};
    if (data.email) {
      const h = await hashIdentifier("email", data.email, opts);
      user.em = [h.sha256];
      user.country = [(await hashIdentifier("country", "us", opts)).sha256];
    }
    if (data.phone) user.ph = [(await hashIdentifier("phone", data.phone, opts)).sha256];
    return {
      url: `https://graph.facebook.com/v21.0/${env.META_PIXEL_ID}/events`,
      body: {
        data: [{
          // Deterministic, so a retry is deduplicated by Meta rather than double-counted.
          // Matches the Python reference exactly: "lm_" + first 32 hex of
          // sha256(submission_id + ":" + event_name). WebCrypto only has async SHA-256,
          // which is why `build` is async; nothing else here needs it.
          event_id: "lm_" + (await sha256Hex(`${submission.submission_id}:Lead`)).slice(0, 32),
          event_name: "Lead",
          event_time: Math.floor(Date.parse(submission.created_at) / 1000),
          action_source: "website",
          user_data: user,
          custom_data: pick(data, ["vertical", "loan_amount", "credit_band"]),
        }],
        access_token: "<redacted>",
      },
      headers: { "content-type": "application/json" },
      redact: ["access_token"],
    };
  },
  dedupKey: ({ submission }) => `meta:Lead:${submission.submission_id}`,
};

// --------------------------------------------------------------------------- //
// Google Ads (enhanced conversions)
// --------------------------------------------------------------------------- //

export const google = {
  kind: "google",
  defaultPurposes: ["advertising_measurement"],
  configured: (env) => Boolean(env.GOOGLE_CUSTOMER_ID &&
    env.GOOGLE_CONVERSION_ACTION_ID && env.GOOGLE_DEVELOPER_TOKEN),
  requires: () => ["advertising_measurement"],
  async build({ submission, data, env, clickIds }) {
    if (!env.GOOGLE_CUSTOMER_ID || !env.GOOGLE_CONVERSION_ACTION_ID ||
        !env.GOOGLE_DEVELOPER_TOKEN) return { skip: REASONS.NO_CREDENTIAL };
    if (!clickIds.gclid) return { skip: REASONS.NOTHING_TO_SEND };
    const opts = { defaultCountry: env.DEFAULT_COUNTRY || "US" };
    const user = {};
    if (data.email) user.hashed_email =
      (await hashIdentifier("email", data.email, opts)).sha256;
    if (data.phone) user.hashed_phone_number =
      (await hashIdentifier("phone", data.phone, opts)).sha256;
    return {
      url: `https://googleads.googleapis.com/v18/customers/${env.GOOGLE_CUSTOMER_ID}:uploadClickConversions`,
      body: {
        conversions: [{
          // The order id is the dedup handle: Google ignores a repeat of the same id.
          orderId: `leadloom:${submission.submission_id}`,
          conversionAction: `customers/${env.GOOGLE_CUSTOMER_ID}/conversionActions/${env.GOOGLE_CONVERSION_ACTION_ID}`,
          conversionDateTime: submission.created_at.replace("T", " ").replace("Z", "+00:00"),
          gclid: clickIds.gclid,
          userIdentifiers: [user],
        }],
        partialFailure: true,
      },
      headers: { "content-type": "application/json", "developer-token": "<redacted>" },
      redact: ["developer-token"],
    };
  },
  dedupKey: ({ submission }) => `google:${submission.submission_id}`,
};

// --------------------------------------------------------------------------- //
// CRM (generic, so one implementation serves several)
// --------------------------------------------------------------------------- //

export const crm = {
  kind: "crm",
  defaultPurposes: ["service_delivery", "crm"],
  configured: (env) => Boolean(env.CRM_WEBHOOK_URL),
  requires: () => ["service_delivery"],
  /** Client-specific mapping lives in config, not code: LEAD_MAP is JSON like
   *  {"email":"Email","phone":"Phone","vertical":"Vertical"}. Unmapped fields are dropped
   *  rather than guessed — a CRM import that puts a lead's name in the "company" column
   *  is worse than one that refuses. */
  async build({ submission, data, env, form }) {
    if (!env.CRM_WEBHOOK_URL) return { skip: REASONS.NO_CREDENTIAL };
    let map = {};
    try { map = JSON.parse(env.LEAD_MAP || "{}"); } catch { map = {}; }
    const mapped = {};
    for (const [k, v] of Object.entries(map)) if (data[k] !== undefined) mapped[v] = data[k];
    if (!Object.keys(mapped).length) return { skip: REASONS.NOTHING_TO_SEND };
    return {
      url: env.CRM_WEBHOOK_URL,
      body: { ...mapped, leadloom_submission_id: submission.submission_id,
        leadloom_form: `${form.form_id}@${form.version}` },
      headers: { "content-type": "application/json" },
    };
  },
  dedupKey: ({ submission }) => `crm:${submission.submission_id}`,
};

export const CONNECTORS = { webhook, meta, google, crm };

export function connectorFor(kind) {
  const c = CONNECTORS[kind];
  if (!c) throw new Error(`unknown destination kind ${kind}`);
  return c;
}
