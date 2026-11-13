// The Worker. Two audiences: the public form, and operators holding the admin token.
// Everything under /admin requires the token; nothing under /admin is guessable-only.

import { d1Store } from "./db.js";
import { buildForm, SchemaError } from "./schema.js";
import { publishNotice, currentState, verifyConsentChain, withdrawAll, ConsentError }
  from "./consent.js";
import { eraseSubject, IntakeError, purge, registerForm, submit, loadForm, CLICK_ID_FIELDS }
  from "./pipeline.js";
import { formPage, errorPage } from "./pages.js";
import { timingSafeEqual, sha256Hex, nowIso } from "./crypto.js";

const json = (body, status = 200, headers = {}) => new Response(
  JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store", ...headers } });

const fail = (code, message, status = 400, extra = {}) =>
  json({ error: message, code, ...extra }, status);

const baseHeaders = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "SAMEORIGIN",
  "permissions-policy": "geolocation=(), microphone=(), camera=()",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const store = d1Store(env.DB);
    const key = env.LEADLOOM_CONSENT_KEY;
    if (!key || key.length < 32) {
      return fail("misconfigured", "LEADLOOM_CONSENT_KEY missing or too short", 500);
    }

    // Cheap bot/CSRF posture: same-origin form posts only, and a body size ceiling.
    const isAdmin = url.pathname.startsWith("/admin");
    const sameOrigin = request.headers.get("origin");
    if (request.method === "POST" && sameOrigin && !isAllowedOrigin(sameOrigin, url, env)) {
      return fail("bad_origin", "cross-origin submissions are refused", 403);
    }

    try {
      const route = match(url.pathname);
      if (!route) return html(errorPage(404, "No such page."), 404);

      if (route.name === "home" && request.method === "GET") {
        const { form } = await loadForm(store, env.LEADLOOM_FORM_ID || "amarcco-lead");
        const notice = await publishNotice(store, form);
        return html(formPage({ form, notice, env, transport: transport(env) }));
      }

      if (route.name === "health") {
        return json({ ok: true, store: store.engine, transport: transport(env),
          form_id: env.LEADLOOM_FORM_ID || "amarcco-lead", at: nowIso() });
      }

      if (route.name === "submit" && request.method === "POST") {
        let payload;
        try { payload = await request.json(); } catch {
          return fail("bad_json", "body must be JSON");
        }
        if (JSON.stringify(payload).length > 32_000) {
          return fail("too_large", "submission too large", 413);
        }
        const { form } = await loadForm(store, payload.form_id || env.LEADLOOM_FORM_ID ||
          "amarcco-lead");
        const clickIds = {};
        for (const k of CLICK_ID_FIELDS) {
          const v = payload.click_ids && payload.click_ids[k];
          if (v) clickIds[k] = String(v).slice(0, 512);
        }
        const res = await submit(store, key, {
          formId: form.form_id,
          formVersion: payload.form_version,
          data: payload.data || {},
          consent: payload.consent || {},
          clickIds,
          transport: transport(env),
          idempotencyKey: request.headers.get("idempotency-key"),
          allowResale: env.ALLOW_LEAD_RESALE === "true",
          env,
          context: {
            ip: request.headers.get("cf-connecting-ip"),
            userAgent: request.headers.get("user-agent"),
            extra: { colo: request.cf && request.cf.colo, country: request.cf && request.cf.country },
          },
        });
        return json({
          submission_id: res.submission.submission_id,
          received_at: res.submission.created_at,
          replayed: res.replayed,
          notice_id: res.submission.notice_id,
          consent_seq: res.submission.consent_seq,
          retention_until: res.submission.retention_until,
          deliveries: res.deliveries.map((d) => ({
            destination: d.destination, kind: d.kind, status: d.status, reason: d.reason,
          })),
        }, 201);
      }

      if (route.name === "withdraw" && request.method === "POST") {
        let payload = {};
        try { payload = await request.json(); } catch { /* empty body is fine */ }
        const submissionId = String(payload.submission_id || "").trim();
        if (!/^sub_[a-z0-9]+$/.test(submissionId)) {
          return fail("bad_reference", "submission_id must look like sub_…");
        }
        const sub = await store.getSubmission(submissionId);
        if (!sub) return fail("unknown_submission", "no such submission", 404);
        const ev = await withdrawAll(store, key, sub.subject_id, {
          context: { via: "withdrawal_endpoint", submission_id: submissionId },
        });
        return json({ withdrawn: true, subject_id: sub.subject_id, consent_seq: ev.seq,
          effect: "no further sending for this subject" });
      }

      // ---------------------------------------------------------------- admin --
      if (isAdmin) {
        const denied = await requireAdmin(env, request);
        if (denied) return denied;
        return await adminRoute(route, request, env, store, key, url);
      }

      return html(errorPage(404, "No such page."), 404);
    } catch (e) {
      if (e instanceof IntakeError) {
        return json({ error: e.message, code: e.code, details: e.details || {} }, e.status);
      }
      if (e instanceof SchemaError || e instanceof ConsentError) {
        return fail(e.code || "invalid", e.message, 422);
      }
      // Fail loudly. A 500 with a log line beats a 200 that lost a lead.
      console.error("unhandled", e && e.stack || e);
      return fail("internal_error", "internal error; nothing was sent", 500);
    }
  },
};

const asObject = (v) => {
  if (v === null || v === undefined) return {};
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return {}; }
};

const transport = (env) => (env.LEADLOOM_TRANSPORT === "live" ? "live" : "dry-run");
const html = (body, status = 200) => new Response(body, { status,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
    ...baseHeaders } });

function isAllowedOrigin(origin, url, env) {
  if (origin === url.origin) return true;
  const extra = (env.LEADLOOM_EXTRA_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return extra.includes(origin);
}

function match(pathname) {
  const p = pathname.replace(/\/+$/, "") || "/";
  if (p === "/" || p === "/form") return { name: "home" };
  if (p === "/healthz") return { name: "health" };
  if (p === "/submit") return { name: "submit" };
  if (p === "/withdraw") return { name: "withdraw" };
  if (p === "/admin") return { name: "admin", rest: "" };
  const m = p.match(/^\/admin\/([a-z]*)$/);
  if (m) return { name: "admin", rest: m[1] };
  return null;
}

async function requireAdmin(env, request) {
  const token = env.LEADLOOM_ADMIN_TOKEN;
  if (!token) return fail("admin_disabled", "no admin token configured", 403);
  const presented = ((request && request.headers.get("authorization")) || "")
    .replace(/^Bearer\s+/i, "");
  if (!presented || !await timingSafeEqual(presented, token)) {
    return fail("unauthorized", "admin token required", 401);
  }
  return null;
}

async function adminRoute(route, request, env, store, key, url) {
  const rest = route.rest || "";
  const method = request.method;

  if (rest === "health" || rest === "") {
    const chain = await verifyConsentChain(store, key);
    return json({
      store: store.engine, transport: transport(env),
      form_id: env.LEADLOOM_FORM_ID || "amarcco-lead",
      submissions: await store.countSubmissions(),
      deliveries: await store.countDeliveries(),
      consent_chain: chain,
      connectors: {
        webhook: Boolean(env.WEBHOOK_URL),
        meta: Boolean(env.META_PIXEL_ID && env.META_ACCESS_TOKEN),
        google: Boolean(env.GOOGLE_CUSTOMER_ID && env.GOOGLE_DEVELOPER_TOKEN),
        crm: Boolean(env.CRM_WEBHOOK_URL),
      },
      lead_resale_enabled: env.ALLOW_LEAD_RESALE === "true",
    });
  }

  if (rest === "forms" && method === "GET") {
    return json({ forms: await store.listForms() });
  }

  if (rest === "forms" && method === "POST") {
    const def = await request.json();
    const form = buildForm(def);
    const reg = await registerForm(store, form);
    const notice = await publishNotice(store, form);
    return json({ form_id: form.form_id, version: form.version, digest: reg.digest,
      notice_id: notice.notice_id, notice_digest: notice.digest }, 201);
  }

  if (rest === "forms/get" && method === "GET") {
    const id = url.searchParams.get("form_id") || env.LEADLOOM_FORM_ID || "amarcco-lead";
    const { form, digest, version } = await loadForm(store, id,
      url.searchParams.get("version"));
    return json({ form, digest, version });
  }

  if (rest === "submissions" && method === "GET") {
    const id = url.searchParams.get("submission_id");
    if (!id) return fail("bad_request", "submission_id required");
    const sub = await store.getSubmission(id);
    if (!sub) return fail("unknown_submission", "no such submission", 404);
    const consent = await store.consentForSubject(sub.subject_id);
    // `d1Store` returns JSON columns already parsed while `memoryStore` returns the raw
    // strings; a helper here means the route works with both instead of only the one the
    // tests happened to use.
    const count = (v) => Object.keys(asObject(v)).length;
    return json({
      submission: { ...sub, data_json: undefined, personal_json: undefined,
        click_ids_json: undefined,
        fields: count(sub.data_json),
        has_personal: count(sub.personal_json) > 0,
        has_click_ids: count(sub.click_ids_json) > 0 },
      deliveries: await store.deliveriesForSubmission(id),
      audit: await store.auditForSubmission(id),
      consent: consent.map((e) => ({ seq: e.seq, kind: e.kind, at: e.at,
        digest: e.digest, purposes: e.purposes_json })),
    });
  }

  if (rest === "consent" && method === "GET") {
    const id = url.searchParams.get("subject_id");
    if (!id) return fail("bad_request", "subject_id required");
    const events = await store.consentForSubject(id);
    if (!events.length) return fail("unknown_subject", "no consent events", 404);
    return json({ subject_id: id, state: currentState(events).purposes,
      events: events.map((e) => ({ seq: e.seq, kind: e.kind, at: e.at, digest: e.digest })) });
  }

  if (rest === "verify" && method === "GET") {
    const chain = await verifyConsentChain(store, key);
    return json(chain, chain.ok ? 200 : 409);
  }

  if (rest === "purge" && method === "POST") {
    const at = url.searchParams.get("at") || nowIso();
    return json(await purge(store, { at }));
  }

  if (rest === "erase" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    return json(await eraseSubject(store, body.subject_id,
      { reason: body.reason || "erasure_request" }));
  }

  if (rest === "digest" && method === "POST") {
    // reproducibility check used by the parity tests: same input, same digest, both runtimes
    const body = await request.json();
    return json({ digest: await sha256Hex(JSON.stringify(body)) });
  }

  return fail("not_found", `no admin route ${rest}`, 404);
}
