# Phase 2: Google Sheets Schema

One spreadsheet, six tabs. This is your source of truth — everything the Zap
writes and everything Lovable reads comes from here.

## Setting it up

1. Create a new Google Sheet, name it something like **"RBC Cash Flow Forecaster"**.
2. Create 6 tabs named exactly as below (names matter — the Zap steps in
   Phase 3 reference them by name).
3. For each tab, paste in the corresponding CSV from `sheets-templates/` (File
   → Import → Upload → the CSV → "Replace current sheet" or "Insert new sheet(s),"
   depending on whether you're building tabs one at a time).
4. **Sharing: do not share this sheet with "Anyone with the link."** Share it
   only with:
   - Your own Google account (owner)
   - The Google service account or OAuth identity Zapier uses to write to
     Sheets (Zapier's native Google Sheets integration uses your own OAuth
     grant, not a separate service account — so this is usually already
     covered by step 1's ownership; if you instead use a service account for
     Lovable's read access, add that service account's email as a Viewer only)
   - Lovable's read connection, as **Viewer**, not Editor
5. Freeze the header row on each tab (View → Freeze → 1 row) so it stays
   visible as data grows.
6. Turn on version history awareness: Sheets keeps this automatically, but
   it's worth knowing File → Version history exists if a bad Zap run ever
   needs to be rolled back.

## Tab 1: `Transactions`

Raw, deduped transaction ledger. One row per transaction, ever.

| Column | Type | Notes |
|---|---|---|
| `transaction_id` | text | Plaid's `transaction_id` — **this is the dedupe key.** Before appending a row, the Zap checks this column for an existing match. |
| `date` | date (YYYY-MM-DD) | Transaction date from Plaid |
| `account_name` | text | e.g. "RBC Joint Chequing" |
| `account_id` | text | Plaid's `account_id` |
| `description` | text | Raw description from Plaid |
| `merchant_name` | text | Plaid's cleaned merchant name, when available (used for recurrence matching) |
| `amount` | number | Plaid convention: positive = money out, negative = money in. Kept as-is from Plaid to avoid sign-flip bugs downstream. |
| `direction` | text | `debit` or `credit`, derived from sign, for human readability |
| `plaid_category_primary` | text | Plaid's top-level category |
| `plaid_category_detailed` | text | Plaid's detailed category |
| `pending` | boolean | Plaid's `pending` flag |
| `is_fixed_bill_match` | boolean | Set by the bill-matching step if this transaction matched a row in `Bills` |
| `synced_at` | datetime | When this row was written (for debugging) |

## Tab 2: `Balances`

Daily balance history, one row per account per day (not overwritten — this
gives you a real time series, not just a snapshot).

| Column | Type | Notes |
|---|---|---|
| `date` | date | Date of this balance reading |
| `account_name` | text | |
| `account_id` | text | Plaid `account_id` |
| `account_type` | text | `depository` or `credit`, from Plaid |
| `current_balance` | number | Plaid `current` balance |
| `available_balance` | number | Plaid `available` balance (null for credit accounts sometimes — leave blank) |
| `credit_limit` | number | Only populated for the credit card / LOC rows |
| `synced_at` | datetime | |

## Tab 3: `Bills`

Manually seeded fixed/recurring bills. **You edit this tab directly** — the
Zap only reads it (to match transactions and build the forecast) and never
overwrites your entries. New candidates go to `Suggested Bills` instead
(Tab 4), never here automatically.

| Column | Type | Notes |
|---|---|---|
| `bill_id` | text | Any stable unique ID you assign (e.g. `bill-001`) |
| `name` | text | e.g. "Mortgage", "Netflix" |
| `amount` | number | Expected amount |
| `frequency` | text | `weekly` \| `biweekly` \| `monthly` \| `quarterly` \| `annual` |
| `due_day_or_date` | text | For monthly: day-of-month (e.g. `1`, `15`). For weekly/biweekly: an anchor date (e.g. `2026-08-07`) the forecast counts forward from. |
| `next_due_date` | date | Computed/maintained next occurrence — the forecast script updates this after each run so you always see "next time this hits" |
| `account_paid_from` | text | Must match an `account_name` from `Balances`/`Transactions` |
| `category` | text | Free text, e.g. "Housing", "Subscriptions" |
| `active` | boolean | Set to `FALSE` to pause a bill without deleting its history |
| `last_reminder_sent_date` | date | Maintained by the script — the last date an SMS reminder was sent for this bill's upcoming occurrence. Prevents duplicate texts if the Zap runs more than once inside the reminder window. |
| `notes` | text | Optional |

## Tab 4: `Suggested Bills`

Recurrence-detection output. Nothing here is trusted until you promote it —
promoting means manually copying a row into `Bills` and setting `status` to
`promoted` here.

| Column | Type | Notes |
|---|---|---|
| `suggestion_id` | text | Assigned by the script |
| `detected_name` | text | Merchant/description the detector matched on |
| `matched_transaction_ids` | text | Comma-separated `transaction_id`s that formed this pattern, for audit |
| `avg_amount` | number | Average amount across matches |
| `amount_variance_pct` | number | Max deviation from average, should be ≤5% given the matching rule |
| `detected_frequency` | text | `weekly` \| `biweekly` \| `monthly` (inferred from day gaps) |
| `occurrences` | number | How many times this pattern was seen (≥2 to appear at all) |
| `first_seen_date` | date | |
| `last_seen_date` | date | |
| `account` | text | Which account these transactions came from |
| `status` | text | `pending` \| `promoted` \| `dismissed` — you set this manually |
| `date_detected` | date | When the Zap first added this row |

## Tab 5: `Forecast`

The 30-day rolling projection. **Fully overwritten each nightly run** —
this tab always reflects "today's forecast," not a history (that's what
`Balances` and `Transactions` are for).

| Column | Type | Notes |
|---|---|---|
| `date` | date | One row per day, today through +30 days |
| `day_of_week` | text | e.g. `Mon` |
| `is_business_day` | boolean | `FALSE` for weekends and Canadian statutory holidays |
| `chequing_combined_projected_balance` | number | Joint chequing + personal chequing combined, projected |
| `credit_card_projected_balance_owed` | number | Separate track — see README assumption on this |
| `loc_projected_balance_owed` | number | Separate track |
| `bills_due_today` | text | Comma-separated bill names hitting this date (after weekend/holiday shifting) |
| `bill_amount_today` | number | Sum of bill amounts hitting this date |
| `discretionary_spend_estimate` | number | Modeled non-fixed spend for this day, from trailing average |
| `running_total` | number | Same as `chequing_combined_projected_balance` — kept as an explicit "running total" column for dashboard clarity |
| `below_threshold_flag` | boolean | `TRUE` if `chequing_combined_projected_balance` < configured floor (default $0, see README) |
| `notes` | text | e.g. "Mortgage + Netflix due" |

## Tab 6: `SystemLog`

One row per nightly run. This is how you spot a silent failure without
digging through Zapier's own run history.

| Column | Type | Notes |
|---|---|---|
| `run_timestamp` | datetime | |
| `run_id` | text | Zapier's run/task ID, for cross-referencing |
| `status` | text | `success` \| `failure` \| `partial` |
| `transactions_synced_count` | number | Total returned by `/transactions/sync` this run |
| `new_transactions_count` | number | How many were actually new (post-dedupe) |
| `balances_updated_count` | number | Should be 4 every successful run |
| `bills_matched_count` | number | Transactions matched to a `Bills` row |
| `suggested_bills_added_count` | number | New rows added to `Suggested Bills` |
| `sms_sent_count` | number | |
| `error_message` | text | Blank on success; full error detail on failure |
| `duration_seconds` | number | |

See `sheets-templates/*.csv` for ready-to-import versions of all six tabs
with sample rows already filled in so you can see the shape before real data
flows in.
