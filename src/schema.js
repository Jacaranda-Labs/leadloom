// Form definitions as data: the same validation the Python reference performs, so a form
// that is valid in one runtime is valid in the other and produces the same digest.

import { normalizeEmail, normalizePhone } from "./crypto.js";

export const FIELD_TYPES = new Set(["email", "phone", "text", "longtext", "number",
  "select", "multiselect", "checkbox", "date", "hidden"]);
export const ALWAYS_PERSONAL = new Set(["email", "phone"]);
export const VALID_BASIS = new Set(["consent", "contract", "legal_obligation",
  "legitimate_interests"]);

export class SchemaError extends Error {}

export function buildForm(payload) {
  const form = {
    form_id: payload.form_id,
    version: Number(payload.version),
    title: payload.title,
    path: payload.path || "/",
    retention_days: Number(payload.retention_days ?? 180),
    destinations: [...(payload.destinations || [])],
    purposes: (payload.purposes || []).map((p) => ({
      key: p.key, label: p.label, description: p.description,
      basis: p.basis || "consent", required: Boolean(p.required),
    })),
    fields: (payload.fields || []).map((f) => ({
      name: f.name, type: f.type, label: f.label || "",
      required: Boolean(f.required),
      personal: Boolean(f.personal) || ALWAYS_PERSONAL.has(f.type),
      purpose: f.purpose ?? null,
      max_length: f.max_length ?? null,
      pattern: f.pattern ?? null,
      options: [...(f.options || [])],
      help: f.help || "",
    })),
  };
  validateDefinition(form);
  return form;
}

export function validateDefinition(form) {
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(form.form_id || "")) {
    throw new SchemaError("form_id must be lowercase letters, digits and dashes");
  }
  if (!Number.isInteger(form.version) || form.version < 1) {
    throw new SchemaError("version must be a positive integer");
  }
  const names = new Set();
  for (const f of form.fields) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(f.name || "")) {
      throw new SchemaError(`bad field name ${f.name}`);
    }
    if (names.has(f.name)) throw new SchemaError(`duplicate field ${f.name}`);
    names.add(f.name);
    if (!FIELD_TYPES.has(f.type)) throw new SchemaError(`${f.name}: unknown type ${f.type}`);
    if ((f.type === "select" || f.type === "multiselect") && !f.options.length) {
      throw new SchemaError(`${f.name}: ${f.type} needs options`);
    }
    if (f.pattern) {
      try { new RegExp(f.pattern); } catch (e) {
        throw new SchemaError(`${f.name}: bad pattern: ${e.message}`);
      }
    }
    if (f.purpose && !form.purposes.some((p) => p.key === f.purpose)) {
      throw new SchemaError(`${f.name}: purpose ${f.purpose} is not declared`);
    }
  }
  const keys = new Set();
  for (const p of form.purposes) {
    if (keys.has(p.key)) throw new SchemaError(`duplicate purpose ${p.key}`);
    keys.add(p.key);
    if (!VALID_BASIS.has(p.basis)) throw new SchemaError(`purpose ${p.key}: bad basis ${p.basis}`);
    if (p.basis !== "consent" && !p.required) {
      // A purpose with a non-consent basis is either necessary for the service or it
      // should not be running under that basis. "Optional, but we do it anyway under
      // legitimate interests" is the pattern regulators fine.
      throw new SchemaError(`purpose ${p.key} has basis ${p.basis} but is marked optional; ` +
        `a purpose with a non-consent basis must be declared required, or it should be a ` +
        `consent purpose`);
    }
  }
  if (!form.destinations.length) {
    throw new SchemaError("a form with no destinations stores leads and tells nobody");
  }
  if (!(form.retention_days >= 1)) throw new SchemaError("retention_days must be positive");
  return form;
}

export function formAsDict(form) {
  return {
    form_id: form.form_id, version: form.version, title: form.title, path: form.path,
    retention_days: form.retention_days, destinations: [...form.destinations],
    purposes: form.purposes.map((p) => ({ key: p.key, label: p.label,
      description: p.description, basis: p.basis, required: p.required })),
    fields: form.fields.map((f) => ({ name: f.name, type: f.type, label: f.label,
      required: f.required, personal: f.personal, purpose: f.purpose,
      max_length: f.max_length, pattern: f.pattern, options: [...f.options], help: f.help })),
  };
}

export const personalFields = (form) => new Set(form.fields.filter((f) => f.personal)
  .map((f) => f.name));

export const purposeOf = (form, key) => form.purposes.find((p) => p.key === key) || null;

export function validateSubmission(form, data) {
  const errors = {};
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { cleaned: {}, errors: { _: "submission must be an object" } };
  }
  const known = new Set(form.fields.map((f) => f.name));
  for (const name of Object.keys(data)) {
    if (!known.has(name)) errors[name] = "unknown field: this form does not collect it";
  }
  const cleaned = {};
  for (const f of form.fields) {
    const raw = data[f.name];
    const present = raw !== null && raw !== undefined && raw !== "";
    if (!present) {
      if (f.required) errors[f.name] = "required";
      continue;
    }
    try {
      cleaned[f.name] = coerce(f, raw);
    } catch (e) {
      errors[f.name] = e.message;
    }
  }
  return { cleaned, errors };
}

function coerce(f, raw) {
  if (f.type === "email") {
    const v = normalizeEmail(String(raw));
    if (f.max_length && v.length > f.max_length) throw new Error("too long");
    return v;
  }
  if (f.type === "phone") return normalizePhone(String(raw));
  if (f.type === "number") {
    // An <input type="number"> gives us a *string*. Rejecting strings meant the field was
    // impossible to fill in from the form at all — a bug that only a real browser showed.
    const n = typeof raw === "number" ? raw : Number(String(raw).trim());
    if (!Number.isFinite(n)) throw new Error("must be a number");
    return n;
  }
  if (f.type === "checkbox") {
    if (typeof raw !== "boolean") throw new Error("must be true or false");
    return raw;
  }
  if (f.type === "select") {
    const v = String(raw).trim();
    if (!f.options.includes(v)) throw new Error("not one of: " + f.options.join(", "));
    return v;
  }
  if (f.type === "multiselect") {
    if (!Array.isArray(raw)) throw new Error("must be a list");
    const bad = raw.filter((v) => !f.options.includes(String(v).trim()));
    if (bad.length) throw new Error("not allowed: " + bad.join(", "));
    return raw.map((v) => String(v).trim());
  }
  if (f.type === "date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw))) {
      throw new Error("must be an ISO date (YYYY-MM-DD)");
    }
    return String(raw);
  }
  const v = String(raw);
  if (f.max_length !== null && v.length > f.max_length) throw new Error("too long");
  if (f.pattern && !new RegExp(`^(?:${f.pattern})$`).test(v)) {
    throw new Error("does not match the required format");
  }
  return v.trim();
}

/** The notice text, generated from the definition so it cannot drift from the purposes. */
export function noticeText(form) {
  const lines = [`${form.title} — privacy notice`, "",
    "We process the details you submit as follows:", ""];
  for (const p of form.purposes) {
    const basis = p.basis.replace(/_/g, " ");
    lines.push(`- ${p.label} (${p.required ? "required" : "optional"}, lawful basis: ${basis}). ` +
      p.description);
  }
  lines.push("", `Lead data is kept for ${form.retention_days} days from submission.`,
    "Click identifiers (for example a Google or Meta click id) are kept for a shorter " +
    "period, then deleted.",
    "You can withdraw consent at any time from the form, and it takes effect immediately " +
    "for anything not yet sent.",
    "Automated decision-making: none. Advertising platforms receive hashed identifiers " +
    "only, and only with your consent.");
  return lines.join("\n");
}
