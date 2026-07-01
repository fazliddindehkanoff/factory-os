# Factory OS - Full Security & Logic Audit
**Date:** 2026-07-02
**Auditors:** Claude Opus 4.6 (10 parallel agents) + Fable 5 (independent)
**Scope:** All source code, DB schema, migrations, tests, deploy, frontend
**Production:** NOT touched. All analysis on local copy.

---

## Summary

| Metric | Value |
|---|---|
| Files analyzed | ~60 |
| Total issues found | ~96 |
| CRITICAL | 30 |
| HIGH | 40 |
| MEDIUM | ~26 |
| Tests passing | 212/223 (11 failed in legacy `factory-os-master/`) |

---

## CRITICAL ISSUES (fix immediately)

### CRIT-01: Race condition in warehouse — stock goes negative
**File:** `src/services/warehouse.service.ts:50-118`
**Found by:** All 3 audits (consensus)

`applyStock` does SELECT without `FOR UPDATE`. Two parallel `issueStock` calls read same balance, both pass check, both subtract — balance goes negative.

**Reproduction:**
```
availableQty = 10, two parallel POST /warehouse/issue {qty:8}
Tx1: SELECT -> sees 10, check OK
Tx2: SELECT -> sees 10, check OK
Tx1: UPDATE availableQty = 10-8 = 2
Tx2: UPDATE availableQty = 10-8 = 2 (overwrites Tx1, issued 16 from 10)
```

**Fix:** Atomic guarded UPDATE:
```ts
const upd = await tx.execute(sql`
  UPDATE stock_balances
  SET available_qty = available_qty - ${p.quantity}, updated_at = now()
  WHERE id = ${balance.id} AND available_qty >= ${p.quantity}
  RETURNING available_qty`);
if (upd.rowCount === 0) throw new ValidationError('Insufficient stock');
```
Plus CHECK constraint: `ALTER TABLE stock_balances ADD CONSTRAINT stock_avail_nonneg CHECK (available_qty >= 0);`

---

### CRIT-02: Race condition in lifecycle — double approve skips steps
**File:** `src/services/lifecycle.service.ts:241-257`
**Found by:** Opus Agent #1, Fable 5 (prompt)

Transaction reads request without `FOR UPDATE`. For non-approval steps (warehouse_check, procurement, finance_payment, delivery, receiving, issue, close) there is no unique index guard. Two parallel requests both advance the request.

**Fix:** Add `FOR UPDATE` when reading request inside transaction:
```ts
const [req] = await tx.execute(sql`SELECT * FROM requests WHERE id = ${input.requestId} FOR UPDATE`);
```

---

### CRIT-03: Compat — cross-tenant privilege escalation via PATCH /admin/users/:id
**File:** `src/http/compat.routes.ts:950-974`
**Found by:** All 3 audits

No holdingId check on target user. Admin of holding A can modify/hijack user from holding B. `setSingleRole` transfers victim to attacker's holding.

**Fix:** Add `if (targetUser.holdingId !== ctx.holdingId) return res.status(404)` or use `loadHoldingRow`.

---

### CRIT-04: Compat — PIN brute-force (no lockout)
**File:** `src/http/compat.routes.ts:357-390, 407-476, 491-503`
**Found by:** Opus Agent #2

`POST /approvals/:id/approve`, `POST /requests/:id/override`, `POST /auth/verify-pin` — all check PIN without `pinLockoutRemaining`/`recordPinFailure`. Unlimited attempts.

**Fix:** Add lockout calls matching `routes.ts:632` pattern.

---

### CRIT-05: Compat — holding isolation breach in GET /admin/users
**File:** `src/http/compat.routes.ts:892-893`
**Found by:** Opus Agents #2, #3

`userRoles` loaded without holdingId filter — roles from ALL holdings leak into response.

**Fix:** Add `eq(schema.userRoles.holdingId, ctx.holdingId)` to WHERE clause.

---

### CRIT-06: Compat — receive-close writes status 'approved' instead of 'closed'
**File:** `src/http/compat.routes.ts:800-803`
**Found by:** Opus Agent #3

DB gets `status: 'approved'` but response says `status: 'closed'`. Mismatch between DB and UI.

**Fix:** Change `.set({ status: 'approved', ...})` to `.set({ status: 'closed', ...})`.

---

### CRIT-07: Compat — IDOR in POST /requests/:id/attachments
**File:** `src/http/compat.routes.ts:623-666`
**Found by:** Opus Agent #3

No access check before inserting attachment. User who gets 403 on reading can still write attachments to any request by UUID.

**Fix:** Add `canAccessRequest()` check before insert.

---

### CRIT-08: Admin — workflow can be activated with zero steps
**File:** `src/http/admin.routes.ts:1019-1044`
**Found by:** Opus Agent #4

Activating empty workflow causes `firstStep()` to return null — all new requests auto-approve without any review.

**Fix:** Before activation, check `steps.length > 0`.

---

### CRIT-09: Admin — system form fields can be deleted
**File:** `src/http/admin.routes.ts:1406-1428`
**Found by:** Opus Agent #4

Comment says "system fields can only be disabled, never deleted" but code has no `field.system` check. Deleting system fields breaks request creation.

**Fix:** Add `if (field.system) throw new ForbiddenError('Cannot delete system field')`.

---

### CRIT-10: DB — stock_balances missing UNIQUE constraint
**File:** `src/db/schema.ts:532-549`
**Found by:** Opus Agent #7, Fable 5 (both)

Only regular index on `(holdingId, materialId)`, not unique. Parallel first operations create duplicate balance rows — stock accounting splits.

**Fix:** Add unique index:
```sql
CREATE UNIQUE INDEX stock_balances_uniq
  ON stock_balances (holding_id, material_id, COALESCE(warehouse_id, '00000000-0000-0000-0000-000000000000'));
```

---

### CRIT-11: Workflow — request stuck forever if step deleted
**File:** `src/services/lifecycle.service.ts:246-247`
**Found by:** Opus Agent #1

`currentStepId` FK has no `onDelete: 'set null'`. If step deleted, every `performAction` throws ConflictError 409 forever. No recovery path via API.

**Fix:** Add `onDelete: 'set null'` to FK, handle null step gracefully.

---

### CRIT-12: approval.service uses input.inStock instead of req.inStock
**File:** `src/services/approval.service.ts:144-148`
**Found by:** Opus Agent #1

`nextStep` context uses `input.inStock` (from caller, possibly undefined) instead of `req.inStock` from DB. When undefined, `Boolean(undefined) = false`, making procurement step applicable even when goods ARE in stock.

**Fix:** Replace `input.inStock` with `req.inStock ?? undefined`.

---

### CRIT-13: No graceful shutdown
**File:** `src/server/index.ts`
**Found by:** All 3 audits

No SIGTERM/SIGINT handler. Deploy kills in-flight transactions, drops Telegram polling mid-update.

**Fix:**
```ts
const shutdown = async (sig: string) => {
  console.log(`${sig} received, shutting down...`);
  if (bot) bot.stop();
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

---

### CRIT-14: Backups not encrypted + empty backup on pg_dump failure
**File:** `deploy/backup.sh`
**Found by:** All 3 audits

gzip is compression, not encryption. No exit code check — failed pg_dump creates empty .sql.gz. Old valid backups get rotated out, leaving only empty ones.

**Fix:** Add `set -o pipefail`, size check after dump, encryption with `openssl enc` or `gpg`.

---

### CRIT-15: Frontend — double-submit on approve/reject/create
**File:** `web/src/App.tsx:1444-1469 (actions), 1263-1265 (create)`
**Found by:** Opus Agent #6

`setBusy(true)` is async — React batches state updates. Two fast clicks both start with `busy=false` and fire two API calls.

**Fix:** Add `useRef` flag:
```tsx
const submitting = useRef(false);
const run = async () => {
  if (submitting.current) return;
  submitting.current = true;
  // ...
  finally { submitting.current = false; }
};
```

---

### CRIT-16: Frontend — file upload breaks when any file >2MB in multi-select
**File:** `web/src/App.tsx:1116-1134`
**Found by:** Opus Agent #6

Skipped files (>2MB) don't decrement `pending` counter. Counter never reaches 0, valid files never get added.

**Fix:** Decrement `pending` on skip too: `pending--; if (pending <= 0) setValues(...)`.

---

### CRIT-17: Frontend — memory leak in ImageThumb (blob URL never revoked)
**File:** `web/src/App.tsx:1274-1286`
**Found by:** Opus Agent #6

`URL.revokeObjectURL(src)` in cleanup captures stale `src` (always null due to closure). Blob URLs leak on every navigation.

**Fix:** Use local variable in effect instead of state in cleanup.

---

### CRIT-18: Frontend — race condition loading request details
**File:** `web/src/App.tsx:1439-1442`
**Found by:** Opus Agent #6

Fast navigation A->B: request A response arrives after B and overwrites state with wrong data.

**Fix:** Add cancellation flag in useEffect.

---

### CRIT-19: Admin — duplicate stepOrder not blocked
**File:** `src/http/admin.routes.ts:1110-1145`
**Found by:** Opus Agent #4

No unique constraint on `(workflowId, stepOrder)`. Duplicate orders cause non-deterministic step routing.

**Fix:** Add unique index and validate on insert/update.

---

### CRIT-20: Admin — rename role has no audit log
**File:** `src/http/admin.routes.ts:851-867`
**Found by:** Opus Agent #4

PUT /roles/:id (rename) does not call `writeAudit`. Critical admin action invisible in audit trail.

**Fix:** Add `writeAudit(db, { action: 'role.renamed', ... })`.

---

### CRIT-21: DB — connection pool without timeout
**File:** `src/db/client.ts:8-11`
**Found by:** Opus Agent #7

`pg.Pool` created without `max`, `connectionTimeoutMillis`, `idleTimeoutMillis`. Under load, requests queue forever without error.

**Fix:** Add `max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000`.

---

### CRIT-22: DB — roles UNIQUE index doesn't protect NULL holdingId
**File:** `src/db/schema.ts:153`
**Found by:** Opus Agent #7

PostgreSQL: `NULL != NULL` in unique indexes. System roles (holdingId=NULL) can be duplicated.

**Fix:** Add partial unique index: `CREATE UNIQUE INDEX roles_system_code_unique ON roles(code) WHERE holding_id IS NULL;`

---

### CRIT-23: Deploy — PIN_PEPPER read from raw process.env bypassing validation
**File:** `src/auth/pin.ts:6,15`
**Found by:** Opus Agent #10

`hashPin`/`verifyPin` read `process.env.PIN_PEPPER` directly, not from validated `loadEnv()`. If env var missing, pepper silently becomes empty string.

**Fix:** Pass pepper as parameter from validated env object.

---

### CRIT-24: Secrets leaked in archive (.env with production values)
**File:** `.env` in project archive
**Found by:** Fable 5 (both audits)

BOT_TOKEN + SESSION_SECRET in archive = two independent full auth bypasses. PIN_PEPPER enables offline PIN cracking.

**Action:** Rotate ALL secrets immediately. Use `git archive` for packaging.

---

### CRIT-25: Warehouse — duplicate materialId in requestItems breaks idempotency
**File:** `src/services/warehouse.service.ts:60-73, lifecycle.service.ts:422`
**Found by:** Opus Agent #5

Idempotency key is `(requestId, materialId, movementType)`. If same materialId appears twice in requestItems, second item silently skipped — only first quantity issued.

**Fix:** Aggregate quantities by materialId before calling stock operations.

---

### CRIT-26: Warehouse — nested transaction (savepoint) inside lifecycle transaction
**File:** `src/services/warehouse.service.ts:77, lifecycle.service.ts:425-426`
**Found by:** Opus Agent #5

`receiveStock(tx, op)` calls `db.transaction()` on already-open `tx`. Creates savepoint — if refactored to pass `db` instead of `tx`, atomicity silently breaks.

**Fix:** Split into `receiveStockInTx(tx)` (no own transaction) and `receiveStock(db)` (with transaction).

---

### CRIT-27: POST /requests doesn't validate factoryId/departmentId belong to holding
**File:** `src/http/routes.ts:349-382`
**Found by:** Fable 5 (both audits)

factoryId/departmentId from body written to request without checking they belong to user's holding. FK only checks existence. Affects scope resolution and audit.

**Fix:** Validate both IDs via SELECT with holdingId before createRequest.

---

### CRIT-28: Warehouse receive doesn't validate materialId belongs to holding
**File:** `src/http/routes.ts:778-800`
**Found by:** Fable 5 (prompt audit)

`POST /warehouse/receive` accepts any materialId. Can create balance row referencing material from another tenant.

**Fix:** Check `materials.holdingId === u.holdingId` before operation.

---

### CRIT-29: Tests — zero unit tests for hashPin/verifyPin
**Found by:** Opus Agent #9

Cryptographic functions (scrypt + pepper) have no direct tests. Only indirect coverage through lifecycle tests with hardcoded PIN '1234'.

---

### CRIT-30: Tests — zero tests for PIN lockout mechanism
**Found by:** Opus Agent #9

`recordPinFailure`, `pinLockoutRemaining`, `clearPinFailures` — no unit tests at all. `rate-limit.test.ts` only tests HTTP rate limiting.

---

## HIGH ISSUES

### HIGH-01: No workflow versioning — editing active workflow affects in-flight requests
**Files:** `src/db/schema.ts:330-346, lifecycle.service.ts:391`
**Found by:** Opus Agent #1, Fable 5

`performAction` loads current steps, not snapshot from request creation time. Admin changes routing mid-flight.

### HIGH-02: PIN lockout in memory — reset on restart, per-instance
**File:** `src/http/rate-limit.ts:44-80`
**Found by:** All 3 audits

### HIGH-03: actionsForKind fallback to 'approval' for unknown kind
**File:** `src/workflow/step-kinds.ts:130-132`
**Found by:** Opus Agent #1

### HIGH-04: Two independent reject paths not synchronized
**Files:** `lifecycle.service.ts:382-385, approval.service.ts:203-215`
**Found by:** Opus Agent #1

### HIGH-05: Compat — activate/delete users without holding check
**File:** `src/http/compat.routes.ts:976, 991`
**Found by:** Opus Agent #2, Fable 5

### HIGH-06: Admin — required system field can be disabled
**File:** `src/http/admin.routes.ts:1377`
**Found by:** Opus Agent #4

### HIGH-07: Admin — DELETE /users/:id audit log outside transaction
**File:** `src/http/admin.routes.ts:586-611`
**Found by:** Opus Agent #4

### HIGH-08: Admin — telegram_id not validated as numeric
**File:** `src/http/admin.routes.ts:521-523`
**Found by:** Opus Agent #4

### HIGH-09: Admin — conditionRule accepted without structure validation
**File:** `src/http/admin.routes.ts:1137, 1183`
**Found by:** Opus Agent #4

### HIGH-10: Admin — POST /roles unique violation returns 500 not 409
**File:** `src/http/admin.routes.ts:833-848`
**Found by:** Opus Agent #4

### HIGH-11: Admin — no uniqueness check on department/warehouse names
**File:** `src/http/admin.routes.ts:306-322, 417-433`
**Found by:** Opus Agent #4

### HIGH-12: Admin — DELETE /warehouses without checking stock/requests
**File:** `src/http/admin.routes.ts:453-474`
**Found by:** Opus Agent #4

### HIGH-13: Warehouse — reservedQty never updated, issueStock ignores reserves
**File:** `src/services/warehouse.service.ts:86, schema.ts:544`
**Found by:** Opus Agent #5, Fable 5

### HIGH-14: Warehouse — warehouse_check sets inStock without real balance check
**File:** `src/workflow/step-kinds.ts:67-70`
**Found by:** Opus Agent #5

### HIGH-15: Supplier quotation selection — no DB constraint for single selected
**File:** `src/db/schema.ts:608, lifecycle.service.ts:327-331`
**Found by:** Opus Agent #5

### HIGH-16: FK materialId without onDelete — cryptic error on delete
**File:** `src/db/schema.ts:540, 560`
**Found by:** Opus Agent #5

### HIGH-17: Bot — no graceful shutdown for polling
**File:** `src/server/index.ts:28`
**Found by:** Opus Agent #8

### HIGH-18: Bot — notifications lost without retry (Telegram 30/sec rate limit)
**File:** `src/http/routes.ts:81-83, bot/bot.ts:79-83`
**Found by:** Opus Agent #8

### HIGH-19: Scope-blind userCanSeeRequest (uses permission codes without scope)
**File:** `src/http/routes.ts:25-29`
**Found by:** Opus Agent #2

### HIGH-20: Token for pending users (enumeration vector)
**File:** `src/http/routes.ts:112`
**Found by:** Opus Agent #2

### HIGH-21: No helmet — missing CSP, HSTS in Express
**File:** `src/server/app.ts`
**Found by:** Opus Agent #10, Fable 5

### HIGH-22: nginx — no rate limiting, no HSTS, no proxy_send_timeout
**File:** `deploy/nginx.conf`
**Found by:** Opus Agent #10, Fable 5

### HIGH-23: Missing index (holdingId, status) on requests
**File:** `src/db/schema.ts:429-433`
**Found by:** Opus Agent #7

### HIGH-24: Missing index warehouseId on stock_movements
**File:** `src/db/schema.ts:570-573`
**Found by:** Opus Agent #7

### HIGH-25: updatedAt not auto-updated (no DB trigger)
**File:** `src/db/schema.ts:135, 633`
**Found by:** Opus Agent #7

### HIGH-26: quotations.supplier_id FK ON DELETE NO ACTION blocks supplier deletion
**File:** `src/db/schema.ts:604`
**Found by:** Opus Agent #7

### HIGH-27: No holdings.name unique constraint — race in setupTenant
**File:** `src/db/tenant-setup.ts:73-78`
**Found by:** Opus Agent #7

### HIGH-28: Bot — "approved" notification sent for ANY status except approved/rejected
**File:** `src/http/routes.ts:570-579`
**Found by:** Opus Agent #8

### HIGH-29: API — quantity=0 accepted silently in warehouse receive/issue
**File:** `src/http/routes.ts:790,813`
**Found by:** Opus Agent #3

### HIGH-30: API — Invalid Date causes 500 instead of 400
**File:** `src/http/routes.ts:373`
**Found by:** Opus Agent #3

### HIGH-31: Admin — workflow steps reorder has no audit log
**File:** `src/http/admin.routes.ts:1069-1108`
**Found by:** Opus Agent #4

### HIGH-32: Admin — PUT /settings has no key whitelist
**File:** `src/http/admin.routes.ts:1234-1258, compat.routes.ts:1042-1070`
**Found by:** Opus Agents #3, #4

### HIGH-33: Compat — settings thresholds read/write disconnected from workflow engine
**File:** `src/http/compat.routes.ts:1002-1027`
**Found by:** Opus Agent #3

### HIGH-34: generateRequestNumber scans ALL numbers per year on every create
**File:** `src/services/request.service.ts:44`
**Found by:** Fable 5

### HIGH-35: Frontend — Telegram BackButton not implemented
**File:** `web/src/telegram.ts:1-6`
**Found by:** Opus Agent #6

### HIGH-36: Frontend — token in localStorage without expiry
**File:** `web/src/api.ts:1-11`
**Found by:** Opus Agent #6

### HIGH-37: Frontend — admin "Overview" tab accessible to all authenticated users
**File:** `web/src/admin/AdminPanel.tsx:27-63`
**Found by:** Opus Agent #6

### HIGH-38: Tests — no concurrent access tests at all
**Found by:** Opus Agent #9, Fable 5

### HIGH-39: Tests — no cross-tenant stock mutation tests
**Found by:** Opus Agent #9

### HIGH-40: Tests — delivery step kind has no test
**Found by:** Opus Agent #9

---

## MEDIUM ISSUES

M-01: Multi-tenancy relies only on WHERE (no RLS)
M-02: Sessions without revocation (7 days, stateless)
M-03: /auth/telegram creates pending user on any valid initData
M-04: type Db = any across data layer
M-05: No zod validation on API request bodies
M-06: Pagination missing in some endpoints (inbox N+1)
M-07: Email not validated as email in PUT /me/profile
M-08: close step has no REJECT action
M-09: enterApprovalIfNeeded no existing check (raw DB error vs ConflictError)
M-10: thresholdAmount + conditionRule.amount hidden conflict
M-11: Bot — BOT_TOKEN lives in RouterDeps object (serialization risk)
M-12: Bot — setChatMenuButton without chat_id (global, including groups)
M-13: Bot — no markdown escaping in message templates
M-14: Frontend — dashboard error silently swallowed
M-15: Frontend — "Show more" button active with empty filtered list
M-16: Frontend — two simultaneous BottomSheets z-index conflict
M-17: Frontend — AuditLog stale closure on double-click "Show more"
M-18: Frontend — groupByDay uses local timezone, not UTC
M-19: Frontend — success banner doesn't auto-dismiss
M-20: Frontend — DevLogin no loading state
M-21: DB — approvals_one_pending_idx uses literal string not enum cast
M-22: DB — PILOT_PIN='1234' exported, printed to stdout
M-23: Deploy — backup.sh source .env exposes secrets in /proc
M-24: Deploy — stack traces logged with filesystem paths
M-25: Deploy — no .nvmrc / engines in package.json
M-26: Deploy — drizzle.config.ts doesn't validate DATABASE_URL

---

## FIX PRIORITY

### Wave 1: Security (1-2 days)
1. CRIT-03..07 — Patch or disable compat.routes.ts
2. CRIT-01, CRIT-02 — Add FOR UPDATE + atomic updates
3. CRIT-27, CRIT-28 — Validate holdingId on factoryId/departmentId/materialId
4. CRIT-04 — PIN lockout in compat routes
5. CRIT-24 — Rotate all secrets

### Wave 2: Data Integrity (1-2 days)
6. CRIT-10, CRIT-19, CRIT-22 — Add UNIQUE constraints
7. CRIT-08 — Empty workflow activation guard
8. CRIT-09 — System field deletion guard
9. CRIT-06 — Fix receive-close status
10. CRIT-12 — Fix approval.service inStock source

### Wave 3: Stability (1-2 days)
11. CRIT-13 — Graceful shutdown
12. CRIT-15..18 — Frontend double-submit, memory leak, race conditions
13. CRIT-14 — Backup encryption + validation
14. CRIT-21 — Connection pool timeout
15. CRIT-23 — PIN_PEPPER from validated env

### Wave 4: Tests (2-3 days)
16. CRIT-29, CRIT-30 — PIN hash/lockout tests
17. HIGH-38, HIGH-39 — Concurrent + cross-tenant tests
18. HIGH-40 — Delivery step test
19. Negative path tests

### Wave 5: Improvements (ongoing)
20. HIGH issues
21. MEDIUM issues
22. Workflow versioning
23. RLS as second defense line
24. Redis-based rate limiting
