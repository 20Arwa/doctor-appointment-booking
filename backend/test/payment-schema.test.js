const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const migration = fs.readFileSync(path.join(__dirname, "..", "migrations", "008_payment_refund_schema.sql"), "utf8");
const reconciliationMigration = fs.readFileSync(path.join(__dirname, "..", "migrations", "010_payment_capture_reconciliation.sql"), "utf8");
const stripeBookingMigration = fs.readFileSync(path.join(__dirname, "..", "migrations", "009_payment_booking_reason.sql"), "utf8");

describe("payment and refund database migration", () => {
  it("adds payment, refund, event, and slot-hold records without changing appointment status", () => {
    assert.match(migration, /CREATE TABLE appointment_slot_holds/i);
    assert.match(migration, /CREATE TABLE payments/i);
    assert.match(migration, /appointment_id UUID REFERENCES appointments\(id\) ON DELETE RESTRICT/i);
    assert.match(migration, /slot_hold_id UUID REFERENCES appointment_slot_holds\(id\) ON DELETE RESTRICT/i);
    assert.match(migration, /CREATE TABLE refunds/i);
    assert.match(migration, /CREATE TABLE payment_provider_events/i);
    assert.doesNotMatch(migration, /ALTER TABLE appointments/i);
    assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|TRUNCATE/i);
  });

  it("requires positive INR-capable money values and blocks duplicate provider attempts and events", () => {
    assert.match(migration, /amount NUMERIC\(10, 2\) NOT NULL CHECK \(amount > 0\)/i);
    assert.match(migration, /currency CHAR\(3\) NOT NULL DEFAULT 'INR'/i);
    assert.match(migration, /payments_provider_order_unique/i);
    assert.match(migration, /payments_provider_payment_unique/i);
    assert.match(migration, /payments_provider_transaction_unique/i);
    assert.match(migration, /payments_provider_idempotency_unique/i);
    assert.match(migration, /payments_one_open_or_captured_per_appointment/i);
    assert.match(migration, /payments_one_open_or_captured_per_hold/i);
    assert.match(migration, /payment_provider_event_unique UNIQUE \(provider, provider_event_id\)/i);
  });

  it("serializes refunds against the payment and prevents pending or processed totals exceeding capture", () => {
    assert.match(migration, /CREATE TRIGGER refunds_amount_within_payment/i);
    assert.match(migration, /UPDATE payments[\s\S]+WHERE id = NEW\.payment_id[\s\S]+RETURNING amount, currency, status, provider/i);
    assert.match(migration, /payment_status NOT IN \('captured', 'partially_refunded'\)/i);
    assert.match(migration, /existing_refunds \+ CASE[\s\S]+> payment_amount/i);
    assert.ok(migration.indexOf("UPDATE payments") < migration.indexOf("SELECT COALESCE(SUM(amount), 0)"));
    assert.match(migration, /refunds_provider_reference_unique/i);
    assert.match(migration, /refunds_provider_idempotency_unique/i);
  });

  it("allows only one active hold per availability slot and indexes expiry", () => {
    assert.match(migration, /appointment_slot_holds_one_active_per_slot[\s\S]+ON appointment_slot_holds \(availability_id\)[\s\S]+WHERE status = 'active'/i);
    assert.match(migration, /appointment_slot_holds_expiry_idx[\s\S]+ON appointment_slot_holds \(expires_at\)/i);
    assert.match(migration, /appointment_slot_hold_expiry_after_creation CHECK \(expires_at > created_at\)/i);
    assert.match(migration, /expires_at TIMESTAMPTZ NOT NULL DEFAULT \(NOW\(\) \+ INTERVAL '10 minutes'\)/i);
  });

  it("allows failed and expired payment retries while pending and captured payments stay unique", () => {
    assert.match(migration, /'created', 'pending', 'authorized', 'captured', 'failed', 'cancelled', 'expired'/i);
    const activePaymentIndex = migration.match(/CREATE UNIQUE INDEX payments_one_open_or_captured_per_appointment([\s\S]*?);/i)?.[1] || "";
    assert.match(activePaymentIndex, /'pending'/i);
    assert.match(activePaymentIndex, /'captured'/i);
    assert.doesNotMatch(activePaymentIndex, /'failed'|'expired'|'cancelled'/i);
    assert.match(migration, /payments_expired_timestamp_required/);
  });

  it("records additional captures separately without overwriting the primary payment reference", () => {
    assert.match(reconciliationMigration, /CREATE TABLE payment_capture_reconciliation/i);
    assert.match(reconciliationMigration, /payment_id UUID NOT NULL REFERENCES payments\(id\) ON DELETE RESTRICT/i);
    assert.match(reconciliationMigration, /provider_payment_id TEXT NOT NULL/i);
    assert.match(reconciliationMigration, /payment_capture_reconciliation_provider_payment_unique/i);
    assert.match(reconciliationMigration, /status IN \('unresolved', 'resolved'\)/i);
    assert.match(reconciliationMigration, /reason IN \('additional_capture', 'slot_unavailable'\)/i);
    assert.doesNotMatch(reconciliationMigration, /DROP TABLE|DROP COLUMN|TRUNCATE/i);
  });

  it("sets the unapplied hold default beyond Stripe's Checkout expiry", () => {
    assert.match(stripeBookingMigration, /ALTER COLUMN expires_at SET DEFAULT \(NOW\(\) \+ INTERVAL '40 minutes'\)/i);
    assert.match(stripeBookingMigration, /Stripe Checkout Sessions expire after 35 minutes; the 40-minute hold/i);
  });
});
