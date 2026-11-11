import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("assisted rescheduling patient navigation", () => {
  it("loads requests from the retained appointment target independently of URL cleanup", () => {
    const source = fs.readFileSync(path.join(root, "components/patient-appointments-page.tsx"), "utf8");
    const requestEffect = source.match(/useEffect\(\(\) => \{\s*if \(!assistedTargetAppointmentId\) return;[\s\S]*?\}, \[assistedTargetAppointmentId,[^\]]*assistedReload\]\);/);
    assert.ok(requestEffect, "request lookup must be keyed by the retained target and retry counter");
    assert.match(requestEffect[0], /getPatientAssistedRequest\(token, assistedTargetAppointmentId\)/);
    const notificationEffect = source.match(/requestedNotificationAppointment\.current = appointmentFromNotification;[\s\S]*?\}, \[appointmentFromNotification, getToken, loading, setAppointments\]\);/);
    assert.ok(notificationEffect, "URL focus effect must not depend on assisted request retries or retained target changes");
  });

  it("scrolls deep links to loaded pending suggestions and preserves appointment fallback scrolling", () => {
    const source = fs.readFileSync(path.join(root, "components/patient-appointments-page.tsx"), "utf8");
    const scrollEffect = source.match(/useEffect\(\(\) => \{\s*const appointmentId = pendingNotificationScroll\.current;[\s\S]*?\}, \[appointments, assistedTargetAppointmentId,[^\]]*\]\);/);
    assert.ok(scrollEffect, "deep-link scrolling should wait in its dedicated effect");
    assert.match(scrollEffect[0], /assistedTargetAppointmentId === appointmentId && assistedLoading/);
    assert.match(scrollEffect[0], /assistedRequest\.status === "pending_patient"/);
    assert.match(scrollEffect[0], /assistedRequest\.suggestions\.length > 0/);
    assert.match(scrollEffect[0], /assistedSectionRef\.current/);
    assert.match(scrollEffect[0], /header\.sticky/);
    assert.match(scrollEffect[0], /sectionTop - headerOffset - 16/);
    assert.match(scrollEffect[0], /card\.scrollIntoView\(\{ block: "center" \}\)/);
    assert.match(scrollEffect[0], /searchParams\.delete\("appointment"\)/);
  });

  it("refreshes and closes the original appointment's Assisted request after regular rescheduling", () => {
    const source = fs.readFileSync(path.join(root, "components/patient-appointments-page.tsx"), "utf8");
    const handler = source.match(/async function confirmReschedule\(appointment: PatientAppointment\) \{[\s\S]*?\n  async function confirmAssistedReschedule/);
    assert.ok(handler, "regular reschedule handler should be present");
    assert.match(handler[0], /assistedTargetAppointmentId === appointment\.id \|\| assistedRequest\?\.appointment_id === appointment\.id/);
    assert.match(handler[0], /status: "superseded"/);
    assert.match(handler[0], /setAssistedSlots\(\[\]\)/);
    assert.match(handler[0], /setAssistedReload\(\(value\) => value \+ 1\)/);
    assert.match(source, /assistedRequest\.status === "superseded" \? "This request was superseded because the appointment was rescheduled\./);
  });

  it("only keeps saved suggestions whose complete identity and current capacity still match", () => {
    const source = fs.readFileSync(path.join(root, "components/patient-appointments-page.tsx"), "utf8");
    for (const condition of ["suggestion.availability_id === slot.id", "suggestion.mode === slot.mode", "suggestion.date === slot.date",
      "suggestion.start_time.slice(0, 8) === slot.start_time.slice(0, 8)", "suggestion.end_time.slice(0, 8) === slot.end_time.slice(0, 8)",
      "(slot.remaining_capacity ?? 0) > 0", "!slot.reservation_only"]) assert.ok(source.includes(condition), `missing live suggestion check: ${condition}`);
    assert.match(source, /appointment_status !== "confirmed"/);
    assert.match(source, /status === "expired"/);
  });

  it("revalidates patient suggestions without the doctor-only appointment exclusion", () => {
    const source = fs.readFileSync(path.join(root, "components/patient-appointments-page.tsx"), "utf8");
    assert.ok(source.includes("getDoctorSlots(token, assistedTargetAppointment.doctor_id, dates[0], dates[dates.length - 1])"));
    assert.ok(source.includes("getDoctorSlots(token, appointment.doctor_id, dates[0], dates[dates.length - 1])"));
    assert.equal((source.match(/getDoctorSlots\(token, (?:assistedTargetAppointment|appointment)\.doctor_id, dates\[0\], dates\[dates\.length - 1\],/g) || []).length, 0);
    assert.match(source, /assistedError \? null : assistedSlots\.length \?/);
    assert.match(source, /setAssistedSlots\(live\.filter\([\s\S]*?setAssistedError\(null\);/);
    assert.match(source, /setAssistedError\(availabilityError instanceof Error \? availabilityError\.message/);
  });

  it("maps expiration, decline, and other request conflicts to distinct patient states", () => {
    const source = fs.readFileSync(path.join(root, "components/patient-appointments-page.tsx"), "utf8");
    assert.match(source, /cause\.code === "ASSISTED_RESCHEDULE_REQUEST_EXPIRED"/);
    assert.match(source, /cause\.code === "ASSISTED_RESCHEDULE_REQUEST_DECLINED"/);
    assert.match(source, /cause\.code === "ASSISTED_RESCHEDULE_REQUEST_SUPERSEDED"/);
    assert.match(source, /cause\.code === "ASSISTED_RESCHEDULE_REQUEST_CONFLICT"/);
    assert.match(source, /The request changed while confirmation was processing/);
    assert.match(source, /You already declined this assisted rescheduling request/);
  });

  it("validates the confirmation response against the selected suggestion before showing success", () => {
    const source = fs.readFileSync(path.join(root, "components/patient-appointments-page.tsx"), "utf8");
    const handler = source.match(/async function confirmAssistedReschedule\([\s\S]*?\n  async function declineAssistedReschedule/);
    assert.ok(handler, "confirmation handler should be present");
    for (const condition of ["updated.availability_id === selectedSuggestion.availability_id", "updated.mode === selectedSuggestion.mode",
      "updated.date === selectedSuggestion.date", "updated.start_time.slice(0, 8) === selectedSuggestion.start_time.slice(0, 8)",
      "updated.end_time.slice(0, 8) === selectedSuggestion.end_time.slice(0, 8)"]) {
      assert.ok(handler[0].includes(condition), `missing response match check: ${condition}`);
    }
    assert.ok(handler[0].indexOf("if (!matchesSuggestion)") < handler[0].indexOf("notifySuccess("));
    assert.match(source, /throw new AssistedRescheduleResponseMismatchError\(\)/);
    assert.match(source, /const responseMismatch = cause instanceof AssistedRescheduleResponseMismatchError/);
    assert.match(source, /const acceptedStateConflict = cause instanceof ProfileApiError && cause\.code === "ASSISTED_RESCHEDULE_ACCEPTED_STATE_CONFLICT"/);
    assert.doesNotMatch(handler[0], /new ProfileApiError\(409,[\s\S]*ASSISTED_RESCHEDULE_ACCEPTED_STATE_CONFLICT/);
    assert.match(source, /request is marked accepted, but the appointment does not match the selected time/);
  });
});
