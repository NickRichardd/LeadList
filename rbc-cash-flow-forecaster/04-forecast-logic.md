# Phase 4: Forecast Logic — Audit Walkthrough

This is a prose walkthrough of `forecast-logic/forecast.js` so you can verify
the math without reading code. Every function referenced here is a plain,
deterministic calculation — nothing probabilistic, nothing that "learns."

Run `node forecast-logic/forecast.test.js` any time to see 26 hand-checked
cases pass — that's your regression check if you ever change the constants
at the top of the file.

## 1. Weekend/holiday-aware due dates

`getCanadianBankHolidays(year)` computes the RBC/federal holiday schedule
for a given year: New Year's Day, Good Friday, Victoria Day, Canada Day,
Labour Day, National Day for Truth and Reconciliation, Thanksgiving,
Remembrance Day, Christmas, Boxing Day — with the standard "falls on a
weekend → observed the following Monday" rule applied to fixed dates.

`shiftToBusinessDay(date)` walks a date forward one day at a time until it
lands on a weekday that isn't in that holiday set. A bill "due" on a Sunday
is therefore modeled as hitting the following Monday (or Tuesday, if Monday
is also a holiday) — matching how RBC actually posts pre-authorized debits.

## 2. Bill due-date projection

`computeNextDueDate(bill, asOfDate)` advances a bill's `next_due_date`
forward to the next occurrence on/after "today," based on its `frequency`:

- **monthly/quarterly/annual**: walks forward by the appropriate number of
  months from the bill's due-day, clamping to the last day of a short month
  (e.g. a "due day 31" bill lands on Sept 30, not an invalid Sept 31).
- **weekly/biweekly**: walks forward in fixed 7- or 14-day steps from the
  bill's anchor date.

In `buildForecast`, each active bill is walked forward independently across
the full 30-day window, so a weekly bill can hit the forecast 4 times while
a monthly bill hits once (or not at all, if its due date falls outside the
window).

## 3. The 30-day projection itself

`buildForecast` starts from your real current balances (pulled from the
`Balances` tab that morning) and walks forward day by day:

- **Day 0 is "today"** — shown as-is, no discretionary drag applied yet
  (that starts accruing from day 1 onward, since day 0's real balance
  already reflects whatever happened today).
- For each day, any bill whose *shifted* due date lands there is applied:
  - If paid from a chequing account, its amount is **subtracted from the
    combined chequing line**.
  - If paid from the credit card or LOC, its amount is **added to that
    account's separate "owed" line** instead — chequing isn't touched. This
    is the "separate tracks" behavior noted as the default assumption in
    the README; the alternative (netting everything into one number) is a
    one-line change if you'd rather have that.
- Every day also has a flat **discretionary spend estimate** subtracted from
  chequing — see section 4 below for where that number comes from.
- If the resulting chequing balance drops below `LOW_BALANCE_FLOOR`
  (default $0), that row's `below_threshold_flag` is set to `true`.

Nothing here uses transaction categories to predict category-specific future
spend — it's one flat daily number, kept simple on purpose per the "no
black-box ML" requirement. If you later want per-category discretionary
modeling, that's a scoped addition, not a rewrite.

## 4. Discretionary spend estimate

`computeDiscretionaryDailyAverage` looks at every transaction in the
trailing `DISCRETIONARY_LOOKBACK_DAYS` window (default 90 days) that is
**not** a match to a known fixed bill, sums the outflows, and divides by the
number of days in the window. That single number is applied identically to
every future day in the 30-day forecast. It deliberately ignores weekday/
weekend spending pattern differences — a possible future refinement, not a
v1 requirement.

## 5. Recurrence detection

`detectRecurringPatterns` is the "hybrid" half of bill tracking from spec
section 5:

1. Groups all outgoing transactions by a normalized merchant key
   (`normalizeMerchantKey` uppercases the description, strips long numeric
   store codes, and collapses whitespace/punctuation) — this is the "fuzzy
   match on merchant name."
2. Skips anything already represented in the `Bills` tab (substring match
   against the same normalized key, so "Netflix" in `Bills` matches
   "NETFLIX.COM" in transactions).
3. Within each merchant group, requires **2+ occurrences**
   (`RECURRENCE_MIN_OCCURRENCES`), amounts within **±5%** of each other
   (`RECURRENCE_AMOUNT_TOLERANCE_PCT`), and a day-gap between occurrences
   that falls into a recognized weekly/biweekly/monthly band.
4. Anything meeting all three conditions becomes a row in `Suggested Bills`.
   **Nothing here ever gets written to `Bills` automatically** — the output
   is only ever a suggestion, per the "never auto-add without confirmation"
   requirement.

## 6. SMS reminder selection

`getBillsNeedingReminder` checks every active bill's shifted next due date
against "today." If that due date is between 0 and `SMS_LEAD_DAYS` (default
3) days away, **and** the bill's `last_reminder_sent_date` doesn't already
match that specific due date, it's included in the reminder batch. After a
successful send, the Zap writes the shifted due date back into
`last_reminder_sent_date` for that bill — see `03-zapier-zap-spec.md` step 7
— so re-running the Zap the same day (or a retry) never double-texts you for
the same bill occurrence.

## 7. Where the numbers are auditable

Every row written to the `Forecast` tab traces back to:
- A starting balance you can see in `Balances` for that same date.
- A list of bill hits you can see in `Bills` (via `bills_due_today`).
- One constant (`dailyDiscretionary`) you can verify by hand-summing
  non-bill debits in `Transactions` over the last 90 days and dividing by 90.

If a number in `Forecast` ever looks wrong, those three things are the whole
explanation — there's no hidden state anywhere else in the pipeline.
