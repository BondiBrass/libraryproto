/* Hybrid API (Apps Script) — paste into Code.gs */

function doGet(e) {
  const action = String((e && e.parameter && e.parameter.action) || "").toLowerCase();
  const cb = String((e && e.parameter && e.parameter.callback) || "");

  if (action === "configp") {
    const cfg = readConfig_();
    return jsonp_(cb, {
      ok: true,
      config: {
        inventory_csv: cfg.inventory_csv,
        responses_csv: cfg.responses_csv,
        voting_enabled: cfg.voting_enabled,
        rehearsal_mode: cfg.rehearsal_mode
      }
    });
  }

  if (action === "whoamip") {
    const email = String((e.parameter && e.parameter.email) || "").trim().toLowerCase();
    const u = lookupUser_(email);
    if (!u) return jsonp_(cb, { ok:false, error:"not_approved" });
    return jsonp_(cb, { ok:true, email:u.email, role:u.role });
  }

  return jsonp_(cb, { ok:false, error:"unknown_action" });
}

function doPost(e) {
  try {
    const action = String((e && e.parameter && e.parameter.action) || "").toLowerCase();
    if (action !== "submit") return text_("unknown_action");

    const cfg = readConfig_();
    if (!cfg.voting_enabled) return text_("voting_disabled");

    const email  = String((e.parameter && e.parameter.email) || "").trim().toLowerCase();
    const id     = String((e.parameter && e.parameter.id) || "").trim();
    const choice = String((e.parameter && e.parameter.choice) || "").trim();
    const comment = String((e.parameter && e.parameter.comment) || "").trim();
    const ua     = String((e.parameter && e.parameter.user_agent) || "");

    if (!email || !id || !choice) return text_("missing_fields");

    const u = lookupUser_(email);
    if (!u) return text_("not_allowed");

    if (cfg.rehearsal_mode) return text_("rehearsal_ok");

    SpreadsheetApp.getActive()
      .getSheetByName("Responses")
      .appendRow([new Date(), email, id, choice, comment, ua]);

    return text_("ok");

  } catch (err) {
    return text_("error: " + err);
  }
}

// ---------- helpers ----------
function readConfig_() {
  const sh = SpreadsheetApp.getActive().getSheetByName("Config");
  const cfg = { voting_enabled:true, rehearsal_mode:false, inventory_csv:"", responses_csv:"" };
  if (!sh) return cfg;

  const rows = sh.getRange(1, 1, sh.getLastRow(), 2).getValues();
  for (const r of rows) {
    const k = String(r[0] || "").trim();
    if (!k) continue;
    cfg[k] = r[1];
  }

  cfg.inventory_csv = String(cfg.inventory_csv || "").trim();
  cfg.responses_csv = String(cfg.responses_csv || "").trim();
  cfg.voting_enabled = normBool_(cfg.voting_enabled, true);
  cfg.rehearsal_mode = normBool_(cfg.rehearsal_mode, false);
  return cfg;
}

function lookupUser_(email) {
  if (!email) return null;
  const sh = SpreadsheetApp.getActive().getSheetByName("Login");
  if (!sh) return null;

  const lastRow = sh.getLastRow();
  if (lastRow < 2) return null;

  const rows = sh.getRange(2, 1, lastRow - 1, 2).getValues();
  for (const r of rows) {
    if (String(r[0] || "").trim().toLowerCase() === email) {
      return { email, role: String(r[1] || "member").trim().toLowerCase() || "member" };
    }
  }
  return null;
}

function normBool_(v, dflt) {
  const s = String(v == null ? "" : v).trim().toUpperCase();
  if (s === "TRUE" || s === "1" || s === "YES") return true;
  if (s === "FALSE" || s === "0" || s === "NO") return false;
  return dflt;
}

function jsonp_(callback, obj) {
  const cb = callback && /^[a-zA-Z0-9_.$]+$/.test(callback) ? callback : "callback";
  const payload = cb + "(" + JSON.stringify(obj) + ");";
  return ContentService
    .createTextOutput(payload)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function text_(s) {
  return ContentService
    .createTextOutput(String(s))
    .setMimeType(ContentService.MimeType.TEXT);
}
