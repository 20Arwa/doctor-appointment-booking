const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { recognizeAppointmentHistory, recognizeCanonicalIntent } = require("../src/services/assistant/intentModel");
const { dateReferences, resolveDateReference } = require("../src/services/assistant/temporalInterpretation");

describe("canonical patient assistant intent model", () => {
  it("maps appointment-history tasks to distinct deterministic scopes", () => {
    const cases = [
      ["What is my next appointment?", { view: "upcoming", scope: "nearest" }],
      ["Show all my upcoming appointments", { view: "upcoming", scope: "all" }],
      ["Show my past visits", { view: "past", scope: "all" }],
      ["What was my last appointment?", { view: "past", scope: "last" }],
      ["What was my last completed appointment?", { view: "past", scope: "last_completed" }],
      ["List my cancelled appointments", { view: "cancelled", scope: "all" }],
    ];
    for (const [text, expected] of cases) assert.deepEqual(recognizeAppointmentHistory(text), expected);
  });

  it("distinguishes last-week date ranges from the last appointment", () => {
    const now = Date.parse("2027-01-13T12:00:00+05:30");
    assert.deepEqual(recognizeAppointmentHistory("Show my appointments from last week", "Asia/Kolkata", now), {
      view: "past", scope: "all", from: "2027-01-04", to: "2027-01-10",
    });
    assert.deepEqual(recognizeAppointmentHistory("What was my last appointment?", "Asia/Kolkata", now), { view: "past", scope: "last" });
  });

  it("classifies action and reference types while keeping source and target time counts distinct", () => {
    assert.deepEqual(recognizeCanonicalIntent("Move this appointment from 9 AM to 11 AM"), {
      category: "rescheduling", historyScope: null, historyQuery: null, reference: "demonstrative", timePrecision: "exact", timeInterpretation: "explicit", sourceTimeCount: 1, targetTimeCount: 1,
    });
    assert.equal(recognizeCanonicalIntent("Book around 11:30 AM").timePrecision, "approximate");
    assert.equal(recognizeCanonicalIntent("Book at 11:30").timeInterpretation, "ambiguous");
    assert.equal(recognizeCanonicalIntent("him").reference, "pronoun");
    assert.equal(recognizeCanonicalIntent("2").reference, "numeric");
    assert.equal(recognizeCanonicalIntent("Can I get my money back?").category, "refund_preview");
  });

  it("classifies payment history separately from appointment specific refund previews", () => {
    assert.equal(recognizeCanonicalIntent("Show my payment history").category, "payment_history");
    assert.equal(recognizeCanonicalIntent("List my payment and refund records").category, "payment_history");
    assert.equal(recognizeCanonicalIntent("What refund applies to my appointment?").category, "refund_preview");
  });

  it("uses deterministic precedence for mixed intents and carries history filters with the canonical route", () => {
    const cases = [
      ["Can you cancel my previous appointment and tell me the refund?", "refund_preview", { view: "past", scope: "last" }],
      ["Cancel my appointment from last week", "cancellation", { view: "past", scope: "all", from: "2027-01-04", to: "2027-01-10" }],
      ["Show my appointments from last week", "appointment_history", { view: "past", scope: "all", from: "2027-01-04", to: "2027-01-10" }],
      ["Reschedule my last appointment", "rescheduling", { view: "past", scope: "last" }],
      ["List my cancelled appointments", "appointment_history", { view: "cancelled", scope: "all" }],
      ["Book a slot and reschedule my appointment", "rescheduling", null],
    ];
    const now = Date.parse("2027-01-13T12:00:00+05:30");
    for (const [text, category, historyQuery] of cases) {
      const intent = recognizeCanonicalIntent(text, "Asia/Kolkata", now);
      assert.equal(intent.category, category, text);
      assert.deepEqual(intent.historyQuery, historyQuery, text);
    }
  });

  it("resolves relative calendar dates in the requested application timezone", () => {
    const now = Date.parse("2026-11-15T18:30:00.000Z"); // 2026-11-16 in Asia/Kolkata
    const [tomorrow] = dateReferences("tomorrow");
    assert.equal(resolveDateReference(tomorrow, "Asia/Kolkata", now), "2026-11-17");
  });

  it("routes date specific appointment wording consistently and resolves yearless dates to the next occurrence", () => {
    const now = Date.parse("2026-11-17T04:00:00.000Z");
    for (const text of ["Show me all my appointments for today", "List every appointment on today", "What appointments do I have today?"]) {
      assert.deepEqual(recognizeCanonicalIntent(text, "Asia/Kolkata", now).historyQuery, {
        view: "date", scope: "all", from: "2026-11-17", to: "2026-11-17",
      });
    }
    assert.deepEqual(recognizeCanonicalIntent("Show all appointments for 15th December", "Asia/Kolkata", now).historyQuery, {
      view: "date", scope: "all", from: "2026-12-15", to: "2026-12-15",
    });
    assert.deepEqual(recognizeCanonicalIntent("Show appointments for December 15, 2024", "Asia/Kolkata", now).historyQuery, {
      view: "date", scope: "all", from: "2024-12-15", to: "2024-12-15",
    });
  });
});
