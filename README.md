# leadloom-worker

Cloudflare-native lead intake for **Amarcco Leads & Marketing LLC**: a Workers + D1 port of
the Python `leadloom` reference, built so the client can run it without servers, and so the
consent evidence it produces is worth something in a complaint.

The point of this code is not "a form with a checkbox". It is that a lead is transmitted
**only** where a stored, versioned, tamper-evident consent record permits that specific
purpose — and that every non-transmission has a written reason.

---

## What it does

```
visitor → form (purpose checkboxes) → POST /submit
                │
                ├─ validate against the published form definition (unknown fields refused)
                ├─ publish/resolve the notice for that exact wording → notice_id
                ├─ append a MAC'd, hash-chained consent event
                ├─ store the submission under a retention date
                └─ for each destination: purpose gate → build → send | dry-run | block | skip
                                                   └─ audit event, either way
```

| Destination kind | Purpose it requires | Dedup handle |
| --- | --- | --- |
| `webhook` (client intake) | `service_delivery` (contract) | `submission_id` |
| `crm` | `service_delivery` | `submission_id` + `LEAD_MAP` |
| `meta` (Conversions API) | `advertising_measurement` (consent) | `event_id = lm_ + sha256(sub:id)[:32]` |
| `google` (click conversions) | `advertising_measurement` (consent) | `orderId = leadloom:<submission_id>` |
| `webhook` with `purposes:["resale"]` | `resale` (consent) **and** `ALLOW_LEAD_RESALE=true` | `submission_id` |

### Status vocabulary (never collapsed)

| status | meaning |
| --- | --- |
| `sent` | a real request left and was accepted |
| `not_sent` | dry-run: payload built, transport suppressed |
| `blocked` | the purpose gate refused; no request was built |
| `skipped` | permitted, but there was nothing to send (or no credential) |
| `failed` | we tried and the other side refused it (including a 200 whose body names an error) |

A blocked delivery carries no built request. A skipped one never claims to have been sent.

### The basis rule

`consent` basis ⇒ a `true` record must exist (absent is not permission). `contract`,
`legal_obligation`, `legitimate_interests` ⇒ no grant needed, but an explicit refusal is
honoured. A purpose not on the notice ⇒ always blocks, because nobody was told.

---

## Layout

```
src/worker.js        router: public form, /submit, /withdraw, /admin/*
src/pipeline.js      intake → gate → destinations → audit; purge, erasure
src/consent.js       notices, chained consent events, the basis rule, verification
src/schema.js        form definitions, validation, notice text generation
src/connectors.js    webhook / meta / google / crm
src/db.js            storage interface, implemented for D1 and for memory
src/crypto.js        canonical JSON, SHA-256/HMAC, normalisation, IP truncation
src/pages.js         the form page (single file, no external requests)
src/forms/amarcco.js the client's form definition — the client-specific substance
schema.sql           D1 schema (identical to the Python reference's shape)
tests/               47 tests; see "Tests" below
scripts/seed.mjs     register the client form with a running deployment
scripts/deploy-cf.mjs  deploy via the Cloudflare REST API
scripts/serve-local.mjs  run the Worker locally, over real SQLite
scripts/browser_check.py real-Chromium check of the rendered form
```

---

## Run it locally

```bash
node /home/user/leadloom-worker/scripts/serve-local.mjs     # http://0.0.0.0:8080
```

`wrangler dev` is the normal tool and `wrangler.toml` is included for it, but `npm install`
does not work in this build sandbox, so `serve-local.mjs` starts a small SQLite-over-HTTP
bridge (`tests/sqlite_bridge.py`) and calls the Worker's `fetch` handler directly. The Worker
code is unchanged and unaware; D1 *is* SQLite, so the SQL is real.

## Deploy

```bash
export CLOUDFLARE_API_TOKEN=...        # Workers Scripts:Edit, D1:Edit
export CLOUDFLARE_ACCOUNT_ID=...
export LEADLOOM_CONSENT_KEY=$(openssl rand -hex 32)
export LEADLOOM_ADMIN_TOKEN=$(openssl rand -hex 24)
node scripts/deploy-cf.mjs
```

It creates the D1 database, applies `schema.sql`, uploads the Worker as an ES-module bundle,
sets the bindings (the two secrets as encrypted `secret_text`), enables the `workers.dev`
route, seeds the client form, and verifies `/healthz`, `/` and `/admin/health` over HTTPS.
It prints no secret value and refuses to run if a required variable is missing.

**Keep `LEADLOOM_CONSENT_KEY`.** It is what makes the consent log tamper-evident: without
it the chain cannot be verified, and a lost key means the evidence for existing leads
degrades to "a chain nobody can check".

## Tests

```bash
node --test tests/                                   # 47 tests
LD_LIBRARY_PATH=/home/user/pwlibs/root/usr/lib/x86_64-linux-gnu \
  python3 scripts/browser_check.py http://127.0.0.1:8080   # 19 browser checks
```

- `core.test.mjs` — schema refusals, chain tampering, the gate, dedup, retention, erasure,
  and a live-transport run against a stubbed `fetch`.
- `worker.test.mjs` — the real `fetch` handler end-to-end against **real SQLite**: routing,
  401s, cross-origin refusal, idempotency, withdrawal, purge, erasure.
- `parity.test.mjs` — shells out to the Python reference and asserts **byte-identical**
  canonical JSON, consent digests, Meta `event_id`s, identifier normalisation and refusals.
  This is the test that stops the two implementations drifting apart.
- `amarcco.test.mjs` — the shipped client form: every vertical, the required contact
  consent, and the "optional purposes declined" path.
- `browser_check.py` — real Chromium: no pre-ticked boxes, the contract purpose is not a
  fake opt-out, refusal is refused, the receipt never claims a send, nothing loads from
  outside the page.

---

## Compliance position (read this before going live)

This is built for a **US consumer finance lead seller that operates from India**. That
changes what the obligations are, and a GDPR-shaped design would have been the wrong one.

1. **Contact consent is separate and required.** TCPA (and analogous state statutes) require
   prior express written consent for autodialled/prerecorded calls and texts, and the
   consent must not be bundled into "we will provide the service". `contact_consent` is its
   own purpose with its own checkbox.
2. **Resale is its own purpose, off by default.** Selling or sharing a lead is a *sale* of
   personal information under CPRA and several other state laws, which brings disclosure,
   an opt-out right, and (for consumers under 16, or in some states) opt-in. `ALLOW_LEAD_RESALE`
   defaults to `false`; the `resale` purpose is unchecked; a `resale` destination is blocked
   with `customer_data_sharing_not_enabled` unless an operator turns it on deliberately.
3. **Financial data.** Mortgage, debt and insurance enquiries touch GLBA-adjacent data and
   state financial-privacy rules. No account numbers, SSNs or card numbers are collected by
   this form, and add none without a legal review.
4. **India DPDP Act 2023** applies to the processing done in India: notice, purpose
   limitation, erasure on withdrawal, and (from the rules in force) breach notification.
   `/admin/erase` and the retention sweep are the mechanisms; they are exercised by tests.
5. **Retention is enforced, not aspirational.** 180 days by default, then personal data is
   destroyed and replaced with `{redacted: true}`; click identifiers go at 30 days. The audit
   trail of *what happened* survives, without the person in it.
6. **Not claimed:** no EU/UK targeting, so the notice does not claim GDPR. If the client
   starts taking EU traffic, that is a new notice, not a text edit.

### What this deployment does *not* prove

- **No Meta or Google credentials were supplied**, so `LEADLOOM_TRANSPORT=dry-run` and no
  conversion has ever actually reached either platform. The payloads, hashing and dedup ids
  are built and inspected by tests; delivery is unproven until credentials exist.
- **No CRM field map** (`LEAD_MAP`) was supplied, so the CRM connector reports `skipped`.
- **Data-broker registration and buyer disclosure** (state licensing regimes, and whether
  Amarcco must register as a data broker where it sells leads) is a legal question this
  repository cannot answer, and it is load-bearing for the `resale` purpose.
- The Python reference's Postgres DDL path is still unexecuted (no Postgres in the sandbox);
  the D1 schema *is* executed, against real SQLite, by `worker.test.mjs`.
