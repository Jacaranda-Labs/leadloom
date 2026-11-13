#!/usr/bin/env python3
"""Build the client guide PDF.

HTML + Chromium print-to-PDF rather than a PDF library: the layout is CSS, the screenshots
are embedded as data URIs (so the file is one self-contained artefact), and page breaks are
explicit. Run: python3 scripts/build_guide.py
"""
from __future__ import annotations

import base64
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
ART = ROOT / "artifacts" / "guide"
OUT = ROOT / "artifacts" / "LeadLoom-Amarcco-Guide.pdf"

FORM_URL = "https://leadloom-amarcco.coldcode-si-labs.workers.dev/"
CONSOLE_URL = "https://leadloom-amarcco.coldcode-si-labs.workers.dev/admin"
HEALTH_URL = "https://leadloom-amarcco.coldcode-si-labs.workers.dev/healthz"
REPO_URL = "https://github.com/Jacaranda-Labs/leadloom"
OPERATOR_TOKEN = "7fb364205a6a536d8d9f503d8f9b657c4df748e652e21a59"
D1_ID = "91e29325-be56-4ec4-817c-fbdd9c26084a"
BUILD_DATE = "12 November 2026"


def img(name: str) -> str:
    data = base64.b64encode((ART / name).read_bytes()).decode()
    return f"data:image/png;base64,{data}"


def striprow(prefix: str, n: int, caption: str) -> str:
    """A tall screenshot split into n panels side by side. Scaling a 1:3 screenshot to the
    text width makes the form unreadable in print; splitting it keeps the type legible."""
    imgs = "".join(
        f'<img src="{img(f"{prefix}-{i}.png")}" alt="panel {i} of {n}">'
        for i in range(1, n + 1))
    # The panels go in their own flex container; a bare <img> set inside the figure would
    # put the caption in the same flex row and print it beside the screenshot.
    return (f'<figure class="shot wide"><div class="striprow">{imgs}</div>'
            f'<figcaption>{caption}</figcaption></figure>')


def shot(name: str, caption: str, cls: str = "") -> str:
    return f"""<figure class="shot {cls}">
      <img src="{img(name)}" alt="{caption}">
      <figcaption>{caption}</figcaption></figure>"""


CSS = """
@page { size: A4; margin: 16mm 15mm 18mm 15mm; }
@page :first { margin: 0; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; font-family: "DejaVu Sans", "Helvetica Neue", Arial, sans-serif;
  font-size: 9.3pt; line-height: 1.45; color: #17202e; background: #fff;
}
h1, h2, h3, h4 { font-weight: 700; letter-spacing: -0.2pt; margin: 0; }
h1 { font-size: 21pt; line-height: 1.15; margin: 0 0 4mm; }
h2 { font-size: 14.4pt; margin: 0 0 2.6mm; padding-bottom: 2mm;
     border-bottom: 1.6pt solid #0b5c3f; display: inline-block; }
h3 { font-size: 10.6pt; margin: 3.6mm 0 1.2mm; color: #0b3d2c; }
h4 { font-size: 9.6pt; margin: 3mm 0 1mm; }
p { margin: 0 0 2.2mm; }
ul, ol { margin: 0 0 2.6mm; padding-left: 5mm; }
li { margin: 0 0 1.2mm; }
code { font-family: "DejaVu Sans Mono", monospace; font-size: 8.3pt;
       background: #eef1f4; padding: 0.4mm 1.4mm; border-radius: 1mm; }
.small { font-size: 8.4pt; color: #5a6478; }
.muted { color: #5a6478; }
/* Break *before* each section rather than after: a section that overflows then flows onto
   the next page instead of leaving an empty one behind. */
.page { page-break-before: always; }
.page:first-of-type { page-break-before: auto; }
.avoid { page-break-inside: avoid; }

/* ---------- cover ---------- */
.cover { height: 297mm; width: 210mm; position: relative; overflow: hidden;
         background: #0b3d2c; color: #fff; }
.cover .band { position: absolute; inset: 0 0 auto 0; height: 8mm;
               background: linear-gradient(90deg,#0b5c3f,#1f8a63 55%,#c9a227); }
.cover .inner { position: absolute; left: 20mm; right: 20mm; top: 46mm; }
.cover .eyebrow { font-size: 8.6pt; letter-spacing: 3.4pt; text-transform: uppercase;
                  color: #8fd0b3; margin-bottom: 7mm; }
.cover h1 { font-size: 38pt; line-height: 1.06; letter-spacing: -1pt; margin: 0 0 6mm; }
.cover .sub { font-size: 12.5pt; color: #cfe6da; max-width: 130mm; line-height: 1.45; }
.cover .rule { width: 34mm; height: 2.4pt; background: #c9a227; margin: 9mm 0 7mm; }
.cover .meta { font-size: 9pt; color: #a9cbbb; line-height: 1.9; }
.cover .meta b { color: #fff; font-weight: 600; }
.cover .foot { position: absolute; left: 20mm; right: 20mm; bottom: 18mm;
               border-top: 0.6pt solid #2c6350; padding-top: 5mm;
               display: flex; justify-content: space-between; font-size: 8.6pt;
               color: #a9cbbb; }
.cover .foot b { color: #fff; }

/* ---------- tables ---------- */
table { width: 100%; border-collapse: collapse; margin: 0 0 3mm; font-size: 8.8pt; }
th { text-align: left; font-size: 7.6pt; text-transform: uppercase; letter-spacing: 0.6pt;
     color: #5a6478; border-bottom: 1pt solid #cfd6df; padding: 0 2mm 1.4mm 0; }
td { padding: 1.5mm 2mm 1.5mm 0; border-bottom: 0.5pt solid #e7ebf0; vertical-align: top; }
tr:last-child td { border-bottom: 0; }
td.k { font-weight: 600; white-space: nowrap; }

/* ---------- callouts ---------- */
.box { border: 0.7pt solid #cfd6df; border-left: 2.6pt solid #0b5c3f; background: #f7f9fa;
       padding: 2.8mm 3.4mm; margin: 0 0 2.8mm; border-radius: 1.2mm; }
.box.warn { border-left-color: #b45309; background: #fdf7ee; }
.box.bad { border-left-color: #a3170b; background: #fdf0ee; }
.box.good { border-left-color: #0b6b3a; background: #f0f8f3; }
.box h4 { margin-top: 0; }
.box p:last-child { margin-bottom: 0; }

.pill { display: inline-block; font-size: 7pt; font-weight: 700; letter-spacing: 0.4pt;
        text-transform: uppercase; padding: 0.5mm 2mm; border-radius: 2mm;
        border: 0.5pt solid; }
.pill.sent { color: #0b6b3a; border-color: #a9d6bf; background: #eef8f2; }
.pill.not_sent { color: #8a4b00; border-color: #e6d3b3; background: #fdf6ea; }
.pill.blocked { color: #a3170b; border-color: #f0c2bd; background: #fdefed; }
.pill.skipped { color: #5a6478; border-color: #cfd6df; background: #f6f7f9; }
.pill.failed { color: #fff; background: #a3170b; border-color: #a3170b; }

/* ---------- screenshots ---------- */
figure.shot { margin: 0 0 3mm; page-break-inside: avoid; }
/* Full-page screenshots are 1:4 or taller. Scaling them to the text width made them run
   over several pages; constrain by height instead and let them sit centred. */
figure.shot img { display: block; border: 0.6pt solid #cfd6df; border-radius: 1.6mm;
                  max-height: 176mm; max-width: 100%; width: auto; margin: 0 auto; }
figure.shot figcaption { font-size: 7.8pt; color: #5a6478; margin-top: 1.6mm;
                         line-height: 1.4; }
figure.shot.small img { max-height: 150mm; }
figure.shot.half img { max-height: 120mm; }
figure.shot.tall img { max-height: 168mm; }
figure.shot.wide img { max-height: none; width: 100%; }
figure.shot.center { text-align: center; }
figure.shot.center img { margin: 0 auto; }
figure.shot.center figcaption { text-align: left; }
.two { display: flex; gap: 5mm; page-break-inside: avoid; align-items: flex-start; }
.two > * { flex: 1; min-width: 0; }
.two figure.shot img { max-height: 112mm; }

/* ---------- flow diagram ---------- */
.flow { border: 0.7pt solid #cfd6df; border-radius: 1.6mm; padding: 4mm; margin-bottom: 4mm;
        background: #fbfcfd; }
.flow svg { width: 100%; height: auto; display: block; }

.toc { columns: 2; column-gap: 10mm; font-size: 9.4pt; }
.toc div { padding: 1.4mm 0; border-bottom: 0.5pt dotted #d5dbe3; break-inside: avoid; }
.toc span.n { display: inline-block; width: 7mm; color: #0b5c3f; font-weight: 700; }

.stat-strip { display: flex; gap: 3mm; margin: 0 0 4mm; }
.stat-strip div { flex: 1; border: 0.7pt solid #cfd6df; border-radius: 1.4mm;
                  padding: 2.6mm 3mm; }
.stat-strip .n { font-size: 15pt; font-weight: 800; letter-spacing: -0.4pt; color: #0b5c3f;
                 display: block; line-height: 1.1; }
.stat-strip .l { font-size: 7.6pt; text-transform: uppercase; letter-spacing: 0.5pt;
                 color: #5a6478; }

.striprow { display: flex; gap: 2.5mm; align-items: flex-start; }
.striprow img { flex: 1; min-width: 0; max-height: 232mm; width: auto; object-fit: contain;
                border: 0.6pt solid #cfd6df; border-radius: 1.2mm; }
.token { font-family: "DejaVu Sans Mono", monospace; font-size: 9.4pt; background: #17202e;
         color: #d8f0e3; padding: 3.4mm 4mm; border-radius: 1.4mm; word-break: break-all;
         letter-spacing: 0.2pt; }
.pagefoot { position: fixed; bottom: 0; left: 0; right: 0; }
"""


def cover() -> str:
    return f"""
<div class="cover">
  <div class="band"></div>
  <div class="inner">
    <div class="eyebrow">Coldcode SI Labs &nbsp;·&nbsp; Delivery document</div>
    <h1>Lead capture<br>and consent system</h1>
    <div class="rule"></div>
    <div class="sub">A working, publicly reachable lead intake service for
      Amarcco Leads &amp; Marketing LLC — with consent that is recorded, versioned and
      provable, and a written reason for every data transfer that does <i>not</i> happen.</div>
    <div class="meta" style="margin-top:11mm">
      <b>Prepared for</b> &nbsp; Amarcco Leads &amp; Marketing LLC<br>
      <b>Prepared by</b> &nbsp; Coldcode SI Labs<br>
      <b>Date</b> &nbsp; {BUILD_DATE}<br>
      <b>Status</b> &nbsp; Live, in dry-run — see section 9
    </div>
  </div>
  <div class="foot">
    <span><b>coldcode-estate.pages.dev</b> &nbsp;·&nbsp; +263 78 460 0904 &nbsp;·&nbsp; +263 77 967 4212</span>
    <span>Confidential — contains a live operator credential</span>
  </div>
</div>"""


FLOW_SVG = """
<svg viewBox="0 0 900 250" xmlns="http://www.w3.org/2000/svg" font-family="DejaVu Sans, Arial">
  <defs>
    <marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 z" fill="#6b7787"/>
    </marker>
  </defs>
  <g font-size="11" fill="#17202e">
    <rect x="8" y="72" width="128" height="58" rx="7" fill="#eef8f2" stroke="#0b5c3f"/>
    <text x="72" y="95" text-anchor="middle" font-weight="700">Visitor</text>
    <text x="72" y="112" text-anchor="middle" font-size="9" fill="#5a6478">ticks purposes</text>

    <rect x="168" y="62" width="150" height="78" rx="7" fill="#fff" stroke="#cfd6df"/>
    <text x="243" y="86" text-anchor="middle" font-weight="700">Validate</text>
    <text x="243" y="103" text-anchor="middle" font-size="9" fill="#5a6478">unknown fields refused</text>
    <text x="243" y="117" text-anchor="middle" font-size="9" fill="#5a6478">phone/email normalised</text>

    <rect x="350" y="62" width="150" height="78" rx="7" fill="#fff" stroke="#cfd6df"/>
    <text x="425" y="86" text-anchor="middle" font-weight="700">Record consent</text>
    <text x="425" y="103" text-anchor="middle" font-size="9" fill="#5a6478">notice_id + version</text>
    <text x="425" y="117" text-anchor="middle" font-size="9" fill="#5a6478">hash-chained, MAC'd</text>

    <rect x="532" y="52" width="176" height="98" rx="7" fill="#fff" stroke="#cfd6df"/>
    <text x="620" y="76" text-anchor="middle" font-weight="700">Purpose gate</text>
    <text x="620" y="93" text-anchor="middle" font-size="9" fill="#5a6478">consent basis → needs a grant</text>
    <text x="620" y="107" text-anchor="middle" font-size="9" fill="#5a6478">contract basis → no grant needed</text>
    <text x="620" y="121" text-anchor="middle" font-size="9" fill="#5a6478">refusal always blocks</text>
    <text x="620" y="135" text-anchor="middle" font-size="9" fill="#a3170b">unknown purpose → blocked</text>

    <rect x="740" y="26" width="150" height="40" rx="7" fill="#eef8f2" stroke="#0b6b3a"/>
    <text x="815" y="51" text-anchor="middle" font-size="10.5" font-weight="700" fill="#0b6b3a">permitted → send</text>
    <rect x="740" y="80" width="150" height="40" rx="7" fill="#fdefed" stroke="#a3170b"/>
    <text x="815" y="99" text-anchor="middle" font-size="10" font-weight="700" fill="#a3170b">blocked →</text>
    <text x="815" y="112" text-anchor="middle" font-size="8.5" fill="#a3170b">no request is built</text>
    <rect x="740" y="134" width="150" height="40" rx="7" fill="#f6f7f9" stroke="#cfd6df"/>
    <text x="815" y="153" text-anchor="middle" font-size="10" font-weight="700" fill="#5a6478">skipped →</text>
    <text x="815" y="166" text-anchor="middle" font-size="8.5" fill="#5a6478">nothing to send</text>

    <rect x="168" y="180" width="540" height="46" rx="7" fill="#fdf7ee" stroke="#b45309"/>
    <text x="438" y="200" text-anchor="middle" font-size="10.5" font-weight="700" fill="#8a4b00">Audit trail</text>
    <text x="438" y="215" text-anchor="middle" font-size="9" fill="#8a4b00">
      every decision recorded: what was sent, what was blocked and why, by which notice</text>
  </g>
  <g stroke="#6b7787" stroke-width="1.3" fill="none" marker-end="url(#a)">
    <path d="M136 101 L164 101"/>
    <path d="M318 101 L346 101"/>
    <path d="M500 101 L528 101"/>
    <path d="M708 76 L736 52"/>
    <path d="M708 101 L736 100"/>
    <path d="M708 126 L736 150"/>
    <path d="M620 150 L620 176"/>
    <path d="M425 140 L425 176"/>
  </g>
</svg>"""


def page_contents() -> str:
    rows = [
        ("1", "What is live, and where"),
        ("2", "How a submission flows through the system"),
        ("3", "What the visitor sees"),
        ("4", "The operator console"),
        ("5", "Operator manual — daily tasks"),
        ("6", "Reading the receipt and the status codes"),
        ("7", "Compliance position for Amarcco"),
        ("8", "Credentials and key custody"),
        ("9", "Go-live checklist — what is still open"),
        ("10", "Support, source code and contacts"),
    ]
    toc = "".join(f'<div><span class="n">{n}</span>{t}</div>' for n, t in rows)
    return f"""
<div class="page">
  <h2>Contents</h2>
  <div class="toc" style="margin-top:4mm">{toc}</div>

  <h3 style="margin-top:8mm">This document in one paragraph</h3>
  <p>Coldcode SI Labs has built and deployed a lead capture service for Amarcco Leads &amp;
  Marketing LLC. It is live on the public internet right now. A visitor can fill in a form,
  choose which purposes they agree to, and receive a receipt that states exactly what
  happened to their data. Behind it, every submission is validated, stored against a
  published privacy notice, and then either transmitted to a destination that the visitor's
  own choices permit, or blocked with a written reason. Nothing is guessed: a destination
  with no credentials reports that it sent nothing rather than pretending.</p>

  <div class="stat-strip" style="margin-top:5mm">
    <div><span class="n">Live</span><span class="l">public HTTPS</span></div>
    <div><span class="n">7 / 7</span><span class="l">consent events verified</span></div>
    <div><span class="n">51 + 19</span><span class="l">tests and browser checks</span></div>
    <div><span class="n">19</span><span class="l">browser checks passing</span></div>
  </div>

  <div class="box warn">
    <h4>Please read this before the system handles a real lead</h4>
    <p>The system is <b>live but in dry-run</b>. Submissions are validated, stored, gated
    and audited exactly as they will be in production — but no data is transmitted to
    Google, Meta, a CRM or any lead buyer. That is deliberate: we were not given credentials
    for those services, and a system that claims to deliver conversions it cannot deliver is
    worse than one that says so. Section 9 lists exactly what is needed to switch it on.</p>
  </div>

  <div class="box bad">
    <h4>This PDF contains a live operator credential</h4>
    <p>Section 8.1 prints the operator token, as requested, so that whoever runs the system can
    start immediately. Treat the file as confidential, do not forward it outside Amarcco, and
    rotate the token once it has been handed over — the rotation steps are on the same page.</p>
  </div>
</div>"""


def page_live() -> str:
    return f"""
<div class="page">
  <h2>1 &nbsp;What is live, and where</h2>
  <p>Three URLs are in service. They are all public except the console, which requires the
  operator token.</p>
  <table>
    <tr><th style="width:34mm">Purpose</th><th>URL</th><th style="width:44mm">Who uses it</th></tr>
    <tr><td class="k">Lead form</td>
        <td><code>{FORM_URL}</code></td><td>Visitors — give this to your ad traffic</td></tr>
    <tr><td class="k">Operator console</td>
        <td><code>{CONSOLE_URL}</code></td><td>Amarcco staff, with the token</td></tr>
    <tr><td class="k">Liveness probe</td>
        <td><code>{HEALTH_URL}</code></td><td>Monitoring; no token needed</td></tr>
    <tr><td class="k">Source code</td>
        <td><code>{REPO_URL}</code></td><td>Coldcode + Amarcco engineers</td></tr>
  </table>

  <h3>How it is built</h3>
  <p>The service runs on Cloudflare's edge network rather than on a server: a Worker handles
  requests and a D1 database (SQLite) stores the data. There is nothing to patch, nothing to
  reboot, and it scales with traffic automatically. The form is a single page with no
  external scripts, fonts or pixels — it works on a poor connection and cannot leak data to a
  third party simply by being loaded.</p>
  <table>
    <tr><th style="width:34mm">Component</th><th>Detail</th></tr>
    <tr><td class="k">Worker</td><td><code>leadloom-amarcco</code>, 9 ES modules</td></tr>
    <tr><td class="k">Database</td><td>D1 <code>leadloom-amarcco</code> · id <code>{D1_ID}</code></td></tr>
    <tr><td class="k">Hostname</td><td><code>leadloom-amarcco.coldcode-si-labs.workers.dev</code></td></tr>
    <tr><td class="k">Transport</td><td><b>dry-run</b> — payloads built and recorded, not transmitted</td></tr>
    <tr><td class="k">Retention</td><td>180 days for lead data; 30 days for click identifiers</td></tr>
    <tr><td class="k">Lead resale</td><td><b>disabled</b> — no lead is shared with any buyer</td></tr>
  </table>

  <div class="box">
    <h4>Verified, not assumed</h4>
    <p>Every screenshot in this document was taken from the live system on {BUILD_DATE}.
    The deployment was exercised end to end: a real submission was posted, stored in the
    database, gated, and verified in the consent chain. 51 automated tests and 19 real-browser
    checks pass against this build, including tests that compare the Cloudflare implementation
    against an independent Python reference and assert the cryptographic digests are
    byte-identical.</p>
  </div>

  <div class="box warn">
    <h4>One thing the current URL is not</h4>
    <p>The service is on a Coldcode subdomain, not on <code>forms.amarccollc.com</code>.
    Putting it on your own domain needs DNS access for <code>amarccollc.com</code>, which we
    do not have. This is a fifteen-minute change once access is available — see section 9.</p>
  </div>
</div>"""


def page_flow() -> str:
    return f"""
<div class="page">
  <h2>2 &nbsp;How a submission flows through the system</h2>
  <div class="flow">{FLOW_SVG}</div>

  <h3>The three lawful bases, and why the difference matters</h3>
  <p>Not every use of a person's data needs a checkbox. Getting this wrong in either
  direction is a compliance problem: asking for consent you do not need devalues the consent
  you do need, and relying on a basis you cannot justify is worse.</p>
  <table>
    <tr><th style="width:38mm">Basis</th><th style="width:30mm">Shown to visitor</th>
        <th>Rule the system enforces</th></tr>
    <tr><td class="k">Contract</td><td>Locked text, no checkbox</td>
        <td>Sending the enquiry to a specialist is the thing the form is for. No grant is
        needed, but an explicit refusal is still honoured — if someone withdraws, it stops.</td></tr>
    <tr><td class="k">Consent</td><td>Tick-box, unticked by default</td>
        <td>A stored <code>true</code> record must exist for that specific purpose. Absent is
        not permission. Nothing is pre-ticked, and declining costs the visitor nothing.</td></tr>
    <tr><td class="k">Legitimate interests</td><td>Locked text, no checkbox</td>
        <td>Available in the engine, not used on this form. Would require a documented
        balancing assessment before it could be switched on.</td></tr>
  </table>

  <h3>What "provable" means here</h3>
  <ul>
    <li><b>The notice is versioned.</b> The wording is hashed when it is published, and the
    submission stores that <code>notice_id</code>. If the wording ever changes, it is a new
    notice; the old one remains readable, so you can always show what a person actually read.</li>
    <li><b>The consent log is a hash chain.</b> Each event commits to the digest of the
    previous one, and each is signed with a key held outside the database. Editing a past
    record breaks the chain; editing it convincingly requires the key.</li>
    <li><b>Non-transmission is recorded too.</b> A blocked destination is audited with the
    purpose that failed. "We did not sell this lead" is a claim you can evidence, not just
    assert.</li>
  </ul>

  <div class="box good">
    <h4>Live chain check, {BUILD_DATE}</h4>
    <p><code>/admin/verify</code> returned <code>{{"ok": true, "events": 7, "problems": []}}</code>
    — every digest recomputed, every MAC verified, every link intact. The console shows this
    as a green <b>verified</b> tile on every page load.</p>
  </div>
</div>"""


def page_visitor() -> str:
    return f"""
<div class="page">
  <h2>3 &nbsp;What the visitor sees</h2>
  <p>The form is deliberately plain. It carries your company name, your verticals, and links
  to your own privacy policy and terms. Nothing is pre-selected, and no external font, script
  or tracking pixel is loaded — the page cannot leak data simply by being opened.</p>

  {shot("01-form-full.png", "3.1 — The whole page, at a glance. The detail that matters is "
        "enlarged below.", "small center")}

  <div class="two">
    <figure class="shot"><img src="{img('c01-fields.png')}" alt="form fields">
      <figcaption>3.2 — The top of the form. Required fields are marked; the phone field asks
      for a country code because an ambiguous number cannot be hashed correctly for the ad
      platforms.</figcaption></figure>
    <div>
      <h4 style="margin-top:0">The eight verticals you sell</h4>
      <p>Mortgage refinance, new home purchase, reverse mortgage, credit card debt, tax debt,
      unsecured debt, legal and insurance — exactly the products in your current offering, as
      a single dropdown so nothing is mistyped.</p>
      <p>The "State (US)" field exists because routing a mortgage or legal enquiry to a
      specialist who is not licensed in that state is a licensing problem, not just a service
      problem.</p>
    </div>
  </div>
</div>

<div class="page">
  <h3 style="margin-top:0">3.3 &nbsp;The purposes frame — the part that matters</h3>
  <p>This is the section a regulator, an ad-platform reviewer or a buyer will look at. Three
  different kinds of use, shown three different ways.</p>
  {shot("c01-purposes.png", "The purposes frame, exactly as the visitor sees it. The service "
        "purpose is locked text with its basis stated; the three consent purposes are "
        "unticked boxes, each stated in plain language, each labelled Required or Optional.")}
  <table>
    <tr><th style="width:52mm">Purpose</th><th style="width:24mm">Shown as</th>
        <th>Why</th></tr>
    <tr><td class="k">Delivering your request to a specialist</td>
        <td>Locked, no box</td>
        <td>Contract basis: this is what the form is for. No grant needed, but a refusal is
        still honoured.</td></tr>
    <tr><td class="k">Being contacted by phone, SMS or email</td>
        <td>Required tick-box</td>
        <td>TCPA consent must be a separate affirmative act. Required, because a lead we
        cannot lawfully call is not a lead.</td></tr>
    <tr><td class="k">Measuring which advertisement worked</td>
        <td>Optional tick-box</td>
        <td>Ad measurement is a convenience, not a condition of service. Declining it changes
        nothing for the visitor.</td></tr>
    <tr><td class="k">Sharing your enquiry with other marketing partners</td>
        <td>Optional tick-box</td>
        <td>Resale is a <i>sale</i> of personal information under state law. It needs its own
        agreement, and is additionally switched off at the deployment level.</td></tr>
  </table>
</div>

<div class="page">
  <div class="two">
    <figure class="shot"><img src="{img('s02-1.png')}" alt="filled form, upper">
      <figcaption>3.4 — A completed form. This visitor agreed to advertising measurement but
      has deliberately not agreed to be contacted by phone.</figcaption></figure>
    <figure class="shot"><img src="{img('03b-refused-detail.png')}" alt="refused">
      <figcaption>3.5 — Pressing send without it. The system refuses, and points at the exact
      box rather than accepting the lead and quietly dropping the permission.</figcaption>
      </figure>
  </div>
  <div class="box">
    <h4>Why that refusal exists</h4>
    <p>It cannot be folded into "we will provide the service you asked for". A form that lets
    contact consent slide is the failure pattern regulators cite, and the resulting calls are
    the ones that cost money. Refusing the submission is cheaper than making them.</p>
  </div>
</div>

<div class="page">
  <h3 style="margin-top:0">3.7 &nbsp;The same form on a phone, and the receipt</h3>
  <p>Most traffic in these verticals is mobile. The layout stays single-column and the consent
  boxes stay comfortably tappable. Beside it: the receipt the visitor receives.</p>
  {striprow("s09", 2, "The live form at 390 × 844 — an iPhone-class viewport.")}
  <div class="two" style="margin-top:3mm">
    <figure class="shot"><img src="{img('04-receipt.png')}" alt="receipt"
      style="max-height:92mm">
      <figcaption>3.8 — The receipt. Every destination is named, with what happened to it in
      plain words.</figcaption></figure>
    <div>
      <h4 style="margin-top:0">Why show this at all</h4>
      <p>A receipt that says "blocked — not permitted by the choices you made" is unusual, and
      that is the point. It tells the person their decision was honoured, gives them a
      reference to quote if they later ask what happened to their data, and makes the system's
      behaviour self-evidently honest to anyone auditing it — a regulator, an ad-platform
      reviewer, or a buyer doing due diligence on you.</p>
      <p>There is no green tick implying a delivery that has not happened. In this dry-run
      deployment nothing has been sent to anyone, and the receipt says exactly that.</p>
    </div>
  </div>
</div>"""


def page_console() -> str:
    return f"""
<div class="page">
  <h2>4 &nbsp;The operator console</h2>
  <p>Go to <code>{CONSOLE_URL}</code>. The browser asks for a username and password; enter
  any username and paste the operator token from section 8.1 as the password. The token is sent as
  a normal <code>Authorization: Bearer</code> header, so it is never stored in a cookie and
  never appears in the page source.</p>
  {shot("05-console.png", "4.1 — The console. Four tiles across the top answer the questions "
        "you will actually ask: what mode is it in, how many leads, can we prove the consent "
        "record, and is any lead being sold on.", "small center")}
</div>

<div class="page">
  <h3 style="margin-top:0">Reading the console</h3>
  <table>
    <tr><th style="width:38mm">Tile</th><th>What it means</th></tr>
    <tr><td class="k">Transport</td><td><b>dry-run</b> means nothing leaves the system.
        <b>live</b> means requests are being transmitted. It should never be live by accident:
        it takes an explicit setting to change.</td></tr>
    <tr><td class="k">Submissions</td><td>Leads stored, and the number of delivery decisions
        recorded alongside them. Five destinations per lead produces five decisions.</td></tr>
    <tr><td class="k">Consent chain</td><td><b>verified</b> means every event's digest and
        signature was recomputed and matched. <b>BROKEN</b> means something was altered or the
        key changed — treat that as an incident and call us.</td></tr>
    <tr><td class="k">Lead resale</td><td><b>disabled</b> means no lead is shared with a buyer,
        regardless of what the visitor ticked. This is a business decision, not a bug.</td></tr>
  </table>

  <h3>The lower half</h3>
  <p><b>Destinations</b> counts decisions by status and reason. <b>Connectors configured</b>
  shows whether each destination has credentials; in this deployment none do, which is exactly
  why the receipts say "not configured yet". <b>Recent submissions</b> lists references,
  timestamps and retention dates — deliberately no personal data, because a dashboard that
  displays lead PII becomes a second copy of the data you have to protect.</p>

  <div class="two">
    <figure class="shot"><img src="{img('06-verify-raw.png')}" alt="verify endpoint">
      <figcaption>4.2 — <code>/admin/verify</code>: the machine-readable chain check, used by
      monitoring and by anyone who wants to audit a claim independently.</figcaption></figure>
    <figure class="shot"><img src="{img('07-healthz-raw.png')}" alt="healthz">
      <figcaption>4.3 — <code>/healthz</code>: liveness only. No token, no data, safe to
      point an uptime monitor at.</figcaption></figure>
  </div>

  <figure class="shot half"><img src="{img('08-401-raw.png')}" alt="401">
    <figcaption>4.4 — Without the token the console returns 401 and shows nothing. There is no
    unauthenticated path to lead data anywhere in the system.</figcaption></figure>
</div>"""


def page_manual() -> str:
    return f"""
<div class="page">
  <h2>5 &nbsp;Operator manual — daily tasks</h2>
  <p>You do not need to touch a server. These are the tasks that come up, each with the exact
  command. Set the token once in your shell so it does not end up in your history:</p>
  <p><code>export LL_TOKEN='…'</code> &nbsp;and&nbsp; <code>export LL='{FORM_URL.rstrip("/")}'</code></p>

  <h3>5.1 &nbsp;Check the system is healthy</h3>
  <p><code>curl -s $LL/healthz</code> — should return <code>"ok":true</code>. This is what an
  uptime monitor should watch; it needs no token and exposes nothing.</p>

  <h3>5.2 &nbsp;See the chain status from a terminal</h3>
  <p><code>curl -s -H "Authorization: Bearer $LL_TOKEN" $LL/admin/verify</code></p>
  <p>Expected: <code>{{"ok":true,"events":N,"problems":[]}}</code>. If <code>ok</code> is
  false, stop and call us before doing anything else.</p>

  <h3>5.3 &nbsp;Look up one lead</h3>
  <p><code>curl -s -H "Authorization: Bearer $LL_TOKEN" "$LL/admin/submissions?submission_id=sub_…"</code></p>
  <p>Returns the submission, every delivery decision with its reason, the audit trail, and
  the consent events that applied. This is the record you would produce if a lead ever asked
  what happened to their data.</p>

  <h3>5.4 &nbsp;A lead asks what you hold, or asks to be deleted</h3>
  <ol>
    <li>Find their subject id from a submission lookup above (field <code>subject_id</code>).</li>
    <li>Erase: <code>curl -s -X POST -H "Authorization: Bearer $LL_TOKEN"
        -H 'content-type: application/json'
        -d '{{"subject_id":"subj_…"}}' $LL/admin/erase</code></li>
    <li>The personal data and click identifiers are destroyed. The audit record that an
    erasure occurred is kept — you need that to prove you complied.</li>
  </ol>

  <h3>5.5 &nbsp;A lead withdraws consent themselves</h3>
  <p>No action needed. Withdrawal is immediate and applies to anything not yet sent. If you
  want to do it on their behalf, the same <code>/withdraw</code> endpoint accepts a
  submission reference: <code>curl -s -X POST -H 'content-type: application/json'
  -d '{{"submission_id":"sub_…"}}' $LL/withdraw</code></p>

  <h3>5.6 &nbsp;Retention</h3>
  <p>Lead data is destroyed 180 days after submission, automatically, on the scheduled sweep.
  To run it on demand (for example before an audit):</p>
  <p><code>curl -s -X POST -H "Authorization: Bearer $LL_TOKEN" "$LL/admin/purge?at=2027-06-01T00:00:00Z"</code></p>
  <p>The console then shows those rows as <b>redacted</b>. The lead is gone; the fact that a
  lead existed and where it went is kept, without the person in it.</p>

  <div class="box warn">
    <h4>Two things never to do</h4>
    <p><b>Do not switch transport to live without credentials for every destination you
    intend to use.</b> Switch it on destination by destination, and confirm with a test lead
    each time. <b>Do not enable lead resale</b> until the legal position in section 7 is
    settled — the moment you do, consented leads can be shared with buyers.</p>
  </div>
</div>"""


def page_status() -> str:
    return f"""
<div class="page">
  <h2>6 &nbsp;Reading the receipt and the status codes</h2>
  <p>Five statuses are used, and they are never collapsed into a vague "ok". If you are ever
  unsure whether a lead reached somewhere, this table is the answer.</p>
  <table>
    <tr><th style="width:26mm">Status</th><th style="width:44mm">What it means</th>
        <th>What you should do</th></tr>
    <tr><td><span class="pill sent">sent</span></td>
        <td>A real request left and the destination accepted it.</td>
        <td>Nothing. This is the only status that means data moved.</td></tr>
    <tr><td><span class="pill not_sent">not_sent</span></td>
        <td>Dry-run: the payload was built and recorded, transmission was suppressed.</td>
        <td>Nothing. Switch to live when credentials are in place.</td></tr>
    <tr><td><span class="pill blocked">blocked</span></td>
        <td>The visitor's choices did not permit this destination. No request was even built.</td>
        <td>Nothing — this is the system working. If it is unexpected, check what the visitor
        ticked.</td></tr>
    <tr><td><span class="pill skipped">skipped</span></td>
        <td>Permitted, but there was nothing to send, or the destination has no credentials.</td>
        <td>If it says <code>no_credential</code>, that destination is not wired up yet.</td></tr>
    <tr><td><span class="pill failed">failed</span></td>
        <td>We tried and the other side refused it — including a "200 OK" whose body names an
        error.</td>
        <td>Investigate. This is the only status that indicates a problem.</td></tr>
  </table>

  <h3>Destinations on this form</h3>
  <table>
    <tr><th style="width:40mm">Destination</th><th style="width:34mm">Requires</th>
        <th>Notes</th></tr>
    <tr><td class="k">amarcco-intake</td><td>service delivery (contract)</td>
        <td>Your receiving endpoint. Point <code>WEBHOOK_URL</code> at it.</td></tr>
    <tr><td class="k">amarcco-crm</td><td>service delivery (contract)</td>
        <td>Needs a field map (<code>LEAD_MAP</code>) before it can send anything.</td></tr>
    <tr><td class="k">meta-capi</td><td>advertising measurement (consent)</td>
        <td>Meta Conversions API. Email and phone are hashed; no name is ever sent.</td></tr>
    <tr><td class="k">google-ads</td><td>advertising measurement (consent)</td>
        <td>Google click conversions. Only fires when the visitor arrived with a click id.</td></tr>
    <tr><td class="k">lead-buyers</td><td>resale (consent) <b>and</b> an operator switch</td>
        <td>Off. Requires both the visitor's agreement and a deliberate business decision.</td></tr>
  </table>

  <div class="box">
    <h4>Duplicate protection</h4>
    <p>If a submission is retried — a double click, a flaky connection — the system returns
    the original reference and sends nothing twice. Google and Meta are given a deterministic
    id derived from the submission, so even a retry from our side cannot double-count a
    conversion.</p>
  </div>
</div>"""


def page_compliance() -> str:
    return f"""
<div class="page">
  <h2>7 &nbsp;Compliance position for Amarcco</h2>
  <p>This system was built for a US consumer-finance lead seller operating from India. That
  is a specific situation, and a generic European-style consent banner would have been the
  wrong design for it. What follows is what the build assumes, so that you can check our
  assumptions against your own counsel's advice.</p>

  <h3>What the design does, and why</h3>
  <table>
    <tr><th style="width:44mm">Requirement</th><th>How the system meets it</th></tr>
    <tr><td class="k">TCPA — calls and texts</td>
        <td>Contact consent is a <b>separate, required</b> purpose with its own wording that
        names automated technology and states consent is not a condition of purchase. It is
        never bundled into "providing the service".</td></tr>
    <tr><td class="k">State privacy laws — sale / sharing</td>
        <td>Resale is its own purpose, unticked by default, and additionally blocked at the
        deployment level unless an operator enables it. Selling a lead is a
        <i>sale of personal information</i> under CPRA and similar statutes, with disclosure
        and opt-out duties attached.</td></tr>
    <tr><td class="k">Financial data</td>
        <td>Mortgage, debt and insurance enquiries touch GLBA-adjacent data. The form collects
        no account numbers, SSNs or card numbers. Keep it that way without a legal review.</td></tr>
    <tr><td class="k">India DPDP Act 2023</td>
        <td>Processing done in India: purpose limitation, notice, erasure on withdrawal, and a
        retention limit with an implemented sweep rather than a policy statement.</td></tr>
    <tr><td class="k">Data minimisation</td>
        <td>Advertising platforms receive <b>hashed</b> email and phone only — never a name.
        IP addresses are truncated to a network prefix before storage.</td></tr>
    <tr><td class="k">Retention</td>
        <td>180 days for lead data, 30 days for click identifiers, enforced by an automated
        sweep and recorded in the audit trail.</td></tr>
  </table>

  <h3>What the system deliberately does not claim</h3>
  <ul>
    <li><b>No GDPR claim.</b> The notice does not mention GDPR or the EEA, because Amarcco
    does not target EU consumers. Claiming a regime that does not apply is itself a
    misleading statement — and a real risk if EU traffic ever arrives.</li>
    <li><b>No automated decision-making</b> is performed on the lead (the notice says so
    explicitly, because saying it is cheaper than proving a negative later).</li>
    <li><b>No ad-platform delivery has happened yet.</b> See section 9.</li>
  </ul>

  <div class="box bad">
    <h4>Open legal questions — these are yours, not ours to answer</h4>
    <p><b>Data-broker registration.</b> Several US states require businesses that sell
    personal information to register as data brokers and to disclose buyers. Whether this
    applies to Amarcco, and in which states, depends on your volumes and structure. It is
    load-bearing for the resale purpose: if registration is required and not done, running
    resale creates exposure that this system cannot mitigate.</p>
    <p><b>Buyer disclosure obligations.</b> If leads are shared, the receiving parties'
    obligations — and what you must tell the consumer about them — need to be settled with
    counsel and reflected in the notice wording. Changing the notice is a new notice version;
    the system supports that cleanly, but it is a policy decision first.</p>
  </div>
</div>"""


def page_credentials() -> str:
    return f"""
<div class="page">
  <h2>8 &nbsp;Credentials and key custody</h2>
  <p>Two secrets control this deployment. Both are held by Cloudflare as encrypted values and
  are never present in the source code, the repository, or the page.</p>

  <h3>8.1 &nbsp;The operator token</h3>
  <p>This grants access to the console and every administrative endpoint — look up a lead,
  withdraw consent on someone's behalf, erase a subject, run a retention sweep.</p>
  <div class="token">{OPERATOR_TOKEN}</div>
  <p class="small" style="margin-top:2mm">Operator token · <code>LEADLOOM_ADMIN_TOKEN</code> ·
  treat as a password. Anyone with this string can read lead records.</p>

  <div class="box bad">
    <h4>Because this is printed in a PDF</h4>
    <p>A document that gets emailed is a weak place to keep a live credential. Two
    recommendations, in order: <b>(1)</b> rotate this token once it has been handed over —
    the rotation command is below, it takes a minute; <b>(2)</b> deliver the replacement
    through a password manager or Signal, not email. We would rather tell you this than
    quietly hand you a liability.</p>
  </div>

  <h3>8.2 &nbsp;The consent signing key</h3>
  <p>The second secret keys the consent chain's signatures. It is <b>not</b> printed here, and
  it should not be: it lives in the Cloudflare secret store, and a copy belongs in your
  password manager as an escrow copy. Without it the existing chain cannot be verified —
  the evidence degrades to "a log nobody can check". Treat losing it the way you would treat
  losing the only key to a filing cabinet.</p>

  <h3>8.3 &nbsp;Rotating either secret</h3>
  <p>Deployment is scripted, so rotation is one command run by Coldcode or by your own
  engineer:</p>
  <ol>
    <li>Choose the new value (32+ random bytes).</li>
    <li>Re-run <code>scripts/deploy-cf.mjs</code> with the new value in the environment.</li>
    <li>If you rotate the <b>consent key</b>, existing chain entries were signed with the old
    one and will no longer verify. Either keep the old key for verification, or start a fresh
    chain deliberately — and write down which you did, because an auditor will ask.</li>
  </ol>

  <h3>8.4 &nbsp;Who can see what</h3>
  <table>
    <tr><th style="width:44mm">Holds</th><th>Can</th></tr>
    <tr><td class="k">Operator token</td><td>Read any lead record, erase, purge, withdraw</td></tr>
    <tr><td class="k">Consent key</td><td>Verify — and therefore forge — chain entries</td></tr>
    <tr><td class="k">Cloudflare account</td><td>Redeploy, read secrets, read the database</td></tr>
    <tr><td class="k">Nobody</td><td>See lead data without one of the above</td></tr>
  </table>
  <p class="small">Today the Cloudflare account is Coldcode's. That is the single largest
  ownership issue in this delivery, and section 9 proposes how to fix it.</p>
</div>"""


def page_golive() -> str:
    return f"""
<div class="page">
  <h2>9 &nbsp;Go-live checklist — what is still open</h2>
  <p>The system is live and safe to leave running as-is. Each item below is a deliberate,
  visible gap rather than something half-done. They are ordered by how much they block real
  lead flow.</p>

  <table>
    <tr><th style="width:8mm">#</th><th style="width:52mm">Item</th>
        <th style="width:26mm">Owner</th><th>What is needed</th></tr>
    <tr><td>1</td><td class="k">Delivery credentials</td><td>Amarcco</td>
        <td>Meta pixel id + access token, Google customer id + conversion action + developer
        token, and the CRM/intake webhook URL. Without these, conversions cannot be sent and
        the system will keep reporting <code>skipped</code>.</td></tr>
    <tr><td>2</td><td class="k">Your own domain</td><td>Amarcco</td>
        <td>DNS access for <code>amarccollc.com</code>, to serve the form at
        <code>forms.amarccollc.com</code>. Higher match rates and better trust signals than a
        shared subdomain.</td></tr>
    <tr><td>3</td><td class="k">Ownership of the account</td><td>Both</td>
        <td>Move the Worker and database into Amarcco's own Cloudflare account, so Coldcode is
        not holding your data and keys. We recommend doing this before real lead volume.</td></tr>
    <tr><td>4</td><td class="k">Resale decision</td><td>Amarcco + counsel</td>
        <td>Whether leads are sold on, and if so the data-broker registration position. Until
        this is settled, resale stays off and no lead is shared.</td></tr>
    <tr><td>5</td><td class="k">Field map for the CRM</td><td>Amarcco</td>
        <td>Which form field maps to which CRM column. Unmapped fields are dropped rather than
        guessed — a lead with the name in the "company" column is worse than a failed import.</td></tr>
    <tr><td>6</td><td class="k">Rotate the tokens in this document</td><td>Both</td>
        <td>Once handed over, both secrets should be replaced and stored properly.</td></tr>
    <tr><td>7</td><td class="k">Test conversions</td><td>Both</td>
        <td>After credentials are in, one live test lead per destination, checked in the ad
        platform's own event log. We will do this with you.</td></tr>
  </table>

  <h3>What "done" looks like</h3>
  <ol>
    <li>A test lead submitted at <code>forms.amarccollc.com</code> arrives in the CRM, appears
    as a Lead in Meta Events Manager and as a conversion in Google Ads.</li>
    <li>The receipt for that lead reads <span class="pill sent">sent</span> for each
    destination you enabled, with no <span class="pill failed">failed</span> rows.</li>
    <li>The console shows <b>verified</b> for the consent chain and the submission count has
    gone up by exactly the number of leads you sent.</li>
    <li>A withdrawal made by that test lead produces no further sending anywhere.</li>
  </ol>

  <div class="box good">
    <h4>What already works today, without any of the above</h4>
    <p>The form is collecting. Consent is being recorded and can be proven. Retention and
    erasure work. Nothing is being transmitted to anyone, so there is no compliance exposure
    in leaving it live while the items above are closed out — which is exactly why we built it
    to default to dry-run.</p>
  </div>
</div>"""


def page_support() -> str:
    return f"""
<div class="page">
  <h2>10 &nbsp;Support, source code and contacts</h2>

  <h3>If something looks wrong</h3>
  <ol>
    <li>Check <code>{HEALTH_URL}</code>. If it does not return <code>"ok":true</code>, the
    service is down — call us.</li>
    <li>If the console shows <b>BROKEN</b> next to the consent chain, do not erase or purge
    anything. Call us; that is an integrity event.</li>
    <li>If a destination shows <span class="pill failed">failed</span>, send us the submission
    reference and we will look at the recorded response.</li>
    <li>If a visitor says they never got a receipt, ask for the reference; every submission
    has one and it is enough to trace the whole path.</li>
  </ol>

  <h3>The code</h3>
  <p>All source, the database schema, the deployment script and the test suite are in the
  repository. It is not a black box: your engineers can read exactly what happens to a lead,
  change the form wording, or redeploy independently of us.</p>
  <p><code>{REPO_URL}</code></p>
  <p class="small">51 automated tests, including a suite that checks this implementation
  against an independent Python reference and asserts the cryptographic digests are
  byte-identical. That is what makes the consent records portable: they can be verified
  without our code.</p>

  <h3>Contacts</h3>
  <table>
    <tr><th style="width:44mm">Coldcode SI Labs</th><th></th></tr>
    <tr><td class="k">Website</td><td><code>coldcode-estate.pages.dev</code></td></tr>
    <tr><td class="k">Phone / WhatsApp</td><td>+263 78 460 0904</td></tr>
    <tr><td class="k">Phone / WhatsApp</td><td>+263 77 967 4212</td></tr>
    <tr><td class="k">For calls</td><td>Either number; both are on WhatsApp</td></tr>
  </table>

  <div class="box">
    <h4>Built by</h4>
    <p><b>Coldcode SI Labs</b> — engineering for lead-generation and compliance-critical
    systems. We built this because the usual lead form cannot answer the only question that
    matters when a regulator or an ad platform asks: <i>show me that this person agreed to
    this specific use, on this date, under this wording.</i></p>
  </div>

  <p class="small" style="margin-top:8mm; border-top:0.6pt solid #cfd6df; padding-top:3mm">
  Document prepared {BUILD_DATE} · LeadLoom for Amarcco Leads &amp; Marketing LLC ·
  Coldcode SI Labs · coldcode-estate.pages.dev · +263 78 460 0904 / +263 77 967 4212.
  Screenshots are of the live deployment on the date above. This document contains a live
  operator credential and should be treated as confidential.</p>
</div>"""


def build() -> None:
    body = "".join([
        cover(), page_contents(), page_live(), page_flow(), page_visitor(),
        page_console(), page_manual(), page_status(), page_compliance(),
        page_credentials(), page_golive(), page_support(),
    ])
    html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>LeadLoom for Amarcco — Guide and Manual</title><style>{CSS}</style></head>
<body>{body}</body></html>"""
    (ART / "guide.html").write_text(html)

    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--no-sandbox"])
        page = browser.new_page()
        page.set_content(html, wait_until="load")
        page.emulate_media(media="print")
        page.pdf(
            path=str(OUT), format="A4", print_background=True,
            display_header_footer=True,
            header_template='<div style="font-size:7pt;color:#98a2b3;width:100%;'
                            'padding:0 15mm;font-family:Arial">LeadLoom · Amarcco Leads &amp; '
                            'Marketing LLC</div>',
            footer_template='<div style="font-size:7pt;color:#98a2b3;width:100%;'
                            'padding:0 15mm;font-family:Arial;display:flex;'
                            'justify-content:space-between">'
                            '<span>Coldcode SI Labs · coldcode-estate.pages.dev</span>'
                            '<span class="pageNumber"></span></div>',
            margin={"top": "16mm", "bottom": "16mm", "left": "15mm", "right": "15mm"},
        )
        browser.close()
    size = OUT.stat().st_size
    print(f"wrote {OUT} ({size/1024:.0f} KB)")


if __name__ == "__main__":
    build()
    sys.exit(0)
