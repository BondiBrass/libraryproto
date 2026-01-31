/* HYBRID (hard-coded API URL, no ?api, no localStorage)
- Reads Inventory + Responses via published CSV URLs
- Uses Apps Script ONLY for:
   - config + whoami via JSONP (no CORS)
   - submit vote/comment via hidden <form> POST (no CORS)
*/

// ✅ Paste your working web app URL here (start with https://script.google.com/.../exec OR https://script.googleusercontent.com/...)
const API_URL = "https://script.google.com/macros/s/AKfycbw8VR3LsGs6Jm2Zy6g3K8WmPLhQEYzJs4pd-_M-Vz3ypPpqXH18o-25eCSjV80jcNez/exec";

let config = null;
let inventory = [];
let responses = [];
let session = { ok:false, email:null, role:"guest" };

let activeClass10 = null;
let pageSize = 100;
let pageOffset = 0;
let showDash = false;

const els = {};
window.addEventListener("DOMContentLoaded", () => {
  ["emailInput","loginBtn","loginStatus","reloadBtn","dashBtn","search","classPills","cards","stats","banner","dashboard","loadMoreBtn","modePill"]
    .forEach(id => els[id] = document.getElementById(id));

  els.loginBtn.addEventListener("click", login);
  els.reloadBtn.addEventListener("click", reloadAll);
  els.search.addEventListener("input", () => { pageOffset = 0; render(); });
  els.dashBtn.addEventListener("click", () => { showDash = !showDash; renderDashboard(); });
  els.loadMoreBtn.addEventListener("click", () => { pageOffset += pageSize; render(); });

  if(!API_URL || API_URL.includes("PASTE_YOUR_")){
    showBanner("Set API_URL in app.js (paste your working Apps Script Web App URL).");
    els.modePill.textContent = "API not set";
    els.modePill.classList.add("active");
    els.reloadBtn.disabled = true;
    return;
  }

  reloadAll();
});

function showBanner(msg){
  els.banner.style.display = msg ? "block" : "none";
  els.banner.textContent = msg || "";
}

function jsonp(action, params){
  return new Promise((resolve, reject) => {
    const cb = "cb_" + Math.random().toString(36).slice(2);
    let done = false;

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("jsonp_timeout"));
    }, 12000);

    function cleanup(){
      if(done) return;
      done = true;
      clearTimeout(timeout);
      try { delete window[cb]; } catch {}
      try { script.remove(); } catch {}
    }

    window[cb] = (data) => {
      if(done) return; // ignore duplicate callback invocations
      clearTimeout(timeout);
      done = true;
      try { delete window[cb]; } catch {}
      try { script.remove(); } catch {}
      resolve(data);
    };

    const url = new URL(API_URL);
    url.searchParams.set("action", action);
    url.searchParams.set("callback", cb);
    Object.entries(params || {}).forEach(([k,v]) => url.searchParams.set(k, v));

    const script = document.createElement("script");
    script.src = url.toString();
    script.onerror = () => {
      if(done) return;
      cleanup();
      reject(new Error("jsonp_error"));
    };
    document.head.appendChild(script);
  });
}

async function reloadAll(){
  showBanner("");

  try {
    const cfgResp = await jsonp("configp", {});
    if(!cfgResp.ok) throw new Error(cfgResp.error || "config_failed");
    config = cfgResp.config;

    if(!config.voting_enabled){
      els.modePill.textContent = "Read-only (voting off)";
      els.modePill.classList.add("active");
      showBanner("Voting is currently DISABLED (read-only).");
    } else if(config.rehearsal_mode){
      els.modePill.textContent = "Rehearsal mode";
      els.modePill.classList.add("active");
      showBanner("Rehearsal mode is ON: submissions won’t be written.");
    } else {
      els.modePill.textContent = "Live";
      els.modePill.classList.remove("active");
    }

    await Promise.all([loadInventory(), loadResponses()]);
    buildClassPills();
    pageOffset = 0;
    render();
    renderDashboard();

    els.stats.textContent = `Inventory: ${inventory.length} • Responses: ${responses.length}`;
    els.reloadBtn.disabled = false;
  } catch (e) {
    showBanner("Load failed: " + (e.message || e));
  }
}

async function loadInventory(){
  const t = await (await fetch(config.inventory_csv)).text();
  inventory = parseCsv(t);
}
async function loadResponses(){
  const t = await (await fetch(config.responses_csv)).text();
  responses = parseCsv(t);
}

async function login(){
  const email = (els.emailInput.value||"").trim().toLowerCase();
  if(!email){ alert("Enter your email"); return; }

  try{
    const r = await jsonp("whoamip", { email });
    if(!r.ok){
      session = { ok:false, email:null, role:"guest" };
      els.loginStatus.textContent = "Not approved (view-only)";
      els.dashBtn.style.display = "none";
      showDash = false;
      renderDashboard();
      render();
      return;
    }
    session = r;
    els.loginStatus.textContent = `${session.email} (${session.role})`;
    els.dashBtn.style.display = (session.role === "admin") ? "inline-block" : "none";
    renderDashboard();
    render();
  } catch(e){
    alert("Login check failed: " + (e.message || e));
  }
}

function buildClassPills(){
  const set = new Set(inventory.map(r => (r.CLASS10||"").trim()).filter(Boolean));
  const vals = Array.from(set).sort();
  els.classPills.innerHTML = "";

  const add = (label, value) => {
    const d = document.createElement("div");
    d.className = "pill" + ((activeClass10===value) ? " active" : "");
    d.textContent = label;
    d.onclick = () => { activeClass10 = (activeClass10===value) ? null : value; pageOffset = 0; buildClassPills(); render(); };
    els.classPills.appendChild(d);
  };

  add("All", null);
  vals.forEach(v => add(v, v));
}

function render(){
  const q = (els.search.value||"").toLowerCase().trim();

  let rows = inventory;
  if(activeClass10) rows = rows.filter(r => (r.CLASS10||"").trim() === activeClass10);
  if(q){
    rows = rows.filter(r => {
      const hay = `${r.TITLE||""} ${r.COMPOSER||""} ${r.ARRANGER||""} ${r.CLASS||""} ${r.NOTE1||""} ${r.NOTE2||""} ${r["PERFORMANCE NOTES"]||""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  els.cards.innerHTML = "";
  const page = rows.slice(pageOffset, pageOffset + pageSize);
  page.forEach(r => els.cards.appendChild(renderCard(r)));
  els.loadMoreBtn.style.display = (pageOffset + pageSize < rows.length) ? "inline-block" : "none";
}

function renderCard(r){
  const div = document.createElement("div");
  div.className = "card";

  const id = r.ID || "";
  const title = r.TITLE || "(no title)";
  const meta = [r.CLASS10, r.CLASS, r.COMPOSER, r.ARRANGER, r.PART_TYPE].filter(Boolean).join(" • ");

  const myResp = responses.filter(x => (x.ID||"") === id);
  const topComments = myResp.slice(-3).map(x => `• ${x.EMAIL||"?"}: ${x.COMMENT||""}`).join("\n");

  const locked = !session.ok;

  div.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <div class="meta">${escapeHtml(meta)}</div>
    <div class="meta muted">ID: ${escapeHtml(id)} • Box: ${escapeHtml(r.BOX||"")}</div>

    <div class="row">
      <button class="btn secondary" data-act="want" ${locked ? "disabled":""}>People’s choice ✅</button>
      <button class="btn secondary" data-act="maybe" ${locked ? "disabled":""}>Maybe 🤔</button>
      <button class="btn secondary" data-act="no" ${locked ? "disabled":""}>Not for now ✋</button>
    </div>

    <div class="row">
      <textarea placeholder="${locked ? "Sign in to comment" : "Comment (optional)"}" ${locked ? "disabled":""}></textarea>
      <button class="btn" data-act="submit" ${locked ? "disabled":""}>Submit</button>
    </div>

    <pre>${escapeHtml(topComments || "")}</pre>
  `;

  const buttons = div.querySelectorAll("button[data-act]");
  const ta = div.querySelector("textarea");
  let choice = "";

  buttons.forEach(b => {
    const act = b.getAttribute("data-act");
    if(act==="want"||act==="maybe"||act==="no"){
      b.onclick = () => {
        choice = act.toUpperCase();
        buttons.forEach(x => x.classList.remove("active"));
        b.classList.add("active");
      };
    }
    if(act==="submit"){
      b.onclick = async () => {
        if(!session.ok){ alert("Sign in first (approved email)."); return; }
        if(!choice){ alert("Pick a choice first."); return; }
        await submitViaForm({
          email: session.email,
          id,
          choice,
          comment: ta.value || "",
          user_agent: navigator.userAgent
        });
        await loadResponses();
        render();
        renderDashboard();
      };
    }
  });

  return div;
}

function submitViaForm(payload){
  return new Promise((resolve) => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = API_URL;
    form.target = "postTarget";

    const fields = { action:"submit", ...payload };
    Object.entries(fields).forEach(([k,v]) => {
      const inp = document.createElement("input");
      inp.type = "hidden";
      inp.name = k;
      inp.value = String(v ?? "");
      form.appendChild(inp);
    });

    document.body.appendChild(form);
    form.submit();
    form.remove();

    setTimeout(resolve, 800);
  });
}

function renderDashboard(){
  if(session.role !== "admin" || !showDash){
    els.dashboard.style.display = "none";
    els.dashboard.innerHTML = "";
    return;
  }
  els.dashboard.style.display = "block";

  const approvedEmails = new Set(responses.map(r => String(r.EMAIL||"").trim().toLowerCase()).filter(Boolean));
  const totalVotes = responses.length;
  const wantVotes = responses.filter(r => String(r.CHOICE||"").toUpperCase()==="WANT").length;

  const wantById = new Map();
  for(const r of responses){
    if(String(r.CHOICE||"").toUpperCase()!=="WANT") continue;
    const id = String(r.ID||"").trim();
    if(!id) continue;
    wantById.set(id, (wantById.get(id)||0)+1);
  }
  const topIds = Array.from(wantById.entries()).sort((a,b)=>b[1]-a[1]).slice(0,10);

  const invById = new Map(inventory.map(r => [String(r.ID||"").trim(), r]));
  const topRows = topIds.map(([id,count]) => {
    const it = invById.get(id) || {};
    return { id, count, title: it.TITLE || "", class10: it.CLASS10 || "" };
  });

  const wantByClass = new Map();
  for(const [id,count] of wantById.entries()){
    const it = invById.get(id) || {};
    const c = String(it.CLASS10||"").trim() || "(blank)";
    wantByClass.set(c, (wantByClass.get(c)||0)+count);
  }
  const classRows = Array.from(wantByClass.entries()).sort((a,b)=>b[1]-a[1]).slice(0,12);

  const recent = responses.slice(-20).reverse();

  els.dashboard.innerHTML = `
    <div class="pills">
      <div class="pill tiny">Voters seen: <b>${approvedEmails.size}</b></div>
      <div class="pill tiny">Total responses: <b>${totalVotes}</b></div>
      <div class="pill tiny">People’s choice: <b>${wantVotes}</b></div>
    </div>

    <div class="dash-grid">
      <div class="dash-card">
        <h4>Top 10 People’s Choice</h4>
        <table>
          <thead><tr><th>#</th><th>Title</th><th>Class10</th><th>WANT</th><th>ID</th></tr></thead>
          <tbody>
            ${topRows.map((r,i)=>`
              <tr>
                <td>${i+1}</td>
                <td>${escapeHtml(r.title)}</td>
                <td>${escapeHtml(r.class10)}</td>
                <td><b>${r.count}</b></td>
                <td class="muted">${escapeHtml(r.id)}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>

      <div class="dash-card">
        <h4>People’s Choice by CLASS10</h4>
        <table>
          <thead><tr><th>Class10</th><th>WANT</th></tr></thead>
          <tbody>
            ${classRows.map(([c,n])=>`
              <tr><td>${escapeHtml(c)}</td><td><b>${n}</b></td></tr>`).join("")}
          </tbody>
        </table>
      </div>

      <div class="dash-card">
        <h4>Recent responses</h4>
        <table>
          <thead><tr><th>When</th><th>Email</th><th>Choice</th><th>ID</th></tr></thead>
          <tbody>
            ${recent.map(r=>`
              <tr>
                <td class="muted">${escapeHtml(String(r.TIMESTAMP||""))}</td>
                <td>${escapeHtml(String(r.EMAIL||""))}</td>
                <td><b>${escapeHtml(String(r.CHOICE||""))}</b></td>
                <td class="muted">${escapeHtml(String(r.ID||""))}</td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function parseCsv(text){
  const lines = text.trim().split(/\r?\n/);
  if(lines.length < 1) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).filter(Boolean).map(line => {
    const cols = splitCsvLine(line);
    const o = {};
    headers.forEach((h,i) => o[h] = cols[i] ?? "");
    return o;
  });
}

function splitCsvLine(line){
  const out = [];
  let cur = "", inQ = false;
  for(let i=0;i<line.length;i++){
    const ch = line[i];
    if(ch === '"' ){
      if(inQ && line[i+1] === '"'){ cur+='"'; i++; }
      else inQ = !inQ;
    } else if(ch === "," && !inQ){
      out.push(cur); cur="";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function escapeHtml(s){
  return String(s||"").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
