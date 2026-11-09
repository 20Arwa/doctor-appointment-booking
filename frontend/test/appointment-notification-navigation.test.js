import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const directory = path.dirname(fileURLToPath(import.meta.url));
const homePage = fs.readFileSync(path.join(directory, "..", "app", "page.tsx"), "utf8");
const patientPage = fs.readFileSync(path.join(directory, "..", "components", "patient-appointments-page.tsx"), "utf8");
const doctorPage = fs.readFileSync(path.join(directory, "..", "components", "doctor-appointments-page.tsx"), "utf8");
const api = fs.readFileSync(path.join(directory, "..", "lib", "profile-api.ts"), "utf8");
const siteHeader = fs.readFileSync(path.join(directory, "..", "components", "site-header.tsx"), "utf8");
const bell = fs.readFileSync(path.join(directory, "..", "components", "notification-bell.tsx"), "utf8");
const notificationsPage = fs.readFileSync(path.join(directory, "..", "components", "in-app-notifications-page.tsx"), "utf8");
const notificationEvents = fs.readFileSync(path.join(directory, "..", "lib", "notifications.ts"), "utf8");
const bookingPage = fs.readFileSync(path.join(directory, "..", "components", "doctor-booking-page.tsx"), "utf8");
const patientAppointments = fs.readFileSync(path.join(directory, "..", "components", "patient-appointments-page.tsx"), "utf8");
const doctorAppointments = fs.readFileSync(path.join(directory, "..", "components", "doctor-appointments-page.tsx"), "utf8");

describe("appointment notification navigation", () => {
  it("loads the requested appointment through the authenticated detail API for both roles", () => {
    for (const page of [patientPage, doctorPage]) {
      assert.match(page, /useSearchParams\(\)/);
      assert.match(page, /searchParams\.get\("appointment"\)/);
      assert.match(page, /getAppointment\(token, appointmentFromNotification\)/);
      assert.match(page, /setAppointments\(\(current\) => current\.some/);
    }
    assert.match(api, /request<unknown>\(token, `\/appointments\/\$\{encodeURIComponent\(appointmentId\)\}`\)/);
  });

  it("scrolls to and highlights the requested card without rendering a notification message", () => {
    for (const page of [patientPage, doctorPage]) {
      assert.match(page, /getElementById\(`appointment-\$\{appointmentId\}`\)/);
      assert.match(page, /card\.scrollIntoView\(\{ block: "center" \}\)/);
      assert.match(page, /notificationFocusId/);
      assert.match(page, /border-primary/);
      assert.doesNotMatch(page, /notificationAppointmentError|notificationMessageTimer|Opened the appointment from your notification/);
    }
  });

  it("keeps a doctor deep-link target renderable when the appointment history request failed", () => {
    assert.match(doctorPage, /!loading && \(!error \|\| \(notificationFocusId !== null && appointments\.some/);
    assert.match(doctorPage, /<AppointmentGroup notificationFocusId=\{notificationFocusId\}/);
    assert.match(doctorPage, /id=\{`appointment-\$\{appointment\.id\}`\}/);
  });

  it("fetches once, waits for the card, and removes only the current appointment query from the browser URL", () => {
    for (const page of [patientPage, doctorPage]) {
      assert.match(page, /requestedNotificationAppointment\.current === appointmentFromNotification/);
      assert.match(page, /requestedNotificationAppointment\.current = appointmentFromNotification/);
      assert.match(page, /notificationRequestInFlight\.current = request/);
      assert.match(page, /pendingNotificationScroll\.current = appointment\.id/);
      assert.match(page, /new URL\(window\.location\.href\)/);
      assert.match(page, /currentUrl\.searchParams\.get\("appointment"\) !== appointmentId/);
      assert.match(page, /currentUrl\.searchParams\.delete\("appointment"\)/);
      assert.match(page, /router\.replace\(`\$\{currentUrl\.pathname\}\$\{currentUrl\.search\}\$\{currentUrl\.hash\}`/);
      assert.ok(page.indexOf("card.scrollIntoView") < page.indexOf('currentUrl.searchParams.delete("appointment")'));
    }
  });

  it("does not replay a completed notification navigation when appointment rows change", () => {
    assert.match(patientPage, /setAppointments\(\(current\) => \[\.\.\.current\.map/);
    assert.match(doctorPage, /setAppointments\(\(current\) => current\.map/);
    assert.match(patientPage, /requestedNotificationAppointment\.current === appointmentFromNotification/);
    assert.match(doctorPage, /requestedNotificationAppointment\.current === appointmentFromNotification/);
    for (const page of [patientPage, doctorPage]) {
      assert.match(page, /pendingNotificationScroll\.current = null;\s*setNotificationFocusId\(null\)/);
      assert.match(page, /function clearNotificationFocus\(\)/);
    }
    assert.match(patientPage, /clearNotificationFocus\(\);\s*requestLock\.current = true/);
    assert.match(doctorPage, /clearNotificationFocus\(\);\s*mutationLock\.current = true/);
  });

  it("renders the existing bell beside the profile menu for authenticated patient and doctor home states", () => {
    assert.match(homePage, /<SiteHeader \/>/);
    assert.match(siteHeader, /const \{ isLoaded, isSignedIn \} = useAuth\(\)/);
    assert.match(siteHeader, /isLoaded && isSignedIn && role !== "unknown" && <NotificationBell role=\{notificationRole\} \/>/);
    assert.match(siteHeader, /role === "patient" \|\| role === "doctor" \? role : null/);
    assert.match(siteHeader, /<NotificationBell role=\{notificationRole\} \/>[\s\S]*?<SiteAuthActions \/>/);
    assert.doesNotMatch(siteHeader, /NotificationBell[^\n]*role="patient"/);
  });

  it("dismisses the bell accessibly and refreshes while it remains closed", () => {
    assert.match(bell, /document\.addEventListener\("pointerdown"/);
    assert.match(bell, /event\.key === "Escape"/);
    assert.match(bell, /document\.removeEventListener\("pointerdown"/);
    assert.match(bell, /window\.addEventListener\("focus"/);
    assert.match(bell, /document\.addEventListener\("visibilitychange"/);
    assert.match(bell, /setInterval\(refresh, 15_000\)/);
    assert.match(bell, /window\.addEventListener\(IN_APP_NOTIFICATIONS_CHANGED_EVENT, refresh\)/);
    assert.match(bell, /inFlightLoad\.current/);
    assert.match(bell, /refreshQueued\.current/);
    assert.match(bell, /if \(!open\) void load\(\)/);
    assert.match(bell, /max-h-\[min\(28rem,calc\(100vh-5rem\)\)\].*overflow-y-auto/);
    assert.match(bell, /View all notifications/);
    assert.match(bell, /getInAppNotifications\(token, 5\)/);
  });

  it("loads notifications in five-item pages and offers Show More only while more exist", () => {
    assert.match(notificationsPage, /getInAppNotifications\(token, 5\)/);
    assert.match(notificationsPage, /getInAppNotifications\(token, 5, items\.length\)/);
    assert.match(notificationsPage, /items\.length < total/);
    assert.match(notificationsPage, /"Show More"/);
  });

  it("requests a same-session refresh after booking, cancellation, and either reschedule", () => {
    assert.match(notificationEvents, /IN_APP_NOTIFICATIONS_CHANGED_EVENT/);
    assert.match(bookingPage, /notifyInAppNotificationsChanged\(\)/);
    assert.match(patientAppointments, /notifyInAppNotificationsChanged\(\)/);
    assert.match(doctorAppointments, /notifyInAppNotificationsChanged\(\)/);
  });
});
