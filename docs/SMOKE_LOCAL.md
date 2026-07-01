# Local smoke — `npm run smoke:golden`

Fast, zero-setup confidence check that the **pilot golden path works end-to-end over real HTTP**. Use it before a release, after touching the request lifecycle / RBAC / warehouse code, or to demo the flow locally.

## What it does

Boots the **real Express app** (`createApp`) over an **in-memory PGlite** database — the same engine the test suite uses — seeds the deterministic pilot data (`seedPilot`), then drives the golden path against a live `http://127.0.0.1:<random-port>` server, exactly as the Mini App would.

- **No production DB** — in-memory only, discarded on exit.
- **No local PostgreSQL** required.
- **No real Telegram** — dev-auth is enabled only for this in-process harness; the production server stays fail-closed (`devAuthEnabled()`).
- **Real HTTP + real routes** — exercises the same endpoints the Mini App calls.
- **CI-friendly** — exits `0` on success, `1` on any failed assertion.

## Run

```bash
npm run smoke:golden
```

Expected tail:

```
PASS — 12 passed, 0 failed
```

## Assertions covered

| Area | Check |
|---|---|
| Auth | dev-auth issues tokens for requester / director / warehouse |
| Create | `POST /requests` → 201, `pending_approval` |
| Separation of duties | requester approving own request → **403** |
| PIN gate | wrong PIN → 403; missing PIN → 403; correct PIN → advance |
| Approval | director `approve` (PIN) → `warehouse_check` |
| Step guard | re-approve after advance (wrong step) → **400** |
| Warehouse | `wh_in_stock` → `issue`; `issue` → `close` |
| Stock | decremented exactly once (100 → 95) |
| Close | requester `close` → `closed`, workflow done |

## Relationship to other checks

- `npm test` — full unit/integration suite (Vitest + PGlite), incl. procurement & finance logic.
- `npm run smoke:golden` — single real-HTTP pass of the core pilot flow; what to run as a quick gate / live demo.
- Manual Telegram smoke (prod) — verifies the production Mini App runtime; see `docs/PILOT_SMOKE_CHECKLIST.md`.

## Scope

Covers the pilot golden path only (approval → warehouse_check → issue → close). Procurement and finance branches are not in the pilot workflow; they are covered by the unit suite (`procurement-lite.test.ts`, `finance-lite.test.ts`). A separate non-prod demo-workflow seed is planned for manual procurement/finance UI smoke.
