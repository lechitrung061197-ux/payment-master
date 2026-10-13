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

Payment Master is the **only** accounting source of truth. Seller child spreadsheets (Phase 2K)
are output-only projections written by `syncSellerSheets`; nothing is ever read back from them.

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
  SellerMapping.gs              Sellers draft -> effective-dated Endpoint Mapping history
  EndpointKeyMigration.gs       One-time guarded correction: credential keys -> endpoint tokens;
                                also hosts the credential guard/redaction helpers (keep this file)
  SecurityRedaction.gs          Audit Log credential redaction + exposure check
  InternalTransactions.gs       Raw Internal Transactions -> Source System -> Transactions
  PaymentReconciliation.gs      Exact Transactions <-> Provider Transactions -> Payment Matches
  SellerTerms.gs                Effective-dated seller fee history (validation, resolution, initial seed)
  PaymentLegs.gs                Confirmed matches -> Payment Legs (provider + seller economics, settlement)
  SettlementItems.gs            Frozen per-leg accounting snapshot of provider-paid (AVAILABLE) legs
  SellerBalances.gs             Derived per-seller balances (+ read-only freshness for downstream gates)
  SellerPayoutAllocations.gs    Seller Payout Allocations: obligations, validation, derived states, FIFO
  SellerDestinations.gs         Seller child spreadsheet destinations (validation, initial seed)
  SellerOutput.gs               Seller output contract (schema 4): template anchors, validation, model, checksums
  PaymentPipeline.gs            Scheduled twice-daily pipeline, health gates, trigger installer
  SellerSheets.gs               Seller child sheet sync / verify (owned-range renderer, _Sync commit)
  SellerProvisioning.gs         Template-based seller sheet provisioning + seller-sheet menu helpers
  Operations.gs                 Operations tab (operator view + payout form) and controlled payout transitions
  Main.gs           Public entry points and the "Payment Master" menu
test/               Node tests (npm test, not pushed); test/helpers/masterSim.js = production-shaped
                    end-to-end Master simulation used by the integration tests
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
from the Apps Script editor. `setupMaster` never deletes data rows or schema tabs:

- A tab whose header differs from the schema is migrated **only if it has no data
  rows**; otherwise it is left untouched and reported as a warning.
- Renamed Settings keys (`SETTING_KEY_RENAMES`) are renamed in place, keeping the value.
- A tab removed from the schema (`LEGACY_TABS`) is deleted only when it is provably unused: header
  empty or exactly the legacy header, no data rows, nothing beyond the header columns, and no formula
  or named range elsewhere that references it. Otherwise it is kept, reported as a warning by
  `setupMaster` and listed under `legacyTabs` by `verifyMaster`.
- Each run writes a `SCHEMA_SETUP` row to Audit Log (old/new schema version,
  migrated tabs, renamed keys, removed / kept legacy tabs, warnings).

Schema v17 (Phase 2N) removed `Source Payments`: it never had a reader or writer (provider movements
live in Provider Transactions / Provider Events), so `setupMaster` deletes the empty tab.

Schema v18 (Phase 2O) adds the `Operations` tab (layout only, first tab). Setup never changes which tabs are
hidden and never overwrites operator input in it.

## Master tabs

| Tab | Purpose |
| --- | --- |
| Operations | Operator view + payout command form (not an accounting source; nothing reads it) — see "Operations" below |
| Settings | Key/value config. Provider-scoped keys: `provider_fee_rate.<PROVIDER>`, `provider_hold_rate.<PROVIDER>`; `default_seller_hold_rate` is legacy (not used for KH001) |
| Sellers | User-managed desired mapping: 1 row = 1 seller, endpoint_<N>_name/key pairs |
| Seller Terms | User-edited effective-dated seller fee history per seller + payment_source (seeded once while empty) |
| Seller Destinations | User-managed seller child spreadsheet IDs (ACTIVE / INACTIVE; seeded once while empty) |
| Endpoint Mapping | System-managed effective-dated endpoint ownership history |
| Raw Internal Transactions | Append-only internal CSV evidence: 16 raw CSV columns + 5 ingestion metadata columns |
| Source System | Latest canonical snapshot per internal transaction (rebuilt from raw) |
| Transactions | Canonical internal transactions + effective-dated endpoint ownership |
| Payment Matches | Exact internal ↔ provider reconciliation, one row per (payment_source, transaction id) |
| Payment Legs | One leg per CONFIRMED MATCHED payment: provider amounts, KH001 actual fee/hold, settlement membership |
| Settlements | Canonical provider settlement headers (provider economics only), all providers |
| Settlement Items | Frozen per-leg snapshot inside a settlement |
| Seller Balances | Per-seller balance across all providers |
| Seller Payouts | Money actually sent to sellers (no settlement_id: one payout may be funded by many settlements) |
| Seller Payout Allocations | Classification of each payout to seller settlement obligations (never reduces a balance) |
| Adjustments | Seller-side money effects: REFUND, DISPUTE, DISPUTE_FEE, MANUAL_ADJUSTMENT, HOLD_RELEASE |
| Disputes | Dispute case tracking |
| Dashboard | Optional read-only report (formulas over accounting tabs; nothing reads it) |
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
| Provider Events | `provider_id + payment_source + external_event_id` |
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

Provider and seller economics are kept separate. Fees are independent per layer; for
KH001 the seller hold **mirrors** the provider hold (policy `MIRROR_PROVIDER`).

| | Provider layer (provider pays us) | Seller layer (we owe the seller) |
| --- | --- | --- |
| Fee | `provider_fee_amount`: actual provider value (KH001: DoiSoat `Phí thuê OP`); rates in Settings are only a fallback/validation | `seller_fee_amount = net × seller_fee_rate` |
| Hold | `provider_hold_amount`: actual provider value (KH001: DoiSoat `Hold`) | **KH001:** `seller_hold_amount = frozen provider_hold_amount of that exact transaction` (1:1) |
| Result | provider payout = `net − provider_fee − provider_hold (+ provider_adjustments)` | `seller_available_amount = net − seller_fee_amount − frozen provider_hold_amount` |
| Lives in | Settlements (+ provider columns on legs/items) | Settlement Items, Adjustments, Seller Payouts |

- **KH001 seller hold = provider hold, 1:1, per transaction.** Provider hold 0 → seller hold 0;
  10 → 10; 20 → 20. It is never recalculated from a rate. There is no separate KH001 seller
  hold rate.
- `system_margin = seller_fee_amount − provider_fee_amount` — the fee difference only. The
  hold contributes no margin because it is mirrored.
- Seller available **never** subtracts `provider_fee_amount`.
- Provider fee and seller fee remain separate economics; one never overwrites the other.
- Settings `seller_fee_rate` is the default seller fee. Settings `default_seller_hold_rate` is
  **LEGACY — not used for KH001 mirror-hold accounting**; it is kept (not deleted or migrated)
  until an explicit cleanup phase. Future providers may define their own seller-hold policy;
  KH001 is explicitly `MIRROR_PROVIDER`.

Example (KH001 transaction: provider fee 6.72 and provider hold 9.60 from DoiSoat; seller fee 8%):

```
Gross 100.00 − Processing fee 4.00 = Net 96.00
Provider payout  = 96.00 − 6.72 (provider fee) − 9.60 (provider hold) = 79.68
Seller hold      = 9.60 (= provider hold, 1:1)
Seller available = 96.00 − 7.68 (seller fee)   − 9.60 (seller hold)   = 78.72
System margin    = 7.68 − 6.72                                        =  0.96
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
- The section-D sheet row is not stored (row position is not a stable identity); the
  verifier/audit report the current row as diagnostic `settlement_source_rows` only.
- **Immutability boundary:** Settlements is still a *rebuildable observed* provider
  settlement layer — a later provider edit changes the affected settlement on the next run.
  Before Settlement Items are created/frozen (Phase 2E), a commit/lock boundary must prevent
  a committed settlement from silently mutating; the settlement-specific fingerprint is the
  revision identity for that boundary.
- The KH001 Provider Transactions partition must be current before any write or NO_CHANGE.
  Written with the shared provider-partition replace and crash-safe swap.

## Seller / endpoint mapping

Entry points: `publishSellerMapping()` and read-only `verifySellerMapping()`.

- **Sellers** (user-edited): `seller_id, seller_name, status (ACTIVE/INACTIVE), effective_from,
  endpoint_1_name, endpoint_1_key, … endpoint_10_name, endpoint_10_key, notes`. Pairs are
  discovered from the header (`endpoint_<N>_name/key`), so adding slots is a schema-only
  change. A pair is both blank or both filled. Among ACTIVE sellers `endpoint_key` is unique
  and `endpoint_name` is unique case-insensitively. Row order, slot order, blank slots and
  notes have no meaning. `effective_from` is the date of the NEXT ownership change of the row.
- **Seller IDs**: blank `seller_id` gets the next `SLR-######` after every ID seen in Sellers
  or Endpoint Mapping (never recycled), written back to Sellers under the lock. Custom unique
  IDs are kept. Identity never comes from `seller_name`.
- **Endpoint Mapping** (system-managed): `mapping_id, seller_id, seller_name_snapshot,
  endpoint_name, endpoint_key, effective_from, effective_to, opened_version, closed_version,
  status (OPEN/CLOSED), opened_at, closed_at, notes`.
  `mapping_id = EM-<sha256(seller_id|endpoint_key|effective_from)>`.
- **Publish**: desired = endpoints of ACTIVE sellers. OPEN rows whose
  (seller_id, endpoint_key, endpoint_name) are not desired are closed
  (`effective_to = effective_from − 1 day`, `closed_version`, `status`, `closed_at` only);
  desired entries not OPEN are opened. Reported as NEW / REMOVED / MOVED_TO_ANOTHER_SELLER /
  NAME_CHANGED / KEY_CHANGED. All changes share one `effective_from` taken from the involved
  Sellers rows (old owner of every closed row, new owner of every opened row) and one
  version `SMV-######`. A seller name or notes change alone is NO_CHANGE. CLOSED rows are
  immutable.
- **Version boundaries:** every version has one effective date, derived from history —
  `opened_version` → `effective_from`, `closed_version` → `effective_to + 1 day` (CLOSED rows).
  All occurrences of a version must agree and dates must increase with the version number
  (history integrity). The initial publish may be back-dated; every later publish must be
  strictly after the latest version boundary (this covers publishes that only closed rows)
  and after the `effective_from` of every row it closes.
- **Seller retention:** every `seller_id` that ever appeared in Endpoint Mapping must stay on
  exactly one Sellers row forever (it may be INACTIVE with no endpoints; the name may change).
  A missing or re-keyed historical seller fails the publish before anything is written.
- The new history is validated (ids, snapshot name, opened/closed timestamps, dates, versions
  and version boundaries, no overlaps per key / per name, at most one open-ended row each,
  immutability) and written as a whole table through the shared crash-safe swap
  (`writeCanonicalTable_`). Audit reports `initial_swap_state`, `recovery_actions` and
  `final_swap_state`.
- **Resolvers** (for later phases): `resolveEndpointByKey_`, `resolveEndpointByName_`,
  `resolveEndpointByNameAndKey_` — match `effective_from <= date <= effective_to`
  (blank = open) on Master-timezone date keys; none → UNMAPPED, several → error; name and
  key together must resolve to the same row.
- **Seller hold (locked rule for the next phase):** for KH001, `seller_hold_amount` = the
  frozen `provider_hold_amount` of the same transaction, 1:1 (see Financial design rules §3).
  There is no independent KH001 seller hold percentage and Sellers does not configure it.
  `default_seller_hold_rate` is legacy and left for a later explicit cleanup.

### Endpoint key = ownership token, never a credential

- `endpoint_key` (Sellers `endpoint_<N>_key`, Endpoint Mapping `endpoint_key`) is the stable
  internal endpoint **token**, e.g. `glk_r8XToW` — an ownership identifier, not an API
  credential. The internal transaction export field `endpoint_token` maps to it by exact
  equality (`internal.endpoint_token === Endpoint Mapping.endpoint_key`); no split/prefix
  heuristics in transaction processing.
- Full endpoint credentials (`<token>.<secret>`) must never be stored in ownership history.
  `publishSellerMapping()` refuses them, and credential-looking values are redacted
  (`<token>.<redacted>`) from errors, audit details, logs and verifier reports. A future
  realtime integration must keep credentials/configuration in a secured connector/settings
  layer, never in Endpoint Mapping or other accounting history.
- **One-time correction** `migrateSellerEndpointKeysToTokens()` (with read-only
  `verifySellerEndpointKeys()`): rewrites legacy `<glk_token>.<suffix>` keys to the token in
  Sellers and Endpoint Mapping and recomputes `mapping_id`; every other history field is
  preserved and no new version is created. It runs under the script lock only when
  `schema_version = 7`, Source System / Transactions / Payment Matches / Payment Legs /
  Settlement Items are empty, history is exactly the initial OPEN `SMV-000001` rows effective
  `2026-10-01`, all keys are recognized, resulting tokens are unique, historical sellers are
  retained and Sellers matches published ownership (token-normalized). Otherwise it fails
  without mutation. Endpoint Mapping is written through SafeSwap, Sellers in one batch; the
  result is re-read and validated. It is idempotent (fully migrated → `NO_CHANGE`) and
  converges from a partially migrated state. Once any dependent table has data it is refused.
  The legacy parser is for this migration only.
- **Security redaction:** `redactAuditLogCredentials()` is a controlled exception to the
  append-only Audit Log: it replaces credential substrings in existing cells with
  `<token>.<redacted>` (nothing else changes) and appends a `SECURITY_REDACTION` entry listing
  the cleaned rows, never the removed values. Read-only `verifyCredentialExposure()` counts rows
  that still hold credentials in Audit Log, Sellers and Endpoint Mapping. Rotating the exposed
  credentials is the real remediation; spreadsheet version history and old execution logs
  cannot be guaranteed clean.

## Internal transactions (Phase 2F)

Entry points: `normalizeInternalTransactions()` and read-only `verifyInternalTransactions()`.
Scope: raw evidence and canonical internal transactions with ownership only — no provider
matching, Payment Legs, fees, holds, availability, balances or payouts.

- **Raw Internal Transactions** (append-only, written only by the import step): the 16 CSV
  columns `order_id, payment_method, transaction_id, gateway, status, total, currency,
  sub_account, store_domain, shield_domain, endpoint_token, created_at, refunded_at, customer,
  settled_at, note` exactly as exported (written as text, never normalized), then
  `import_batch_id, source_file_name, source_row_number, row_fingerprint, imported_at`.
  The same `transaction_id` may appear in several batches.
- **`row_fingerprint`** (computed by the importer, verified by the normalizer): lowercase hex
  SHA-256 of the UTF-8 string `"INTERNAL_RAW_V1" + U+001E + join(U+001F, f1..f16)` where `fi`
  is `E` for an empty field, else `S` + JSON string of the field text. Metadata is excluded,
  so the same CSV row always has the same fingerprint.
- **Import Batches** for a manual CSV: `provider_id = INTERNAL`, `source_spreadsheet_id` blank,
  `source_sheet` = file name, `target_sheet = Raw Internal Transactions`, `source_rows` = CSV data
  rows, `source_columns = 16`, `checksum` = full file checksum, status SUCCESS / NO_CHANGE /
  FAILED, `actor = system`. The verifier warns about raw batches without such a record.
- **Snapshot selection** per `transaction_id`: latest `imported_at` wins (tie: `import_batch_id`,
  then `source_row_number`). Fails on a blank id, a fingerprint mismatch, two payment sources for
  one id, or two different snapshots of one id within a batch. Identical repeats are fine.
- **Gateway**: `paypal → PAYPAL`, `stripe → STRIPE` (case-insensitive); anything else fails.
- **Timestamps**: Date values or ISO `YYYY-MM-DD[T ]HH:mm[:ss[.fff]]` with `Z`/offset. Timestamps
  without an offset are rejected unless Settings `source.INTERNAL.naive_timestamp_timezone` is set.
  `total` must be a plain decimal (e.g. `1234.50`).
- **Source System**: `source_record_id = ISRC-<sha256(payment_source|internal_transaction_id)>`;
  raw texts copied, `created_at` / `imported_at` parsed, `order_amount` numeric.
- **Transactions / ownership**: exact `endpoint_token === Endpoint Mapping.endpoint_key` on the
  created date in America/New_York (no split, prefix, case folding or fallback to sub_account /
  names). One mapping → `MAPPED` with `mapping_id`, `mapping_version` (= opened_version),
  `seller_id`, `seller_name_snapshot`, `endpoint_name_snapshot`; none → `UNASSIGNED_ENDPOINT`
  (row kept, not seller money); overlapping history → fail. `status = UNMATCHED`.
  `settled_at_raw` / `refunded_at_raw` are internal raw text only — never settlement proof,
  availability or adjustments.
- Both tables are rebuilt from raw under the script lock and written as whole tables through
  SafeSwap only when their content changed (Transactions keeps `updated_at` for unchanged rows
  and ignores it for NO_CHANGE). Provider / settlement / seller-money tabs are never touched.
- Dashboard formulas reference tabs by name (`INDIRECT`) and are refreshed by `setupMaster`, so
  they keep working when a tab is replaced by a swap.

## Payment reconciliation (Phase 2G)

Entry points: `reconcilePayments()` and read-only `verifyPaymentReconciliation()`.
Only Payment Matches and Audit Log are written — no Payment Legs, fees, holds, availability,
settlement items, balances or payouts, and `Transactions.status` is not changed
(Payment Matches is the reconciliation source of truth until the settlement state machine).

- **Exact key**: internal `(payment_source, internal_transaction_id)` = provider
  `(payment_source, external_transaction_id)`, string equality only. PAYPAL only matches PAYPAL,
  STRIPE only STRIPE. No order / customer / amount-only / sub_account / store / seller fallback.
- **Uniqueness guards**: both key sets must be unique; a provider key present twice fails even
  under different `provider_id` (one provider payment never confirms two internal transactions).
- **Status** over the union of keys: both sides with equal currency (trim + uppercase) and
  `|provider gross_amount − internal order_amount| < 0.005` → `MATCHED` (AUTO / CONFIRMED);
  otherwise `AMOUNT_MISMATCH` (AUTO / PENDING_REVIEW; currency mismatch leaves
  `amount_difference` blank with a note); internal only → `MISSING_PROVIDER`; provider only →
  `MISSING_INTERNAL`. Provider `external_status` (e.g. Pending) does not affect identity.
- **IDs / lineage**: `match_id = PM-<sha256(payment_source|transaction id)>`, stable when a row
  moves from MISSING_PROVIDER to MATCHED. Copies internal / provider fingerprints,
  `provider_transaction_id`, `provider_id`, `provider_external_status`; no seller economics.
- **Timestamps**: `matched_at` / `matched_by = system` are set the first time a row is CONFIRMED
  and preserved; `updated_at` changes only when the row content changes. A rerun with the same
  input is NO_CHANGE. An existing `match_id` missing from the fresh union fails (rows are never
  silently deleted); a previously confirmed row that is no longer MATCHED is reported.
- **Upstream freshness gates** (before any write; a NORMAL swap state alone is not enough):
  Transactions must equal the canonical result of current Raw Internal Transactions + Endpoint
  Mapping (ignoring only `updated_at`), else FAILED "Transactions is stale; run
  normalizeInternalTransactions first."; the KH001 partition of Provider Transactions must
  equal the canonical result of the current KH001 raw tabs (`checkKh001ProviderTransactionsCurrent_`),
  else FAILED "Provider Transactions KH001 is stale; run normalizeKh001ProviderTransactions first.".
  The verifier reports `internal_transactions_current` / `provider_transactions_current` and
  fails when either is false. Whole-table duplicate provider key validation still follows.
- Written as a whole table through SafeSwap under the script lock; requires Transactions and
  Provider Transactions in a NORMAL swap state. The Dashboard "Matched" metric counts
  Payment Matches with `reconciliation_status = MATCHED`.

## Payment Legs (Phase 2H)

Entry points: `normalizePaymentLegs()` and read-only `verifyPaymentLegs()`. Writes only
Payment Legs and Audit Log. Provider economics and settlement availability are described here;
seller economics (Phase 2I) and provider-paid `AVAILABLE` (Phase 2J) are described below.
Refunds/disputes and payout allocation are still out of scope.

- **Eligible**: Payment Matches with `reconciliation_status = MATCHED` and `match_status =
  CONFIRMED` (MISSING_*, AMOUNT_MISMATCH, REJECTED, REVERSED create none). Only KH001 / PAYPAL
  is supported; any other eligible provider/source fails.
- **Identity**: `payment_leg_id = PL-<sha256(payment_source|external_transaction_id)>`; unique by
  `payment_source + external_transaction_id`. The exact Provider Transactions row named by the
  match must agree on source, id and provider. Base `currency`, `gross_amount`,
  `processing_fee`, `net_amount` come from Provider Transactions; `created_at` = provider
  `transaction_at`.
- **Actual KH001 economics** (provider reconciliation RECONCILED): exactly one Raw KH001
  Reconciled row (exact Transaction ID, status Khớp); DoiSoat gross / Phí PayPal / Net must equal
  the provider values (< 0.005); `provider_fee` = `Phí thuê OP`, `provider_hold_amount` = `Hold`
  (actual, authoritative, never computed from Settings); `provider_fee_rate` / `provider_hold_rate`
  are derived (amount / net; blank when net = 0); `net − fee − hold` = `Thực nhận` (< 0.005);
  fee and hold are non-negative. Not yet RECONCILED → base values only, provider economics and
  settlement blank, `WAITING_SETTLEMENT` (no estimated hold).
- **Settlement membership**: `Lần chốt (ngày)` (provider-timezone date key) resolves to exactly
  one KH001 Settlements row by `period_end_date` → `settlement_id`, `settlement_status = SETTLED`;
  blank → `WAITING_SETTLEMENT`; zero or several settlements → fail. Since Phase 2J a leg whose
  settlement the provider has fully paid becomes `AVAILABLE` (see below).
- **Settlement aggregates**: per settlement, leg count and sums of gross / processing fee / net
  (< 0.005) and provider fee / hold / derived transaction payout (< 0.00005) must equal the
  Settlements header. A settled provider payment without a confirmed match therefore fails.
- **Seller fields** come from the effective-dated Seller Terms rate (`seller_fee = net × rate`);
  `seller_hold_amount` mirrors the actual provider hold and `seller_available_amount = net −
  seller_fee − seller_hold_amount` (Phase 2I). `refund_amount` / `dispute_amount` / `dispute_fee`
  stay blank (out of scope; not computed, not zero). `Transactions.status` is not changed.
- **Gates**: Transactions, Provider Transactions KH001, Payment Matches and Settlements KH001
  must all be current (shared read-only freshness helpers), Seller Terms must be valid (every
  seller covered) and fresh legs must agree with frozen Settlement Items before any write.
- **Timestamps**: `updated_at` set on creation, preserved when the leg content is unchanged; a
  rerun is NO_CHANGE; a previously produced leg that disappears fails. SafeSwap under the lock.
- Dashboard "Waiting settlement" counts `Payment Legs.settlement_status = WAITING_SETTLEMENT`.

## Seller terms and seller economics (Phase 2I)

- **Seller Terms** (`seller_id, payment_source, seller_name_snapshot, seller_fee_rate, effective_from,
  effective_to, notes`; schema v14): effective-dated seller FEE history **per seller + payment source**.
  The applicable term is looked up by `seller_id + payment_source + transaction date` with an exact
  `payment_source` match — never a fallback to another source (PAYPAL terms are never used for
  STRIPE); no applicable term fails closed. Rules: seller exists in Sellers, `payment_source` required
  (PAYMENT_SOURCE enum), non-blank name snapshot, `0 <= rate < 1`, `effective_from` required,
  `effective_to` blank (open) or ≥ from; per seller + source no overlapping periods, at most one open
  row, no duplicate periods; and every seller with a
  `seller_id` must have at least one valid row (a missing seller blocks Payment Legs and everything
  downstream; once the tab has data it is never auto-seeded — add the term manually). A fee change closes the old row
  and adds a new one, so earlier transactions keep their rate. `verifySellerTerms()` is read-only.
- **v13 → v14 migration** (`setupMaster`): when Seller Terms still has the v13 header, a
  `payment_source` column is inserted after `seller_id` and every existing row gets `PAYPAL` (all terms
  so far are PAYPAL activity); rates, dates, names and notes are preserved and frozen Payment Legs /
  Settlement Items are never recalculated.
- **Seed**: `setupMaster` seeds Seller Terms only while it has no data rows — one PAYPAL row per seller
  with Settings `seller_fee_rate`, starting at the seller's earliest Endpoint Mapping
  `effective_from` — and never reseeds or overwrites history. After that, rates come only from
  Seller Terms.
- **Seller economics in Payment Legs** (still the only Payment Legs writer): the leg's internal
  Transaction (exact `payment_source + internal_transaction_id`) must be MAPPED to a seller; the
  Seller Terms row of that seller and the leg's own `payment_source` in effect on the transaction's
  created date (America/New_York) gives `seller_fee_rate` (frozen in the leg snapshot); `seller_fee = net × rate` (unrounded). With actual provider economics:
  `seller_hold_amount = provider_hold_amount` (KH001 MIRROR_PROVIDER), `seller_hold_rate = hold / net`,
  `seller_available_amount = net − seller_fee − seller_hold_amount`. Without an actual provider hold,
  seller hold and available stay blank. `system_margin = seller_fee − provider_fee` is reported.
- `normalizePaymentLegs()` additionally requires valid Seller Terms; `verifyPaymentLegs()` reports
  `seller_terms_valid`, seller totals, per-seller totals and seller-economics invariant errors.

## Provider-paid availability, Settlement Items and Seller Balances (Phase 2J)

Operating order: `syncKh001Raw` → `normalizeKh001ProviderTransactions` →
`normalizeKh001Settlements` → `normalizeInternalTransactions` → `reconcilePayments` →
`normalizePaymentLegs` → `normalizeSettlementItems` → `normalizeSellerBalances`. Each step fails
without writing while any upstream step is stale.

- **AVAILABLE** (Payment Legs): settlement membership alone gives `SETTLED`. A leg becomes
  `AVAILABLE` only when its settlement has a `source_payment_date`, `source_paid_amount ≥
  total_due_amount − 0.005` and `outstanding_amount ≤ 0.005` (provider paid in full). Blank
  payment date, partial payment or any outstanding amount keeps the leg `SETTLED`.
- **Settlement Items** (`normalizeSettlementItems()` / read-only `verifySettlementItems()`): one
  item per AVAILABLE leg, `settlement_item_id = SI-<sha256(settlement_id|payment_leg_id)>`;
  `seller_id` comes from the leg's exact internal Transaction (must be MAPPED). Items are
  **frozen**: an existing item is kept byte-for-byte (`snapshot_at` set once, on creation, and it
  must stay a valid datetime — a blank or invalid `snapshot_at` on an existing item fails
  normalize and verify (`invalid_snapshot_at`) and is never repaired automatically); an
  item whose fresh leg would differ in any frozen field, is no longer AVAILABLE, or disappears is a
  hard error, as are duplicate item ids or payment legs. Per item `seller_hold = provider_hold`
  and `seller_available = net − seller_fee − seller_hold`; in total
  `provider transaction payout = seller available + system margin`.
- **Frozen guard in Payment Legs**: `normalizePaymentLegs()` also fails (no write) when a fresh
  leg diverges from its frozen item — e.g. a retroactive Seller Terms rate change or a settlement
  that stops being paid. Fee changes must be future-dated (close the old row, add a new one).
- **Seller Balances** (`normalizeSellerBalances()` / read-only `verifySellerBalances()`): derived
  per `seller_id + currency`, computed in micro-units:
  `settled_amount = SUM(items.seller_available_amount)`;
  `adjustments = SUM(Adjustments.amount WHERE status = APPLIED)` (PENDING / VOID ignored);
  `paid_amount = SUM(Seller Payouts.amount WHERE status IN (SENT, CONFIRMED))` (DRAFT / VOID
  ignored); `current_balance = available_amount = settled + adjustments − paid` (negative allowed
  and reported as a warning, never clamped); `seller_hold_balance = SUM(items.seller_hold_amount)
  − SUM(APPLIED HOLD_RELEASE)`. HOLD_RELEASE amounts must be positive and may not drive the hold
  below zero; payout amounts must be positive; duplicate ids, unknown sellers, blank currency or
  non-numeric amounts fail. `updated_at` is preserved while a row is unchanged; a balance key that
  disappears fails. Gate: Settlement Items must be current.
- **Dashboard** (USD): Available and Seller balances = Seller Balances `available_amount` /
  `current_balance`; Provider settlements = Settlements `source_paid_amount`; System margin =
  Settlement Items `seller_fee − provider_fee`; Holds = Seller Balances `seller_hold_balance`.
- Schema v12 changes only column types/descriptions of Settlement Items and Seller Balances
  (`AMOUNT4` for unrounded economics); `setupMaster` on a v10 Master adds Seller Terms (seeded
  once) and leaves every data tab untouched.

## Scheduled payment pipeline (Phase 2M)

`runScheduledPaymentPipeline()` runs the whole chain twice a day and publishes seller sheets only when every
stage and every health gate passes. It reuses the existing runners (each keeps its own script lock, staging /
swap, freshness gates and idempotency); the pipeline itself holds the **document lock**, so an overlapping run
is skipped (`PIPELINE_SKIPPED_LOCKED`) and never runs in parallel.

| # | Stage (audit prefix) | Runner |
| --- | --- | --- |
| 1 | `PROVIDER_SYNC` | adapter preflight, then raw sync of every enabled provider source (`syncRawSource_`) |
| 2 | `PROVIDER_NORMALIZE` | per enabled provider: Provider Transactions, then Provider Events |
| 3 | `INTERNAL_NORMALIZE` | Raw Internal Transactions → Transactions (NO_CHANGE when raw is unchanged) |
| 4 | `RECONCILE` | Payment Matches |
| 5 | `SETTLEMENT_REFRESH` | per enabled provider: provider Settlements (source paid amount / date) |
| 6 | `PAYMENT_LEGS_REFRESH` | Payment Legs, incl. provider-paid availability (AVAILABLE) |
| 7 | `SETTLEMENT_ITEMS_REFRESH` | frozen Settlement Items |
| 8 | `SELLER_BALANCES_REFRESH` | Seller Balances |
| 9 | `SELLER_PAYOUT_STATUS_REFRESH` | validates Seller Payouts + Allocations; UNPAID / PARTIAL / PAID are derived, never stored |
| 10 | `HEALTH_CHECK` (`_PASS` / `_FAIL`) | `verifyPaymentPipelineHealth` gates (below) |
| 11 | `SELLER_SHEETS_SYNC` | ACTIVE seller sheets (PARTIAL counts as a pipeline failure) |

- **Providers**: only providers ENABLED in `RAW_SOURCES` (Settings `source.<ID>.enabled`) are fetched and
  normalized, each through its adapters in `PROVIDER_PIPELINE_RUNNERS` (`transactions`, `events`, `settlements`,
  `eventsReport`; today only KH001). An enabled provider without a complete adapter set fails the run closed in
  `PROVIDER_SYNC` before anything is fetched (`missing_adapters` in the audit); disabled providers are skipped.
  Adding a provider = its `RAW_SOURCES` entry + its adapters.
- **Stop on failure**: any stage that is not SUCCESS / NO_CHANGE (/ PASS) stops the run — nothing downstream
  runs and seller sheets are not published. Every run has a `pipeline_run_id` (`PRUN-…`); audit rows
  (`entity_type` PIPELINE, `entity_id` = run id): `PIPELINE_STARTED`, `<STAGE>_<STATUS>` with stage,
  status, started_at, completed_at, duration and error, then `PIPELINE_SUCCESS` / `PIPELINE_FAILED` (failed
  stage, failed_at, duration) or `PIPELINE_SKIPPED_LOCKED`. The stage runners keep their own detailed audit rows.
- **Health gates** (`verifyPaymentPipelineHealth()`, read-only): raw provider sync current (swap NORMAL, last
  batch SUCCESS / NO_CHANGE per enabled tab), Provider Events current, and Transactions / Provider Transactions /
  Payment Matches / Settlements / Seller Terms / Payment Legs / Settlement Items / Seller Balances current; no
  duplicate IDs in any canonical table; MATCHED amount mismatch = 0; `seller_available = net − seller_fee −
  seller_hold` on every leg and item; payout allocations valid; paid ≤ obligation; Seller Balances reconcile to
  Settlement Items + APPLIED adjustments − valid seller payouts.
- **Schedule** (Settings, seeded): `scheduled_sync_morning_hour` (8), `scheduled_sync_afternoon_hour` (17),
  `scheduled_sync_timezone` (`America/New_York` = the Master timezone `APP.TIMEZONE`; Phase 2O.2). The time zone
  must be an IANA region name — fixed offsets (`GMT+7`, `UTC-05:00`, `Etc/GMT-7`, `UTC`) are rejected — so
  08:00 / 17:00 stay New York wall-clock hours across daylight saving time (handled by Apps Script, no UTC offset
  arithmetic). `installScheduledPaymentPipelineTriggers()` replaces this pipeline's triggers with exactly two
  daily time-driven triggers (idempotent — re-running never duplicates; other triggers untouched; warns when the
  schedule time zone is not the Master timezone); `removeScheduledPaymentPipelineTriggers()` removes them;
  `verifyScheduledPaymentPipelineTriggers()` (read-only) checks there are exactly 2 and that the last install
  (audited `PIPELINE_TRIGGERS_INSTALLED`) matches Settings in the Master timezone. Requires the `script.scriptapp`
  scope.
- **Timezone migration (2O.2)**: setup never overwrites an existing Settings value, so a Master seeded with the
  retired default `Asia/Ho_Chi_Minh` is moved explicitly by `migrateScheduledPipelineTimezoneToMaster()`
  (`Asia/Ho_Chi_Minh` → `America/New_York`, description + `updated_at` refreshed, audited
  `PIPELINE_SCHEDULE_TIMEZONE_MIGRATED`; already New York → `NO_CHANGE`; any other value → `FAILED`, untouched),
  then `installScheduledPaymentPipelineTriggers()`. Hours, triggers and `source.KH001.timezone`
  (`America/Los_Angeles`, the provider's source timezone used only to read KH001 dates) are not touched. All
  Master-generated dates (Operations default payout date, payout dates, Seller Terms "today", import batch ids)
  already use `APP.TIMEZONE`.
- **Provider paid ≠ seller paid.** Provider paid (did the provider pay VNS?) comes only from Settlements
  (`source_paid_amount`, `source_payment_date` → AVAILABLE). Seller paid (did VNS pay the seller?) comes only from
  Seller Payouts + Seller Payout Allocations (`validateSellerPayoutAllocations_` in SellerPayoutAllocations.gs). A
  provider-paid settlement without a seller payout stays UNPAID. Payout statuses: DRAFT (provisional), SENT /
  CONFIRMED (effective), VOID / REVERSED / CANCELLED / FAILED (no financial effect — the balance is restored and
  the obligation falls back to PARTIAL / UNPAID automatically).

## Seller Payout Allocations (Phase 2L)

- **Seller Payout** = the actual money transfer. It is the only thing that reduces Seller Balances
  (`current_balance = settled + APPLIED adjustments − SENT/CONFIRMED payouts`, unchanged).
- **Seller Payout Allocation** = classification of that transfer to payout obligations (tab
  `Seller Payout Allocations`: `allocation_id, seller_payout_id, seller_id, target_type, target_id,
  payment_source, currency, allocated_amount, created_at, notes`; schema v15). Allocations never reduce a
  balance again and never create money. `allocation_id = SPA-<sha256(seller_payout_id|target_type|target_id)>`;
  unique by `seller_payout_id + target_type + target_id` (one payout may pay several obligations, one
  obligation may be paid by several payouts).
- **Payout obligations** (what a payout can pay):
  1. `SETTLEMENT` / `target_id = settlement_id`: due = SUM of the seller's frozen Settlement Items
     `seller_available_amount` in that settlement + currency — never provider totals, non-AVAILABLE legs,
     balances or seller-sheet values; another seller's share is never allocatable; payment source must match.
  2. `ADJUSTMENT` / `target_id = adjustment_id`: a seller credit — status `APPLIED` and amount `> 0`, of any
     type (e.g. `HOLD_RELEASE`, positive `MANUAL_ADJUSTMENT`); due = amount. Seller and currency must match;
     payment source must equal the adjustment's (blank for a manual credit — never invented).
  Negative / zero adjustments (REFUND, DISPUTE, DISPUTE_FEE, negative manual), PENDING and VOID adjustments
  reduce or do not affect the balance but are never payout targets.
- **Effective** = parent payout SENT / CONFIRMED. DRAFT allocations are provisional (not paid). VOID
  allocations have no financial effect, but every row (VOID included) must be structurally valid (id,
  references, target type, seller, currency, payment source, positive amount, no duplicate). Every SENT /
  CONFIRMED payout must be fully allocated (± 0.00005) across settlement and/or adjustment obligations; no
  payout may be over-allocated; no obligation over-paid. Any violation fails closed: `normalizeSellerBalances`,
  its freshness check and therefore seller-sheet sync stop until the allocations are fixed.
- **Derived per obligation** (never stored): `due_amount`, `paid_amount` (effective allocations),
  `remaining_amount = due − paid`, and `UNPAID` (paid 0) / `PARTIAL` / `PAID` (paid = due).
- **Cash attribution ≠ accounting balance.** Allocations classify *cash payouts* only. Negative APPLIED
  adjustments (REFUND, DISPUTE, DISPUTE_FEE, negative manual) are balance debits, never fake payouts, so an
  obligation can keep a cash remainder while the balance is already 0 (settlement 100, refund −20, payout 80
  → settlement PARTIAL with 20 "Chưa payout", Seller Balance 0). The remainder is **not** permission to pay.
- **Temporal guards** (all fail closed; enforced by `verifySellerPayoutAllocations`, the Seller Balances
  normalize / freshness guard and therefore the seller-sheet gate — manual allocations cannot bypass them):
  - a SENT / CONFIRMED payout needs a valid `payout_date` (DRAFT may have none, but FIFO needs one);
  - every non-VOID allocation target must be available on or before the payout date (settlement:
    `Settlements.source_payment_date`; adjustment: `effective_date`) — no payment of a settlement before the
    provider paid it, no payment of a future credit; a target without a date fails;
  - **payable balance as of each effective payout date** (per seller + currency, micro units):
    `Σ Settlement Items paid by that date + Σ APPLIED adjustments effective by that date − Σ SENT/CONFIRMED
    payouts dated by that date` must stay ≥ 0 (± 0.00005); same-day payouts are checked together. The check is
    chronological, so a later debit (e.g. a refund after a valid payout) never invalidates an earlier payout and
    the current balance may legitimately become negative. APPLIED adjustments without a valid effective date
    make this ambiguous and fail when the seller has effective payouts.
- **`autoAllocateSellerPayoutFIFO(payoutId)`**: for one DRAFT payout, writes allocation rows against the
  open obligations of the same seller + currency, oldest first — settlements by provider payment date,
  adjustments by effective date; ties: SETTLEMENT before ADJUSTMENT, settlement period end / number, then
  target id. Open = due − effective payments − other DRAFT payouts' claims (existing manual rows reserve
  capacity). It needs a `payout_date`, considers only obligations available by that date, and also checks the
  seller payable balance as of that date (this payout counted as effective): a payout above it fails even when
  the open cash obligations are larger (settlement 100, refund −20 → 80 payable; DRAFT 80 passes, DRAFT 100
  fails). It never changes the payout (status stays DRAFT), never touches existing rows (a payout that already
  has allocations → `NO_CHANGE`, operator review), is idempotent, and writes nothing when it refuses.
- **`verifySellerPayoutAllocations()`** (read-only): row counts (draft / effective / void, per target type),
  effective payouts and how many are fully allocated, every error class, `settlement_due / _paid /
  _remaining`, `adjustment_due / _paid / _remaining`, `total_payoutable_due / total_paid / total_remaining`,
  the same per seller, status counts (total and per target type), every obligation state and a report-only
  production regression (HUI settlement obligations 2132.2706 + 905.1734 = 3037.444, no payouts, no credits).
- **Workflow**: use the Operations tab (Phase 2O, below): Create Draft + FIFO → review → Mark Selected SENT
  (→ CONFIRMED). The manual path (`autoAllocateSellerPayoutFIFO`, editing the status in Seller Payouts, then
  `normalizeSellerBalances` and `syncSellerSheets`) still works and is guarded by the same validation, but
  skips the pre-write simulation of the Operations transitions.

## Operations tab and seller payout operations (Phase 2O, schema v18)

`Operations` is the operator's daily screen. It is a **view + command form only**: no accounting module reads
it (balances, amounts, statuses and seller ownership always come from the canonical tabs), and after any
operation the truth lives in Seller Payouts + Seller Payout Allocations; the tab is re-rendered from them.

**Layout** (`setupMaster` writes labels / help / input formats only; operator input in column B is never
overwritten): rows 5–16 **System status** (Master schema version, latest pipeline run + status and latest
health check from the Audit Log, providers (enabled + raw sync), total seller available / hold (Seller Balances),
effective payouts (SENT / CONFIRMED), DRAFT payouts, open payout obligations, ACTIVE seller destinations);
rows 18–30 **New payout form** (Seller dropdown of ACTIVE sellers, Currency, Payout Date `dd/MM/yyyy` (a text
cell, parsed strictly — never re-read by the en_US locale), Amount, Payout Currency, FX Rate, Payout Amount,
Payment Method, Reference, Notes, request token, last result); from row 32 (columns A–L, rewritten on every
refresh — keep custom notes in column N or later) **Seller payable** (one row per seller + currency:
current_balance, seller_hold_balance, DRAFT reserved, available_to_draft, open obligations, effective paid,
payment state) and **Recent / active payouts** (every DRAFT / SENT / CONFIRMED + the 20 latest closed ones:
id, seller, date, amounts and currencies, method, reference, status, allocated amount, FULL / PARTIAL / NONE).

- `available_to_draft = max(0, min(current_balance − DRAFT reserved, open obligations not yet claimed by a
  DRAFT))`. DRAFT is never paid money.
- **Refresh**: menu Refresh Operations, after every payout operation, and after every pipeline run (outside
  the stages, best effort; it never changes the pipeline result).

**Payout lifecycle** (only these transitions; payouts and allocations are never deleted, no negative payout is
ever created):

| From | To | Menu | Effect |
| --- | --- | --- | --- |
| (form) | DRAFT | Create Draft + FIFO | no financial effect; FIFO allocation rows claim obligations |
| DRAFT | SENT | Mark Selected SENT | reduces the seller balance once; obligations PARTIAL / PAID |
| SENT | CONFIRMED | Mark Selected CONFIRMED | no second deduction |
| DRAFT | CANCELLED | Cancel Selected DRAFT | no financial effect; its allocations stay (audit trail) but stop claiming |
| SENT / CONFIRMED | REVERSED | Reverse Selected Payout (reason required) | balance and obligation statuses restored |

- **Create Draft + FIFO** (`createDraftSellerPayoutFromOperations`): Settlement Items and Seller Balances must
  be current and the ledger valid; the form is validated (ACTIVE seller, a currency the seller has, date,
  amount > 0; same currency → fx 1, payout currency = currency, payout amount = amount; another payout currency
  needs an explicit FX rate and payout amount — no conversion rule is invented); amount ≤ available_to_draft and
  ≤ payable balance as of the payout date minus other DRAFTs; the FIFO plan (`planFifoAllocation_`, oldest first)
  must allocate it fully — all **before** one Seller Payouts row is written; then `runSellerPayoutFifo_` writes
  the allocation rows. **Idempotency**: `seller_payout_id = SP-OPS-<sha256(request token)>`; the token is the
  request's retry identity. Only the create operation rotates it (and clears amount / reference / notes), and only
  once the request's DRAFT exists **and is fully allocated** (new request, a retry that completed the allocation, or
  `NO_CHANGE` retry of a complete request). Refresh only fills a blank token. If FIFO fails after the DRAFT row was
  written, the result is FAILED, the token and form stay, and the next click retries the **same** payout (never a
  second DRAFT); the DRAFT has no financial effect and cannot be marked SENT meanwhile. Same token with different
  values (notes included) → rejected, nothing changed, token kept. **Payouts > New Payout Request** rotates the
  token explicitly; it is refused while the current request's DRAFT exists but is not fully allocated (retry it or
  cancel it first).
- **Before SENT** (pre-write simulation, all must hold or nothing changes): payout exists once and is DRAFT;
  Settlement Items + Seller Balances current; the current ledger is valid; known seller, currency, positive
  amount, valid payout date, consistent fx / payout amount; the payout fully allocated; the ledger with the payout
  as SENT has no error (no over-allocation, no over-paid obligation, no cross-seller / currency / source
  mismatch, every target available by the payout date, payable balance ≥ 0 as of every effective payout date);
  the Seller Balances rebuild with it has no error. CONFIRMED and REVERSED use the same simulation.
- **After SENT / CONFIRMED / REVERSED**: `normalizeSellerBalances`, ledger re-verification (derived
  UNPAID / PARTIAL / PAID), pipeline health, then `syncSellerSheet` of the **affected seller only** (when it has
  an ACTIVE destination and health passes), Operations refresh, audit. A failing follow-up leaves the recorded
  status and reports `PARTIAL` (run the pipeline to finish).
- **Selection**: transitions act on the selected row of the Operations payouts table. Another tab, a non-payout
  row, several rows, or a row whose status no longer matches Seller Payouts (stale view) → alert, nothing changed.
- **Locking**: every operation holds the **document lock** (the scheduled pipeline's outer lock) and the reused
  runners keep their script lock inside (DocumentLock → ScriptLock, the pipeline's order). Busy →
  `SKIPPED_LOCKED`, nothing changed; the pipeline likewise skips while an operation runs.
- **Audit**: `SELLER_PAYOUT_DRAFT_CREATED` is written as soon as the canonical DRAFT row exists, before FIFO
  (`allocation_status: PENDING`; never repeated for a retry of the same row); FIFO then writes its own
  `SELLER_PAYOUT_ALLOCATION_FIFO_*` row. If FIFO fails, `SELLER_PAYOUT_OPERATION_FAILED` records `draft_created: true`,
  the payout id, `payout_status: DRAFT`, the FIFO error, the allocated amount and the required action (retry). Also
  `SELLER_PAYOUT_SENT`, `_CONFIRMED`, `_CANCELLED`, `_REVERSED`
  (old / new status; payout id, seller, currency, amount, payout currency / amount, fx, date, method, reference,
  allocation targets, reason, follow-up results), `SELLER_PAYOUT_OPERATION_FAILED` (validation error),
  `SELLER_PAYOUT_OPERATION_SKIPPED_LOCKED`, plus the reused runners' own rows.

**Menu `Payment Master`**: Sync (Run Full Sync, Verify Health, Sync Seller Sheets) · Payouts (Refresh
Operations, Create Draft + FIFO, New Payout Request, Mark Selected SENT / CONFIRMED, Cancel Selected DRAFT, Reverse Selected Payout,
Verify Seller Payouts) · Sellers (Create Seller Sheet, Sync Seller Sheets, Verify Seller Sheets) · View
(Operator View, Technical View).

**Views** (menu only; `setupMaster` never changes visibility): **Operator View** shows Operations, Dashboard,
Sellers, Seller Terms, Seller Destinations, Seller Payouts, Adjustments, Disputes and hides every other Master
tab (raw, canonical engine tables, Seller Payout Allocations, Import Batches, Settings, Audit Log); **Technical
View** shows every Master tab. `__STAGE_*` tabs always stay hidden and custom (non-Master) tabs are never touched.
Hidden state never affects code (tabs are found by name). Because a crash-safe swap shows the tab it rewrites,
pipeline runs and payout operations re-hide the tabs that were hidden before they started, so the chosen view
survives them.

## Seller child sheets (Phase 2K + 2L + 2M, seller output schema version 4)

Seller child spreadsheets are **output-only projections**. Payment Master stays the sole accounting
source of truth: it computes and snapshots provider gross, processing fee, net, seller fee rate, seller
fee, seller hold, seller amount, settlement / payout state and adjustments; the child only receives
those values and is never read back into Master. No provider trace = no provider economics; no
confirmed provider settlement = no seller available balance; MATCHED ≠ AVAILABLE.

**Output contract (seller output schema version 4, current)** — exactly four visible tabs from the template
plus one hidden system tab (version 2 was the Phase 2K contract; version 3 added the Phase 2L
allocation-aware PhieuDoiSoat section D; version 4 adds the payout date / method / reference of the effective
payouts on each section D obligation row):

| Tab | Content (owned ranges only) |
| --- | --- |
| `DoiSoat_GD` | One row per seller internal transaction (header row 6, data from row 7): status (Khớp / Lệch số tiền / Thiếu trên cổng), payment source, internal order data and, for MATCHED legs, provider gross, processing fee, net, frozen `seller_fee_rate`, seller fee, seller hold, settlement dates / status and seller amount. MISSING_PROVIDER rows keep every provider / seller / settlement field blank. |
| `TongHop_Thang` | One row per month, all payment sources together. Transaction month: count, distinct sources, gross / processing fee / net, `Phí VNS` = SUM of frozen leg `seller_fee` (never net × one rate). Provider-paid (AVAILABLE) month — the Seller Balances recognition point: available seller, hold created and the month-end hold balance; actual HOLD_RELEASE by its effective date. Also disputes, effective payouts, adjustments, balance, known obligation. Rows are inserted before the `Logic:` footer when needed. |
| `PhieuDoiSoat` | Seller + period; "Chưa đối soát / chưa tính" (internal order amount and count of transactions without provider economics) and "Hold đang giữ" (Seller Balances hold) — never added together; A: known economics per payment source (rate shown only when exactly one rate applies); B: seller-only payable from AVAILABLE legs, hold releases, refunds / disputes, APPLIED adjustments, effective payouts → current balance and hold; C: counts / internal amounts by reconciliation status; D: chronological seller-only ledger of paid settlements (seller share only, labelled by provider and payment state, e.g. `PAYPAL #1 · PAID`, `STRIPE #1 · UNPAID`), adjustments (positive credits with a payment state, e.g. `HOLD_RELEASE · PARTIAL`; negative ones by type) and SENT / CONFIRMED payouts (`Payout`) — see section D below. |
| `Dispute` | Canonical Master disputes attributable to the seller (no buyer data, no internal notes); clean headers when none. |
| `_Sync` (hidden) | `output_schema_version, seller_id, seller_name, master_schema_version, synced_at`, the four tab checksums and a combined checksum — the commit marker. No Master ID, tokens or PII. |

**PhieuDoiSoat section D (output schema 3+, Phase 2L / 2M)** — same template geometry; column I is
**`Chưa payout`** (it was `Còn nợ` in the template before Phase 2L):

| Column | Settlement row / positive APPLIED adjustment row (payout obligation) | Negative adjustment row | `Payout` row |
| --- | --- | --- | --- |
| A `Lần` | `<source> #<n> · PAID / PARTIAL / UNPAID`, or `<adjustment_type> · …` | adjustment type | `Payout` |
| E `Phát sinh phải trả` | due (settlement: this seller's frozen Settlement Items; adjustment: its amount) | the (negative) amount | 0 |
| G `Tổng phải trả` | chronological running seller accounting balance after the row | same | same |
| H `Đã payout seller (USD)` | effective allocations to this obligation | 0 | the actual SENT / CONFIRMED payout amount |
| I `Chưa payout` | cash-attribution remainder of this obligation (due − effective allocations) | blank | blank |
| O `Hình thức / chứng từ` | effective payouts allocated to it: `dd/MM/yyyy · method · reference · amount` (schema 4) | type | method / reference |

`Chưa payout` is cash attribution only, **not** the seller's debt. Section B `CÒN NỢ SAU THANH TOÁN (USD)`
remains the authoritative current accounting balance. Example: settlement 100, refund −20, payout 80
allocated to the settlement → `PAYPAL #1 · PARTIAL` 100 / 80 / 20, `REFUND` −20, `Payout` 80, and Section B
= 0. Allocations have no balance effect (the running balance moves only with settlements, adjustments and
actual payouts), so nothing is deducted twice; TongHop_Thang `Đã payout seller` and section B keep using
actual Seller Payouts. Existing schema-2 children are upgraded in place by the next sync (owned content +
`_Sync` only; no reclone, no formatting writes); a child that still shows `Còn nợ` in section D gets that
one header value cell migrated to `Chưa payout`. A template must already say `Chưa payout` (update the live
template before provisioning new sellers).

**Template preflight** (`createSellerSheet` before cloning, every sync before writing): the four tabs
exist and are visible; no other tab (RAW_KH / RAW_PP, the old Phase 2K tabs or anything unknown —
never deleted automatically, validation fails instead); exact headers / anchors (DoiSoat_GD row 6,
TongHop_Thang header + `Logic:` footer, PhieuDoiSoat labels of sections A–D, Dispute row 7); formulas
only at the **approved presentation locations** — DoiSoat_GD summary `COUNTIF` row and `SUBTOTAL` row,
Dispute summary row and the per-row "Số ngày còn lại" formula — and no formula referencing RAW_KH /
RAW_PP, IMPORTRANGE / IMPORT*, another sheet, an endpoint token or a protected spreadsheet ID; no
token, protected ID or e-mail address in any cell.

**Renderer**: only explicit owned ranges are written, with `setValues` (blank padding clears stale
rows); `sheet.clear()`, format calls and static titles / headers / approved formulas are never
touched. Text that Sheets could reinterpret is written with a quote prefix. Date-only values are
anchored at 12:00 UTC to avoid date drift in the supported seller-template time zones. When a block outgrows
the template capacity (DoiSoat_GD 1000 rows, TongHop_Thang months, PhieuDoiSoat A / D, Dispute),
rows are inserted inside the block so presentation formula ranges, filters and conditional formats
extend, and the template data-row format is copied onto the new rows.

**Provider-agnostic**: one reconciliation across payment sources (no per-provider tabs, no code like
"PayPal = 8%"): every rate comes from Seller Terms (seller + payment_source + effective date) via the
frozen Payment Leg snapshot; PAYPAL and STRIPE rows share DoiSoat_GD, TongHop_Thang aggregates both,
PhieuDoiSoat section A shows one row per source.

**Destination configuration** — tab `Seller Destinations` (`seller_id, seller_name_snapshot,
spreadsheet_id, status, notes`), user-managed. `setupMaster` seeds it once, while it has no data
rows, with one `INACTIVE` row per seller and a blank `spreadsheet_id`; it never reseeds, never opens a
child spreadsheet, and never auto-adds sellers created later. `verifySellerDestinations()` is
read-only. Hard errors (config ambiguity / data-leak risk — `syncSellerSheets` then writes nothing
anywhere): unknown or blank seller, duplicate `seller_id` rows, invalid status, a value that is not a
spreadsheet ID (e.g. a URL), `ACTIVE` without `spreadsheet_id`, the same `spreadsheet_id` ACTIVE for
several rows, or a `spreadsheet_id` equal to the Payment Master (or the KH001 provider source).
Warnings only: sellers without a destination row, name-snapshot differences, an ID shared with an
INACTIVE row. A missing destination never affects accounting.

**Add a seller destination** — automatically (recommended): set Settings
`seller_template_spreadsheet_id` and `seller_output_folder_id`, then run **Seller Sheets → Create
Seller Sheet** (or `createSellerSheet('CUS001')`). Manually: create a Google Sheet, paste its ID (the
part of the URL between `/d/` and `/edit`) into the seller's row, set `status = ACTIVE`, run
`verifySellerDestinations`, then `syncSellerSheets`.

**Template provisioning** (`createSellerSheet(sellerId)`, under the script lock). Lifecycle of the
seller's Seller Destinations row — intentionally recoverable:

```
INACTIVE + blank ID  -> clone template -> INACTIVE + registered ID -> sync + verify -> ACTIVE + registered ID
```

1. Same Master freshness gates as `syncSellerSheets`; the seller must exist and have valid Seller
   Terms; exactly one Seller Destinations row; an ACTIVE row is never cloned again. A known seller
   with no row gets one appended (`INACTIVE`, blank ID, note "Auto-created by seller sheet
   provisioning") — never for unknown sellers, duplicate rows or an invalid Seller Destinations
   config; the row is kept for a retry if a later step fails.
2. Template / folder checks before any clone: both Settings values are Drive IDs; the template is an
   accessible Google Spreadsheet that is not the Payment Master, a provider source spreadsheet or a
   registered seller destination; the folder is accessible; the template satisfies the output
   contract below (read-only check).
3. An INACTIVE row that already has a `spreadsheet_id` is a retry: that copy is reused and nothing is
   cloned. Otherwise the template is copied once into the folder as `Seller - <seller_id> -
   <seller_name>` and its ID is written to the row immediately (status stays INACTIVE).
4. Seller-specific sync into the copy, then a full verification of the child output. Only when both
   pass does the row become ACTIVE (and `seller_name_snapshot` current). On failure the ID stays
   registered and the row INACTIVE; the next `createSellerSheet` reuses it. Copies are never deleted
   automatically.

The template (`seller_template_spreadsheet_id`, currently VNS_SELLER_PAYMENT_TEMPLATE) is the UI
authority: it is validated against the output contract before any clone, cloned as-is (colors, fonts,
borders, merges, conditional formats, filters, frozen panes, row heights, column widths, number
formats, locale and time zone are all kept — nothing is rebuilt or forced), and after cloning Master
writes only the owned ranges. `syncSellerSheet(sellerId)` syncs exactly one ACTIVE destination with
the same guards and never touches another seller.

**Menu**: `Payment Master` → **Sellers** → Create Seller Sheet (prompts for the seller ID, lists
INACTIVE sellers, shows the result and the sheet URL), Sync Seller Sheets, Verify Seller Sheets.
Alerts never show the Master, provider-source, template or folder IDs. The manifest therefore also
requests the `drive` and `script.container.ui` scopes (re-authorization needed after deploy).

**Sync order**: run the full Master chain first (`syncKh001Raw` → … → `normalizePaymentLegs` →
`normalizeSettlementItems` → `normalizeSellerBalances`), then `syncSellerSheets` (or
`syncSellerSheet(id)`), then `verifySellerSheets`.

**Freshness gates**: before any child write, Transactions, Provider Transactions, Payment Matches,
Settlements, Seller Terms, Payment Legs, Settlement Items and Seller Balances must all be current
(Seller Balances via a read-only rebuild from Settlement Items, Adjustments and Seller Payouts,
compared ignoring only `updated_at`). Stale Master → FAILED, nothing written. The seller model also
reconciles itself to Seller Balances (TongHop_Thang, sections B and D) and fails closed otherwise.

**Seller isolation / privacy**: ownership is the exact `Transactions.seller_id`; every other row
reaches a seller only through that seller's own rows; provider settlements show the seller's share
only. Output never contains endpoint tokens or credentials, customer / buyer data, provider fee /
provider hold / system margin, fingerprints, import metadata, internal notes or the Master ID; any
token- or e-mail-like value fails the whole sync before any write. Payouts count only when SENT /
CONFIRMED and adjustments only when APPLIED; DRAFT, PENDING and VOID rows never change seller output.

**Idempotency / commit**: per-tab checksums of the canonical owned content (not formatting). Unchanged
→ `NO_CHANGE`: zero writes, `synced_at` kept, presentation formulas untouched. Otherwise only changed
tabs are written, then the hidden `_Sync` marker **last** (one write), and the child is reread and fully
verified (contract, isolation, leaks, checksums) before `SUCCESS`. A failure before the commit leaves
the old `_Sync`, so `verifySellerSheets` reports the child as stale / incomplete; the next sync repairs it.

**Results**: per seller `SUCCESS` / `NO_CHANGE` / `FAILED`; overall `SELLER_SHEETS_SYNC_SUCCESS`,
`_NO_CHANGE`, `_PARTIAL` or `_FAILED`, audited with per-seller details. `verifySellerSheets()` is
read-only: per ACTIVE destination it checks access, the contract, each tab's checksum, `_Sync`,
combined checksum, isolation and leaks, and reports a report-only production regression (CUS002 / HUI:
143 transactions, 74 MATCHED, 69 MISSING_PROVIDER; balance 3037.444 + hold 370.420 + seller fee
296.336 + processing fee 156.310 + missing-provider order amount 3501.760 = 7362.270 total order amount).

## Tests

```bash
npm test   # Node built-in test runner, no dependencies
```

## Out of scope (current phase)

Production imports, PayPal/Stripe/provider connections, web apps, triggers, scheduled sync,
automatic settlement, payout automation, refunds/disputes accounting.
