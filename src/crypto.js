// Canonical form, hashing, HMAC and PII normalisation — the exact rules the Python
// reference implementation uses, so a record produced on either runtime digests the same.
//
// Everything here is async because the Workers runtime exposes hashing only through
// WebCrypto (`crypto.subtle`), which is promise-based. That is a real constraint, not a
// style choice: `crypto.subtle` has no SHA-1, which is why `eventId` is SHA-256-derived
// rather than a uuid5 (see below).

const encoder = new TextEncoder();

/** Deterministic JSON: sorted keys, no whitespace, integers only.
 *
 * Floats are refused for the same reason as in the Python build: 0.1 does not serialise
 * identically everywhere, and a digest that depends on the host is not evidence.
 */
export function canonical(value, path = "") {
  if (typeof value === "number" && !Number.isInteger(value)) {
    throw new TypeError(
      `float at ${path || "<root>"}: canonical form is integers only (use minor units). ` +
      `Got ${value}`);
  }
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map((v, i) => canonical(v, `${path}[${i}]`)).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const v = value[key];
      if (v === undefined) continue;
      parts.push(JSON.stringify(key) + ":" + canonical(v, path ? `${path}.${key}` : key));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new TypeError(`cannot canonicalise ${typeof value} at ${path}`);
}

export function sha256Hex(text) {
  return crypto.subtle.digest("SHA-256", encoder.encode(text)).then((buf) =>
    [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

export async function digest(value) {
  return sha256Hex(canonical(value));
}

/**
 * HMAC-SHA256, hex. Used for the consent chain and for outbound webhook signatures.
 *
 * `key` may be a string (an env var, which is the normal case) or bytes. Strings are
 * UTF-8 encoded here rather than at every call site: a key that only works when the caller
 * remembered to encode it is a key that eventually breaks in production and passes in tests.
 */
export async function hmacHex(key, data) {
  const raw = typeof key === "string" ? encoder.encode(key) : key;
  const k = await crypto.subtle.importKey(
    "raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", k, encoder.encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison. A timing side channel on a signature check is a real bug. */
export function timingSafeEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let out = 0;
  for (let i = 0; i < left.length; i += 1) out |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return out === 0;
}

/**
 * Random hex. Deliberately *not* `newId(prefix, n)`: an earlier version took a prefix and
 * the call site `newId(10)` silently produced ids like `sub_10_ab12…`, which then failed
 * the `^sub_[a-z0-9]+$` guard on the withdrawal endpoint. Callers now concatenate their own
 * prefix, so there is no second positional argument to get wrong.
 */
export function newId(nbytes = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(nbytes));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function bytesToHex(bytes) {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// --------------------------------------------------------------------------- //
// PII normalisation
// --------------------------------------------------------------------------- //

//: ISO-3166 alpha-2 -> dialling code. An unknown country is an error, never a guess:
//: the wrong country code hashes the wrong identifier, and the match silently fails.
export const DIAL_CODES = {
  GB: "44", UK: "44", IE: "353", US: "1", CA: "1", ZW: "263", ZA: "27", NG: "234",
  KE: "254", GH: "233", EG: "20", MA: "212", TZ: "255", UG: "256", ZM: "260",
  BW: "267", MW: "265", MZ: "258", NA: "264", AO: "244", IN: "91", PK: "92",
  BD: "880", LK: "94", NP: "977", AE: "971", SA: "966", QA: "974", KW: "965",
  BH: "973", OM: "968", IL: "972", TR: "90", DE: "49", FR: "33", NL: "31",
  BE: "32", ES: "34", PT: "351", IT: "39", CH: "41", AT: "43", SE: "46",
  NO: "47", DK: "45", FI: "358", PL: "48", CZ: "420", RO: "40", GR: "30",
  HU: "36", AU: "61", NZ: "64", SG: "65", MY: "60", ID: "62", TH: "66",
  VN: "84", PH: "63", JP: "81", KR: "82", CN: "86", HK: "852", TW: "886",
  BR: "55", MX: "52", AR: "54", CL: "56", CO: "57", PE: "51", RU: "7",
  UA: "380", IS: "354",
};

export class PIIError extends Error {}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_RE = /^\+?[0-9][0-9\s\-().]{5,}$/;

export function normalizeEmail(value, { stripGmailDots = false } = {}) {
  const email = String(value ?? "").normalize("NFKC").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new PIIError(`not an email address: ${value}`);
  if (stripGmailDots && /@(gmail|googlemail)\.com$/.test(email)) {
    const [local, domain] = email.split("@");
    return `${local.split("+")[0].replace(/\./g, "")}@${domain}`;
  }
  return email;
}

export function dialCode(country) {
  const value = String(country).trim().toUpperCase();
  if (/^\d+$/.test(value)) return value;
  if (DIAL_CODES[value]) return DIAL_CODES[value];
  throw new PIIError(`unknown default_country ${country}: use an ISO-3166 alpha-2 code ` +
    `from DIAL_CODES or the dialling digits`);
}

export function normalizePhone(value, { defaultCountry = null } = {}) {
  const raw = String(value ?? "").normalize("NFKC").trim();
  if (!PHONE_RE.test(raw)) throw new PIIError(`not a phone number: ${value}`);
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+")) return digits;
  if (defaultCountry) return dialCode(defaultCountry) + digits.replace(/^0+/, "");
  throw new PIIError(
    `phone number has no country code and no default_country is configured: ${value}. ` +
    `Guessing the country would silently hash the wrong identifier.`);
}

/** Hash one identifier for ad-platform matching, keeping the rule that produced it. */
export async function hashIdentifier(kind, value, opts = {}) {
  let normalised;
  let rule;
  if (kind === "email") {
    normalised = normalizeEmail(value, opts);
    rule = opts.stripGmailDots ? "trim+lowercase+gmail-dot-strip" : "trim+lowercase";
  } else if (kind === "phone") {
    normalised = normalizePhone(value, opts);
    rule = opts.defaultCountry ? `digits-only+default-country-${opts.defaultCountry}`
      : "digits-only+e164";
  } else if (["first_name", "last_name", "city", "zip", "country", "external_id"]
    .includes(kind)) {
    normalised = String(value ?? "").normalize("NFKC").trim().toLowerCase()
      .replace(/\s+/g, " ");
    if (!normalised) throw new PIIError(`empty ${kind}`);
    rule = "trim+lowercase+collapse-space";
  } else {
    throw new PIIError(`unknown identifier kind ${kind}`);
  }
  return { kind, sha256: await sha256Hex(normalised), normalisation: rule };
}

/** Keep a network prefix, not the address (GDPR/DPDP minimisation). */
export function truncateIp(ip) {
  if (!ip) return null;
  const value = String(ip).trim();
  if (value.includes(":")) return value.split(":").slice(0, 3).join(":") + "::/48";
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  return parts.slice(0, 3).join(".") + ".0";
}

/** UTC ISO-8601, second precision. Local time in an audit trail is unfalsifiable. */
export function nowIso(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** `plusDays(isoOrDate, n)` — same argument order as the call sites that read as English:
 *  "this timestamp, plus n days". Accepts an ISO string because that is what we store. */
export function plusDays(from, days) {
  const d = new Date(from instanceof Date ? from.getTime() : from);
  if (Number.isNaN(d.getTime())) throw new PIIError(`plusDays: not a date: ${from}`);
  d.setUTCDate(d.getUTCDate() + Number(days));
  return nowIso(d);
}
