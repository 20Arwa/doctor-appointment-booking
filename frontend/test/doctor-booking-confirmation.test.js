import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(__dirname, "..", "components", "doctor-booking-page.tsx"), "utf8");
const api = fs.readFileSync(path.join(__dirname, "..", "lib", "profile-api.ts"), "utf8");
const noticePath = path.join(__dirname, "..", "components", "checkout-return-notice.tsx");
const noticeSource = fs.readFileSync(noticePath, "utf8");
const noticeModule = new Module(noticePath);
noticeModule.filename = noticePath;
noticeModule.paths = Module._nodeModulePaths(path.dirname(noticePath));
noticeModule._compile(ts.transpileModule(noticeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText, noticePath);
const { CheckoutReturnNotice } = noticeModule.exports;

function renderNotice(props) {
  return renderToStaticMarkup(React.createElement(CheckoutReturnNotice, props));
}

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
    assert.match(confirmHandler, /setBooking\(true\)/);
    assert.match(confirmHandler, /setBookingDialogOpen\(false\)/);
    assert.doesNotMatch(confirmHandler, /setPaymentPendingId\(/);
    assert.doesNotMatch(confirmHandler, /verifyAppointmentPayment\(/);
    assert.doesNotMatch(confirmHandler, /createAppointment\(/);
    assert.match(api, /checkout_url: z\.string\(\)\.url\(\)\.refine/);
    assert.match(api, /checkoutUrl\.protocol === "https:" && checkoutUrl\.hostname === "checkout\.stripe\.com"/);
    assert.match(page, /if \(booking\) return <AppShellLoading message="Redirecting to secure checkout…" \/>/);
    assert.match(page, /<AlertDialogCancel disabled=\{booking\}>Go back<\/AlertDialogCancel>/);
  });

  it("shows the selected doctor, time, INR consultation fee, and online payment status", () => {
    assert.match(page, /Dr\. \{doctor\.first_name\} \{doctor\.last_name\}/);
    assert.match(page, /formatSlotDate\(selectedSlot\.date\)\} at \{formatSlotTime\(selectedSlot\.start_time\)\} IST/);
    assert.match(page, /inrFormatter\.format\(doctor\.consultation_fee\)/);
    assert.match(page, /Pay in Stripe Test Mode/);
    assert.match(page, /held for up to 40 minutes/);
  });

  it("distinguishes cancelled Checkout returns from successful returns and verifies both server-side", () => {
    const returnHandler = page.match(/useEffect\(\(\) => \{([\s\S]*?query\.get\("checkout"\) === "cancelled"[\s\S]*?)\n  \}, \[checkPaymentStatus, doctorId, getToken, pathname, startTransition\]\);/)?.[1];
    assert.ok(returnHandler);
    assert.match(returnHandler, /query\.get\("checkout"\) === "cancelled"/);
    assert.match(returnHandler, /setCheckoutReturn\("cancelled"\)/);
    assert.match(returnHandler, /setCheckoutReturn\("cancelling"\)/);
    assert.match(returnHandler, /checking whether payment completed/i);
    assert.match(returnHandler, /cancelAppointmentPaymentOrder\(token, returnedPaymentId\)/);
    assert.match(returnHandler, /checkPaymentStatus\(returnedPaymentId\)/);
    assert.match(returnHandler, /setCheckoutReturn\("success"\)/);
    assert.match(returnHandler, /void checkPaymentStatus\(returnedPaymentId\)/);
    assert.match(page, /state=\{checkoutReturn\}/);
    assert.match(page, /statusAction=\{paymentPendingId \?/);
    assert.match(page, /setCheckoutReturn\("cancelled"\)/);
    assert.match(page, /status\.status === "failed" \|\| status\.status === "cancelled" \|\| status\.status === "expired"/);
    assert.match(page, /if \(status\.appointment\) \{/);
    assert.match(page, /setConfirmation\(status\.appointment\)/);
    assert.ok(page.indexOf("if (status.appointment)") < page.indexOf('status.status === "cancelled"'));
  });

  it("keeps an expired unpaid cancellation visible after the payment ID is cleared", () => {
    const markup = renderNotice({
      state: "cancelled",
      paymentPendingId: null,
      message: "Payment was not completed. Your appointment is not confirmed.",
      statusAction: React.createElement("button", null, "Check payment status"),
    });
    assert.match(markup, /Checkout cancelled/);
    assert.match(markup, /Payment was not completed/);
    assert.doesNotMatch(markup, /Check payment status/);
    assert.match(page, /setPaymentPendingId\(null\);\s*setCheckoutReturn\("cancelled"\)/);
  });

  it("renders the cancellation result independently of whether appointment slots are available", () => {
    const noticePosition = page.indexOf("<CheckoutReturnNotice");
    const slotsPosition = page.indexOf('aria-labelledby="available-times-title"');
    assert.ok(noticePosition >= 0 && noticePosition < slotsPosition);
    const noSlotsBranch = page.slice(page.indexOf("{slots.length === 0 ?"), page.indexOf("<form className=\"mt-5 space-y-5\""));
    assert.doesNotMatch(noSlotsBranch, /CheckoutReturnNotice/);
    assert.match(renderNotice({ state: "cancelled", paymentPendingId: null, message: "Payment was not completed." }), /Payment was not completed/);
  });

  it("does not offer a status check for terminal cancelled or expired payments", () => {
    for (const state of ["cancelled", "captured"]) {
      const markup = renderNotice({
        state,
        paymentPendingId: "payment-id",
        message: state === "captured" ? "Payment received; contact support." : "Payment was not completed.",
        statusAction: React.createElement("button", null, "Check payment status"),
      });
      assert.doesNotMatch(markup, /Check payment status/);
    }
  });

  it("shows the confirmed appointment instead of the cancel notice when a payment completed during return", () => {
    assert.match(page, /if \(status\.appointment\) \{[\s\S]*?setConfirmation\(status\.appointment\);[\s\S]*?setCheckoutReturn\(null\)/);
    assert.match(page, /confirmation \? \([\s\S]*?Appointment confirmed/);
    assert.doesNotMatch(renderNotice({ state: null, paymentPendingId: null, message: null }), /Checkout cancelled/);
    assert.match(renderNotice({ state: "captured", paymentPendingId: null, message: "Your payment was received, but the appointment could not be confirmed." }), /payment was received, but the appointment could not be confirmed/i);
    assert.doesNotMatch(renderNotice({ state: "captured", paymentPendingId: null, message: "Payment received." }), /Checkout cancelled/);
  });

  it("keeps an open or pending session unresolved rather than showing a completed cancellation", () => {
    const markup = renderNotice({
      state: "cancelling",
      paymentPendingId: "payment-id",
      message: "You returned from Checkout. Payment is still being verified. Your appointment is not confirmed yet.",
      statusAction: React.createElement("button", null, "Check payment status"),
    });
    assert.match(markup, /Checking payment status/);
    assert.match(markup, /Payment is still being verified/);
    assert.match(markup, /Check payment status/);
    assert.doesNotMatch(markup, /Checkout cancelled/);
  });
});
