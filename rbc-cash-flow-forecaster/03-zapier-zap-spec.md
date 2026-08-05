# Phase 3: Zapier Zap Spec

One multi-step Zap, run nightly. Zapier's native Google Sheets actions
handle appends; two Code by Zapier (NodeJS) steps carry the Plaid calls and
the forecast math, since neither is a native Zapier action. This doc gives
you exact step order, field mappings, and the two scripts to paste in.

## Before you build: one-time setup in Zapier

1. **Connect Plaid.** If Zapier's app directory has a native Plaid
   integration available on your plan, use it only for the connection/auth
   handshake — the actual `/transactions/sync` and `/accounts/balance/get`
   calls happen in Code by Zapier below, since Plaid's native Zapier
   triggers/actions don't cover `/transactions/sync`'s cursor model. If no
   native Plaid app is available, that's fine — Step 2 below calls Plaid's
   REST API directly with `fetch`, no native app needed at all.
2. **Store secrets in Zapier Storage**, not in the Zap itself. Zapier
   Storage (via the "Storage by Zapier" app, or the `StoreClient` available
   inside Code by Zapier steps) is a private key-value store scoped to your
   account. Set these keys once, before the first real run:
   - `plaid_client_id`
   - `plaid_secret` (Production secret)
   - `plaid_access_token` (obtained during the Plaid Link flow in
     `01-plaid-setup.md` — set this after you complete Link, not before)
   - `plaid_cursor` (leave empty string initially — `/transactions/sync`
     uses this to fetch only what's new each run)
   - `google_sheet_id` (the ID from your Sheet's URL)
   - `google_service_account_json` (see the note in Step 8 below — only
     needed for the bulk Forecast-tab rewrite; everything else uses your
     own native Google Sheets connection)
3. **Connect Google Sheets** natively in Zapier (OAuth as your own Google
   account — the same account that owns the Sheet from Phase 2). This
   covers every step except the bulk Forecast overwrite in Step 8.
4. **Connect your SMS provider.** Either Zapier's native SMS by Zapier
   action (if available on your plan) or a Twilio account connected via
   Zapier's Twilio integration. Verify your own phone number as the
   recipient.

## Step 1 — Trigger: Schedule by Zapier

- Trigger event: **Every Day**
- Time of day: **4:00 AM**
- Timezone: your local timezone (Atlantic Time) — set this explicitly in
  the trigger's timezone field so it doesn't default to UTC. 4am Atlantic
  is safely after RBC's typical overnight posting window.

## Step 2 — Code by Zapier (NodeJS): "Plaid Sync"

Action: **Run JavaScript**. No input fields needed from prior steps (this
step reads its own config from Storage).

Paste this into the code editor:

```js
const store = StoreClient(process.env.STORE_SECRET); // Zapier's Code-step Storage client

const clientId = await store.get('plaid_client_id');
const secret = await store.get('plaid_secret');
const accessToken = await store.get('plaid_access_token');
let cursor = (await store.get('plaid_cursor')) || '';

const PLAID_BASE = 'https://production.plaid.com';

async function plaidPost(path, body) {
  const res = await fetch(`${PLAID_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, secret, ...body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Plaid ${path} failed: ${JSON.stringify(json)}`);
  return json;
}

// --- 1. Sync transactions (cursor-based: only new/changed since last run) ---
let added = [];
let modified = [];
let hasMore = true;
while (hasMore) {
  const page = await plaidPost('/transactions/sync', {
    access_token: accessToken,
    cursor,
  });
  added = added.concat(page.added);
  modified = modified.concat(page.modified);
  cursor = page.next_cursor;
  hasMore = page.has_more;
}
await store.set('plaid_cursor', cursor);

const accountsMeta = {}; // account_id -> name, filled in below from balances call

function normalizeTxn(t) {
  const amount = t.amount; // Plaid convention: positive = outflow
  return {
    transaction_id: t.transaction_id,
    date: t.date,
    account_id: t.account_id,
    account_name: accountsMeta[t.account_id] || t.account_id,
    description: t.name,
    merchant_name: t.merchant_name || '',
    amount,
    direction: amount >= 0 ? 'debit' : 'credit',
    plaid_category_primary: (t.personal_finance_category && t.personal_finance_category.primary) || '',
    plaid_category_detailed: (t.personal_finance_category && t.personal_finance_category.detailed) || '',
    pending: t.pending,
  };
}

// --- 2. Balances (needed for both the Balances tab and account_id -> name map) ---
const balancesResp = await plaidPost('/accounts/balance/get', { access_token: accessToken });

// Map your 4 real accounts by Plaid's official_name/name — adjust these
// three match rules once, after your first real Production Link, to match
// exactly what Plaid returns for your RBC accounts.
function friendlyAccountName(acct) {
  const n = (acct.official_name || acct.name || '').toLowerCase();
  if (n.includes('joint')) return 'RBC Joint Chequing';
  if (n.includes('chequing') || n.includes('checking')) return 'RBC Personal Chequing';
  if (n.includes('visa') || n.includes('credit card') || acct.type === 'credit' && acct.subtype === 'credit card') return 'RBC Credit Card';
  if (n.includes('line of credit') || acct.subtype === 'line of credit') return 'RBC Line of Credit';
  return acct.official_name || acct.name;
}

const todayIso = new Date().toISOString().slice(0, 10);
const balances = balancesResp.accounts.map((acct) => {
  const friendly = friendlyAccountName(acct);
  accountsMeta[acct.account_id] = friendly;
  return {
    date: todayIso,
    account_name: friendly,
    account_id: acct.account_id,
    account_type: acct.type,
    current_balance: acct.balances.current,
    available_balance: acct.balances.available,
    credit_limit: acct.balances.limit || '',
  };
});

const transactions = added.concat(modified).map(normalizeTxn);

output = {
  transactionsJson: JSON.stringify(transactions),
  balancesJson: JSON.stringify(balances),
  transactionCount: transactions.length,
  balanceCount: balances.length,
  asOfDate: todayIso,
};
```

**Notes:**
- `StoreClient` and `fetch` are both available inside Zapier's Code by
  Zapier NodeJS runtime without any `require`.
- Output fields are flattened JSON strings (`transactionsJson`,
  `balancesJson`) rather than raw arrays, because Zapier's inter-step data
  passing is friendliest with strings/primitives; Step 3 and Step 7 both
  `JSON.parse()` them back out.
- If this step throws, the Zap run fails here and nothing gets written to
  Sheets — that's intentional; a partial write is worse than no write, and
  Zapier's own run history plus the `SystemLog` fallback (Step 9) both
  surface the failure.

## Step 3 — Looping by Zapier: iterate `transactionsJson`

- App: **Looping by Zapier** → action **Create Loop From Line Items**
- Values to loop over: parse `transactionsJson` from Step 2 first via a
  small **Formatter by Zapier → Utilities → Line Item to Text** is *not*
  what you want here — instead, feed the already-JSON array by using
  **Looping by Zapier's "Create Loop From Line Items"** action, or if your
  plan doesn't support arbitrary JSON looping, replace this whole Step 3
  with the alternative below.

**Simplest reliable alternative (recommended):** rather than fighting
Zapier's line-item looping with a dynamic JSON string, do the Sheet writes
from inside a **second Code by Zapier step** that calls the Google Sheets
API directly (same pattern as Step 8's bulk write). This avoids Looping by
Zapier entirely and keeps the whole "append rows" concern in one auditable
script:

### Step 3 (revised) — Code by Zapier: "Write Transactions & Balances to Sheets"

```js
const sheetId = await StoreClient(process.env.STORE_SECRET).get('google_sheet_id');
const saJson = await StoreClient(process.env.STORE_SECRET).get('google_service_account_json');
const { google } = require('googleapis'); // available in Zapier's Code runtime

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(saJson),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

const transactions = JSON.parse(inputData.transactionsJson);
const balances = JSON.parse(inputData.balancesJson);

if (transactions.length > 0) {
  const rows = transactions.map((t) => [
    t.transaction_id, t.date, t.account_name, t.account_id, t.description,
    t.merchant_name, t.amount, t.direction, t.plaid_category_primary,
    t.plaid_category_detailed, t.pending, false, new Date().toISOString(),
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Transactions!A:M',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

if (balances.length > 0) {
  const rows = balances.map((b) => [
    b.date, b.account_name, b.account_id, b.account_type,
    b.current_balance, b.available_balance, b.credit_limit, new Date().toISOString(),
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Balances!A:H',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

output = { transactionsWritten: transactions.length, balancesWritten: balances.length };
```

Input field to map: `transactionsJson` and `balancesJson` from Step 2.

**On the `google_service_account_json` secret:** create one Google Cloud
service account, enable the Sheets API for it, download its JSON key, and
share your Google Sheet with that service account's email as **Editor**.
This is the one deliberate exception to "don't share the Sheet" — it's a
machine identity you control (not a public link, not another person), used
only for this write path. Paste the JSON key content into Zapier Storage as
`google_service_account_json`. This same auth pattern is reused in Step 8.

**On duplicate protection:** this relies on Plaid's `/transactions/sync`
cursor (Step 2) to avoid re-sending already-seen transactions — that's the
primary defense per spec section 4. If you want the extra `transaction_id`
safety net for the rare case of a retried run with a stale cursor, add a
`values.get` call on the `Transactions!A:A` column before the append and
filter `rows` to exclude any `transaction_id` already present — flagged
here as an optional hardening step, not required for v1.

## Step 4 — Google Sheets: "Get Many Rows" — `Bills`

Native Zapier Google Sheets action. Spreadsheet: your Sheet. Worksheet:
`Bills`. No filter needed — pull all rows (bill count will always be small).

## Step 5 — Google Sheets: "Get Many Rows" — `Transactions`

Same action, Worksheet: `Transactions`. This feeds the discretionary-average
calculation in Step 7, which needs ~90 days of history. If your row count
grows large over time (thousands of rows after a year+), consider adding a
"days back" filter here later — not needed at launch.

## Step 6 — Google Sheets: "Get Many Rows" — `Suggested Bills`

Same action, Worksheet: `Suggested Bills`. Feeds the dedupe check in Step 7
(so already-suggested patterns aren't re-added nightly).

## Step 7 — Code by Zapier (NodeJS): "Compute Forecast"

Action: **Run JavaScript**.

Input fields to map:
- `asOfDate` ← Step 2 `asOfDate`
- `transactionsJson` ← Step 2 `transactionsJson` (the *new* ones from
  tonight's sync — for the discretionary average you actually want the
  fuller history, so also map `historicalTransactions` ← the raw output of
  Step 5, Zapier will hand you each row as a line-item array; the script
  below normalizes either shape)
- `billsRows` ← Step 4 output (line items)
- `balancesJson` ← Step 2 `balancesJson`
- `suggestedBillsRows` ← Step 6 output (line items)

Paste the **entire contents of `forecast-logic/forecast.js`** into the top
of this code box (everything above the `module.exports` guard at the
bottom — delete that guard block, Code by Zapier doesn't need it and
`module` isn't defined in that runtime). Then append this driver code below
it:

```js
// --- Adapt Zapier's line-item inputData shape into the plain objects
// forecast.js expects ---
function zapierRowsToObjects(rows, headers) {
  // Zapier's "Get Many Rows" returns one flat object per row already
  // keyed by column header when using the Google Sheets integration's
  // row output — if your version instead hands back parallel arrays,
  // this helper reshapes them. Adjust to match what Step 4/5/6 actually
  // output in your Zap (check the Zapier step's data-in panel).
  return rows;
}

const bills = zapierRowsToObjects(inputData.billsRows);
const existingSuggestedBills = zapierRowsToObjects(inputData.suggestedBillsRows);
const newTransactions = JSON.parse(inputData.transactionsJson);
const historicalTransactions = zapierRowsToObjects(inputData.historicalTransactions || []);
const balances = JSON.parse(inputData.balancesJson);

// Merge tonight's new transactions with historical ones for the
// discretionary-average window, de-duped by transaction_id.
const byId = new Map();
for (const t of historicalTransactions) byId.set(t.transaction_id, t);
for (const t of newTransactions) byId.set(t.transaction_id, t);
const allTransactions = Array.from(byId.values());

const result = runForecast({
  transactions: allTransactions,
  bills,
  balances,
  asOfDate: inputData.asOfDate,
  existingSuggestedBills,
});

output = {
  forecastJson: JSON.stringify(result.forecast),
  suggestedBillsJson: JSON.stringify(result.suggestedBills),
  remindersDueJson: JSON.stringify(result.remindersDue),
  smsBody: result.smsBody || '',
  reminderCount: result.remindersDue.length,
};
```

## Step 8 — Code by Zapier (NodeJS): "Write Forecast, Suggested Bills, and Reminder Flags"

This is the bulk-overwrite step referenced in Step 3's note — the
`Forecast` tab gets **fully replaced** each run (per the schema doc, it
reflects "today's forecast," not history), which native Zapier actions
can't do cleanly, so it goes through the Sheets API directly:

```js
const store = StoreClient(process.env.STORE_SECRET);
const sheetId = await store.get('google_sheet_id');
const saJson = await store.get('google_service_account_json');
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(saJson),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

const forecast = JSON.parse(inputData.forecastJson);
const suggestedBills = JSON.parse(inputData.suggestedBillsJson);

// 1. Clear and rewrite Forecast (keep header row, wipe A2:L and below).
await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: 'Forecast!A2:L' });
const forecastRows = forecast.map((r) => [
  r.date, r.day_of_week, r.is_business_day, r.chequing_combined_projected_balance,
  r.credit_card_projected_balance_owed, r.loc_projected_balance_owed, r.bills_due_today,
  r.bill_amount_today, r.discretionary_spend_estimate, r.running_total,
  r.below_threshold_flag, r.notes,
]);
await sheets.spreadsheets.values.update({
  spreadsheetId: sheetId,
  range: 'Forecast!A2',
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: forecastRows },
});

// 2. Append newly detected Suggested Bills (never overwrite this tab —
// your promote/dismiss decisions live here).
if (suggestedBills.length > 0) {
  const now = new Date().toISOString().slice(0, 10);
  const rows = suggestedBills.map((s, i) => [
    `sugg-auto-${now}-${i}`, s.detected_name, s.matched_transaction_ids, s.avg_amount,
    s.amount_variance_pct, s.detected_frequency, s.occurrences, s.first_seen_date,
    s.last_seen_date, s.account, 'pending', now,
  ]);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Suggested Bills!A:L',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: rows },
  });
}

output = { forecastRowsWritten: forecast.length, suggestedBillsAdded: suggestedBills.length };
```

## Step 9 — Code by Zapier (NodeJS): "Log Run to SystemLog" (always runs)

Placed here — right after the Forecast/Suggested Bills write and *before*
the reminder Filter below — specifically so it always executes regardless
of whether any bills are due tonight. If it ran after the Filter, a
no-reminders night would never get logged, defeating the point of
`SystemLog` as your "did last night's run actually work" check.

```js
const store = StoreClient(process.env.STORE_SECRET);
const sheetId = await store.get('google_sheet_id');
const saJson = await store.get('google_service_account_json');
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(saJson),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

const row = [[
  new Date().toISOString(),
  inputData.zapRunId || '',
  'success',
  inputData.transactionCount || 0,
  inputData.transactionCount || 0,
  inputData.balanceCount || 0,
  '', // bills_matched_count — optionally wire through from Step 7 if you add that stat
  inputData.suggestedBillsAdded || 0,
  inputData.reminderCount || 0,
  '',
  '',
]];

await sheets.spreadsheets.values.append({
  spreadsheetId: sheetId,
  range: 'SystemLog!A:K',
  valueInputOption: 'USER_ENTERED',
  requestBody: { values: row },
});

output = { logged: true };
```

Map inputs from Step 7 (`transactionCount`, `balanceCount`,
`reminderCount`) and Step 8 (`suggestedBillsAdded`).

**On failure logging:** Zapier's own **"Have this Zap step run when a
previous step errors"** feature (available via the Zap's Error handling
settings) can trigger a small parallel path that writes a `status: failure`
row with the error message — set this up once you've completed the test
plan (Phase 6) and are comfortable with the happy path.

## Step 10 — Filter by Zapier: only continue if reminders are due

- App: **Filter by Zapier**
- Condition: Step 7's `reminderCount` → **Greater than** → `0`
- This stops the Zap here on nights with no upcoming bills, so you don't
  get an empty/irrelevant SMS.

## Step 11 — SMS by Zapier (or Twilio): send reminder

- To: your phone number (hardcoded in this step — it's your own number, not
  a per-run variable)
- Message: map to Step 7's `smsBody` output field
- This produces one text listing every bill due in the next `SMS_LEAD_DAYS`
  window, rather than one text per bill — adjust in `forecast.js`
  (`buildReminderSmsBody`) if you'd rather get separate texts.

## Step 12 — Code by Zapier (NodeJS): "Mark Reminders Sent"

Runs after a successful SMS send, writes `last_reminder_sent_date` back to
the `Bills` tab for each bill that was just texted, so tomorrow's run
doesn't re-send the same reminder for the same due date.

```js
const store = StoreClient(process.env.STORE_SECRET);
const sheetId = await store.get('google_sheet_id');
const saJson = await store.get('google_service_account_json');
const { google } = require('googleapis');

const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(saJson),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });

const remindersDue = JSON.parse(inputData.remindersDueJson);

// Read Bills to find each bill_id's row number, then write its
// last_reminder_sent_date cell individually (small volume, simplest to reason about).
const billsResp = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range: 'Bills!A:J' });
const billRows = billsResp.data.values || [];
const header = billRows[0];
const billIdCol = header.indexOf('bill_id');
const lastReminderCol = header.indexOf('last_reminder_sent_date');

for (const reminder of remindersDue) {
  const rowIndex = billRows.findIndex((row, i) => i > 0 && row[billIdCol] === reminder.bill_id);
  if (rowIndex === -1) continue;
  const colLetter = String.fromCharCode('A'.charCodeAt(0) + lastReminderCol);
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `Bills!${colLetter}${rowIndex + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[reminder.new_last_reminder_sent_date]] },
  });
}

output = { billsMarked: remindersDue.length };
```

## Summary of the step order

1. Schedule trigger (4am Atlantic)
2. Code: Plaid sync (transactions + balances)
3. Code: write Transactions + Balances to Sheets
4. Sheets: Get Many Rows — Bills
5. Sheets: Get Many Rows — Transactions (history for discretionary avg)
6. Sheets: Get Many Rows — Suggested Bills
7. Code: compute forecast (uses `forecast.js`)
8. Code: write Forecast (overwrite) + append Suggested Bills
9. Code: log run to SystemLog (always runs, before the reminder filter)
10. Filter: reminderCount > 0
11. SMS: send reminder text
12. Code: mark reminders sent on Bills tab

This is more Code-step-heavy than a "pure native Zapier" build — that's a
direct consequence of needing `/transactions/sync`'s cursor model and a
full-tab overwrite for `Forecast`, neither of which native Sheets/Plaid
Zapier actions support cleanly. Everything Code-side is plain, readable
JavaScript you can read top to bottom, matching the "transparent, no
black-box" requirement from the spec.
