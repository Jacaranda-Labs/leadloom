// Pages, as strings. Single-file, no external requests: the form must work on a locked-down
// network, and a tracking form that depends on a CDN is a form that silently collects
// nothing. Everything below is served by the Worker itself.

export const CSS = `
:root{--ink:#101828;--muted:#5a6478;--line:#dfe3ea;--bg:#f6f7f9;--accent:#0b5c3f;
--accent-ink:#ffffff;--warn:#8a4b00;--bad:#a3170b;--ok:#0b6b3a}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header.site{background:#0b3d2c;color:#fff;padding:14px 20px;display:flex;flex-wrap:wrap;
gap:8px 18px;align-items:baseline}
header.site strong{font-size:17px;letter-spacing:.2px}
header.site .sub{font-size:13px;color:#bcd8cb}
header.site nav{margin-left:auto;display:flex;gap:16px;font-size:14px}
header.site a{color:#d8ece2;text-decoration:none}
header.site a:hover{text-decoration:underline}
main{max-width:720px;margin:0 auto;padding:28px 20px 64px}
h1{font-size:26px;margin:0 0 6px;letter-spacing:-.2px}
.lede{color:var(--muted);margin:0 0 22px;font-size:15px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:22px}
.field{margin:0 0 18px}
label{display:block;font-weight:600;font-size:14px;margin-bottom:6px}
.hint{font-size:12.5px;color:var(--muted);margin:5px 0 0}
input[type=text],input[type=email],input[type=tel],input[type=number],input[type=date],
select,textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:7px;
font:inherit;background:#fff;color:var(--ink)}
textarea{min-height:88px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid #7fb8a0;outline-offset:1px;
border-color:#7fb8a0}
optgroup{font-weight:600}
.err{color:var(--bad);font-size:13px;margin:6px 0 0;font-weight:600}
fieldset{border:1px solid var(--line);border-radius:8px;padding:6px 16px 14px;margin:0 0 18px}
legend{font-weight:700;font-size:14px;padding:0 6px}
.purpose{padding:12px 0;border-bottom:1px solid #eef0f4}
.purpose:last-of-type{border-bottom:0}
.purpose .row{display:flex;gap:10px;align-items:flex-start}
.purpose input[type=checkbox]{margin:3px 0 0;width:17px;height:17px;flex:none}
.purpose .ptitle{font-weight:600;font-size:14.5px}
.purpose .pdesc{font-size:13px;color:var(--muted);margin:2px 0 0}
.purpose .meta{font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;
color:var(--muted);margin-top:4px}
.purpose .meta b{color:var(--accent);font-weight:700}
.purpose.locked{color:var(--muted)}
.purpose.locked .ptitle{font-weight:600}
button{font:inherit;font-weight:700;border:0;border-radius:8px;padding:12px 20px;
background:var(--accent);color:var(--accent-ink);cursor:pointer}
button[disabled]{opacity:.6;cursor:progress}
button.secondary{background:#e8ecef;color:var(--ink);font-weight:600}
.notice{font-size:13px;color:var(--muted);margin:18px 0 0}
.notice a{color:var(--accent)}
.receipt{margin-top:20px;border-top:1px solid var(--line);padding-top:16px}
.receipt h2{font-size:16px;margin:0 0 10px}
.receipt ul{list-style:none;margin:0;padding:0}
.receipt li{display:flex;gap:10px;align-items:baseline;font-size:13.5px;padding:7px 0;
border-bottom:1px solid #f0f2f5}
.receipt li:last-child{border-bottom:0}
.pill{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;
padding:2px 8px;border-radius:99px;border:1px solid;flex:none}
.pill.sent{color:var(--ok);border-color:#a9d6bf;background:#eef8f2}
.pill.not_sent{color:var(--warn);border-color:#e6d3b3;background:#fdf6ea}
.pill.blocked{color:var(--bad);border-color:#f0c2bd;background:#fdefed}
.pill.skipped{color:var(--muted);border-color:var(--line);background:#f6f7f9}
.pill.failed{color:#fff;background:var(--bad);border-color:var(--bad)}
.pill.replayed{color:var(--accent);border-color:#a9d6bf;background:#eef8f2}
.banner{border:1px solid #f0c2bd;background:#fdefed;color:var(--bad);border-radius:8px;
padding:12px 14px;font-size:14px;margin:0 0 18px;font-weight:600}
.ok-banner{border:1px solid #a9d6bf;background:#eef8f2;color:var(--ok)}
footer.site{max-width:720px;margin:0 auto;padding:0 20px 40px;font-size:12.5px;
color:var(--muted)}
code{background:#eef0f4;padding:1px 5px;border-radius:4px;font-size:12.5px}
.diag{font-size:12.5px;color:var(--muted);margin-top:14px}
`;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const CLIENT = {
  name: "Amarcco Leads & Marketing LLC",
  short: "Amarcco",
  site: "https://www.amarccollc.com",
  privacy: "https://www.amarccollc.com/privacypolicy",
  terms: "https://www.amarccollc.com/terms",
};

function shell({ title, body }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<style>${CSS}</style>
</head><body>
<header class="site">
  <strong>${esc(CLIENT.name)}</strong>
  <span class="sub">Finance lead request</span>
  <nav>
    <a href="${CLIENT.site}" rel="noopener">Main site</a>
    <a href="${CLIENT.privacy}" rel="noopener">Privacy</a>
    <a href="${CLIENT.terms}" rel="noopener">Terms</a>
  </nav>
</header>
${body}
<footer class="site">
  ${esc(CLIENT.name)} · this form is operated by LeadLoom on the client's behalf.
  Data collected here is used only for the purposes listed, and only where you have
  agreed to them. <a href="${CLIENT.privacy}" rel="noopener">Privacy policy</a> ·
  <a href="${CLIENT.terms}" rel="noopener">Terms</a>
</footer>
</body></html>`;
}

const VERTICALS = {
  mortgage: ["Mortgage refinance", "New home purchase", "Reverse mortgage"],
  debt: ["Credit card debt", "Tax debt", "Unsecured debt"],
  legal: ["Legal enquiry"],
  insurance: ["Insurance enquiry"],
};

function fieldHtml(f) {
  const id = `f_${f.name}`;
  const req = f.required ? " required" : "";
  const lbl = `<label for="${id}">${esc(f.label || f.name)}${f.required ? " *" : ""}</label>`;
  let input;
  if (f.type === "longtext") {
    input = `<textarea id="${id}" name="${esc(f.name)}"${req}${f.max_length
      ? ` maxlength="${f.max_length}"` : ""}></textarea>`;
  } else if (f.type === "select") {
    const groups = Object.entries(VERTICALS);
    const isVertical = f.name === "vertical";
    const opts = isVertical
      ? groups.map(([g, xs]) => `<optgroup label="${esc(g)}">${
        xs.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("")}</optgroup>`)
        .join("")
      : f.options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
    input = `<select id="${id}" name="${esc(f.name)}"${req}>
      <option value="">Please choose…</option>${opts}</select>`;
  } else if (f.type === "multiselect") {
    input = f.options.map((o) => `<label class="check"><input type="checkbox"
      name="${esc(f.name)}" value="${esc(o)}"> ${esc(o)}</label>`).join("");
  } else if (f.type === "checkbox") {
    input = `<input type="checkbox" id="${id}" name="${esc(f.name)}" value="true">`;
  } else {
    const t = f.type === "text" || f.type === "hidden" ? "text" : f.type;
    input = `<input type="${t}" id="${id}" name="${esc(f.name)}"${req}${f.max_length
      ? ` maxlength="${f.max_length}"` : ""}>`;
  }
  return `<div class="field">${lbl}${input}${f.help
    ? `<p class="hint">${esc(f.help)}</p>` : ""}<p class="err" data-err="${esc(f.name)}"
    hidden></p></div>`;
}

function purposeHtml(p) {
  if (p.basis !== "consent") {
    // Not a checkbox. A contract or legal-obligation purpose is not something the person
    // can opt out of by unticking a box, and rendering it as one would be theatre.
    return `<div class="purpose locked">
      <div class="ptitle">${esc(p.label)}</div>
      <p class="pdesc">${esc(p.description)}</p>
      <p class="meta">Required for the service · basis: ${esc(p.basis.replace(/_/g, " "))}</p>
    </div>`;
  }
  return `<div class="purpose">
    <div class="row">
      <input type="checkbox" id="p_${esc(p.key)}" name="purpose" value="${esc(p.key)}"
        ${p.required ? "data-required=\"1\"" : ""}>
      <div>
        <label class="ptitle" for="p_${esc(p.key)}">${esc(p.label)}${p.required ? " *" : ""}</label>
        <p class="pdesc">${esc(p.description)}</p>
        <p class="meta">${p.required ? "Required" : "Optional"} · basis: <b>consent</b></p>
      </div>
    </div>
  </div>`;
}

export function formPage({ form, notice, env, transport }) {
  const purposes = form.purposes.map(purposeHtml).join("");
  const fields = form.fields.filter((f) => f.type !== "hidden").map(fieldHtml).join("");
  const hidden = form.fields.filter((f) => f.type === "hidden")
    .map((f) => `<input type="hidden" name="${esc(f.name)}" value="">`).join("");
  const dry = transport === "dry-run";
  return shell({
    title: `${form.title} — ${CLIENT.short}`,
    body: `<main>
  <h1>${esc(form.title)}</h1>
  <p class="lede">Tell us what you need and we will route it to a licensed specialist.
  Everything below is used only for the purposes you agree to.</p>
  ${dry ? `<div class="banner ok-banner">This deployment is in dry-run: submissions are
  validated, stored and gated exactly as in production, but no data is transmitted to any
  third party.</div>` : ""}
  <form class="card" id="lead" method="post" action="/submit" novalidate>
    ${fields}
    ${hidden}
    <fieldset>
      <legend>How we may use your details</legend>
      ${purposes}
    </fieldset>
    <button type="submit" id="go">Send my request</button>
    <p class="notice">${esc(CLIENT.name)} keeps your details for
    ${form.retention_days} days. Your choices are recorded with the exact wording of the
    notice that was in force when you submitted, and withdrawing consent is honoured
    immediately for anything not yet sent. See the
    <a href="${CLIENT.privacy}" rel="noopener">privacy policy</a> and
    <a href="${CLIENT.terms}" rel="noopener">terms</a>. Notice
    <code>${esc(notice.notice_id)}</code>, form <code>${esc(form.form_id)}@${form.version}</code>.</p>
  </form>
  <div id="out" aria-live="polite"></div>
</main>
<script>
${FORM_JS}
</script>`,
  });
}

const FORM_JS = String.raw`
(function () {
  var form = document.getElementById("lead");
  var out = document.getElementById("out");
  var go = document.getElementById("go");

  function clickIds() {
    var q = new URLSearchParams(location.search);
    var ids = {};
    ["gclid","gbraid","wbraid","fbclid","ttclid","msclkid"].forEach(function (k) {
      var v = q.get(k) || (window.localStorage && localStorage.getItem("ll_" + k));
      if (v) ids[k] = v;
    });
    return ids;
  }

  function collect() {
    var data = {}, purposes = {}, fd = new FormData(form);
    form.querySelectorAll(".field input, .field select, .field textarea").forEach(function (el) {
      if (!el.name) return;
      if (el.type === "checkbox") data[el.name] = el.checked;
      else if (el.type === "multiselect") return;
      else if (el.value !== "") data[el.name] = el.value;
    });
    form.querySelectorAll('input[name="purpose"]').forEach(function (el) {
      purposes[el.value] = el.checked;
    });
    return { data: data, consent: purposes };
  }

  function showErrors(details) {
    form.querySelectorAll("[data-err]").forEach(function (p) {
      p.hidden = true; p.textContent = "";
    });
    Object.keys(details || {}).forEach(function (k) {
      var p = form.querySelector('[data-err="' + k + '"]');
      if (p) { p.hidden = false; p.textContent = details[k]; }
    });
  }

  // Reasons are written for a person: a receipt that says "no_credential" tells the visitor
  // nothing and looks like a crash.
  var REASONS = {
    ok: "delivered",
    dry_run: "dry-run: not transmitted",
    blocked_by_purpose_gate: "not permitted by the choices you made",
    customer_data_sharing_not_enabled: "sharing is switched off for this service",
    no_credential: "not configured yet, so nothing was sent",
    nothing_to_send: "nothing to send for this enquiry"
  };

  function pill(status) {
    var s = document.createElement("span");
    s.className = "pill " + status;
    s.textContent = status.replace("_", "-");
    return s;
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    go.disabled = true;
    go.textContent = "Sending…";
    out.innerHTML = "";
    var payload = collect();
    payload.click_ids = clickIds();
    payload.form_id = form.dataset.formId || undefined;
    var idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now());
    fetch(location.pathname.replace(/\/$/, "") + "/submit", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idem },
      body: JSON.stringify(payload)
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    }).then(function (res) {
      go.disabled = false;
      go.textContent = "Send my request";
      if (res.status >= 400) {
        showErrors(res.body.details);
        var b = document.createElement("div");
        b.className = "banner";
        b.textContent = res.body.error || "Something went wrong.";
        out.appendChild(b);
        return;
      }
      form.hidden = true;
      var box = document.createElement("div");
      box.className = "card receipt";
      var h = document.createElement("h2");
      h.textContent = res.body.replayed ? "Already received" : "Request received";
      box.appendChild(h);
      var p = document.createElement("p");
      p.className = "lede";
      p.textContent = "Reference " + res.body.submission_id + ". What happened to it:";
      box.appendChild(p);
      var ul = document.createElement("ul");
      (res.body.deliveries || []).forEach(function (d) {
        var li = document.createElement("li");
        li.appendChild(pill(d.status));
        var t = document.createElement("span");
        t.textContent = d.destination + " — " + (REASONS[d.reason] || d.reason);
        li.appendChild(t);
        ul.appendChild(li);
      });
      box.appendChild(ul);
      out.appendChild(box);
    }).catch(function (e) {
      go.disabled = false;
      go.textContent = "Send my request";
      var b = document.createElement("div");
      b.className = "banner";
      b.textContent = "Network error: " + e.message + ". Nothing was sent.";
      out.appendChild(b);
    });
  });
})();
`;

export function errorPage(code, message) {
  return shell({
    title: `${code} — ${CLIENT.short}`,
    body: `<main><h1>${esc(code)}</h1><p class="lede">${esc(message)}</p></main>`,
  });
}
