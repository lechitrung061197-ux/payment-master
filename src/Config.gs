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
  SCHEMA_VERSION: 1,
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
  SOURCE_RECORD_TYPE: ['PAYMENT', 'REFUND', 'DISPUTE', 'FEE', 'ADJUSTMENT', 'OTHER'],
  TRANSACTION_STATUS: ['UNMATCHED', 'MATCHED', 'WAITING_SETTLEMENT', 'SETTLED', 'AVAILABLE', 'PAID'],
  MATCH_TYPE: ['AUTO', 'MANUAL'],
  MATCH_STATUS: ['PENDING_REVIEW', 'CONFIRMED', 'REJECTED', 'REVERSED'],
  LEG_SETTLEMENT_STATUS: ['WAITING_SETTLEMENT', 'SETTLED', 'AVAILABLE', 'PAID'],
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
    description: 'Seller master. Blank rate columns fall back to Settings defaults.',
    columns: [
      col_('seller_id', T.ID),
      col_('seller_name', T.TEXT),
      col_('seller_fee_rate', T.RATE),
      col_('hold_rate', T.RATE),
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
    description: 'Raw external payment records from all sources, one row per source record. ' +
      'Unique key: payment_source + external_transaction_id.',
    columns: [
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('external_transaction_id', T.ID),
      col_('provider', T.ID),
      col_('record_type', T.ENUM, ENUMS.SOURCE_RECORD_TYPE),
      col_('transaction_date', T.DATETIME),
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
    description: 'Internal transactions (source of truth for ownership: endpoint, seller, store, order).',
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
    description: 'Links internal transactions to external payments. Rows are never deleted; ' +
      'un-matching sets match_status = REVERSED.',
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
    description: 'One row per external payment record linked to an internal transaction. ' +
      'Live (pre-settlement) economics; rates are copied onto the row for auditability.',
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
      col_('seller_fee_rate', T.RATE),
      col_('seller_fee', T.USD),
      col_('hold_rate', T.RATE),
      col_('hold_amount', T.USD),
      col_('refund_amount', T.USD),
      col_('dispute_amount', T.USD),
      col_('dispute_fee', T.USD),
      col_('settlement_id', T.ID),
      col_('settlement_status', T.ENUM, ENUMS.LEG_SETTLEMENT_STATUS),
      col_('available_amount', T.USD),
      col_('created_at', T.DATETIME),
      col_('updated_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SETTLEMENTS,
    description: 'Provider payout batches. Snapshot once LOCKED; payout_amount is in payout_currency.',
    columns: [
      col_('settlement_id', T.ID),
      col_('provider', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
      col_('settlement_date', T.DATE),
      col_('currency', T.TEXT),
      col_('gross_amount', T.USD),
      col_('net_amount', T.USD),
      col_('provider_fee', T.USD),
      col_('hold_amount', T.USD),
      col_('adjustments', T.USD),
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
      'Self-contained: does not depend on live source sheets.',
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
      col_('seller_fee_rate', T.RATE),
      col_('seller_fee', T.USD),
      col_('hold_rate', T.RATE),
      col_('hold_amount', T.USD),
      col_('available_amount', T.USD),
      col_('snapshot_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SELLER_BALANCES,
    description: 'Per-seller, per-currency balance aggregated across all providers (future).',
    columns: [
      col_('seller_id', T.ID),
      col_('currency', T.TEXT),
      col_('settled_amount', T.USD),
      col_('available_amount', T.USD),
      col_('paid_amount', T.USD),
      col_('hold_balance', T.USD),
      col_('adjustments', T.USD),
      col_('current_balance', T.USD),
      col_('updated_at', T.DATETIME),
    ],
  },
  {
    sheet: SHEETS.SELLER_PAYOUTS,
    description: 'Money actually sent to sellers. amount is in currency; payout_amount is in payout_currency.',
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
    description: 'Money-affecting events after the original payment. ' +
      'amount sign is from the seller perspective: positive = credit, negative = debit.',
    columns: [
      col_('adjustment_id', T.ID),
      col_('adjustment_type', T.ENUM, ENUMS.ADJUSTMENT_TYPE),
      col_('seller_id', T.ID),
      col_('provider', T.ID),
      col_('payment_source', T.ENUM, ENUMS.PAYMENT_SOURCE),
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
 * Provider fees are scoped per provider (provider_fee_rate.<PROVIDER>) and are never
 * a single global rate.
 */
const DEFAULT_SETTINGS = Object.freeze([
  ['schema_version', String(APP.SCHEMA_VERSION), 'NUMBER', 'Master schema version.'],
  ['default_currency', APP.DEFAULT_CURRENCY, 'STRING', 'Default currency for amounts.'],
  ['default_timezone', APP.TIMEZONE, 'STRING', 'Spreadsheet and script timezone.'],
  ['seller_fee_rate', 0.08, 'RATE', 'Default seller fee rate on net amount. Overridable per seller in Sellers.'],
  ['default_hold_rate', 0.10, 'RATE', 'Default hold rate on net amount. Overridable per seller in Sellers.'],
  ['provider_fee_model.KH001', 'PERCENT_OF_NET', 'STRING', 'Fee model for provider KH001.'],
  ['provider_fee_rate.KH001', 0.07, 'RATE', 'Provider KH001 fee rate on net amount.'],
]);
