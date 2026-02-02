/* BBLib app.js (final zip build)
   - NO config fetch from Apps Script (your backend rejects query params: unknown_action)
   - Reads inventory + responses directly from published CSV URLs (hard-coded below)
   - Writes responses back via hidden <form> POST to Apps Script /exec (CORS bypass)
   - Features:
     * Modal login (provided by index.html: window.BBLibAuth)
     * Two filter pill groups: Class (CLASS10/CLASS) + Meg’s Genre (GENRE)
     * Pill counts (faceted)
     * Duration shown on card
     * Per-user state (already voted/commented)
     * Visual feedback (toast + inline status)
     * Admin-only dashboard button (admin emails list below)
     * Comment box per card + Save comment
     * More details accordion (all fields)
     * Play button if RECORDINGLINK exists
*/

"use strict";

/** ========= SET THESE ========= **/
const API_URL = "https://script.google.com/macros/s/AKfycbw8VR3LsGs6Jm2Zy6g3K8WmPLhQEYzJs4pd-_M-Vz3ypPpqXH18o-25eCSjV80jcNez/exec";

// Paste your published CSV URLs here (from File → Share → Publish to web, output=csv)
const INVENTORY_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRUu3Z1-wYHxAy0isgXvzFq6FCbL00YxeRX0W3W0m4sKGTgEcg488mJwezTMreZvu5seodoYoEZl4AA/pub?gid=0&single=true&output=csv";
const RESPONSES_CSV = "https://docs.google.com/spreadsheets/d/e/2PACX-1vRUu3Z1-wYHxAy0isgXvzFq6FCbL00YxeRX0W3W0m4sKGTgEcg488mJwezTMreZvu5seodoYoEZl4AA/pub?gid=1798293675&single=true&output=csv";

// Optional: publish the "Login" worksheet as CSV and paste it here.
// Columns expected: email, role (role is compared case-insensitively to "admin").
const LOGIN_CSV = "";

// Admin list (emails). Dashboard button only shows for these.
const ADMIN_EMAILS = [
  // "royh@mapshed.com.au",
];

/** ========= STATE ========= **/
let inventory = [];
let responses = [];
let _reloadInFlight = null;

const state = {
  loginRoles: new Map(), // email -> role
  isAdmin: false,

  classSel: new Set(),
  genreSel: new Set(),
  search: "",
  pageSize: 40,
  pageOffset: 0,
  currentUser: null,
  showDash: false,
  publicMode: false, // ?mode=public
  userVotedIds: new Set(),      // IDs user has any response for
  userCommentById: new Map(),   // ID -> latest comment text
};

const els = {};

/** ========= BOOT ========= **/
window.addEventListener("DOMContentLoaded", () => {
  ["loginStatus","reloadBtn","dashBtn","search","classPills","cards","stats","banner","dashboard","loadMoreBtn"]
    .forEach(id => els[id] = document.getElementById(id));

  const qp = new URLSearchParams(location.search);
  state.publicMode = (qp.get("mode") || "").toLowerCase() === "public";

  els.reloadBtn?.addEventListener("click", reloadAll);
  els.search?.addEventListener("input", () => {
    state.search = els.search.value || "";
    state.pageOffset = 0;
    render();
    updatePillCounts();
  });
  els.dashBtn?.addEventListener("click", () => {
    state.showDash = !state.showDash;
    renderDashboard();
  });
  els.loadMoreBtn?.addEventListener("click", () => {
    state.pageOffset += state.pageSize;
    render();
  });

  window.addEventListener("bblib:auth-changed", () => {
    syncUserFromShell();
    deriveUserState();
    applyRoleFromLogin();
    render();
    renderDashboard();
  });
  window.addEventListener("bblib:reload", () => reloadAll());

  if(!INVENTORY_CSV || INVENTORY_CSV.includes("PASTE_")){
    showBanner("Set INVENTORY_CSV and RESPONSES_CSV at the top of app.js (published CSV URLs).");
    return;
  }

  ensureFilterGroups();
  syncUserFromShell();
  reloadAll();
});

function syncUserFromShell(){
  if(state.publicMode){
    state.currentUser = null;
    if(els.loginStatus) els.loginStatus.textContent = "Public mode";
    return;
  }
  const email = window.BBLibAuth?.getUserEmail?.() || "";
  state.currentUser = email ? String(email).trim().toLowerCase() : null;
  if(els.loginStatus){
    els.loginStatus.textContent = state.currentUser ? state.currentUser : "Not logged in";
  }
}

function isAdmin(){ return !!state.isAdmin; }

/** ========= MAIN LOAD ========= **/
async function reloadAll(){
  if(_reloadInFlight) return _reloadInFlight;
  _reloadInFlight = (async () => {
    showBanner("");
    if(els.reloadBtn) els.reloadBtn.disabled = true;

    try{
      if(els.dashBtn){
        els.dashBtn.style.display = isAdmin() ? "inline-flex" : "none";
      }
      if(state.publicMode){
        showBanner("Public mode (read-only): browsing enabled, voting/comments disabled.");
      }

      await loadInventoryFromCsv(INVENTORY_CSV);
      await loadResponsesFromCsv(RESPONSES_CSV);
      await loadLoginFromCsv(LOGIN_CSV);
      applyRoleFromLogin();

      buildFilterPills();
      deriveUserState();
    applyRoleFromLogin();
      state.pageOffset = 0;

      render();
      renderDashboard();

    }catch(err){
      console.error(err);
      const code = String(err?.message || err);
      let msg = "Could not load data. Check published CSV permissions.";
      if(code === "inventory_not_public") msg = "Inventory CSV is not public (it returned HTML/login). Publish the sheet to web as CSV.";
      else if(code.startsWith("inventory_fetch_")) msg = "Inventory CSV fetch failed (" + code.replace("inventory_fetch_","") + ").";
      else if(code === "inventory_empty") msg = "Inventory CSV loaded but contains no rows.";
      else if(code === "inventory_missing_id_col") msg = "Inventory CSV loaded but is missing the ID column.";
      else if(code === "responses_not_public") msg = "Responses CSV is not public (it returned HTML/login). Publish the sheet to web as CSV.";
      else if(code.startsWith("responses_fetch_")) msg = "Responses CSV fetch failed (" + code.replace("responses_fetch_","") + ").";
      else msg = "Could not load data. (" + code + ")";
      showBanner(msg);
    }finally{
      if(els.reloadBtn) els.reloadBtn.disabled = false;
      _reloadInFlight = null;
    }
  })();
  return _reloadInFlight;
}

/** ========= LOADERS ========= **/
async function loadInventoryFromCsv(url){
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  if(!r.ok) throw new Error("inventory_fetch_" + r.status);
  if(isProbablyHtml(text)) throw new Error("inventory_not_public");

  inventory = parseCsv(text);
  if(inventory.length === 0) throw new Error("inventory_empty");
  const cols = Object.keys(inventory[0] || {}).map(h => h.toUpperCase());
  if(!cols.includes("ID")) throw new Error("inventory_missing_id_col");
  inventory = inventory.map(row => normalizeRow(row));
}

async function loadResponsesFromCsv(url){
  if(!url || url.includes("PASTE_")){
    responses = [];
    return;
  }
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  if(!r.ok) throw new Error("responses_fetch_" + r.status);
  if(isProbablyHtml(text)) throw new Error("responses_not_public");
  responses = parseCsv(text).map(row => normalizeResponseRow(row));
}

function isProbablyHtml(s){
  const t = (s||"").trim().slice(0,200).toLowerCase();
  return t.includes("<!doctype") || t.includes("<html") || t.includes("<head") || t.includes("<body");
}

/** ========= CSV PARSE + NORMALIZE ========= **/
function parseCsv(text){
  const rows = [];
  let i = 0, field = "", row = [], inQuotes = false;
  if(text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  while(i < text.length){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      }else field += c;
    }else{
      if(c === '"') inQuotes = true;
      else if(c === ","){ row.push(field); field = ""; }
      else if(c === "\n"){
        row.push(field); field = "";
        if(row.some(v => String(v||"").trim() !== "")) rows.push(row);
        row = [];
      }else if(c !== "\r") field += c;
    }
    i++;
  }
  if(field.length || row.length){
    row.push(field);
    if(row.some(v => String(v||"").trim() !== "")) rows.push(row);
  }
  if(rows.length === 0) return [];
  const header = rows[0].map(h => String(h||"").trim());
  const out = [];
  for(let r = 1; r < rows.length; r++){
    const obj = {};
    for(let c = 0; c < header.length; c++){
      obj[header[c] || ("col" + c)] = rows[r][c] ?? "";
    }
    out.push(obj);
  }
  return out;
}

function pick(obj, keys){
  for(const k of keys){
    if(obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k];
  }
  return "";
}

function normalizeRow(row){
  return {
    ...row,
    _ID: String(pick(row, ["ID","id","Id"])).trim(),
    _TITLE: String(pick(row, ["TITLE","Title","title"])).trim(),
    _SUBTITLE: String(pick(row, ["SUBTITLE","Subtitle","subtitle"])).trim(),
    _CLASS: String(pick(row, ["CLASS10","CLASS","Class10","Class","class10","class"])).trim(),
    _GENRE: (String(pick(row, ["GENRE","Genre","genre"])).trim() || "Unknown"),
    _DURATION: String(pick(row, ["DURATION","Duration","LENGTH","Length"])).trim(),
    _COMPOSER: String(pick(row, ["COMPOSER","Composer","composer"])).trim(),
    _ARRANGER: String(pick(row, ["ARRANGER","Arranger","arranger"])).trim(),
    _RECORDING: String(pick(row, ["RECORDINGLINK","RECORDING_LINK","Recording Link","recordinglink"])).trim(),
  };
}

function normalizeResponseRow(row){
  const email = String(pick(row, ["EMAIL","email","Email","USER","user"])).trim().toLowerCase();
  const id = String(pick(row, ["ID","id","Id","ITEM_ID","item_id"])).trim();
  const choice = String(pick(row, ["CHOICE","choice","VOTE","vote","THUMBS","thumbs"])).trim();
  const comment = String(pick(row, ["COMMENT","comment","NOTES","notes"])).trim();
  const ts = String(pick(row, ["TS","ts","TIMESTAMP","timestamp","DATE","date"])).trim();
  return { ...row, _EMAIL: email, _ID: id, _CHOICE: choice, _COMMENT: comment, _TS: ts };
}
/** ========= LOGIN / ROLES (optional) ========= **/
async function loadLoginFromCsv(url){
  state.loginRoles = new Map();
  if(!url) return;
  const r = await fetch(url, { cache: "no-store" });
  const text = await r.text();
  if(!r.ok) throw new Error("login_fetch_" + r.status);
  if(isProbablyHtml(text)) throw new Error("login_not_public");
  const rows = parseCsv(text);
  for(const row of rows){
    const email = String(pick(row, ["email","EMAIL","Email"])).trim().toLowerCase();
    const role  = String(pick(row, ["role","ROLE","Role"])).trim().toLowerCase();
    if(!email) continue;
    state.loginRoles.set(email, role);
  }
}

function applyRoleFromLogin(){
  const email = state.currentUser ? String(state.currentUser).trim().toLowerCase() : "";
  const role = email ? (state.loginRoles.get(email) || "") : "";
  state.isAdmin = (role === "admin") || isAdminFallback();
  if(els.dashBtn){
    els.dashBtn.style.display = state.isAdmin ? "inline-flex" : "none";
  }
}

function isAdminFallback(){
  if(!state.currentUser) return false;
  return ADMIN_EMAILS.map(s=>s.toLowerCase()).includes(String(state.currentUser).toLowerCase());
}



/** ========= FILTER UI ========= **/
function ensureFilterGroups(){
  els.classPills.innerHTML = `
    <div class="pillgroup">
      <div class="pillgroup-title"><span class="msi">category</span> <b>CLASS Filter</b></div>
      <div id="pillsClass" class="pills"></div>
    </div>
    <div class="pillgroup" style="margin-top:8px;">
      <div class="pillgroup-title"><span class="msi">category</span> <b>Meg’s Genre Filter</b></div>
      <div id="pillsGenre" class="pills"></div>
    </div>
  `;
}

function buildFilterPills(){
  const classHost = document.getElementById("pillsClass");
  const genreHost = document.getElementById("pillsGenre");
  if(!classHost || !genreHost) return;

  const classes = uniqueValues(inventory, r => r._CLASS).filter(Boolean);
  const genres  = uniqueValues(inventory, r => r._GENRE).filter(Boolean);

  renderPills(classHost, classes, state.classSel, "class");
  renderPills(genreHost,  genres,  state.genreSel, "genre");
  updatePillCounts();
}

function uniqueValues(arr, getter){
  const set = new Set();
  for(const a of arr){
    const v = String(getter(a) || "").trim();
    if(v) set.add(v);
  }
  return Array.from(set).sort((a,b) => a.localeCompare(b));
}

function renderPills(host, values, selSet, type){
  host.innerHTML = "";
  for(const v of values){
    const btn = document.createElement("button");
    btn.className = "pill";
    btn.type = "button";
    btn.dataset.type = type;
    btn.dataset.value = v;
    btn.innerHTML = `<span class="pilltext">${escapeHtml(v)}</span><span class="pillcount" data-count-for="${type}:${escapeHtmlAttr(v)}">0</span>`;
    btn.addEventListener("click", () => {
      if(selSet.has(v)) selSet.delete(v); else selSet.add(v);
      state.pageOffset = 0;
      render();
      updatePillCounts();
      btn.classList.toggle("active", selSet.has(v));
    });
    btn.classList.toggle("active", selSet.has(v));
    host.appendChild(btn);
  }
}

function updatePillCounts(){
  const base = inventory.filter(row => matchesSearch(row));

  const classCounts = new Map();
  const baseForClass = base.filter(row => matchesSet(row._GENRE, state.genreSel));
  for(const row of baseForClass){
    const k = row._CLASS || "";
    if(!k) continue;
    classCounts.set(k, (classCounts.get(k)||0) + 1);
  }

  const genreCounts = new Map();
  const baseForGenre = base.filter(row => matchesSet(row._CLASS, state.classSel));
  for(const row of baseForGenre){
    const k = row._GENRE || "Unknown";
    genreCounts.set(k, (genreCounts.get(k)||0) + 1);
  }

  document.querySelectorAll(".pillcount[data-count-for]").forEach(el => {
    const key = el.getAttribute("data-count-for");
    const [type, rawVal] = key.split(":");
    const val = unescapeHtmlAttr(rawVal);
    const n = (type === "class") ? (classCounts.get(val) || 0) : (genreCounts.get(val) || 0);
    el.textContent = String(n);
  });
}

function matchesSet(value, set){
  if(set.size === 0) return true;
  return set.has(String(value||"").trim());
}

function matchesSearch(row){
  const q = (state.search || "").trim().toLowerCase();
  if(!q) return true;
  const hay = [
    row._ID, row._TITLE, row._SUBTITLE, row._CLASS, row._GENRE,
    row._COMPOSER, row._ARRANGER,
    String(row["PERFORMANCE NOTES"] || row["PERFORMANCE NOTES "] || row["PERFORMANCE NOTES\t"] || ""),
    String(row["NOTE1"]||""), String(row["NOTE2"]||"")
  ].join(" ").toLowerCase();
  return hay.includes(q);
}

/** ========= RENDER ========= **/
function getFiltered(){
  return inventory.filter(row =>
    matchesSearch(row) &&
    matchesSet(row._CLASS, state.classSel) &&
    matchesSet(row._GENRE, state.genreSel)
  );
}

function render(){
  const rows = getFiltered();
  if(els.stats){
    const sel = [];
    if(state.classSel.size) sel.push("Class: " + Array.from(state.classSel).join(", "));
    if(state.genreSel.size) sel.push("Meg’s Genre: " + Array.from(state.genreSel).join(", "));
    const tail = sel.length ? " • " + sel.join(" • ") : "";
    const total = inventory.length;
    const shown = rows.length;
    const loaded = Math.min(shown, state.pageOffset + state.pageSize);
    const pages = total ? Math.ceil(shown / state.pageSize) : 0;
    const mine = state.currentUser ? state.userVotedIds.size : 0;
    const mineTail = state.currentUser ? ` • Your activity: ${mine}` : "";
    els.stats.textContent = `Showing ${shown} of ${total}` + tail + mineTail;
    }

  const end = Math.min(rows.length, state.pageOffset + state.pageSize);
  const page = rows.slice(0, end);
  if(els.loadMoreBtn){
    els.loadMoreBtn.style.display = (end < rows.length) ? "inline-flex" : "none";
  }

  els.cards.innerHTML = "";
  for(const row of page){
    els.cards.appendChild(renderCard(row));
  }
}

function renderCard(row){
  const card = document.createElement("div");
  card.className = "card";

  const title = row._TITLE || row._ID || "(untitled)";
  const subtitle = row._SUBTITLE ? `<div class="subtitle">${escapeHtml(row._SUBTITLE)}</div>` : "";

  const metaBits = [];
  if(row._COMPOSER) metaBits.push(escapeHtml(row._COMPOSER));
  if(row._ARRANGER) metaBits.push("arr. " + escapeHtml(row._ARRANGER));
  if(row["GRADE"]) metaBits.push("Grade " + escapeHtml(String(row["GRADE"]).trim()));
  if(row._DURATION) metaBits.push("Duration " + escapeHtml(row._DURATION));
  const meta = metaBits.length ? `<div class="meta">${metaBits.join(" · ")}</div>` : "";

  const alreadyVoted = state.userVotedIds.has(row._ID);
  const existingComment = state.userCommentById.get(row._ID) || "";

  const canWrite = (!!state.currentUser) && !state.publicMode;

  const playBtn = row._RECORDING
    ? `<a class="btn small secondary" href="${escapeHtmlAttr(row._RECORDING)}" target="_blank" rel="noopener">🎬 Play</a>`
    : "";

  card.innerHTML = `
    <div class="cardTop">
      <div class="titleRow">
        <div class="title"><span class="workId">${escapeHtml(row._ID||"")}</span><span class="workSep">${(row._ID && row._TITLE)?": ":""}</span><span class="workName">${escapeHtml(row._TITLE||title)}</span></div>
      </div>
      ${subtitle}
      ${meta}
      <div class="tags">
        ${row._CLASS ? `<span class="tag">${escapeHtml(row._CLASS)}</span>` : ""}
        ${row._GENRE ? `<span class="tag">${escapeHtml(row._GENRE)}</span>` : ""}
      </div>
    </div>

    <div class="cardActions">
      <button class="btn small ${alreadyVoted ? "active" : ""}" data-action="vote" ${(!canWrite || alreadyVoted) ? "disabled" : ""}>
        👍 Wish-list
      </button>
      ${playBtn}
      <button class="btn small secondary" data-action="details">More details</button>
      <span class="muted small" data-slot="status">${alreadyVoted ? "You’ve voted" : ""}</span>
    </div>

    <div class="commentRow">
      ${canWrite ? `
        <textarea class="commentInput" placeholder="Add a comment (optional)…">${escapeHtml(existingComment)}</textarea>
        <button class="btn small secondary" data-action="saveComment">Save comment</button>
      ` : `
        <div class="muted small" style="padding:8px 0;">Sign in to leave a comment.</div>
      `}
    </div>

    <details class="details" style="display:none;">
      <summary><span class="detailsSumLine"><span class="msi kvico">category</span><span class="detailsSumText">${escapeHtml(row._ID||"")}${(row._ID&&row._TITLE)?": ":""}${escapeHtml(row._TITLE||"")}</span></span></summary>
      <div class="detailsTop">
        <button class="btn small secondary" data-action="copyDetails">Copy</button>
        <span class="muted tiny">Copies as “column: value”</span>
      </div>
      <div class="kv"></div>
    </details>
  `;

  const btnVote = card.querySelector('button[data-action="vote"]');
  const btnDetails = card.querySelector('button[data-action="details"]');
  const btnSaveComment = card.querySelector('button[data-action="saveComment"]');
  const commentInput = card.querySelector(".commentInput");
  const status = card.querySelector('[data-slot="status"]');
  const details = card.querySelector("details");
  const kv = card.querySelector(".kv");

  btnDetails.addEventListener("click", () => {
    const show = details.style.display === "none";
    details.style.display = show ? "block" : "none";
    if(show){
      kv.innerHTML = renderAllFields(row);
      details.open = true;
    }
  });

  const btnCopy = card.querySelector('button[data-action="copyDetails"]');
  btnCopy?.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const lines = Object.entries(row)
      .filter(([k,v]) => !k.startsWith("_") && String(v||"").trim() !== "")
      .sort((a,b) => a[0].localeCompare(b[0]))
      .map(([k,v]) => `${k}: ${String(v).trim()}`);

    const text = lines.join("\n");
    try{
      await navigator.clipboard.writeText(text);
      toast("Copied ✅", "ok");
    }catch(_){
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try{ document.execCommand("copy"); toast("Copied ✅", "ok"); }
      catch(e2){ console.error(e2); toast("Copy failed", "err"); }
      ta.remove();
    }
  });

  btnVote?.addEventListener("click", async () => {
    const user = window.BBLibAuth?.requireUserEmail?.();
    if(!user) return;

    if(state.userVotedIds.has(row._ID)){
      toast("You already voted.", "info");
      return;
    }

    status.textContent = "Submitting…";
    btnVote.disabled = true;

    try{
      await submitResponse({
        email: user,
        id: row._ID,
        choice: "thumbs_up",
        comment: ((commentInput ? commentInput.value : "") || "").trim()
      });
      status.textContent = "Saved ✅";
      toast("Saved ✅", "ok");
      state.userVotedIds.add(row._ID);
      btnVote.classList.add("active");
      btnVote.disabled = true;

      // also store comment locally (so UI stays in-sync)
      const c = (((commentInput ? commentInput.value : "") || "")).trim();
      if(c) state.userCommentById.set(row._ID, c);

    }catch(e){
      console.error(e);
      status.textContent = "Save failed";
      btnVote.disabled = false;
      toast("Save failed", "err");
    }
  });

  btnSaveComment?.addEventListener("click", async () => {
    const user = window.BBLibAuth?.requireUserEmail?.();
    if(!user) return;

    const comment = (((commentInput ? commentInput.value : "") || "")).trim();
    if(!comment){
      toast("Nothing to save.", "info");
      return;
    }

    status.textContent = "Saving…";
    btnSaveComment.disabled = true;

    try{
      await submitResponse({
        email: user,
        id: row._ID,
        choice: "comment",
        comment
      });
      status.textContent = "Comment saved ✅";
      toast("Comment saved ✅", "ok");
      state.userCommentById.set(row._ID, comment);
      btnSaveComment.disabled = false;
    }catch(e){
      console.error(e);
      status.textContent = "Save failed";
      btnSaveComment.disabled = false;
      toast("Save failed", "err");
    }
  });

  return card;
}

function renderAllFields(row){
  const iconFor = (k) => {
    const key = (k||"").toLowerCase().trim();
    // Common column headings
    if(key === "title" || key === "work" || key === "piece") return "category";
    if(key === "composer" || key === "author" || key === "arranger") return "person";
    if(key === "class" || key === "genre" || key === "category") return "filter_alt";
    if(key === "date" || key === "performance_date") return "calendar_month";
    if(key === "rating" || key === "stars") return "star";
    if(key === "comment" || key === "comments" || key === "notes") return "comment";
    if(key === "id" || key.endsWith("_id")) return "tag";
    return "";
  };

  const priority = (k) => {
    const key = (k||"").toLowerCase().trim();
    if(key === "title") return 0;
    if(key === "composer") return 1;
    if(key === "class") return 2;
    if(key === "genre") return 3;
    if(key === "duration") return 4;
    if(key === "notes") return 5;
    return 99;
  };

  const entries = Object.entries(row)
    .filter(([k,v]) => !k.startsWith("_") && String(v||"").trim() !== "")
    .sort((a,b) => {
      const pa = priority(a[0]), pb = priority(b[0]);
      if(pa !== pb) return pa - pb;
      return a[0].localeCompare(b[0]);
    });

  return entries.map(([k,v]) => {
    const key = escapeHtml(k);
    const raw = String(v ?? "").trim();
    const val = escapeHtml(raw);
    const ico = iconFor(k);

    // Make URLs clickable
    const prettyVal = (raw.startsWith("http://") || raw.startsWith("https://"))
      ? `<a href="${escapeHtmlAttr(raw)}" target="_blank" rel="noopener">${val}</a>`
      : val;

    const icoHtml = ico ? `<span class="msi kvico">${ico}</span>` : `<span class="kvicoSpacer"></span>`;
    return `<div class="kvline">${icoHtml}<span class="kvkey">${key}:</span> <span class="kvval">${prettyVal}</span></div>`;
  }).join("");
}


/** ========= USER STATE ========= **/
function deriveUserState(){
  state.userVotedIds = new Set();
  state.userCommentById = new Map();
  if(!state.currentUser) return;

  // if multiple rows exist per ID, keep the latest non-empty comment we see
  for(const r of responses){
    if(r._EMAIL !== state.currentUser) continue;
    if(r._ID) state.userVotedIds.add(r._ID);
    if(r._ID && r._COMMENT && r._COMMENT.trim()){
      state.userCommentById.set(r._ID, r._COMMENT.trim());
    }
  }
}

/** ========= DASHBOARD ========= **/
function renderDashboard(){
  if(!els.dashboard || !els.dashBtn) return;

  if(state.publicMode){
    els.dashBtn.style.display = "none";
    els.dashboard.style.display = "none";
    return;
  }

  els.dashBtn.style.display = "inline-flex";
  els.dashboard.style.display = state.showDash ? "block" : "none";
  if(!state.showDash) return;

  const wantKey = "WANT";
  const voters = new Set(responses.map(r => (r._EMAIL||"").trim()).filter(Boolean));
  const totalResponses = responses.length;

  // WANT counts by ID
  const wantById = new Map();
  for(const r of responses){
    if((r._CHOICE||"").toUpperCase() !== wantKey) continue;
    const id = (r._ID||"").trim();
    if(!id) continue;
    wantById.set(id, (wantById.get(id)||0) + 1);
  }

  // Build top list using inventory metadata
  const invById = new Map(inventory.map(it => [it._ID, it]));
  const top = Array.from(wantById.entries())
    .map(([id, n]) => {
      const it = invById.get(id) || { _ID:id, _TITLE:"(unknown)", _CLASS:"", _GENRE:"" };
      return { id, n, title: it._TITLE || "(untitled)", class10: it._CLASS || "", genre: it._GENRE || "" };
    })
    .sort((a,b)=> b.n - a.n || a.title.localeCompare(b.title))
    .slice(0, 10);

  // People's choice by Class10
  const wantByClass = new Map();
  for(const [id,n] of wantById.entries()){
    const it = invById.get(id);
    const k = (it? (it._CLASS||"") : "") || "(blank)";
    wantByClass.set(k, (wantByClass.get(k)||0) + n);
  }
  const byClassRows = Array.from(wantByClass.entries())
    .sort((a,b)=> b[1]-a[1] || a[0].localeCompare(b[0]))
    .map(([k,n]) => ({k,n}));

  // Recent responses (last 20 by timestamp if parseable, else original order)
  const parseTs = (s)=>{
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  };
  const recent = responses
    .map(r => ({ when: r._TS||"", email: r._EMAIL||"", choice: r._CHOICE||"", id: r._ID||"" , _t: parseTs(r._TS||"") }))
    .sort((a,b)=>{
      if(a._t!=null && b._t!=null) return b._t - a._t;
      if(a._t!=null) return -1;
      if(b._t!=null) return 1;
      return 0;
    })
    .slice(0, 20);

  const kpiHtml = `
    <div class="dashKpis">
      <div class="kpi"><div class="kpiLabel">Voters seen</div><div class="kpiValue">${voters.size}</div></div>
      <div class="kpi"><div class="kpiLabel">Total responses</div><div class="kpiValue">${totalResponses}</div></div>
      <div class="kpi"><div class="kpiLabel">People’s choice (WANT votes)</div><div class="kpiValue">${Array.from(wantById.values()).reduce((a,b)=>a+b,0)}</div></div>
    </div>
  `;

  const topHtml = `
    <table class="table">
      <thead>
        <tr>
          <th>#</th>
          <th>Title</th>
          <th>Class10</th>
          <th><span class="badgeWant"><span class="msi">star</span>WANT</span></th>
          <th>ID</th>
        </tr>
      </thead>
      <tbody>
        ${top.map((r,i)=>`
          <tr>
            <td>${i+1}</td>
            <td><strong>${escapeHtml(r.title)}</strong></td>
            <td>${escapeHtml(r.class10)}</td>
            <td>${r.n}</td>
            <td>${escapeHtml(r.id)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  const byClassHtml = `
    <table class="table">
      <thead>
        <tr>
          <th>Class10</th>
          <th><span class="badgeWant"><span class="msi">star</span>WANT</span></th>
        </tr>
      </thead>
      <tbody>
        ${byClassRows.map(r=>`
          <tr>
            <td>${escapeHtml(r.k)}</td>
            <td>${r.n}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  const recentHtml = `
    <table class="table">
      <thead>
        <tr>
          <th>When</th>
          <th>Email</th>
          <th>Choice</th>
          <th>ID</th>
        </tr>
      </thead>
      <tbody>
        ${recent.map(r=>`
          <tr>
            <td>${escapeHtml(r.when)}</td>
            <td>${escapeHtml(r.email)}</td>
            <td>${escapeHtml(r.choice)}</td>
            <td>${escapeHtml(r.id)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  els.dashboard.innerHTML = `
    <div class="dashGrid">
      <div class="dashCard">
        <h3><span class="msi">insights</span> Metrics</h3>
        ${kpiHtml}
      </div>
      <div class="dashCard">
        <h3><span class="msi">leaderboard</span> Top 10 People’s choice</h3>
        ${topHtml}
      </div>
      <div class="dashCard">
        <h3><span class="msi">filter_alt</span> People’s choice by Class10</h3>
        ${byClassHtml}
      </div>
      <div class="dashCard">
        <h3><span class="msi">history</span> Recent Responses</h3>
        ${recentHtml}
      </div>
    </div>
  `;
}


function tally(arr, getter){
  const m = new Map();
  for(const a of arr){
    const k = String(getter(a) || "").trim();
    if(!k) continue;
    m.set(k, (m.get(k)||0) + 1);
  }
  return Array.from(m.entries()).sort((a,b) => b[1]-a[1]);
}

function renderTally(entries){
  return `<div class="tally">${
    entries.map(([k,n]) => `<div class="trow"><span>${escapeHtml(k)}</span><span class="muted">${n}</span></div>`).join("")
  }</div>`;
}

/** ========= WRITE-BACK (FORM POST) ========= **/
function submitResponse({ email, id, choice, comment }){
  if(state.publicMode) return Promise.reject(new Error("read_only"));
  return new Promise((resolve) => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = API_URL;
    form.target = "postTarget";
    form.style.display = "none";

    const fields = { action: "submit", email, id, choice, comment };
    for(const [k,v] of Object.entries(fields)){
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = k;
      input.value = String(v ?? "");
      form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();
    setTimeout(() => { form.remove(); resolve(true); }, 650);
  });
}

/** ========= UI HELPERS ========= **/
function showBanner(msg){
  if(!els.banner) return;
  if(!msg){
    els.banner.style.display = "none";
    els.banner.textContent = "";
    return;
  }
  els.banner.style.display = "block";
  els.banner.textContent = msg;
}

let toastTimer = null;
function toast(msg, kind="info"){
  let el = document.getElementById("toast");
  if(!el){
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2200);
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#39;");
}
function escapeHtmlAttr(s){ return escapeHtml(s).replaceAll("\n"," "); }
function unescapeHtmlAttr(s){
  return String(s||"")
    .replaceAll("&amp;","&")
    .replaceAll("&lt;","<")
    .replaceAll("&gt;",">")
    .replaceAll("&quot;",'"')
    .replaceAll("&#39;","'");
}


function toYouTubeEmbed(url){
  try{
    const u = new URL(url);
    if(u.hostname.includes("youtu.be")){
      const id = u.pathname.replace("/", "").trim();
      return id ? `https://www.youtube.com/embed/${id}` : null;
    }
    if(u.hostname.includes("youtube.com")){
      const vid = u.searchParams.get("v");
      if(vid) return `https://www.youtube.com/embed/${vid}`;
      const mShort = u.pathname.match(/\/shorts\/([^\/]+)/);
      if(mShort) return `https://www.youtube.com/embed/${mShort[1]}`;
      const mEmb = u.pathname.match(/\/embed\/([^\/]+)/);
      if(mEmb) return `https://www.youtube.com/embed/${mEmb[1]}`;
    }
    return null;
  }catch(e){
    return null;
  }
}

// Clear filter buttons
// Clear ALL filters (search + class + genre)
function updateClearButtons(){
  const classBtn = document.getElementById("clearClassBtn");
  const genreBtn = document.getElementById("clearGenreBtn");
  const allBtn = document.getElementById("clearAllBtn");
  const q = (document.getElementById("search")?.value || "").trim();

  const hasClass = (state.classSel && state.classSel.size > 0);
  const hasGenre = (state.genreSel && state.genreSel.size > 0);
  const any = hasClass || hasGenre || !!q;

  if(classBtn) classBtn.classList.toggle("is-hidden", !hasClass);
  if(genreBtn) genreBtn.classList.toggle("is-hidden", !hasGenre);
  if(allBtn)   allBtn.classList.toggle("is-hidden", !any);
}


// --- Clear buttons (reset filters back to "all candidates") ---
document.getElementById("clearClassBtn")?.addEventListener("click", ()=>{
  if(state.classSel) state.classSel.clear();
  state.pageOffset = 0;
  document.querySelectorAll("#classPills .pill").forEach(p=>p.classList.remove("active"));
  render();
  updatePillCounts();
  updateClearButtons();
});

document.getElementById("clearGenreBtn")?.addEventListener("click", ()=>{
  if(state.genreSel) state.genreSel.clear();
  state.pageOffset = 0;
  document.querySelectorAll("#genrePills .pill").forEach(p=>p.classList.remove("active"));
  render();
  updatePillCounts();
  updateClearButtons();
});

document.getElementById("clearAllBtn")?.addEventListener("click", ()=>{
  if(state.classSel) state.classSel.clear();
  if(state.genreSel) state.genreSel.clear();
  state.search = "";
  state.pageOffset = 0;

  const s = document.getElementById("search");
  if(s) s.value = "";

  document.querySelectorAll("#classPills .pill, #genrePills .pill").forEach(p=>p.classList.remove("active"));

  render();
  updatePillCounts();
  updateClearButtons();
});

