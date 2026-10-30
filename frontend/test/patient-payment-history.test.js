import assert from "node:assert/strict";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const componentPath = path.join(projectRoot, "components", "payment-history-view.tsx");
const source = fs.readFileSync(componentPath, "utf8");
const paymentHistoryModule = new Module(componentPath);
paymentHistoryModule.filename = componentPath;
paymentHistoryModule.paths = Module._nodeModulePaths(path.dirname(componentPath));
paymentHistoryModule._compile(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText, componentPath);
const { PaymentHistoryView, paymentStatusLabel, refundStatusLabel } = paymentHistoryModule.exports;
const estimatePath = path.join(projectRoot, "components", "cancellation-refund-estimate.tsx");
const estimateSource = fs.readFileSync(estimatePath, "utf8");
const estimateModule = new Module(estimatePath);
estimateModule.filename = estimatePath;
estimateModule.paths = Module._nodeModulePaths(path.dirname(estimatePath));
estimateModule._compile(ts.transpileModule(estimateSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText, estimatePath);
const { CancellationRefundEstimate } = estimateModule.exports;

const payment = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  amount: "500.00",
  currency: "INR",
  status: "partially_refunded",
  date: "2026-10-25T08:00:00.000Z",
  receipt_url: null,
  appointment: {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    status: "cancelled",
    date: "2026-10-26",
    start_time: "10:00:00",
    end_time: "10:30:00",
    doctor: { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", first_name: "Dara", last_name: "Doctor", specialty: "General Practice" },
  },
  refunds: [
    { id: "11111111-1111-4111-8111-111111111111", amount: "250.00", currency: "INR", status: "processed", reason: "patient_cancellation", created_at: "2026-10-25T08:05:00.000Z", processed_at: "2026-10-25T08:06:00.000Z" },
    { id: "22222222-2222-4222-8222-222222222222", amount: "10.00", currency: "INR", status: "pending", reason: null, created_at: "2026-10-25T08:10:00.000Z", processed_at: null },
    { id: "33333333-3333-4333-8333-333333333333", amount: "5.00", currency: "INR", status: "failed", reason: null, created_at: "2026-10-25T08:15:00.000Z", processed_at: null },
  ],
};

function render(props) {
  return renderToStaticMarkup(React.createElement(PaymentHistoryView, props));
}

function renderEstimate(props) {
  return renderToStaticMarkup(React.createElement(CancellationRefundEstimate, props));
}

describe("patient payment history UI", () => {
  it("renders loading, error, and empty states", () => {
    assert.match(render({ payments: [], loading: true, error: null, onRetry() {} }), /Loading payment history/);
    assert.match(render({ payments: [], loading: false, error: "Connection failed", onRetry() {} }), /role="alert"/);
    assert.match(render({ payments: [], loading: false, error: null, onRetry() {} }), /No payments yet/);
  });

  it("shows readable payment and refund labels with only the completed refund total", () => {
    const markup = render({ payments: [payment], loading: false, error: null, onRetry() {} });
    assert.match(markup, /Partially refunded/);
    assert.match(markup, /Refund details/);
    assert.match(markup, /bg-status-completed-bg text-status-completed/);
    assert.match(markup, /bg-status-confirmed-bg text-status-confirmed/);
    assert.match(markup, /Refunded amount: ₹250\.00/);
    assert.match(markup, />Refunded</);
    assert.match(markup, />Pending</);
    assert.match(markup, />Failed</);
    assert.match(markup, /Dr\. Dara Doctor/);
    assert.doesNotMatch(markup, /View receipt/);
    assert.equal(paymentStatusLabel("refunded"), "Refunded");
    assert.equal(refundStatusLabel("pending"), "Pending");
    assert.equal(refundStatusLabel("failed"), "Failed");
  });

  it("uses the success treatment for a fully refunded payment and completed refund", () => {
    const markup = render({
      payments: [{ ...payment, status: "refunded", refunds: [payment.refunds[0]] }],
      loading: false,
      error: null,
      onRetry() {},
    });
    assert.equal((markup.match(/bg-status-confirmed-bg text-status-confirmed/g) || []).length, 2);
  });

  it("provides a receipt action only for the available Stripe receipt URL", () => {
    const receiptUrl = "https://pay.stripe.com/receipts/payment/test-receipt";
    const markup = render({ payments: [{ ...payment, receipt_url: receiptUrl }], loading: false, error: null, onRetry() {} });
    assert.match(markup, new RegExp(`href="${receiptUrl.replaceAll("/", "\\/")}"`));
    assert.match(markup, /View receipt/);
    assert.match(markup, /rel="noreferrer"/);
  });

  it("validates history API shape and receipt URL provenance in the client parser", () => {
    const api = fs.readFileSync(path.join(projectRoot, "lib", "profile-api.ts"), "utf8");
    assert.match(api, /getPatientPaymentHistory\(token: string\)/);
    assert.match(api, /"\/payments\/history"/);
    assert.match(api, /url\.hostname === "pay\.stripe\.com"/);
    assert.match(api, /status: z\.enum\(\["pending", "processed", "failed", "cancelled"\]\)/);
    assert.match(api, /getAppointmentCancellationRefundPreview\(token: string, appointmentId: string\)/);
    assert.match(api, /\/cancellation-preview/);
  });

  it("shows preview loading and error states without inventing an amount", () => {
    assert.match(renderEstimate({ preview: null, loading: true, error: null }), /Checking the current refund estimate/);
    const unavailable = renderEstimate({ preview: null, loading: false, error: "Preview failed" });
    assert.match(unavailable, /Refund estimate unavailable/);
    assert.match(unavailable, /You can still cancel/);
    assert.match(unavailable, /backend will calculate the actual refund/);
    assert.doesNotMatch(unavailable, /₹|0\.00|%/);
  });

  it("displays the backend estimate and explains no-refund outcomes", () => {
    const estimate = {
      original_payment: { amount: "500.00", currency: "INR", status: "captured" },
      refund_percentage: 50,
      estimated_refund_amount: "250.00",
      currency: "INR",
      refund_expected: true,
      explanation: "This is an estimate.",
    };
    const markup = renderEstimate({ preview: estimate, loading: false, error: null });
    assert.match(markup, /₹500\.00/);
    assert.match(markup, /50%/);
    assert.match(markup, /₹250\.00/);
    assert.match(markup, /recalculates the actual refund when you confirm cancellation/);
    const noRefund = renderEstimate({ preview: { ...estimate, refund_percentage: 0, estimated_refund_amount: "0.00", refund_expected: false, explanation: "No refund is expected under the policy." }, loading: false, error: null });
    assert.match(noRefund, /No refund is expected/);
    assert.match(noRefund, /₹0\.00/);
  });

  it("fetches the preview when the dialog opens and leaves cancellation available on preview failure", () => {
    const appointmentsPage = fs.readFileSync(path.join(projectRoot, "components", "patient-appointments-page.tsx"), "utf8");
    assert.match(appointmentsPage, /getAppointmentCancellationRefundPreview\(token, cancelTarget\.id\)/);
    assert.match(appointmentsPage, /<CancellationRefundEstimate preview=\{refundPreview\} loading=\{refundPreviewLoading\} error=\{refundPreviewError\}/);
    const cancelAction = appointmentsPage.match(/<AlertDialogAction[\s\S]*?<\/AlertDialogAction>/)?.[0];
    assert.ok(cancelAction);
    assert.match(cancelAction, /disabled=\{activeRequest\?\.startsWith\("cancel:"\)\}/);
    assert.doesNotMatch(cancelAction, /refundPreview/);
    assert.match(cancelAction, /if \(cancelTarget\) void cancel\(cancelTarget\)/);
  });
});
