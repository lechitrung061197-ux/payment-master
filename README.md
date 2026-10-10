# Payment Master

Payment management system built on Google Sheets + Google Apps Script.

## Architecture

```
Google Sheet "Payment Master"
        ↕
Bound Google Apps Script
        ↕
Local source (managed by clasp)
        ↕
Git → private GitHub repository
```

Current phase: **Master only** (foundation + schema, financial model v2). Seller spreadsheets come in a later phase.

## Conventions

- All schema, code, comments, logs and status values are in English.
- Spreadsheet locale `en_US`, timezone `America/New_York`, currency USD.
- Apps Script runtime V8, timezone `America/New_York`.
- Dates are displayed as ISO 8601 (`yyyy-mm-dd`, `yyyy-mm-dd hh:mm:ss`) to avoid
  month/day ambiguity. Change `FORMATS` in `src/Config.gs` to switch.

## Repository layout

```
appsscript.json     Apps Script manifest (pushed)
.clasp.json         clasp project binding (scriptId, parentId)
.claspignore        Only appsscript.json and src/** are pushed
src/
  Config.gs         Constants, enums, full Master schema, default Settings
  Setup.gs          Idempotent, non-destructive spreadsheet setup/formatting
  Audit.gs          Append-only Audit Log writer
  Utils.gs          Generic helpers
  Settings.gs       Read access to the Settings tab
  ImportBatches.gs  Import Batches rows (one per source-tab sync attempt)
  RawSnapshot.gs    Pure helpers: canonical serialization, checksum, validation, swap-recovery decision
  SafeSwap.gs       Shared crash-safe staging + rename swap + recovery
  RawSync.gs        Safe raw snapshot sync and verify
  CanonicalTable.gs Shared provider-partition replace for canonical tables
  Kh001ProviderTransactions.gs  KH001 normalizer -> Provider Transactions
  Kh001ProviderEvents.gs        KH001 normalizer -> Provider Events
  Kh001Settlements.gs           KH001 normalizer -> Settlements (headers)
  Main.gs           Public entry points
test/               Node unit tests for pure helpers (npm test, not pushed)
```

`rootDir` is `.` (not `src`) because clasp 3.4.0 resolves `rootDir` twice on
`clasp pull` and writes files into `src/src/`. `.claspignore` keeps everything
except the manifest and `src/**` out of the Apps Script project.

## Workflow

```bash
clasp push     # local -> Apps Script
clasp pull     # Apps Script -> local
clasp status   # list tracked files
clasp open-script
```

Then run `setupMaster` (build/update tabs) or `verifyMaster` (read-only report)
from the Apps Script editor. `setupMaster` never deletes tabs or data rows:

- A tab whose header differs from the schema is migrated **only if it has no data
  rows**; otherwise it is left untouched and reported as a warning.
- Renamed Settings keys (`SETTING_KEY_RENAMES`) are renamed in place, keeping the value.
- Each run writes a `SCHEMA_SETUP` row to Audit Log (old/new schema version,
  migrated tabs, renamed keys, warnings).

## Master tabs

| Tab | Purpose |
| --- | --- |
| Settings | Key/value config. Provider-scoped keys: `provider_fee_rate.<PROVIDER>`, `provider_hold_rate.<PROVIDER>` |
| Sellers | Seller master; optional per-seller fee/hold overrides |
| Endpoint Mapping | endpoint_token → seller_id / seller_group, effective-dated |
| Source System | Raw internal transactions (import-only) |
| Source Payments | Raw provider events (payment, refund, dispute, hold, …), one row per event |
| Transactions | Internal transactions (ownership source of truth) |
| Payment Matches | internal transaction ↔ (payment_source, external_transaction_id) |
| Payment Legs | One row per matched external payment transaction, live economics |
| Settlements | Canonical provider settlement headers (provider economics only), all providers |
| Settlement Items | Frozen per-leg snapshot inside a settlement |
| Seller Balances | Per-seller balance across all providers |
| Seller Payouts | Money actually sent to sellers (no settlement_id: one payout may be funded by many settlements) |
| Adjustments | Seller-side money effects: REFUND, DISPUTE, DISPUTE_FEE, MANUAL_ADJUSTMENT, HOLD_RELEASE |
| Disputes | Dispute case tracking |
| Dashboard | Skeleton summary |
| Audit Log | Append-only operation log |
| Import Batches | One row per raw source-tab sync attempt (RUNNING → SUCCESS / NO_CHANGE / FAILED) |
| Raw KH001 PayPal | Raw mirror of KH001 `RAW_PP` |
| Raw KH001 Reconciled | Raw mirror of KH001 `DoiSoat_GD` |
| Raw KH001 Settlements | Raw mirror of KH001 `PhieuDoiSoat` |
| Raw KH001 Disputes | Raw mirror of KH001 `Dispute` |
| Provider Transactions | Canonical provider PAYMENT transactions, all providers (one partition per provider) |
| Provider Events | Canonical signed provider ledger events (payments, reserve holds, withdrawals), all providers |

Hidden `__STAGE_*` tabs are internal to raw sync and must never be read by business logic.

## Financial design rules

### 1. Sources of truth

- The internal system owns transaction ownership (endpoint, seller, store, order).
- The payment source owns actual payment, processing fee, net, refund, dispute and settlement.

### 2. Unique keys

| Table | Unique key |
| --- | --- |
| Source Payments (raw events) | `payment_source + external_event_id` |
| Payment Matches (CONFIRMED rows) | `payment_source + external_transaction_id` |
| Payment Legs | `payment_source + external_transaction_id` |
| Settlement Items | `payment_leg_id` in at most one non-VOID settlement |
| Adjustments, provider-generated | `payment_source + external_event_id + adjustment_type` |
| Adjustments, manual | `adjustment_id` (`external_event_id` blank) |

`external_event_id` identifies one raw provider event/movement. `external_transaction_id`
is the original payment transaction it relates to, so several events (PAYMENT, REFUND,
DISPUTE, DISPUTE_FEE, HOLD, RELEASE, OTHER) can share one `external_transaction_id`.
`related_external_transaction_id` holds a provider parent/reference ID when it differs.

### 3. Two economic layers, never mixed

Provider and seller economics are computed separately from the same `net_amount`.
Each layer uses only its own fee and its own hold.

| | Provider layer (provider pays us) | Seller layer (we owe the seller) |
| --- | --- | --- |
| Fee | `provider_fee = net × provider_fee_rate.<PROVIDER>` | `seller_fee = net × seller_fee_rate` |
| Hold | `provider_hold_amount = net × provider_hold_rate.<PROVIDER>` | `seller_hold_amount = net × seller_hold_rate` |
| Result | provider payout = `net − provider_fee − provider_hold_amount (+ provider_adjustments)` | `seller_available_amount = net − seller_fee − seller_hold_amount` |
| Lives in | Settlements (+ provider columns on legs/items) | Settlement Items, Adjustments, Seller Payouts |

- `system_margin = seller_fee − provider_fee`.
- Seller available **never** subtracts `provider_fee` or `provider_hold_amount`.
- Provider settlement **never** uses `seller_hold_amount`.
- Seller rates fall back to Settings (`seller_fee_rate`, `default_seller_hold_rate`)
  when the Sellers row leaves them blank. There is no shared hold setting.

Example (KH001: provider fee 7%, provider hold 10%; seller fee 8%, seller hold 10%):

```
Gross 100.00 − Processing fee 4.00 = Net 96.00
Provider payout  = 96.00 − 6.72 (fee) − 9.60 (provider hold) = 79.68
Seller available = 96.00 − 7.68 (fee) − 9.60 (seller hold)   = 78.72
System margin    = 7.68 − 6.72                               =  0.96
```

### 4. Lifecycle and where money comes from

| Stage | Source of money figures |
| --- | --- |
| Before settlement | Payment Legs (live, pre-settlement) |
| Provider pays | Settlements + Settlement Items (frozen snapshot once LOCKED) |
| After settlement | Adjustments (refund, dispute, dispute fee, manual, hold release) |
| Paying the seller | Seller Payouts (SENT / CONFIRMED only) |

Seller balance:

```
current_balance = SUM(Settlement Items.seller_available_amount)
                + SUM(Adjustments.amount WHERE status = APPLIED)
                − SUM(Seller Payouts.amount WHERE status IN (SENT, CONFIRMED))
```

Money is never re-read from raw sources or from Payment Legs once a leg is snapshotted.

### 5. Matched ≠ available; transaction status is a summary

- Money becomes available only after the provider settles.
- Financial truth is per Payment Leg. A transaction can have several legs that settle
  on different days.
- `Transactions.status` is a derived summary (`UNMATCHED`, `MATCHED`, `WAITING_SETTLEMENT`,
  `PARTIALLY_SETTLED`, `SETTLED`, `PARTIALLY_AVAILABLE`, `AVAILABLE`) and is never used
  to calculate money. `PAID` is not used at transaction or leg level until seller payout
  allocation exists.

### 6. Refunds, disputes and fees take effect exactly once

- `Payment Legs.refund_amount / dispute_amount / dispute_fee` are provider information for
  reconciliation and audit only.
- Flow: source event → detect refund/dispute/fee → create **one** Adjustment (deduplicated
  by `payment_source + external_event_id + adjustment_type`) → the Adjustment is the only
  financial effect on the seller.
- Sign convention (seller perspective): positive = credit, negative = debit.
  REFUND, DISPUTE, DISPUTE_FEE are negative; HOLD_RELEASE is positive.
- Disputes is case tracking only; its money effect is an Adjustments row.

### 7. Settlement payout amounts

- `payout_base_amount` (in `currency`) = `net_amount − provider_fee − provider_hold_amount + provider_adjustments`.
- `payout_amount` is the actual amount received, in `payout_currency`
  (`fx_rate = 1` when the currencies match).
- Settlements are never used to recalculate seller economics.

### 8. Seller payouts can be funded by several settlements

Seller Payouts has no `settlement_id`. A later phase adds **Seller Payout Allocations**
(`allocation_id, seller_payout_id, seller_id, settlement_id, currency, amount, created_at`),
e.g. SP-001 $1,300 = KH001 settlement $800 + Stripe settlement $500.

### 9. Audit trail

Matches are reversed (`match_status = REVERSED`), never deleted. Settlements are
`LOCKED`, not edited. Important operations are written to Audit Log.

## Raw ingestion (KH001)

Entry points: `syncKh001Raw()` (all tabs), `syncKh001RawPayPal()`,
`syncKh001RawReconciled()`, `syncKh001RawSettlements()`, `syncKh001RawDisputes()`,
and read-only `verifyKh001RawSync()`.

Configuration comes only from Settings: `source.KH001.enabled`,
`source.KH001.spreadsheet_id`, `source.KH001.timezone`, and the source tab names
`source.KH001.raw_paypal_sheet`, `.reconciled_sheet`, `.settlements_sheet`, `.disputes_sheet`.

**Raw means raw.** The used range of each source tab is mirrored as evaluated values
(`getValues()`; formulas are never copied). No renaming, filtering, normalization,
recalculation, business rules or timezone conversion. Types are kept
(number, Date, text, boolean, blank); text cells are written as plain text so values
like `00123` are not re-parsed. The snapshot is exactly the source `getDataRange()`
(used range) dimensions, including trailing cells that evaluate to `""`; staging and
target tabs are resized to exactly those dimensions, so a target snapshot is its whole
grid. A source whose used range is entirely blank fails validation (last known good
snapshot is kept).

**Safe snapshot.** Per source tab, under a script lock: read the whole source once →
validate → checksum → compare with the last SUCCESS/NO_CHANGE batch *and* the current
target → `NO_CHANGE` (no write) or write the full dataset to a hidden staging tab →
verify staging → swap staging into the target by renaming → verify the target (rollback
on mismatch) → log. The live target is never cleared or partially written; the previous
snapshot becomes the staging tab and is kept until the next write. A failure in one tab
does not affect the others.

**Hard-interruption recovery.** The swap renames (1) target → `__SWAP_*`,
(2) staging → target, (3) `__SWAP_*` → staging. If Apps Script is terminated between
steps, the next sync for that tab (under the script lock, before staging is touched)
first marks leftover `RUNNING` batches of that target as `FAILED`
("Recovered interrupted raw sync before next attempt."), then restores names:

| target | swap | staging | state | recovery |
| --- | --- | --- | --- | --- |
| yes | no | any | NORMAL | none |
| no | yes | yes | B (after step 1) | swap → target |
| yes | yes | no | C (after step 2) | target → staging, swap → target (last known good wins) |
| no | yes | no | D | swap → target |
| yes | yes | yes | UNKNOWN | nothing changed; batch FAILED; manual inspection |
| no | no | yes | UNKNOWN | nothing changed; batch FAILED; manual inspection |
| no | no | no | NO_TARGET | none; sync creates the target |

Recovery never deletes a tab. Non-normal recoveries are logged as
`<PROVIDER>_RAW_SYNC_RECOVERED` in Audit Log, and `verifyKh001RawSync()` reports
`swap_state` per source (read-only).

**Checksum.** SHA-256 over a canonical, locale-independent serialization: blank `E`,
text `S<json>`, number `N<decimal>`, boolean `B1/B0`, Date `D<epoch ms>`, hashed in
2,000-row chunks and combined with the dimensions.

**Timezone.** Dates are mirrored as the same instant (epoch ms). Because Master runs in
`America/New_York` and KH001 in `America/Los_Angeles`, a source date-time displays
3 hours later in Master (e.g. 08:00 LA shows as 11:00 NY). The value is unchanged;
interpretation is left to the future KH001 normalizer (`source.KH001.timezone`).

## Provider Transactions (KH001 normalizer)

Entry points: `normalizeKh001ProviderTransactions()` and read-only
`verifyKh001ProviderTransactions()`. Reads only Master raw tabs, never the external sheet.

- **Primary source:** `Raw KH001 PayPal`. One row per row whose `Nhóm GD` is exactly
  `Thanh toán` (NFC-normalized). Status is not filtered (Pending included); `Type` is kept
  as `raw_type`. Headers are looked up by name (row 1); missing/duplicate required
  headers fail.
- **Enrichment only:** `Raw KH001 Reconciled` (header row 6). Exact `Transaction ID` join.
  `Khớp` → `RECONCILED`, `Lệch số tiền` → `AMOUNT_MISMATCH`, no row → `PROVIDER_ONLY`;
  any other status on a joined row fails (`Unmapped KH001 reconciliation status`).
  Reconciled rows without a RAW_PP payment (e.g. `Thiếu trên PayPal`) create nothing.
- **Amounts:** `processing_fee = ABS(raw Fee)`; every row must satisfy
  `gross_amount − processing_fee = net_amount` within 0.005.
- **Keys:** `provider_transaction_id = PT-KH001-PAYPAL-<external_transaction_id>`;
  `provider_id + payment_source + external_transaction_id` is unique across the table;
  a duplicate payment Transaction ID fails.
- **Lineage:** `source_paypal_row`, `source_reconciled_row`,
  `source_fingerprint = SHA-256(paypal_raw_checksum | reconciled_raw_checksum | KH001_PROVIDER_TX_V1)`,
  `normalizer_version`, `normalized_at` (set only when the partition is written).
- **Safe write:** only the KH001 partition is replaced; other providers' rows are kept.
  The full table is sorted by `provider_id, payment_source, transaction_at,
  external_transaction_id`, written to a formatted hidden staging tab, verified, then
  swapped in with the same crash-safe swap/recovery as raw sync. If the table equals the
  current target (ignoring `normalized_at`) the result is `NO_CHANGE` and nothing is written.
- **Verify:** generic checks decide `pass` (target matches a fresh in-memory
  normalization of the current raw tabs, unique keys, amount invariant, swap state).
  A separate `regression` section compares with the October 2026 snapshot expectations
  and does not affect `pass`.

## Provider Events (KH001 normalizer)

Entry points: `normalizeKh001ProviderEvents()` and read-only `verifyKh001ProviderEvents()`.
Source: `Raw KH001 PayPal` only (Provider Transactions is read for referential integrity).

| Nhóm GD | event_type | Verified Type | Status / Balance Impact | Link |
| --- | --- | --- | --- | --- |
| Thanh toán | PAYMENT | Express Checkout Payment | Completed/Credit, Pending/Memo | own Transaction ID |
| Reserve PP | RESERVE_HOLD | Reserve Hold | Completed/Debit | Reference Txn ID (required) |
| Rút tiền | WITHDRAWAL | General Withdrawal | Completed/Debit | none |

- Any other non-blank `Nhóm GD`, Type or Status/Balance Impact combination fails; a row with
  a Transaction ID but blank `Nhóm GD` also fails. No silent `OTHER`.
- Amounts keep PayPal signs (`Fee` stays negative): `gross_amount + fee_amount = net_amount`
  within 0.005.
- `balance_effect_amount`: Credit/Debit → `net_amount` (Credit ≥ 0, Debit ≤ 0), Memo → 0.
  A Pending/Memo payment is an event but does not move the PayPal balance.
- `Txn gốc` is a validation signal only: PAYMENT/WITHDRAWAL → equals Transaction ID;
  RESERVE_HOLD → equals Reference Txn ID (authoritative link).
- PAYMENT and RESERVE_HOLD must link to an existing KH001/PAYPAL Provider Transaction
  (`PT-KH001-PAYPAL-<id>`); WITHDRAWAL has no link. A stale Provider Transactions tab or a
  non-normal swap state on it fails the run.
- **RESERVE_HOLD is the actual PayPal reserve, not the KH001 contractual hold.** No
  percentage is derived; settlements and withdrawal allocation are out of scope.
- IDs `PE-KH001-PAYPAL-<Transaction ID>`; unique `provider_id + payment_source +
  external_event_id`; `source_fingerprint = SHA-256(paypal_raw_checksum | KH001_PROVIDER_EVENTS_V1)`.
- Written with the same provider-partition replace and crash-safe swap as Provider
  Transactions (sorted by `provider_id, payment_source, event_at, external_event_id`).
- Verify: generic checks decide `pass`; the October 2026 `regression` section is report only.

## Settlements (KH001 settlement headers)

Entry points: `normalizeKh001Settlements()` and read-only `verifyKh001Settlements()`.
Order: `syncKh001Raw` → `normalizeKh001ProviderTransactions` → `normalizeKh001Settlements`.

- **History:** only section `D. LỊCH SỬ CHỐT & THANH TOÁN — CÔNG NỢ` of `Raw KH001 Settlements`,
  found by normalized text (NFC, `…` = `...`, case/whitespace-insensitive); the header row is
  searched below it. Sections A/B and unlabeled scratch columns are ignored. The history ends
  at the first row whose `Lần` is not a settlement number; a numbered row with no other
  values is a placeholder and is skipped.
- **Membership:** `Raw KH001 Reconciled` rows with `Có trên PP` = 1 and a `Lần chốt (ngày)`
  belong to the history row whose `Đến ngày` has the same provider-timezone
  (`source.KH001.timezone`) `YYYY-MM-DD` key. Each must resolve to a KH001 Provider
  Transaction; a date with no history row fails.
- **Cross-check (errors):** each included transaction's Provider Transaction must be
  KH001/PAYPAL with the exact external id, `external_status = Completed`, `currency = USD`,
  and DoiSoat `Doanh thu (Gross)` / `Phí PayPal` / `Net` must equal its `gross_amount` /
  `processing_fee` / `net_amount` within 0.005. Provider fee/hold are not compared
  (DoiSoat is authoritative for them).
- **Actual economics:** sums of `Doanh thu (Gross)`, `Phí PayPal`, `Net`, `Phí thuê OP`, `Hold`,
  `Thực nhận (chưa gồm hoàn hold)` — never recalculated from rates, never rounded per row.
  Row and header equations (tolerance 0.005; FX 1 VND) must hold.
- **History fields** are copied as reported (due, carry-in, paid, outstanding, hold released,
  hold balance, due dates, reference, FX, VND paid). `Phát sinh phải trả`, `Còn nợ lần trước`,
  `Tổng phải trả`, `Còn nợ`, `Hold giữ lần này`, `Hold được hoàn lần này`, `Số dư hold` are
  required numbers (blank is an error, never 0). `Đã thanh toán (USD)` may be blank (unpaid;
  0 in equations); a paid amount requires `Ngày thanh toán`; a VND payout requires USD paid
  > 0, FX > 0 and a payment date. `payout_currency` is `VND` only when VND paid is populated.
- **Hold created must reconcile (error):** history `Hold giữ lần này` = SUM(DoiSoat `Hold`)
  of the settlement's transactions within 0.005. `provider_adjustments = period_due −
  transaction_payout − hold_released` is an unclassified residual (warned when non-zero).
- **Hold reconciliation:** `expected_provider_hold_balance` rolls forward
  (previous + created − released) and `hold_balance_difference = provider − expected`.
  The provider value is never overwritten; differences are warnings, not errors.
- Dates are stored as Master date values of the provider-timezone date keys.
- IDs `ST-KH001-PAYPAL-<number padded to 6>`; unique `provider_id + payment_source +
  source_settlement_number`.
- **Settlement-specific `source_fingerprint`** (revision identity of one settlement):
  SHA-256 of `KH001_SETTLEMENT_HEADERS_V1`, that settlement's section-D fields (number,
  period dates, payment date, due, carry-in, total due, paid, outstanding, hold created,
  hold released, hold balance, hold due dates, reference, FX, VND paid) and the DoiSoat inputs
  of its transactions sorted by Transaction ID (id, settlement date key, gross, PayPal fee,
  net, provider fee, hold, payout), using the canonical cell serialization. Sections A/B,
  other settlements, unrelated DoiSoat rows, row numbers and timestamps are excluded. Full
  raw checksums are recorded only in the operation-level audit.
- **Immutability boundary:** Settlements is still a *rebuildable observed* provider
  settlement layer — a later provider edit changes the affected settlement on the next run.
  Before Settlement Items are created/frozen (Phase 2E), a commit/lock boundary must prevent
  a committed settlement from silently mutating; the settlement-specific fingerprint is the
  revision identity for that boundary.
- The KH001 Provider Transactions partition must be current before any write or NO_CHANGE.
  Written with the shared provider-partition replace and crash-safe swap.

## Tests

```bash
npm test   # Node built-in test runner, no dependencies
```

## Out of scope (current phase)

Seller spreadsheets, production imports, PayPal/Stripe/provider connections,
web apps, triggers, scheduled sync, automatic settlement, payout automation.
