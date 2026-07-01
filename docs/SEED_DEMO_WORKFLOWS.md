# Demo workflows seed — `npm run seed:demo-workflows`

Populates **procurement** and **finance** demo data so the Procurement and Finance Mini App screens can be exercised manually.

> ⚠️ **dev / staging / local ONLY.** Never run against production data.
> Guarded like `seed:pilot`: refuses when `NODE_ENV=production` unless `FORCE_DEMO_SEED=1`.

## What it creates

Builds on top of `seed:pilot` (holding **Zelal Group**) — the base pilot seed is left untouched.

- **Extra demo users** (PIN `1234`):
  - `demo_procurement` → `procurement`
  - `demo_finance` → `finance`
- **Demo Full Workflow** (inactive, so it never overrides the active Pilot Workflow):
  `approval → warehouse_check → procurement → finance_payment → receiving → issue → close`
- **Demo requests**, parked on the steps that have queues:
  - «Demo: заявка в закупке» — at the **procurement** step → shows in the Закупки queue.
  - «Demo: заявка на оплате» — at **finance_payment**, **no invoice yet** → shows in the Финансы queue so you can exercise «Выставить счёт» → «Записать оплату».

Idempotent — safe to re-run (stable lookups by telegram id / workflow name / request title).

## Run

```bash
# dev/staging, with a DATABASE_URL pointing at a NON-production DB
npm run seed:demo-workflows
```

Then open the Mini App, log in as `demo_procurement` / `demo_finance` (PIN 1234), and follow
`docs/PROCUREMENT_SMOKE_CHECKLIST.md` / `docs/FINANCE_SMOKE_CHECKLIST.md`.

## Notes

- Invoices/payments are **not** pre-seeded (the finance demo request starts with no invoice) — the
  Finance UI creates them as part of the smoke.
- For a quick, DB-free logic check of the core pilot flow, use `npm run smoke:golden`.
