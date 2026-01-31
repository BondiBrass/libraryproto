Band Library Reviews — HYBRID (hard-coded API URL)

1) Paste your Apps Script Web App URL into app.js (API_URL).
   - You can use the /exec URL OR the script.googleusercontent.com URL.
   - If you ever see jsonp_error, use the googleusercontent URL.

2) Host the UI anywhere (Live Server, GitHub Pages, etc.)

Apps Script:
- Paste apps_script.gs into your script (Code.gs)
- Deploy as Web app (Execute as Me, access Anyone)

Sheets:
- Config: inventory_csv, responses_csv, voting_enabled, rehearsal_mode
- Login: EMAIL, ROLE
- Responses: TIMESTAMP, EMAIL, ID, CHOICE, COMMENT, USER-AGENT

Note:
If your test URL prints cbtest(...) twice, the UI is now hardened:
the JSONP handler ignores duplicate callback invocations.
