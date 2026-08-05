# Phase 5: Lovable Dashboard Spec

A single-page, view-only dashboard for one user (you). This is written as a
prompt you can paste directly into Lovable, followed by implementation
notes for anything Lovable's chat might ask you to clarify.

## Prompt to paste into Lovable

> Build a single-page personal finance dashboard called "Cash Flow
> Forecaster." It is for one user only (me) — no signup flow, no multi-user
> accounts. Use Lovable's built-in basic auth (a single login) to gate the
> whole app; nothing should be visible unauthenticated.
>
> **Data source:** a Google Sheet, connected read-only. The sheet has six
> tabs: `Transactions`, `Balances`, `Bills`, `Suggested Bills`, `Forecast`,
> `SystemLog`. Read from `Forecast`, `Bills`, `Balances`, and `Transactions`.
> Do not write to the sheet from this app — it's display-only. Refresh data
> on page load and offer a manual refresh button; no need for real-time
> sync, since the data only changes once a night.
>
> **Layout — single page, four sections top to bottom:**
>
> 1. **Cash flow chart.** Line chart of `Forecast.chequing_combined_projected_balance`
>    over `Forecast.date`, 30 days. Mark "today" with a vertical reference
>    line. Shade the region below $0 (or a configurable floor — expose a
>    small settings control for this threshold, default $0) in a warning
>    color (red/orange), and shade the area under the curve when it's below
>    that floor. On hover, show the date, projected balance, and
>    `bills_due_today` for that point. Include two secondary thin lines (or
>    a toggle) for `credit_card_projected_balance_owed` and
>    `loc_projected_balance_owed`, styled distinctly from the main chequing
>    line since these represent debt owed, not cash available.
>
> 2. **Upcoming bills list.** Every row in `Bills` (active only) whose next
>    due date falls within the next 10 days, sorted soonest-first. Show:
>    bill name, amount, account it's paid from, and days-until-due (e.g.
>    "in 3 days"). Visually flag anything due within 2 days.
>
> 3. **Spending by category.** Bar or grouped-bar chart comparing current
>    month-to-date spend per category (grouped from `Transactions.plaid_category_primary`,
>    excluding rows where `is_fixed_bill_match` is true) against the
>    trailing 3-month average for that same category. Sort by current-month
>    spend descending.
>
> 4. **Account balances.** Four cards, one per account (RBC Joint Chequing,
>    RBC Personal Chequing, RBC Credit Card, RBC Line of Credit), each
>    showing current balance (from the latest `Balances` row for that
>    account) and a "last updated" timestamp. For the two credit accounts,
>    also show available credit if present.
>
> **Style:** clean, minimal, numbers-first — this is a personal finance
> tool checked daily, not a marketing page. Support both light and dark
> mode. No decorative content, no placeholder testimonials, no pricing
> sections — just the four sections above.
>
> **Explicitly do not:** expose any Plaid credentials, API keys, or the raw
> Google service account key anywhere in this app's code or network
> requests. This app only ever reads already-computed values out of the
> Sheet — it has no knowledge of Plaid or Zapier at all.

## Connecting the data source

Lovable's Google Sheets connection (however it's implemented on your plan
— native integration or a small Supabase/Edge Function proxy Lovable
generates) should authenticate as a **read-only Viewer** on the Sheet, per
the sharing rule in `02-google-sheets-schema.md`. If Lovable's flow asks
you to share the Sheet with an email address it controls, add that address
as **Viewer**, not Editor — the dashboard never needs write access.

If Lovable can't read a Sheet directly and instead wants a JSON API, the
cleanest option is a tiny **Zapier webhook** (Catch Hook trigger → Google
Sheets "Get Many Rows" → Webhooks by Zapier "Respond" or a scheduled push
to a small serverless endpoint) that exposes the same four tabs as JSON on
a private URL. That's an extra Zap beyond the nightly one in
`03-zapier-zap-spec.md` — only build it if Lovable's native Sheets
connector turns out to be insufficient; try the direct connection first.

## Auth

Lovable's built-in single-user auth (email/password or magic link) is
sufficient per the spec — "doesn't need to be bulletproof since it's just
me, but don't leave it fully public." Don't build a signup page; provision
your one login directly in Lovable's auth settings.

## What "done" looks like for this phase

- [ ] Dashboard loads behind login, no public route exposes data
- [ ] Cash flow chart renders 30 days from `Forecast`, correctly marks
      today and the below-floor zone
- [ ] Upcoming bills list matches what's actually in `Bills`
- [ ] Category spending chart reflects real `Transactions` data once the
      pipeline has run a few times (won't be meaningful on day one with an
      empty sheet — see `06-test-plan.md`)
- [ ] All 4 account balance cards populated with a recent `synced_at`/`date`
- [ ] Confirmed no Plaid/Zapier/Google service-account secrets appear in
      Lovable's generated frontend code or browser network tab
