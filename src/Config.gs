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
  SCHEMA_VERSION: 2,
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
  RATE: '0.00%',
  FX_RATE: '0.000000',
  INTEGER: '#,##0',
});

/** Allowed values for enum columns. */
const ENUMS = Object.freeze({
  RECORD_STATUS: ['ACTIVE', 'INACTIVE'],
  PAYMENT_SOURCE: ['PAYPAL', 'STRIPE', 'BANK', 'OTHER'],
  SOURCE_EVENT_TYPE: ['PAYMENT', 'REFUND', 'DISPUTE', 'DISPUTE_FEE', 'HOLD', 'RELEASE', 'OTHER'],
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
  SELLER_PAYOUT_STATUS: ['DRAFT', 'SENT', 'CONFIRMED', 'VOID'],
  ADJUSTMENT_TYPE: ['REFUND', 'DISPUTE', 'DISPUTE_FEE', 'MANUAL_ADJUSTMENT', 'HOLD_RELEASE'],
  ADJUSTMENT_STATUS: ['PENDING', 'APPLIED', 'VOID'],
  DISPUTE_STATUS: ['OPEN', 'UNDER_REVIEW', 'WON', 'LOST', 'CLOSED'],
  SETTING_VALUE_TYPE: ['STRING', 'RATE', 'NUMBER', 'BOOLEAN'],
});

/** Tab names, in display order. */
const SHEETS = Object.freeze({
  SETTINGS: 'Settings',
  SELLERS: 'Sellers',
  ENDPOINT_MAPPING: 'Endpoint Mapping',
  SOURCE_SYSTEM: 'Source System',
  SOURCE_PAYMENTS: 'Source Payments',
  TRANSACTIONS: 'Transactions',
  PAYMENT_MATCHES: 'Payment Matches',
  PAYMENT_LEGS: 'Payment Legs',
  SETTLEMENTS: 'Settlements',
  SETTLEMENT_ITEMS: 'Settlement Items',
  SELLER_BALANCES: 'Seller Balances',
  SELLER_PAYOUTS: 'Seller Payouts',
  ADJUSTMENTS: 'Adjustments',
  DISPUTES: 'Disputes',
  DASHBOARD: 'Dashboard',
  AUDIT_LOG: 'Audit Log',
});

/** Shorthand column constructor: col_('name', COL_TYPE.X, ENUMS.Y?) */
function col_(name, type, values) {
  return { name: name, type: type, values: values || null };
}

const T = COL_TYPE;

/**
 * Data table schemas. Every table has a single, stable header row (row 1).
 * Dashboard is a layout tab, not a data table, and is defined in Setup.gs.
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
    description: 'Seller master. Blank rate columns fall back to Settings defaults ' +
      '(seller_fee_rate, default_seller_hold_rate).',
    columns: [
      col_('seller_id', T.ID),
      col_('seller_name', T.TEXT),
      col_('seller_fee_rate', T.RATE),
      col_('seller_hold_rate', T.RATE),
      col_('default_currency', T.TEXT),
      col_('status', T.ENUM, ENUMS.RECORD_STATUS),
      col_('created_at', T.DATETIME),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.ENDPOINT_MAPPING,
    description: 'Maps internal endpoint tokens to sellers and seller groups, effective-dated.',
    columns: [
      col_('endpoint_token', T.ID),
      col_('seller_id', T.ID),
      col_('seller_group', T.TEXT),
      col_('status', T.ENUM, ENUMS.RECORD_STATUS),
      col_('active_from', T.DATE),
      col_('active_to', T.DATE),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.SOURCE_SYSTEM,
    description: 'Raw internal-system transactions as imported. Never edited after import.',
    columns: [
      col_('source_record_id', T.ID),
      col_('created_at', T.DATETIME),
      col_('endpoint_token', T.ID),
      col_('store', T.TEXT),
      col_('order_id', T.ID),
      col_('order_amount', T.USD),
      col_('currency', T.TEXT),
      col_('raw_status', T.TEXT),
      col_('import_batch_id', T.ID),
      col_('imported_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SOURCE_PAYMENTS,
    description: 'Raw provider events/movements from all sources, one row per event. ' +
      'Unique key: payment_source + external_event_id. Several events (payment, refund, ' +
      'dispute, ...) may share the same external_transaction_id.',
    columns: [
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('external_event_id', T.ID),
      col_('external_transaction_id', T.ID),
      col_('related_external_transaction_id', T.ID),
      col_('provider', T.ID),
      col_('event_type', T.ENUM, ENUMS.SOURCE_EVENT_TYPE),
      col_('event_date', T.DATETIME),
      col_('gross_amount', T.USD),
      col_('processing_fee', T.USD),
      col_('net_amount', T.USD),
      col_('currency', T.TEXT),
      col_('external_status', T.TEXT),
      col_('order_reference', T.TEXT),
      col_('payer_reference', T.TEXT),
      col_('import_batch_id', T.ID),
      col_('imported_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.TRANSACTIONS,
    description: 'Internal transactions (source of truth for ownership: endpoint, seller, store, order). ' +
      'status is a derived summary of its payment legs and is never used to calculate money.',
    columns: [
      col_('internal_transaction_id', T.ID),
      col_('created_at', T.DATETIME),
      col_('endpoint_token', T.ID),
      col_('seller_id', T.ID),
      col_('seller_group', T.TEXT),
      col_('store', T.TEXT),
      col_('order_id', T.ID),
      col_('order_amount', T.USD),
      col_('currency', T.TEXT),
      col_('status', T.ENUM, ENUMS.TRANSACTION_STATUS),
      col_('updated_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.PAYMENT_MATCHES,
    description: 'Links internal transactions to external payment transactions. Rows are never deleted; ' +
      'un-matching sets match_status = REVERSED. At most one CONFIRMED row per ' +
      'payment_source + external_transaction_id.',
    columns: [
      col_('match_id', T.ID),
      col_('internal_transaction_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('external_transaction_id', T.ID),
      col_('match_type', T.ENUM, ENUMS.MATCH_TYPE),
      col_('match_status', T.ENUM, ENUMS.MATCH_STATUS),
      col_('matched_at', T.DATETIME),
      col_('matched_by', T.TEXT),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.PAYMENT_LEGS,
    description: 'One row per external payment transaction linked to an internal transaction. ' +
      'Unique key: payment_source + external_transaction_id. Live (pre-settlement) economics. ' +
      'refund_amount / dispute_amount / dispute_fee are source information only; their money ' +
      'effect is recorded once, in Adjustments.',
    columns: [
      col_('payment_leg_id', T.ID),
      col_('match_id', T.ID),
      col_('internal_transaction_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('provider', T.ID),
      col_('external_transaction_id', T.ID),
      col_('currency', T.TEXT),
      col_('gross_amount', T.USD),
      col_('processing_fee', T.USD),
      col_('net_amount', T.USD),
      col_('provider_fee_rate', T.RATE),
      col_('provider_fee', T.USD),
      col_('provider_hold_rate', T.RATE),
      col_('provider_hold_amount', T.USD),
      col_('seller_fee_rate', T.RATE),
      col_('seller_fee', T.USD),
      col_('seller_hold_rate', T.RATE),
      col_('seller_hold_amount', T.USD),
      col_('seller_available_amount', T.USD),
      col_('refund_amount', T.USD),
      col_('dispute_amount', T.USD),
      col_('dispute_fee', T.USD),
      col_('settlement_id', T.ID),
      col_('settlement_status', T.ENUM, ENUMS.LEG_SETTLEMENT_STATUS),
      col_('created_at', T.DATETIME),
      col_('updated_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SETTLEMENTS,
    description: 'Provider payout batches (provider economics only). Snapshot once LOCKED. ' +
      'payout_base_amount = net_amount - provider_fee - provider_hold_amount + provider_adjustments ' +
      '(in currency). payout_amount is the actual payout in payout_currency. ' +
      'Never used to recalculate seller economics.',
    columns: [
      col_('settlement_id', T.ID),
      col_('provider', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('settlement_date', T.DATE),
      col_('currency', T.TEXT),
      col_('gross_amount', T.USD),
      col_('net_amount', T.USD),
      col_('provider_fee', T.USD),
      col_('provider_hold_amount', T.USD),
      col_('provider_adjustments', T.USD),
      col_('payout_base_amount', T.USD),
      col_('payout_amount', T.AMOUNT),
      col_('fx_rate', T.FX_RATE),
      col_('payout_currency', T.TEXT),
      col_('status', T.ENUM, ENUMS.SETTLEMENT_STATUS),
      col_('created_at', T.DATETIME),
      col_('locked_at', T.DATETIME),
      col_('notes', T.TEXT),
    ],
  },
  {
    sheet: SHEETS.SETTLEMENT_ITEMS,
    description: 'Frozen snapshot of each payment leg included in a settlement. ' +
      'Self-contained: does not depend on live source sheets. A payment_leg_id appears in at most ' +
      'one non-VOID settlement. seller_available_amount = net_amount - seller_fee - seller_hold_amount.',
    columns: [
      col_('settlement_item_id', T.ID),
      col_('settlement_id', T.ID),
      col_('payment_leg_id', T.ID),
      col_('internal_transaction_id', T.ID),
      col_('seller_id', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('external_transaction_id', T.ID),
      col_('currency', T.TEXT),
      col_('gross_amount', T.USD),
      col_('processing_fee', T.USD),
      col_('net_amount', T.USD),
      col_('provider_fee_rate', T.RATE),
      col_('provider_fee', T.USD),
      col_('provider_hold_rate', T.RATE),
      col_('provider_hold_amount', T.USD),
      col_('seller_fee_rate', T.RATE),
      col_('seller_fee', T.USD),
      col_('seller_hold_rate', T.RATE),
      col_('seller_hold_amount', T.USD),
      col_('seller_available_amount', T.USD),
      col_('snapshot_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SELLER_BALANCES,
    description: 'Per-seller, per-currency balance aggregated across all providers (future). ' +
      'current_balance = SUM(Settlement Items.seller_available_amount) + SUM(APPLIED Adjustments.amount) ' +
      '- SUM(SENT/CONFIRMED Seller Payouts.amount).',
    columns: [
      col_('seller_id', T.ID),
      col_('currency', T.TEXT),
      col_('settled_amount', T.USD),
      col_('available_amount', T.USD),
      col_('paid_amount', T.USD),
      col_('seller_hold_balance', T.USD),
      col_('adjustments', T.USD),
      col_('current_balance', T.USD),
      col_('updated_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SELLER_PAYOUTS,
    description: 'Money actually sent to sellers. amount is in currency; payout_amount is in payout_currency. ' +
      'Valid payouts: status SENT or CONFIRMED. One payout may be funded by several settlements ' +
      '(future Seller Payout Allocations), so there is no settlement_id here.',
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
]);

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
  ['default_seller_hold_rate', 0.10, 'RATE',
    'Default seller hold rate on net amount (we hold from the seller). Overridable per seller in Sellers.'],
  ['provider_fee_model.KH001', 'PERCENT_OF_NET', 'STRING', 'Fee model for provider KH001.'],
  ['provider_fee_rate.KH001', 0.07, 'RATE', 'Provider KH001 fee rate on net amount.'],
  ['provider_hold_rate.KH001', 0.10, 'RATE', 'Provider KH001 hold rate on net amount (provider holds from us).'],
]);

/** Settings keys whose value is always kept in sync with code. */
const MANAGED_SETTING_KEYS = Object.freeze(['schema_version']);

/** Renamed Settings keys: [oldKey, newKey]. Applied by Setup before seeding. */
const SETTING_KEY_RENAMES = Object.freeze([
  ['default_hold_rate', 'default_seller_hold_rate'],
]);
