import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(__dirname, "..", "components", "doctor-booking-page.tsx"), "utf8");

describe("doctor booking confirmation dialog", () => {
  it("opens for a selected slot without creating an appointment until explicit confirmation", () => {
    const bookingHandler = page.match(/async function handleBooking\(event: React\.FormEvent<HTMLFormElement>\) \{([\s\S]*?)\n  \}/)?.[1];
    const confirmHandler = page.match(/async function confirmBooking\(\) \{([\s\S]*?)\n  \}/)?.[1];

    assert.ok(bookingHandler);
    assert.match(bookingHandler, /setBookingDialogOpen\(true\)/);
    assert.doesNotMatch(bookingHandler, /createAppointment\(/);
    assert.ok(confirmHandler);
    assert.match(confirmHandler, /createAppointmentPaymentOrder\(/);
    assert.match(confirmHandler, /createAppointmentPaymentOrder\(/);
    assert.match(confirmHandler, /window\.location\.assign\(order\.checkout_url\)/);
    assert.doesNotMatch(confirmHandler, /verifyAppointmentPayment\(/);
    assert.doesNotMatch(confirmHandler, /createAppointment\(/);
    assert.match(page, /<AlertDialogCancel disabled=\{booking\}>Go back<\/AlertDialogCancel>/);
  });

  it("shows the selected doctor, time, INR consultation fee, and online payment status", () => {
    assert.match(page, /Dr\. \{doctor\.first_name\} \{doctor\.last_name\}/);
    assert.match(page, /formatSlotDate\(selectedSlot\.date\)\} at \{formatSlotTime\(selectedSlot\.start_time\)\} IST/);
    assert.match(page, /inrFormatter\.format\(doctor\.consultation_fee\)/);
    assert.match(page, /Pay in Stripe Test Mode/);
    assert.match(page, /held for up to 40 minutes/);
  });
});
