# Personal Cash Flow Forecaster — Jeremie / RBC / Canada

This folder is the complete build package for the personal cash flow forecasting
system described in the original spec: Plaid → Zapier → Google Sheets → SMS →
Lovable dashboard. Nothing here touches real bank credentials — Plaid is the
only thing that ever talks to RBC.

## Assumptions made (please review — no reply was received to the clarifying
## questions, so these are the flagged defaults; override any of them anytime)

| Open question | Default used | Where it shows up |
|---|---|---|
| Credit card / LOC vs. chequing | **Separate tracks.** Chequing + joint chequing forecast as one "available cash" line. Credit card and LOC are tracked as their own running "amount owed" lines, not netted against cash. | `Forecast` tab schema, `forecast-logic/forecast.js` |
| SMS lead time | **3 days** before due date | `03-zapier-zap-spec.md` step 7, `forecast-logic/forecast.js` config |
| Low-balance flag threshold | **$0** (strictly negative) to start, exposed as a single config constant so you can raise it later (e.g. to $500) once you've seen a few weeks of real forecast output | `forecast-logic/forecast.js` `LOW_BALANCE_FLOOR` |
| Weekend/holiday-aware due dates | **Yes.** A bill due on a Saturday/Sunday/Canadian statutory holiday is modeled as hitting the next business day, matching how RBC actually posts pre-authorized debits | `forecast-logic/forecast.js` `shiftToBusinessDay()` |

If any of these are wrong, they're single-line changes — say the word and I'll adjust.

## What's in this folder

| File | Purpose |
|---|---|
| `01-plaid-setup.md` | Step-by-step: sign up for Plaid Trial, sandbox-test first, then connect real RBC accounts |
| `02-google-sheets-schema.md` | Full schema for all 6 tabs, with rationale |
| `sheets-templates/*.csv` | One CSV per tab — headers + sample rows, ready to paste into Google Sheets |
| `03-zapier-zap-spec.md` | Exact Zap build: trigger, every action step, field mappings, where Code by Zapier is required |
| `forecast-logic/forecast.js` | The recurrence-detection + 30-day forecast math, as plain documented JS you can read top to bottom |
| `forecast-logic/forecast.test.js` | Test cases proving the math against hand-checkable numbers |
| `04-forecast-logic.md` | Walkthrough of the logic in `forecast.js`, in prose, so you can audit it without reading code |
| `05-lovable-dashboard-spec.md` | Prompt/spec to hand to Lovable |
| `06-test-plan.md` | End-to-end dry-run plan before trusting it with real reminders |

## Security posture (recap — see `01-plaid-setup.md` and `03-zapier-zap-spec.md` for detail)

- Plaid `client_id`/`secret` live only in Zapier's connected-account storage (server-side), never in Sheets, never in Lovable.
- The Plaid `access_token` for your RBC Item is stored in **Zapier Storage** (encrypted at rest, scoped to your Zapier account), never written to a Sheet cell.
- The Google Sheet is shared with nobody except your own account, one narrowly-scoped Google service account (used only by the Zap's Code steps for the `Forecast` tab's nightly overwrite), and Lovable's connection as Viewer — never "anyone with link."
- At no point does this pipeline ever ask for your RBC username/password. If a step ever seems to require that, stop — that means Plaid Link isn't being used correctly, and the answer is to fix that step, not to work around it.

## Manual setup punch list (only you can do these)

1. Sign up for Plaid at dashboard.plaid.com, request Trial plan production access (see `01-plaid-setup.md`).
2. Enable MFA on: Plaid dashboard, Zapier, Google account, Lovable. (Not automatable — flagging per your request.)
3. Run Plaid Link in Sandbox mode first, confirm the Zap pipeline works end-to-end on fake data.
4. Switch Plaid Link to Production, connect your real RBC login (one Item, should expose all 4 accounts).
5. Create the Google Sheet from `02-google-sheets-schema.md` / `sheets-templates/`, and grab its Sheet ID.
6. Create one Google Cloud service account (Sheets API enabled), download its JSON key, and share the Sheet with that service account's email as **Editor** — this is the identity the Zap's Code steps use for the `Forecast` tab's full nightly overwrite (details in `03-zapier-zap-spec.md`). Don't share the Sheet any more broadly than that plus your own account and Lovable's read-only connection.
7. Build the Zap in your Zapier account following `03-zapier-zap-spec.md` — this includes pasting `forecast-logic/forecast.js` (adapted, see that file's header comment) into the Code by Zapier steps, and setting the secrets listed at the top of that doc in Zapier Storage.
8. Connect Zapier's SMS/Twilio action, verify your phone number.
9. Hand `05-lovable-dashboard-spec.md` to Lovable, connect it to the Sheet (as a Viewer), set up basic auth.
10. Run the dry run in `06-test-plan.md` before enabling real SMS sends.

## Suggested order to review this package

Read in numeric order (01 → 06) — each phase assumes the previous one is settled. I'm stopping after writing all of this to let you review before you go build inside Zapier/Lovable/Plaid, since I can't operate inside those tools directly.
