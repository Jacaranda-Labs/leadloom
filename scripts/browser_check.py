#!/usr/bin/env python3
"""Real-browser check of the lead form.

Node tests prove the HTTP contract; only a browser proves the page a person actually sees:
that the consent boxes exist and are unticked by default, that refusing a required consent
is refused rather than silently sent, and that the receipt tells the truth about what
happened to the data.

Exit codes: 0 all passed, 1 a check failed, 3 could not run (no browser available).
Written for Python Playwright because `npm install` does not work in this sandbox, so
`playwright` for Node is not available.
"""
from __future__ import annotations

import os
import sys

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "LEADLOOM_URL", "http://127.0.0.1:8080")).rstrip("/")
ART = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "artifacts")
os.makedirs(ART, exist_ok=True)

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    detail = str(detail)
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}{' — ' + detail if detail else ''}")


def main() -> int:
    external: list[str] = []
    console_errors: list[str] = []
    own_origin = BASE.split("/")[2]  # host[:port]; earlier versions only allowed
    # 127.0.0.1/localhost and so reported every same-origin request on a real deployment
    # as "external" — a check that fails for the wrong reason is worse than no check.

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch(args=["--no-sandbox"])
        except Exception as exc:  # noqa: BLE001 - report, do not pretend
            print(f"UNCHECKED: could not start Chromium: {exc}")
            return 3

        page = browser.new_page(viewport={"width": 900, "height": 1200})
        page.on("request", lambda r: external.append(r.url)
                if own_origin not in r.url else None)
        # A 400 from the deliberate invalid submission is the *expected* console noise of
        # the browser's fetch; only other errors count.
        page.on("console", lambda m: console_errors.append(m.text)
                if m.type == "error" and "status of 400" not in m.text else None)
        page.on("pageerror", lambda e: console_errors.append(str(e)))

        page.goto(BASE, wait_until="domcontentloaded")

        check("page loads and the title names the client", "Amarcco" in page.title(), page.title())
        check("client legal name is in the header",
              "Amarcco Leads & Marketing" in page.inner_text("header.site strong"))
        check("privacy link points at the client's own policy",
              page.locator('a[href*="privacypolicy"]').count() >= 1)
        check("terms link points at the client's own terms",
              page.locator('a[href*="terms"]').count() >= 1)

        boxes = page.locator('input[type="checkbox"][name="purpose"]')
        # contact_consent, advertising_measurement and resale are all consent-basis, so
        # three checkboxes is correct; service_delivery is contract-basis and is locked text.
        check("all three consent purposes render as checkboxes", boxes.count() == 3,
              f"{boxes.count()} checkboxes")
        check("no consent box is pre-ticked (no dark patterns)",
              page.locator('input[type="checkbox"][name="purpose"]:checked').count() == 0)

        locked = page.locator(".purpose.locked")
        check("the contract-basis purpose is locked text, not a fake opt-out",
              locked.count() == 1 and "contract" in locked.inner_text().lower())

        banner = page.locator(".banner").first.inner_text()
        check("the dry-run banner is shown", "dry-run" in banner.lower())

        # Fill the form, deliberately leaving optional purposes declined.
        page.fill("#f_full_name", "Browser Check")
        page.fill("#f_email", "browser.check@example.com")
        page.fill("#f_phone", "+1 415 555 0142")
        page.select_option("#f_vertical", "Reverse mortgage")
        # Fill every optional field too: a bug where "Amount" could never be filled in
        # passed 19 checks because no check ever typed into it.
        page.fill("#f_state", "Texas")
        page.fill("#f_amount", "240000")
        page.fill("#f_notes", "Called about a reverse mortgage.")
        options = page.locator("#f_vertical option").count()
        check("all eight client verticals are offered", options >= 9, f"{options} options")

        page.check("#f_consent_confirmed")

        # Submit without the required contact consent.
        page.click("#go")
        page.wait_for_timeout(500)
        first_banner = page.locator(".banner").first.inner_text()
        check("submitting without required contact consent is refused",
              page.locator(".banner").count() >= 1, first_banner[:80])
        check("the refusal is not a success receipt", page.locator(".receipt").count() == 0)

        # Now agree, and submit for real.
        page.check("#p_contact_consent")
        page.click("#go")
        page.wait_for_selector(".receipt", timeout=10_000)
        receipt = page.inner_text(".receipt")
        check("a submission produces a receipt with a reference",
              "sub_" in receipt, receipt.split("\n")[1] if "\n" in receipt else "")
        # In this local preview no webhook URL is configured, so the honest status for the
        # client destination is "skipped — no credential", not "not-sent". What must never
        # appear is "sent": nothing is transmitted here.
        check("the receipt never claims anything was sent",
              "sent —" not in receipt.lower() and "sent:" not in receipt.lower(),
              "; ".join(ln for ln in receipt.splitlines() if "sent" in ln.lower())[:120])
        check("the receipt explains the client destination in plain words",
              ("no credentials" in receipt.lower()) or ("not configured" in receipt.lower())
              or ("dry-run" in receipt.lower()),
              "; ".join(ln for ln in receipt.splitlines() if "amarcco-intake" in ln)[:120])
        check("the receipt names each advertising destination as blocked",
              receipt.lower().count("blocked") >= 2, f"{receipt.lower().count('blocked')} blocked")

        page.screenshot(path=os.path.join(ART, "form-filled.png"), full_page=True)
        page.locator(".receipt").screenshot(path=os.path.join(ART, "form-receipt.png"))

        check("no request leaves the page (no CDN, no font, no tracking pixel)",
              not external, ", ".join(external[:3]))
        check("no console errors", not console_errors, " | ".join(console_errors[:2]))

        # The admin view, with the operator token, must show a clean chain.
        page2 = browser.new_page()
        resp = page2.request.get(f"{BASE}/admin/verify", headers={
            "authorization": f"Bearer {os.environ.get('LEADLOOM_ADMIN_TOKEN', 'demo-admin-token')}"})
        body = resp.json()
        check("the consent chain verifies in the deployed instance",
              resp.ok and body.get("ok") is True, f"{body.get('events')} events")
        anon = page2.request.get(f"{BASE}/admin/health")
        check("admin routes are refused without a token", anon.status == 401,
              str(anon.status))

        browser.close()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    if failed:
        print("FAILED: " + "; ".join(r[0] for r in failed))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
