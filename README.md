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

Current phase: **Master only** (foundation + schema). Seller spreadsheets come in a later phase.

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
from the Apps Script editor. `setupMaster` never deletes tabs or data and never
overwrites a header row that differs from the schema (it logs a warning instead).

## Master tabs

| Tab | Purpose |
| --- | --- |
| Settings | Key/value config. Scoped keys: `provider_fee_rate.<PROVIDER>` |
| Sellers | Seller master; optional per-seller fee/hold overrides |
| Endpoint Mapping | endpoint_token → seller_id / seller_group, effective-dated |
| Source System | Raw internal transactions (import-only) |
| Source Payments | Raw external payments, all sources, one row per record |
| Transactions | Internal transactions (ownership source of truth) |
| Payment Matches | internal transaction ↔ (payment_source, external_transaction_id) |
| Payment Legs | One row per matched external payment, live economics |
| Settlements | Provider payout batches (snapshot once LOCKED) |
| Settlement Items | Frozen per-leg snapshot inside a settlement |
| Seller Balances | Per-seller balance across all providers |
| Seller Payouts | Money actually sent to sellers |
| Adjustments | REFUND, DISPUTE, DISPUTE_FEE, MANUAL_ADJUSTMENT, HOLD_RELEASE |
| Disputes | Dispute case tracking |
| Dashboard | Skeleton summary |
| Audit Log | Append-only operation log |

## Financial design rules

1. **Sources of truth.** The internal system owns transaction ownership
   (endpoint, seller, store, order). The payment source owns actual payment,
   processing fee, net, refund, dispute and settlement.
2. **External payment key** is `payment_source + external_transaction_id`,
   never `external_transaction_id` alone.
3. **Matched ≠ available.** Lifecycle: `UNMATCHED → MATCHED → WAITING_SETTLEMENT →
   SETTLED → AVAILABLE → PAID`. Money becomes available only after the provider settles.
4. **Separate economics.** `provider_fee` (what the provider charges us) and
   `seller_fee` (what we charge the seller) are separate columns and are never
   overwritten by each other. System margin = `seller_fee − provider_fee`.
5. **No global provider fee.** Each provider has its own
   `provider_fee_model.<PROVIDER>` / `provider_fee_rate.<PROVIDER>` in Settings.
   Rates are copied onto Payment Legs and Settlement Items so every amount can be
   explained from its own row.
6. **Split per provider, aggregate per seller.** Settlements are per provider /
   payment source. Seller Balances sum available amounts across providers.
7. **Snapshots.** Once a settlement is `LOCKED`, its Settlement Items are frozen
   copies and do not depend on live source tabs.
8. **One place for each money effect** (to prevent double counting). Seller
   balances must take settled/available amounts from Settlement Items only,
   post-settlement money effects from Adjustments only, and payouts from Seller
   Payouts only. Payment Legs are live, pre-settlement values. Disputes is case
   tracking; its money effect is recorded as Adjustments rows.
9. **No deletes for audit.** Matches are reversed (`match_status = REVERSED`),
   not deleted. Important operations are written to Audit Log.

## Out of scope (current phase)

Seller spreadsheets, production imports, PayPal/Stripe/provider connections,
web apps, triggers, scheduled sync, automatic settlement, payout automation.
