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
  Main.gs           Public entry points: setupMaster(), verifyMaster()
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
| Settlements | Provider payout batches, provider economics (snapshot once LOCKED) |
| Settlement Items | Frozen per-leg snapshot inside a settlement |
| Seller Balances | Per-seller balance across all providers |
| Seller Payouts | Money actually sent to sellers (no settlement_id: one payout may be funded by many settlements) |
| Adjustments | Seller-side money effects: REFUND, DISPUTE, DISPUTE_FEE, MANUAL_ADJUSTMENT, HOLD_RELEASE |
| Disputes | Dispute case tracking |
| Dashboard | Skeleton summary |
| Audit Log | Append-only operation log |

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

## Out of scope (current phase)

Seller spreadsheets, production imports, PayPal/Stripe/provider connections,
web apps, triggers, scheduled sync, automatic settlement, payout automation.
