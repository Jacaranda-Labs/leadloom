#!/usr/bin/env python3
"""Build and deploy the pages.dev handover landing page.

Two things this does deliberately:
  * inlines the screenshots as data URIs, so the page renders identically in a sandboxed
    preview with no network — and so the only external request it makes is the guide PDF;
  * publishes the REDACTED guide, never the copy carrying the operator token. A public
    download button must not be a credential leak.

Run: python3 scripts/build_site.py [--deploy]
"""
from __future__ import annotations

import base64
import json
import os
import pathlib
import sys
import time
import mimetypes
import hashlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT = ROOT / "artifacts" / "site"

FORM_URL = "https://leadloom-amarcco.coldcode-si-labs.workers.dev/"
CONSOLE_URL = "https://leadloom-amarcco.coldcode-si-labs.workers.dev/admin"
HEALTH_URL = "https://leadloom-amarcco.coldcode-si-labs.workers.dev/healthz"
REPO_URL = "https://github.com/Jacaranda-Labs/leadloom"
GUIDE_SRC = ROOT / "artifacts" / "LeadLoom-Amarcco-Guide-public.pdf"
GUIDE_NAME = "LeadLoom-Amarcco-Guide.pdf"


def data_uri(path: pathlib.Path) -> str:
    mime = "image/jpeg" if path.suffix == ".jpg" else "image/png"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def build_html() -> str:
    html = (SITE / "index.template.html").read_text()
    repl = {
        "__FORM_URL__": FORM_URL,
        "__CONSOLE_URL__": CONSOLE_URL,
        "__HEALTH_URL__": HEALTH_URL,
        "__REPO_URL__": REPO_URL,
        "__FORM_HOST__": FORM_URL.replace("https://", "").rstrip("/"),
        "__GUIDE_URL__": f"/{GUIDE_NAME}",
        "__IMG_FORM__": data_uri(SITE / "hero-form.jpg"),
        "__IMG_CONSOLE__": data_uri(SITE / "console.jpg"),
    }
    for key, value in repl.items():
        html = html.replace(key, value)
    missing = [k for k in repl if k in html]
    if missing:
        raise SystemExit(f"unreplaced placeholders: {missing}")
    return html


def build() -> pathlib.Path:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "index.html").write_text(build_html())
    # Copy the redacted guide only. Assert it really is redacted before it leaves the machine.
    pdf = GUIDE_SRC.read_bytes()
    import pypdfium2 as pdfium
    tmp_check = pdfium.PdfDocument(GUIDE_SRC)
    text = "".join(tmp_check[i].get_textpage().get_text_range() for i in range(len(tmp_check)))
    token = json.loads((ROOT / ".local-secrets.json").read_text())["LEADLOOM_ADMIN_TOKEN"]
    if token.replace(" ", "") in text.replace("\n", "").replace(" ", ""):
        raise SystemExit("refusing to publish: the operator token is present in the PDF")
    (OUT / GUIDE_NAME).write_bytes(pdf)
    (OUT / "robots.txt").write_text("User-agent: *\nDisallow: /\n")
    (OUT / "_headers").write_text(
        "/*\n"
        "  X-Frame-Options: SAMEORIGIN\n"
        "  X-Content-Type-Options: nosniff\n"
        "  Referrer-Policy: strict-origin-when-cross-origin\n"
        "  Cache-Control: public, max-age=300\n"
        f"/{GUIDE_NAME}\n"
        "  Content-Disposition: attachment\n"
    )
    total = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
    print(f"built {OUT} ({total/1024/1024:.1f} MB)")
    for f in sorted(OUT.rglob("*")):
        if f.is_file():
            print(f"  {f.relative_to(OUT)}  {f.stat().st_size//1024} KB")
    return OUT


# ---------------------------------------------------------------- deploy ----
def deploy() -> str:
    """Deploy with wrangler, not a hand-rolled upload.

    I first wrote the direct-upload protocol by hand against the REST API. It reported
    success every time and served 500 every time: the manifest and the asset part keys did
    not line up, so the deployment contained no assets while claiming to be fine. wrangler
    gets this right, and a deployment tool that lies about success is worse than none.
    """
    import shutil
    import subprocess

    wrangler = shutil.which("wrangler") or os.environ.get("WRANGLER_BIN")
    if not wrangler:
        raise SystemExit("wrangler not found: npm install wrangler, or set WRANGLER_BIN")
    project = os.environ.get("PAGES_PROJECT", "amarcco-leadloom")

    subprocess.run([wrangler, "pages", "project", "create", project,
                    "--production-branch=main"],
                   check=False, capture_output=True, text=True)
    res = subprocess.run(
        [wrangler, "pages", "deploy", str(OUT), f"--project-name={project}",
         "--branch=main", "--commit-dirty=true"],
        check=True, capture_output=True, text=True)
    tail = res.stdout + res.stderr
    print("\n".join(line for line in tail.splitlines() if line.strip())[-600:])
    return f"https://{project}.pages.dev"


def verify(url: str) -> None:
    import requests
    for _ in range(12):
        try:
            r = requests.get(url, timeout=20)
        except requests.RequestException:
            time.sleep(4); continue
        if r.ok and "Coldcode SI Labs" in r.text:
            pdf = requests.get(url.rstrip("/") + "/" + GUIDE_NAME, timeout=60)
            print(f"→ GET /            {r.status_code}  {len(r.content)/1024:.0f} KB")
            print(f"→ GET /guide.pdf   {pdf.status_code}  {len(pdf.content)/1024:.0f} KB  "
                  f"{pdf.headers.get('content-type')}")
            assert pdf.content[:4] == b"%PDF", "guide download is not a PDF"
            token = json.loads((ROOT / ".local-secrets.json").read_text())[
                "LEADLOOM_ADMIN_TOKEN"]
            for stream in (pdf.content,):
                assert token.encode() not in stream, "PUBLIC GUIDE LEAKS THE TOKEN"
            print("→ token not present in the published PDF: ok")
            return
        time.sleep(5)
    raise SystemExit("deployed but the page never came up")


if __name__ == "__main__":
    build()
    if "--deploy" in sys.argv:
        verify(deploy())
