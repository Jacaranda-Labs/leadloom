#!/usr/bin/env node
// Register the client form with a running deployment, through the same admin API an
// operator uses. Idempotent enough for a re-run: re-registering the same version is a
// conflict, which the script reports rather than swallowing.
import { amarccoLead } from "../src/forms/amarcco.js";

const base = (process.env.LEADLOOM_URL || "").replace(/\/$/, "");
const token = process.env.LEADLOOM_ADMIN_TOKEN || "";

if (!base) {
  console.error("set LEADLOOM_URL, e.g. https://leadloom-amarcco.<subdomain>.workers.dev");
  process.exit(2);
}
if (!token) {
  console.error("set LEADLOOM_ADMIN_TOKEN");
  process.exit(2);
}

const res = await fetch(`${base}/admin/forms`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify(amarccoLead),
});
const body = await res.json();
console.log(res.status, JSON.stringify(body, null, 2));
process.exit(res.ok ? 0 : 1);
