# Phase 1: Plaid Setup Walkthrough

Goal: get Plaid connected to your 4 RBC accounts, tested safely in Sandbox first,
without ever putting your RBC username/password anywhere but Plaid's own
hosted Link widget.

## 1.1 Sign up

1. Go to https://dashboard.plaid.com/signup and create a developer account
   (use your own email — this becomes the account that holds your `client_id`/`secret`).
2. During onboarding, Plaid will ask what you're building — describe it as a
   personal finance tool for your own accounts (this is accurate and matches
   the Trial plan's intended use).
3. Once in the dashboard, go to **Team Settings → Keys**. You'll see three
   sets of credentials, one per environment:
   - `client_id` (same across environments)
   - `sandbox` secret
   - `development`/`production` secret (Plaid has consolidated some of these
     over time — use whichever secret the dashboard shows for **Production**)
4. Confirm you're on the **Trial** plan under Team Settings → Billing. Trial
   gives you up to 10 live production Items at no cost — you need 1 (an RBC
   login typically exposes all linked accounts as one Item).

**Do not share these keys anywhere except Zapier's Plaid connection (Phase 3).**
They are backend-only credentials — never paste them into a Sheet, into
Lovable, or into any client-side code.

## 1.2 Enable MFA on your Plaid account

Team Settings → your profile → enable 2FA. Do this now, before connecting
real accounts. (This is on your manual punch list — I can't do it for you.)

## 1.3 Test in Sandbox first — do not skip this

Plaid's Sandbox environment uses fake banks and fake data, so you can prove
the whole pipeline (Plaid → Zapier → Sheets → forecast → SMS) works before
any real RBC data is involved.

1. In the Plaid dashboard, find **Quickstart** (dashboard.plaid.com/overview/quickstart)
   or use Plaid's hosted "Link demo" — either lets you launch Plaid Link
   against the Sandbox environment without writing a backend yourself.
2. When Link asks you to pick an institution, search for **"Platypus Bank"**
   (Plaid's standard Sandbox test institution — has checking, savings, and
   credit accounts, which mirrors your real 4-account setup well enough).
3. When prompted for credentials, use Plaid's documented Sandbox test
   login: username `user_good`, password `pass_good` (these are Plaid's
   public test credentials, not real credentials for anything).
4. Complete Link. You'll get back a `public_token` — in Sandbox mode this is
   safe to inspect/log since it's not tied to any real account.
5. This `public_token` → `access_token` exchange is exactly what your Zap
   will do in Phase 3, so use this Sandbox flow as your first end-to-end test
   of the pipeline (Phase 6 test plan references this).

## 1.4 Connect your real RBC accounts (Production)

Once the Sandbox dry run passes end-to-end (see `06-test-plan.md`):

1. Switch your Plaid dashboard to **Production**.
2. Request Production access if the dashboard asks for it — for personal-use
   Trial plans this is usually instant or same-day approval, no sales call needed.
3. Launch Plaid Link again, this time against Production, and select **RBC
   Royal Bank** as the institution.
4. Plaid Link opens RBC's own hosted login flow (or a Plaid-hosted equivalent
   using OAuth where RBC supports it) — you log in with your real RBC online
   banking credentials **directly into that widget**, which is controlled by
   Plaid/RBC, not by Zapier, not by this codebase, not by me. Neither Zapier
   nor any script you paste ever sees your RBC password.
5. RBC (or Plaid's aggregation layer sitting in front of it) will present a
   list of accounts to share. Select all 4: joint chequing, personal
   chequing, credit card, line of credit.
6. Link completes and hands back a `public_token`. This is single-use and
   expires in ~30 minutes — Zapier's Code step (Phase 3) exchanges it for a
   long-lived `access_token` immediately, then that `access_token` gets
   stored in **Zapier Storage**, not in a Sheet.
7. From then on, the nightly Zap uses that stored `access_token` to call
   `/transactions/sync` and `/accounts/balance/get` — no further login
   prompts unless RBC forces a re-auth (Plaid will surface an `ITEM_LOGIN_REQUIRED`
   error if that happens; the SystemLog tab is where you'll see it, see
   `02-google-sheets-schema.md`).

## 1.5 What to verify before moving on

- [ ] Plaid dashboard MFA enabled
- [ ] Sandbox Link flow completed successfully, `access_token` obtained
- [ ] `/transactions/sync` and `/accounts/balance/get` both return data in
      Sandbox when called with that token (Postman, curl, or Zapier's test
      step — whichever is easiest for you; Phase 3 spec assumes Zapier)
- [ ] Production access confirmed on the Plaid dashboard
- [ ] Real RBC Item connected, all 4 accounts visible in the Plaid dashboard's
      Item inspector

Once these are checked, move to `02-google-sheets-schema.md`.
