/**
 * Config.gs
 * Global constants and the Master spreadsheet schema.
 *
 * The schema below is the single source of truth for tab names, column order,
 * column types (which drive number formats) and allowed enum values.
 * Setup.gs reads it to build and format the spreadsheet.
 */

const APP = Object.freeze({
  NAME: 'Payment Master',
  SCHEMA_VERSION: 18,
  LOCALE: 'en_US',
  TIMEZONE: 'America/New_York',
  DEFAULT_CURRENCY: 'USD',
  SYSTEM_ACTOR: 'system',
});

/**
 * Column types. Each type maps to a number format in FORMATS.
 * - ID / TEXT: stored as plain text so long numeric IDs are never coerced.
 * - GENERAL: no column-wide format (mixed values, e.g. Settings.value).
 * - USD: amounts denominated in the default currency (USD).
 * - AMOUNT: amounts in a currency given by another column (e.g. payout_currency).
 * - AMOUNT4: like AMOUNT, displayed with 4 decimals (unrounded provider fee/hold values).
 * - RATE: fractional rates shown as percentages (0.07 -> 7.00%).
 */
const COL_TYPE = Object.freeze({
  ID: 'ID',
  TEXT: 'TEXT',
  GENERAL: 'GENERAL',
  ENUM: 'ENUM',
  DATE: 'DATE',
  DATETIME: 'DATETIME',
  USD: 'USD',
  AMOUNT: 'AMOUNT',
  AMOUNT4: 'AMOUNT4',
  RATE: 'RATE',
  FX_RATE: 'FX_RATE',
  INTEGER: 'INTEGER',
});

const FORMATS = Object.freeze({
  ID: '@',
  TEXT: '@',
  GENERAL: null,
  ENUM: '@',
  DATE: 'yyyy-mm-dd',
  DATETIME: 'yyyy-mm-dd hh:mm:ss',
  USD: '$#,##0.00;-$#,##0.00',
  AMOUNT: '#,##0.00;-#,##0.00',
  AMOUNT4: '#,##0.0000;-#,##0.0000',
  RATE: '0.00%',
  FX_RATE: '0.000000',
  INTEGER: '#,##0',
});

/** Allowed values for enum columns. */
const ENUMS = Object.freeze({
  RECORD_STATUS: ['ACTIVE', 'INACTIVE'],
  PAYMENT_SOURCE: ['PAYPAL', 'STRIPE', 'BANK', 'OTHER'],
  // Derived summary status only. Never used as a source for money calculations.
  // PAID is intentionally absent until seller payout allocation exists.
  TRANSACTION_STATUS: [
    'UNMATCHED', 'MATCHED', 'WAITING_SETTLEMENT', 'PARTIALLY_SETTLED', 'SETTLED',
    'PARTIALLY_AVAILABLE', 'AVAILABLE',
  ],
  MATCH_TYPE: ['AUTO', 'MANUAL'],
  MATCH_STATUS: ['PENDING_REVIEW', 'CONFIRMED', 'REJECTED', 'REVERSED'],
  LEG_SETTLEMENT_STATUS: ['WAITING_SETTLEMENT', 'SETTLED', 'AVAILABLE'],
  SETTLEMENT_STATUS: ['DRAFT', 'LOCKED', 'VOID'],
  // Only SENT / CONFIRMED move money. VOID / REVERSED / CANCELLED / FAILED never count (balance and paid status revert).
  SELLER_PAYOUT_STATUS: ['DRAFT', 'SENT', 'CONFIRMED', 'VOID', 'REVERSED', 'CANCELLED', 'FAILED'],
  // What a Seller Payout Allocation pays: a seller settlement obligation or a positive APPLIED adjustment.
  SELLER_PAYOUT_ALLOCATION_TARGET_TYPE: ['SETTLEMENT', 'ADJUSTMENT'],
  ADJUSTMENT_TYPE: ['REFUND', 'DISPUTE', 'DISPUTE_FEE', 'MANUAL_ADJUSTMENT', 'HOLD_RELEASE'],
  ADJUSTMENT_STATUS: ['PENDING', 'APPLIED', 'VOID'],
  DISPUTE_STATUS: ['OPEN', 'UNDER_REVIEW', 'WON', 'LOST', 'CLOSED'],
  SETTING_VALUE_TYPE: ['STRING', 'RATE', 'NUMBER', 'BOOLEAN'],
  IMPORT_BATCH_STATUS: ['RUNNING', 'SUCCESS', 'NO_CHANGE', 'FAILED'],
  // Reconciliation inside the provider's own workbook, not Payment Master matching.
  PROVIDER_RECONCILIATION_STATUS: ['RECONCILED', 'AMOUNT_MISMATCH', 'PROVIDER_ONLY'],
  // Canonical provider ledger event types. Only values verified against real data are
  // listed; new types are added together with a verified normalizer mapping.
  PROVIDER_EVENT_TYPE: ['PAYMENT', 'RESERVE_HOLD', 'WITHDRAWAL'],
  SELLER_STATUS: ['ACTIVE', 'INACTIVE'],
  // Seller child spreadsheet destination (output only). Only ACTIVE destinations are synced.
  SELLER_DESTINATION_STATUS: ['ACTIVE', 'INACTIVE'],
  // OPEN = open-ended interval (effective_to blank; may start in the future); CLOSED = bounded.
  ENDPOINT_MAPPING_STATUS: ['OPEN', 'CLOSED'],
  // Ownership of an internal transaction on its created date (Endpoint Mapping, exact token).
  OWNERSHIP_STATUS: ['MAPPED', 'UNASSIGNED_ENDPOINT'],
  // Exact internal <-> provider reconciliation outcome (Payment Matches).
  RECONCILIATION_STATUS: ['MATCHED', 'AMOUNT_MISMATCH', 'MISSING_PROVIDER', 'MISSING_INTERNAL'],
});

/** Number of endpoint_<N>_name / endpoint_<N>_key pairs in Sellers (schema-only to extend). */
const SELLER_ENDPOINT_SLOTS = 10;

/** Tab names, in display order. */
const SHEETS = Object.freeze({
  OPERATIONS: 'Operations',
  SETTINGS: 'Settings',
  SELLERS: 'Sellers',
  SELLER_TERMS: 'Seller Terms',
  SELLER_DESTINATIONS: 'Seller Destinations',
  ENDPOINT_MAPPING: 'Endpoint Mapping',
  RAW_INTERNAL_TRANSACTIONS: 'Raw Internal Transactions',
  SOURCE_SYSTEM: 'Source System',
  TRANSACTIONS: 'Transactions',
  PAYMENT_MATCHES: 'Payment Matches',
  PAYMENT_LEGS: 'Payment Legs',
  SETTLEMENTS: 'Settlements',
  SETTLEMENT_ITEMS: 'Settlement Items',
  SELLER_BALANCES: 'Seller Balances',
  SELLER_PAYOUTS: 'Seller Payouts',
  SELLER_PAYOUT_ALLOCATIONS: 'Seller Payout Allocations',
  ADJUSTMENTS: 'Adjustments',
  DISPUTES: 'Disputes',
  DASHBOARD: 'Dashboard',
  AUDIT_LOG: 'Audit Log',
  IMPORT_BATCHES: 'Import Batches',
  RAW_KH001_PAYPAL: 'Raw KH001 PayPal',
  RAW_KH001_RECONCILED: 'Raw KH001 Reconciled',
  RAW_KH001_SETTLEMENTS: 'Raw KH001 Settlements',
  RAW_KH001_DISPUTES: 'Raw KH001 Disputes',
  PROVIDER_TRANSACTIONS: 'Provider Transactions',
  PROVIDER_EVENTS: 'Provider Events',
});

/** Shorthand column constructor: col_('name', COL_TYPE.X, ENUMS.Y?) */
function col_(name, type, values) {
  return { name: name, type: type, values: values || null };
}

const T = COL_TYPE;

/** endpoint_1_name, endpoint_1_key, ..., endpoint_<count>_key (name beside key). */
function sellerEndpointColumns_(count) {
  const columns = [];
  for (let n = 1; n <= count; n++) {
    columns.push(col_('endpoint_' + n + '_name', T.TEXT));
    columns.push(col_('endpoint_' + n + '_key', T.ID));
  }
  return columns;
}

/**
 * Data table schemas. Every table has a single, stable header row (row 1).
 * Dashboard and Operations are layout tabs, not data tables (Setup.gs / Operations.gs); nothing reads them as a source.
 */
const SCHEMA = Object.freeze([
  {
    sheet: SHEETS.SETTINGS,
    description: 'Key/value configuration. Scoped keys use dot notation, e.g. provider_fee_rate.KH001.',
    columns: [
      col_('key', T.ID),
      col_('value', T.GENERAL),
      col_('value_type', T.ENUM, ENUMS.SETTING_VALUE_TYPE),
      col_('description', T.TEXT),
      col_('updated_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SELLERS,
    description: 'User-managed desired seller/endpoint mapping: 1 row = 1 seller, each endpoint is an ' +
      'endpoint_<N>_name + endpoint_<N>_key pair (slot order has no meaning). effective_from is the date ' +
      'of the NEXT ownership change for this row, not a creation date. Run publishSellerMapping() to ' +
      'publish changes into Endpoint Mapping. Leave seller_id blank for a new seller (assigned on publish).',
    frozenColumns: 4,
    columns: [
      col_('seller_id', T.ID),
      col_('seller_name', T.TEXT),
      col_('status', T.ENUM, ENUMS.SELLER_STATUS),
      col_('effective_from', T.DATE),
    ].concat(sellerEndpointColumns_(SELLER_ENDPOINT_SLOTS)).concat([
      col_('notes', T.TEXT),
    ]),
  },
  {
    sheet: SHEETS.SELLER_TERMS,
    description: 'Effective-dated seller FEE history per seller + payment_source (user-edited). payment_source is ' +
      'required and matched exactly (never a fallback to another source). Per seller + source at most one ' +
      'open-ended row and no overlapping periods. A transaction uses the row of its own payment_source with ' +
      'effective_from <= created date <= effective_to (blank = open); none = fail closed. To change a fee: close ' +
      'the old row (effective_to) and add a new row; frozen history never changes. Seller hold is NOT configured ' +
      'here: KH001 seller hold mirrors the actual provider hold 1:1. Seeded once (PAYPAL) from Settings ' +
      'seller_fee_rate only while this tab is empty.',
    columns: [
      col_('seller_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('seller_name_snapshot', T.TEXT),
      col_('seller_fee_rate', T.RATE),
      col_('effective_from', T.DATE),
      col_('effective_to', T.DATE),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.SELLER_DESTINATIONS,
    description: 'User-managed seller child spreadsheet destinations (output only; never read back). One row per ' +
      'seller. ACTIVE requires spreadsheet_id (the ID, not the URL); only ACTIVE rows are synced by ' +
      'syncSellerSheets. A spreadsheet_id may be ACTIVE for one seller only and never the Master itself. ' +
      'Seeded once (INACTIVE, blank spreadsheet_id) only while this tab is empty; new sellers are added manually.',
    columns: [
      col_('seller_id', T.ID),
      col_('seller_name_snapshot', T.TEXT),
      col_('spreadsheet_id', T.ID),
      col_('status', T.ENUM, ENUMS.SELLER_DESTINATION_STATUS),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.ENDPOINT_MAPPING,
    description: 'System-managed effective-dated endpoint ownership history (written only by ' +
      'publishSellerMapping). A row matches a date when effective_from <= date <= effective_to (blank = ' +
      'open-ended). CLOSED rows are immutable; an OPEN row only ever gets closed.',
    columns: [
      col_('mapping_id', T.ID),
      col_('seller_id', T.ID),
      col_('seller_name_snapshot', T.TEXT),
      col_('endpoint_name', T.TEXT),
      col_('endpoint_key', T.ID),
      col_('effective_from', T.DATE),
      col_('effective_to', T.DATE),
      col_('opened_version', T.ID),
      col_('closed_version', T.ID),
      col_('status', T.ENUM, ENUMS.ENDPOINT_MAPPING_STATUS),
      col_('opened_at', T.DATETIME),
      col_('closed_at', T.DATETIME),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.RAW_INTERNAL_TRANSACTIONS,
    description: 'Append-only evidence of internal transaction CSV exports. The first 16 columns are the CSV ' +
      'fields exactly as exported (text, never normalized); the last 5 are ingestion metadata. ' +
      'row_fingerprint = SHA-256 of the 16 raw fields (see README). The same transaction_id may appear in ' +
      'several batches (re-exports). Written only by the import step; normalizers never modify it.',
    columns: [
      col_('order_id', T.TEXT),
      col_('payment_method', T.TEXT),
      col_('transaction_id', T.TEXT),
      col_('gateway', T.TEXT),
      col_('status', T.TEXT),
      col_('total', T.TEXT),
      col_('currency', T.TEXT),
      col_('sub_account', T.TEXT),
      col_('store_domain', T.TEXT),
      col_('shield_domain', T.TEXT),
      col_('endpoint_token', T.TEXT),
      col_('created_at', T.TEXT),
      col_('refunded_at', T.TEXT),
      col_('customer', T.TEXT),
      col_('settled_at', T.TEXT),
      col_('note', T.TEXT),
      col_('import_batch_id', T.ID),
      col_('source_file_name', T.TEXT),
      col_('source_row_number', T.INTEGER),
      col_('row_fingerprint', T.ID),
      col_('imported_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SOURCE_SYSTEM,
    description: 'Latest canonical snapshot of each internal transaction, rebuilt from Raw Internal ' +
      'Transactions (latest imported snapshot wins). source_record_id = ISRC-<sha256(payment_source|' +
      'internal_transaction_id)>. settled_at_raw / refunded_at are internal raw information only.',
    columns: [
      col_('source_record_id', T.ID),
      col_('internal_transaction_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('gateway', T.TEXT),
      col_('created_at', T.DATETIME),
      col_('endpoint_token', T.ID),
      col_('sub_account', T.TEXT),
      col_('store_domain', T.TEXT),
      col_('shield_domain', T.TEXT),
      col_('order_id', T.ID),
      col_('payment_method', T.TEXT),
      col_('order_amount', T.AMOUNT),
      col_('currency', T.TEXT),
      col_('raw_status', T.TEXT),
      col_('refunded_at', T.TEXT),
      col_('customer', T.TEXT),
      col_('settled_at_raw', T.TEXT),
      col_('note', T.TEXT),
      col_('row_fingerprint', T.ID),
      col_('import_batch_id', T.ID),
      col_('source_file_name', T.TEXT),
      col_('imported_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.TRANSACTIONS,
    description: 'Canonical internal transactions with ownership resolved on the created date ' +
      '(America/New_York) by exact endpoint_token = Endpoint Mapping.endpoint_key. UNASSIGNED_ENDPOINT ' +
      'rows exist but are not seller money. status is a derived summary (UNMATCHED until provider ' +
      'matching) and is never used to calculate money.',
    columns: [
      col_('internal_transaction_id', T.ID),
      col_('created_at', T.DATETIME),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('endpoint_token', T.ID),
      col_('mapping_id', T.ID),
      col_('mapping_version', T.ID),
      col_('seller_id', T.ID),
      col_('seller_name_snapshot', T.TEXT),
      col_('endpoint_name_snapshot', T.TEXT),
      col_('store_domain', T.TEXT),
      col_('shield_domain', T.TEXT),
      col_('sub_account', T.TEXT),
      col_('order_id', T.ID),
      col_('payment_method', T.TEXT),
      col_('order_amount', T.AMOUNT),
      col_('currency', T.TEXT),
      col_('customer', T.TEXT),
      col_('raw_status', T.TEXT),
      col_('refunded_at_raw', T.TEXT),
      col_('settled_at_raw', T.TEXT),
      col_('ownership_status', T.ENUM, ENUMS.OWNERSHIP_STATUS),
      col_('status', T.ENUM, ENUMS.TRANSACTION_STATUS),
      col_('source_record_id', T.ID),
      col_('source_row_fingerprint', T.ID),
      col_('import_batch_id', T.ID),
      col_('updated_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.PAYMENT_MATCHES,
    description: 'Exact internal <-> provider reconciliation: one row per (payment_source, transaction id) in ' +
      'the union of Transactions and Provider Transactions. match_id = PM-<sha256(payment_source|id)> is ' +
      'stable across status changes. Exact key + currency + amount (< 0.005) only; no fallback matching. ' +
      'Source of truth for reconciliation (Transactions.status is not changed here). Rows are never deleted.',
    columns: [
      col_('match_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('internal_transaction_id', T.ID),
      col_('external_transaction_id', T.ID),
      col_('provider_transaction_id', T.ID),
      col_('provider_id', T.ID),
      col_('reconciliation_status', T.ENUM, ENUMS.RECONCILIATION_STATUS),
      col_('match_type', T.ENUM, ENUMS.MATCH_TYPE),
      col_('match_status', T.ENUM, ENUMS.MATCH_STATUS),
      col_('internal_currency', T.TEXT),
      col_('provider_currency', T.TEXT),
      col_('internal_amount', T.AMOUNT),
      col_('provider_gross_amount', T.AMOUNT),
      col_('amount_difference', T.AMOUNT4),
      col_('provider_external_status', T.TEXT),
      col_('internal_source_fingerprint', T.ID),
      col_('provider_source_fingerprint', T.ID),
      col_('matched_at', T.DATETIME),
      col_('matched_by', T.TEXT),
      col_('updated_at', T.DATETIME),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.PAYMENT_LEGS,
    description: 'One leg per CONFIRMED MATCHED Payment Match: payment_leg_id = PL-<sha256(payment_source|' +
      'external_transaction_id)>. Gross / processing fee / net come from Provider Transactions; KH001 ' +
      'provider_fee and provider_hold_amount are the actual DoiSoat values (rates are derived, never applied). ' +
      'settlement_id comes from the provider settlement date; status is SETTLED, or AVAILABLE once the provider ' +
      'has fully paid that settlement. Seller economics use the effective-dated Seller Terms rate on net ' +
      '(seller_fee = net x rate); seller_hold_amount mirrors the actual provider hold; seller_available_amount = ' +
      'net - seller_fee - seller_hold_amount. Refund/dispute fields stay blank (out of scope; blank = not computed, not zero).',
    columns: [
      col_('payment_leg_id', T.ID),
      col_('match_id', T.ID),
      col_('internal_transaction_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('provider', T.ID),
      col_('external_transaction_id', T.ID),
      col_('currency', T.TEXT),
      col_('gross_amount', T.AMOUNT),
      col_('processing_fee', T.AMOUNT),
      col_('net_amount', T.AMOUNT),
      col_('provider_fee_rate', T.RATE),
      col_('provider_fee', T.AMOUNT4),
      col_('provider_hold_rate', T.RATE),
      col_('provider_hold_amount', T.AMOUNT4),
      col_('seller_fee_rate', T.RATE),
      col_('seller_fee', T.AMOUNT4),
      col_('seller_hold_rate', T.RATE),
      col_('seller_hold_amount', T.AMOUNT4),
      col_('seller_available_amount', T.AMOUNT4),
      col_('refund_amount', T.AMOUNT),
      col_('dispute_amount', T.AMOUNT),
      col_('dispute_fee', T.AMOUNT),
      col_('settlement_id', T.ID),
      col_('settlement_status', T.ENUM, ENUMS.LEG_SETTLEMENT_STATUS),
      col_('created_at', T.DATETIME),
      col_('updated_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SETTLEMENTS,
    description: 'Canonical provider settlement headers (provider economics only), all providers. ' +
      'Unique key: provider_id + payment_source + source_settlement_number. Transaction economics are ' +
      'actual provider reconciliation sums; history fields are copied from the provider settlement ' +
      'history. provider_hold_balance is the provider value; expected_provider_hold_balance is a ' +
      'roll-forward and hold_balance_difference = provider - expected. provider_adjustments = ' +
      'period_due_amount - transaction_payout_amount - provider_hold_released_amount (unclassified). ' +
      'Dates are provider-timezone dates. Never used to recalculate seller economics.',
    columns: [
      col_('settlement_id', T.ID),
      col_('provider_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('source_settlement_number', T.INTEGER),
      col_('period_start_date', T.DATE),
      col_('period_end_date', T.DATE),
      col_('source_payment_date', T.DATE),
      col_('currency', T.TEXT),
      col_('transaction_count', T.INTEGER),
      col_('gross_amount', T.AMOUNT),
      col_('processing_fee_amount', T.AMOUNT),
      col_('net_amount', T.AMOUNT),
      col_('provider_fee_amount', T.AMOUNT4),
      col_('provider_hold_created_amount', T.AMOUNT4),
      col_('transaction_payout_amount', T.AMOUNT4),
      col_('provider_hold_released_amount', T.AMOUNT4),
      col_('provider_hold_balance', T.AMOUNT4),
      col_('expected_provider_hold_balance', T.AMOUNT4),
      col_('hold_balance_difference', T.AMOUNT4),
      col_('hold_release_due_from_date', T.DATE),
      col_('hold_release_due_to_date', T.DATE),
      col_('period_due_amount', T.AMOUNT4),
      col_('carry_in_amount', T.AMOUNT4),
      col_('total_due_amount', T.AMOUNT4),
      col_('source_paid_amount', T.AMOUNT4),
      col_('outstanding_amount', T.AMOUNT4),
      col_('provider_adjustments', T.AMOUNT4),
      col_('source_payment_reference', T.TEXT),
      col_('fx_rate', T.FX_RATE),
      col_('payout_currency', T.TEXT),
      col_('source_paid_payout_amount', T.AMOUNT),
      col_('source_fingerprint', T.ID),
      col_('normalizer_version', T.TEXT),
      col_('normalized_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SETTLEMENT_ITEMS,
    description: 'Immutable frozen accounting snapshot: one item per AVAILABLE Payment Leg (provider-paid settlement), ' +
      'settlement_item_id = SI-<sha256(settlement_id|payment_leg_id)>. Written only by normalizeSettlementItems; ' +
      'existing items are never changed or removed and snapshot_at (a valid datetime, required) never changes. seller_hold_amount = ' +
      'provider_hold_amount; seller_available_amount = net_amount - seller_fee - seller_hold_amount.',
    columns: [
      col_('settlement_item_id', T.ID),
      col_('settlement_id', T.ID),
      col_('payment_leg_id', T.ID),
      col_('internal_transaction_id', T.ID),
      col_('seller_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('external_transaction_id', T.ID),
      col_('currency', T.TEXT),
      col_('gross_amount', T.AMOUNT),
      col_('processing_fee', T.AMOUNT),
      col_('net_amount', T.AMOUNT),
      col_('provider_fee_rate', T.RATE),
      col_('provider_fee', T.AMOUNT4),
      col_('provider_hold_rate', T.RATE),
      col_('provider_hold_amount', T.AMOUNT4),
      col_('seller_fee_rate', T.RATE),
      col_('seller_fee', T.AMOUNT4),
      col_('seller_hold_rate', T.RATE),
      col_('seller_hold_amount', T.AMOUNT4),
      col_('seller_available_amount', T.AMOUNT4),
      col_('snapshot_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SELLER_BALANCES,
    description: 'Derived per seller + currency (written only by normalizeSellerBalances). settled_amount = ' +
      'SUM(Settlement Items.seller_available_amount); adjustments = SUM(APPLIED Adjustments.amount); paid_amount = ' +
      'SUM(SENT/CONFIRMED Seller Payouts.amount); current_balance = available_amount = settled + adjustments - paid ' +
      '(may be negative); seller_hold_balance = SUM(Settlement Items.seller_hold_amount) - SUM(APPLIED HOLD_RELEASE).',
    columns: [
      col_('seller_id', T.ID),
      col_('currency', T.TEXT),
      col_('settled_amount', T.AMOUNT4),
      col_('available_amount', T.AMOUNT4),
      col_('paid_amount', T.AMOUNT4),
      col_('seller_hold_balance', T.AMOUNT4),
      col_('adjustments', T.AMOUNT4),
      col_('current_balance', T.AMOUNT4),
      col_('updated_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SELLER_PAYOUTS,
    description: 'Money actually sent to sellers. amount is in currency; payout_amount is in payout_currency. ' +
      'Valid payouts: status SENT or CONFIRMED (DRAFT is provisional; VOID / REVERSED / CANCELLED / FAILED never count). ' +
      'One payout may pay several settlements (see Seller Payout ' +
      'Allocations), so there is no settlement_id here.',
    columns: [
      col_('seller_payout_id', T.ID),
      col_('seller_id', T.ID),
      col_('payout_date', T.DATE),
      col_('currency', T.TEXT),
      col_('amount', T.USD),
      col_('fx_rate', T.FX_RATE),
      col_('payout_currency', T.TEXT),
      col_('payout_amount', T.AMOUNT),
      col_('payment_method', T.TEXT),
      col_('reference', T.TEXT),
      col_('status', T.ENUM, ENUMS.SELLER_PAYOUT_STATUS),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.SELLER_PAYOUT_ALLOCATIONS,
    description: 'Classification of a Seller Payout to payout obligations: target_type SETTLEMENT (target_id = settlement_id; ' +
      'due = frozen Settlement Items of that seller + settlement) or ADJUSTMENT (target_id = adjustment_id of a positive ' +
      'APPLIED adjustment). allocation_id = SPA-<sha256(seller_payout_id|target_type|target_id)>; unique by seller_payout_id + ' +
      'target_type + target_id. Allocations never change Seller Balances (only Seller Payouts do). Only SENT / CONFIRMED ' +
      'payouts count as paid; DRAFT is provisional; VOID has no financial effect (rows must still be valid). An effective ' +
      'payout must be fully allocated.',
    columns: [
      col_('allocation_id', T.ID),
      col_('seller_payout_id', T.ID),
      col_('seller_id', T.ID),
      col_('target_type', T.ENUM, ENUMS.SELLER_PAYOUT_ALLOCATION_TARGET_TYPE),
      col_('target_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('currency', T.TEXT),
      col_('allocated_amount', T.AMOUNT4),
      col_('created_at', T.DATETIME),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.ADJUSTMENTS,
    description: 'Seller-side money effects after settlement (the only source of refund/dispute/fee/' +
      'hold-release effects on seller balance). amount sign is from the seller perspective: ' +
      'positive = credit, negative = debit. Provider-generated rows are unique by ' +
      'payment_source + external_event_id + adjustment_type; manual rows leave external_event_id blank.',
    columns: [
      col_('adjustment_id', T.ID),
      col_('adjustment_type', T.ENUM, ENUMS.ADJUSTMENT_TYPE),
      col_('seller_id', T.ID),
      col_('provider', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('external_event_id', T.ID),
      col_('internal_transaction_id', T.ID),
      col_('payment_leg_id', T.ID),
      col_('settlement_id', T.ID),
      col_('dispute_id', T.ID),
      col_('currency', T.TEXT),
      col_('amount', T.USD),
      col_('effective_date', T.DATE),
      col_('status', T.ENUM, ENUMS.ADJUSTMENT_STATUS),
      col_('reason', T.TEXT),
      col_('created_at', T.DATETIME),
      col_('created_by', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.DISPUTES,
    description: 'Dispute case tracking. Money effects are recorded only in Adjustments.',
    columns: [
      col_('dispute_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('external_dispute_id', T.ID),
      col_('external_transaction_id', T.ID),
      col_('internal_transaction_id', T.ID),
      col_('payment_leg_id', T.ID),
      col_('seller_id', T.ID),
      col_('provider', T.ID),
      col_('currency', T.TEXT),
      col_('dispute_amount', T.USD),
      col_('dispute_fee', T.USD),
      col_('reason', T.TEXT),
      col_('dispute_status', T.ENUM, ENUMS.DISPUTE_STATUS),
      col_('opened_at', T.DATETIME),
      col_('due_at', T.DATETIME),
      col_('resolved_at', T.DATETIME),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.AUDIT_LOG,
    description: 'Append-only log of important operations.',
    columns: [
      col_('timestamp', T.DATETIME),
      col_('action', T.TEXT),
      col_('entity_type', T.TEXT),
      col_('entity_id', T.ID),
      col_('old_status', T.TEXT),
      col_('new_status', T.TEXT),
      col_('actor', T.TEXT),
      col_('details', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.IMPORT_BATCHES,
    description: 'One row per source-tab sync attempt. checksum is the snapshot checksum ' +
      '(SHA-256 over canonical cell values) of the source at sync time.',
    columns: [
      col_('import_batch_id', T.ID),
      col_('provider_id', T.ID),
      col_('source_spreadsheet_id', T.ID),
      col_('source_sheet', T.TEXT),
      col_('target_sheet', T.TEXT),
      col_('started_at', T.DATETIME),
      col_('completed_at', T.DATETIME),
      col_('source_rows', T.INTEGER),
      col_('source_columns', T.INTEGER),
      col_('checksum', T.ID),
      col_('status', T.ENUM, ENUMS.IMPORT_BATCH_STATUS),
      col_('error_message', T.TEXT),
      col_('actor', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.PROVIDER_TRANSACTIONS,
    description: 'Canonical provider PAYMENT transactions, all providers. Unique key: ' +
      'provider_id + payment_source + external_transaction_id. Each provider partition is ' +
      'rebuilt by its normalizer from Master raw tabs; other partitions are preserved. ' +
      'processing_fee is positive; gross_amount - processing_fee = net_amount.',
    columns: [
      col_('provider_transaction_id', T.ID),
      col_('provider_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('gateway_id', T.ID),
      col_('external_transaction_id', T.ID),
      col_('transaction_at', T.DATETIME),
      col_('currency', T.TEXT),
      col_('gross_amount', T.AMOUNT),
      col_('processing_fee', T.AMOUNT),
      col_('net_amount', T.AMOUNT),
      col_('external_status', T.TEXT),
      col_('raw_type', T.TEXT),
      col_('balance_impact', T.TEXT),
      col_('order_reference', T.TEXT),
      col_('payer_reference', T.TEXT),
      col_('provider_sub_account', T.TEXT),
      col_('provider_reconciliation_status', T.ENUM, ENUMS.PROVIDER_RECONCILIATION_STATUS),
      col_('provider_reconciliation_raw_status', T.TEXT),
      col_('reconciliation_difference', T.AMOUNT),
      col_('source_paypal_row', T.INTEGER),
      col_('source_reconciled_row', T.INTEGER),
      col_('source_fingerprint', T.ID),
      col_('normalizer_version', T.TEXT),
      col_('normalized_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.PROVIDER_EVENTS,
    description: 'Canonical provider ledger events, all providers, with signed provider amounts ' +
      '(gross_amount + fee_amount = net_amount). balance_effect_amount is the actual provider ' +
      'balance movement (0 for Memo). Unique key: provider_id + payment_source + external_event_id. ' +
      'RESERVE_HOLD is the provider reserve, not a contractual hold.',
    columns: [
      col_('provider_event_id', T.ID),
      col_('provider_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('gateway_id', T.ID),
      col_('external_event_id', T.ID),
      col_('related_external_transaction_id', T.ID),
      col_('provider_transaction_id', T.ID),
      col_('event_type', T.ENUM, ENUMS.PROVIDER_EVENT_TYPE),
      col_('event_at', T.DATETIME),
      col_('external_status', T.TEXT),
      col_('currency', T.TEXT),
      col_('gross_amount', T.AMOUNT),
      col_('fee_amount', T.AMOUNT),
      col_('net_amount', T.AMOUNT),
      col_('balance_impact', T.TEXT),
      col_('balance_effect_amount', T.AMOUNT),
      col_('raw_type', T.TEXT),
      col_('raw_group', T.TEXT),
      col_('source_paypal_row', T.INTEGER),
      col_('source_fingerprint', T.ID),
      col_('normalizer_version', T.TEXT),
      col_('normalized_at', T.DATETIME),
    ],
  },
]);

/**
 * Raw snapshot sources. Source spreadsheet ID and source tab names are read from
 * Settings at run time (keys below); only Master-side target/staging tab names live here.
 * Target tabs are exact value mirrors of the source used range and have no schema.
 */
const RAW_SOURCES = Object.freeze({
  KH001: {
    providerId: 'KH001',
    enabledSetting: 'source.KH001.enabled',
    spreadsheetIdSetting: 'source.KH001.spreadsheet_id',
    tabs: [
      { sourceSheetSetting: 'source.KH001.raw_paypal_sheet',
        targetSheet: SHEETS.RAW_KH001_PAYPAL, stagingSheet: '__STAGE_KH001_RAW_PP' },
      { sourceSheetSetting: 'source.KH001.reconciled_sheet',
        targetSheet: SHEETS.RAW_KH001_RECONCILED, stagingSheet: '__STAGE_KH001_RECONCILED' },
      { sourceSheetSetting: 'source.KH001.settlements_sheet',
        targetSheet: SHEETS.RAW_KH001_SETTLEMENTS, stagingSheet: '__STAGE_KH001_SETTLEMENTS' },
      { sourceSheetSetting: 'source.KH001.disputes_sheet',
        targetSheet: SHEETS.RAW_KH001_DISPUTES, stagingSheet: '__STAGE_KH001_DISPUTES' },
    ],
  },
});

/** Prefix of hidden staging tabs used only by raw sync. */
const STAGING_SHEET_PREFIX = '__STAGE_';

/**
 * Initial Settings rows, written only when the key does not exist yet.
 * Provider fees and holds are scoped per provider (provider_*.<PROVIDER>) and are never
 * a single global rate. Seller and provider holds are separate settings.
 */
const DEFAULT_SETTINGS = Object.freeze([
  ['schema_version', String(APP.SCHEMA_VERSION), 'NUMBER', 'Master schema version.'],
  ['default_currency', APP.DEFAULT_CURRENCY, 'STRING', 'Default currency for amounts.'],
  ['default_timezone', APP.TIMEZONE, 'STRING', 'Spreadsheet and script timezone.'],
  ['seller_fee_rate', 0.08, 'RATE', 'Default seller fee rate on net amount. Overridable per seller in Sellers.'],
  // LEGACY - NOT USED FOR KH001 MIRROR-HOLD ACCOUNTING. KH001 seller hold = the frozen provider
  // hold of the same transaction (1:1, policy MIRROR_PROVIDER). Kept until an explicit cleanup.
  ['default_seller_hold_rate', 0.10, 'RATE',
    'Default seller hold rate on net amount (we hold from the seller). Overridable per seller in Sellers.'],
  ['provider_fee_model.KH001', 'PERCENT_OF_NET', 'STRING', 'Fee model for provider KH001.'],
  ['provider_fee_rate.KH001', 0.07, 'RATE', 'Provider KH001 fee rate on net amount.'],
  ['provider_hold_rate.KH001', 0.10, 'RATE', 'Provider KH001 hold rate on net amount (provider holds from us).'],
  ['source.KH001.enabled', true, 'BOOLEAN', 'Enable KH001 raw sync.'],
  ['source.KH001.spreadsheet_id', '1gDg2NrxIkXNSnFSOgH-jCUH4GZOpSyrm2Zf8oEuiBzM', 'STRING',
    'KH001 source spreadsheet (PayPal_KH001_T10-2026_MR TRUNG LE).'],
  ['source.KH001.timezone', 'America/Los_Angeles', 'STRING',
    'KH001 source timezone. Raw sync does not convert; used by the future normalizer.'],
  ['source.KH001.raw_paypal_sheet', 'RAW_PP', 'STRING', 'KH001 source tab mirrored to Raw KH001 PayPal.'],
  ['source.KH001.reconciled_sheet', 'DoiSoat_GD', 'STRING', 'KH001 source tab mirrored to Raw KH001 Reconciled.'],
  ['source.KH001.settlements_sheet', 'PhieuDoiSoat', 'STRING', 'KH001 source tab mirrored to Raw KH001 Settlements.'],
  ['source.KH001.disputes_sheet', 'Dispute', 'STRING', 'KH001 source tab mirrored to Raw KH001 Disputes.'],
  ['seller_template_spreadsheet_id', '', 'STRING',
    'Seller template (UI authority) cloned by createSellerSheet: four visible tabs DoiSoat_GD, TongHop_Thang, PhieuDoiSoat, Dispute; Master writes only owned ranges.'],
  ['seller_output_folder_id', '', 'STRING', 'Drive folder that receives seller sheets created by createSellerSheet.'],
  ['scheduled_sync_morning_hour', 8, 'NUMBER', 'Hour (0-23) of the morning runScheduledPaymentPipeline run, in scheduled_sync_timezone.'],
  ['scheduled_sync_afternoon_hour', 17, 'NUMBER', 'Hour (0-23) of the afternoon runScheduledPaymentPipeline run, in scheduled_sync_timezone.'],
  ['scheduled_sync_timezone', APP.TIMEZONE, 'STRING',
    'IANA time zone of the scheduled pipeline hours = the Master timezone (DST handled by Apps Script). Re-run ' +
    'installScheduledPaymentPipelineTriggers after changing the schedule.'],
  ['source.INTERNAL.naive_timestamp_timezone', '', 'STRING',
    'Timezone for internal CSV timestamps without an offset (e.g. "2026-10-01 12:00:00"). Blank = such ' +
    'timestamps are rejected. Timestamps with Z or an offset never use it.'],
]);

/** Settings keys whose value is always kept in sync with code. */
const MANAGED_SETTING_KEYS = Object.freeze(['schema_version']);

/**
 * Tabs removed from the schema. Setup deletes such a tab only when it is provably unused: header row
 * empty or exactly the legacy header, no data rows, no cells beyond the header columns, and no formula
 * or named range elsewhere in the spreadsheet that references it. Otherwise the tab is kept and
 * reported as a warning. Never removes business data.
 */
const LEGACY_TABS = Object.freeze([
  {
    // v17: never had a reader or writer; provider movements live in Provider Transactions/Events.
    sheet: 'Source Payments',
    removedInSchema: 17,
    legacyHeader: ['payment_source', 'external_event_id', 'external_transaction_id', 'related_external_transaction_id',
      'provider', 'event_type', 'event_date', 'gross_amount', 'processing_fee', 'net_amount', 'currency',
      'external_status', 'order_reference', 'payer_reference', 'import_batch_id', 'imported_at'],
  },
]);

/** Renamed Settings keys: [oldKey, newKey]. Applied by Setup before seeding. */
const SETTING_KEY_RENAMES = Object.freeze([
  ['default_hold_rate', 'default_seller_hold_rate'],
]);
