# Phase 6: End-to-End Test Plan

Goal: prove the whole pipeline works before you let it send you real SMS
reminders based on real bank data. Four stages, each a gate for the next.

## Stage 0 — Unit-level: forecast logic in isolation

Before touching Zapier at all:

```
node forecast-logic/forecast.test.js
```

All 27 cases should pass (see `04-forecast-logic.md` for what each one
proves). This is your safety net any time you tweak a constant in
`forecast.js` — rerun it before pasting an updated version into Zapier.

## Stage 1 — Sandbox dry run (fake bank, real pipeline)

Uses Plaid Sandbox (`01-plaid-setup.md` section 1.3) so every step of the
Zap runs against realistic-shaped data with zero risk to real accounts.

1. Set `plaid_secret` in Zapier Storage to your **Sandbox** secret and
   `plaid_access_token` to the token you got from the Sandbox Link flow.
   Point `PLAID_BASE` in Step 2's code at `https://sandbox.plaid.com`
   instead of `production.plaid.com` for this stage only.
2. Manually trigger the Zap (Zapier lets you run a single test execution
   without waiting for the schedule).
3. Check, in order:
   - [ ] `Transactions` tab gets new rows, no duplicates on a second run
         with the same cursor
   - [ ] `Balances` tab gets exactly 4 (or however many Sandbox "Platypus
         Bank" exposes) rows for today's date
   - [ ] `Forecast` tab is fully repopulated with 31 rows (today + 30 days),
         numbers roughly sane (no `NaN`, no wildly wrong signs)
   - [ ] `Suggested Bills` gets rows only if the Sandbox data actually has
         repeating transactions (it may not — that's fine, this stage is
         about the pipeline running without errors, not about realistic
         suggestions)
   - [ ] `SystemLog` gets one new row with `status = success`
   - [ ] No SMS fires unless a Sandbox bill happens to fall inside the
         reminder window (unlikely with fake data — if it does fire, confirm
         the message content makes sense)
4. Deliberately break something once, to confirm failure visibility works:
   temporarily set an invalid `plaid_access_token`, run the Zap, and
   confirm you can see the failure — either in Zapier's own run history or
   (once you've wired up the error-path logging noted in
   `03-zapier-zap-spec.md` Step 9) a `status: failure` row in `SystemLog`.
   Then restore the correct token.

**Do not proceed to Stage 2 until every Stage 1 checkbox passes.**

## Stage 2 — Production connection, one account first

Rather than connecting all 4 RBC accounts at once, connect just one (your
personal chequing) first, in Plaid Production:

1. Run Plaid Link in Production, select only what you can (if RBC's Link
   flow doesn't let you cherry-pick a subset, connect all 4 — Plaid
   typically links a full Item at once. If that's the case, skip ahead to
   Stage 3 with full monitoring instead of a true single-account dry run.)
2. Update Zapier Storage's `plaid_secret` (Production) and
   `plaid_access_token` (the real one), and switch `PLAID_BASE` back to
   `https://production.plaid.com`.
3. Manually trigger the Zap once.
4. Verify real transaction data appears correctly in `Transactions` — spot
   check 3-5 rows against your actual RBC online banking to confirm dates,
   amounts, and descriptions line up.
5. Verify the real balance appears correctly in `Balances`.
6. **Do not yet seed `Bills` with real bill amounts if you're not ready for
   real SMS** — leave `Bills` empty or with `active = FALSE` rows during
   this stage so Step 10/11 of the Zap has nothing to remind you about yet.

## Stage 3 — Full connection, real bills, monitored reminders

1. Confirm all 4 accounts are visible and correctly named in `Balances`
   (check `friendlyAccountName()` in Step 2's code matched them all
   correctly — RBC's exact `official_name` strings from Plaid may need a
   tweak to that function's matching rules).
2. Seed `Bills` with your real fixed bills (mortgage, subscriptions, etc.),
   `active = TRUE`.
3. Let the Zap run on its actual nightly schedule for **3-5 consecutive
   nights** before fully trusting it, checking each morning:
   - [ ] `SystemLog` shows `success` for last night's run
   - [ ] `Forecast` looks right — spot check one or two days by hand against
         `Bills` and `Balances`
   - [ ] Any SMS received matches a real upcoming bill, arrived once (not
         duplicated), and the `Bills` tab's `last_reminder_sent_date` updated
         correctly so it doesn't re-fire tomorrow
   - [ ] `Suggested Bills` entries look plausible — review and promote/dismiss
         each one so the tab doesn't accumulate noise
4. Once 3-5 nights are clean, connect Lovable to the Sheet (Phase 5) and
   confirm the dashboard reflects the same numbers you've been
   spot-checking manually.

## Rollback plan if something misbehaves mid-run

- **Wrong/duplicate transactions:** check Zapier Storage's `plaid_cursor` —
  if it's stuck or corrupted, you can reset it to an empty string to force
  a fresh full sync from Plaid (transactions will re-append; manually
  dedupe by `transaction_id` in the Sheet afterward if needed, or add the
  optional Lookup-before-Create hardening noted in
  `03-zapier-zap-spec.md` Step 3).
- **Bad forecast numbers:** the `Forecast` tab is fully overwritten every
  run, so a bad night self-corrects the next run — no manual cleanup
  needed, just fix the underlying cause (usually a `Bills` row with a wrong
  `account_paid_from` or `frequency` value) before the next run.
- **Unwanted SMS volume:** disable the Zap's schedule trigger (or just Step
  10/11) in Zapier immediately — this is a single toggle, no data is at
  risk by pausing.
- **Suspected credential exposure:** rotate the Plaid `secret` and Google
  service-account key from their respective dashboards immediately, update
  Zapier Storage with the new values. Neither ever touches Sheets or
  Lovable directly, so rotation is contained to Zapier Storage.
