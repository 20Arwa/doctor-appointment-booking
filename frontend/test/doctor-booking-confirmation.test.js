const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

const page = fs.readFileSync(path.join(__dirname, "..", "components", "doctor-booking-page.tsx"), "utf8");

describe("doctor booking confirmation dialog", () => {
  it("opens for a selected slot without creating an appointment until explicit confirmation", () => {
    const bookingHandler = page.match(/async function handleBooking\(event: React\.FormEvent<HTMLFormElement>\) \{([\s\S]*?)\n  \}/)?.[1];
    const confirmHandler = page.match(/async function confirmBooking\(\) \{([\s\S]*?)\n  \}/)?.[1];

    assert.ok(bookingHandler);
    assert.match(bookingHandler, /setBookingDialogOpen\(true\)/);
    assert.doesNotMatch(bookingHandler, /createAppointment\(/);
    assert.ok(confirmHandler);
    assert.match(confirmHandler, /createAppointment\(/);
    assert.match(page, /<AlertDialogCancel disabled=\{booking\}>Go back<\/AlertDialogCancel>/);
  });

  it("shows the selected doctor, time, INR consultation fee, and online payment status", () => {
    assert.match(page, /Dr\. \{doctor\.first_name\} \{doctor\.last_name\}/);
    assert.match(page, /formatSlotDate\(selectedSlot\.date\)\} at \{formatSlotTime\(selectedSlot\.start_time\)\} IST/);
    assert.match(page, /inrFormatter\.format\(doctor\.consultation_fee\)/);
    assert.match(page, /Online payment is not enabled yet/);
  });
});
