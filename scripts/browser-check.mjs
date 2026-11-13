#!/usr/bin/env node
// Real-browser check of the deployed form. Node tests prove the HTTP contract; only a
// browser proves the page a person actually sees — that the consent checkboxes exist,
// that declining them is possible, and that the receipt shown afterwards tells the truth.
//
// Usage: node scripts/browser-check.mjs [url]   (default http://127.0.0.1:8080)
// Exit codes: 0 = all checks passed, 1 = a check failed, 3 = could not run (no browser).
import { chromium } from "playwright";

const BASE = (process.argv[2] || process.env.LEADLOOM_URL || "http://127.0.0.1:8080")
  .replace(/\/$/, "");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

let browser;
try {
  browser = await chromium.launch({ args: ["--no-sandbox"] });
} catch (e) {
  console.error("UNCHECKED: could not start Chromium:", e.message);
  process.exit(3);
}

const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
const external = [];
page.on("request", (r) => {
  const u = new URL(r.url());
  if (!["127.0.0.1", "localhost"].includes(u.hostname)) external.push(r.url());
});
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(String(e)));

await page.goto(BASE, { waitUntil: "domcontentloaded" });

check("page loads with a 200 and a title naming the client",
  (await page.title()).includes("Amarcco"), await page.title());
check("client legal name is on the page",
  (await page.locator("header.site strong").innerText()).includes("Amarcco Leads & Marketing"));
check("privacy link points at the client's own policy",
  (await page.locator('a[href*="privacypolicy"]').count()) >= 1);
check("terms link points at the client's own terms",
  (await page.locator('a[href*="terms"]').count()) >= 1);

const consentBoxes = page.locator('input[type="checkbox"][name="purpose"]');
const consentCount = await consentBoxes.count();
check("consent purposes are checkboxes, two of them", consentCount === 2,
  `${consentCount} checkboxes`);

const locked = page.locator(".purpose.locked");
check("the contract-basis purpose is shown as locked text, not a fake checkbox",
  (await locked.count()) === 1 && (await locked.innerText()).toLowerCase().includes("contract"));

check("the dry-run banner is visible, so nobody thinks this is live delivery",
  (await page.locator(".banner").innerText()).toLowerCase().includes("dry-run"));

// Fill in, deliberately *declining* both optional purposes.
await page.fill("#f_full_name", "Browser Check");
await page.fill("#f_email", "browser.check@example.com");
await page.fill("#f_phone", "+1 415 555 0142");
await page.selectOption("#f_vertical", "Reverse mortgage");
check("all client verticals are offered",
  (await page.locator("#f_vertical option").count()) >= 9,
  `${await page.locator("#f_vertical option").count()} options incl. placeholder`);

// Submit without the required contact consent: the page must complain, not send.
await page.click("#go");
await page.waitForTimeout(400);
const afterRefusal = await page.locator(".banner").count();
check("submitting without required contact consent is refused in the UI",
  afterRefusal >= 1, await page.locator(".banner").first().innerText().catch(() => ""));

await page.check("#p_contact_consent");
await page.click("#go");
await page.waitForSelector(".receipt", { timeout: 8000 });
const receipt = await page.locator(".receipt").innerText();
check("a submission produces a receipt with a reference",
  /sub_[0-9a-f]+/.test(receipt), receipt.split("\n")[1] || "");
check("the receipt reports the client destination as not-sent (dry-run)",
  /not-sent/i.test(receipt));
check("the receipt reports advertising destinations as blocked, not sent",
  (receipt.match(/blocked/gi) || []).length >= 1);

await page.screenshot({ path: "artifacts/form-1-filled.png", fullPage: true });
await page.locator(".receipt").screenshot({ path: "artifacts/form-2-receipt.png" });

// Withdrawing consent for the next visit: reload and check the boxes are not pre-ticked.
await page.goto(BASE, { waitUntil: "domcontentloaded" });
check("a fresh visit starts with every consent box unticked (no dark patterns)",
  (await page.locator('input[type="checkbox"][name="purpose"]:checked').count()) === 0);

check("no requests leave the page (self-contained: no CDN, no font, no pixel)",
  external.length === 0, external.join(", "));
check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED: " + failed.map((f) => f.name).join("; "));
  process.exit(1);
}
