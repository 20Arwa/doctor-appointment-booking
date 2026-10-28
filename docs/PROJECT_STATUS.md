# Medrella Project Handoff

Last inspected: 2026-10-28. This document describes the checked-out source and working tree, not a deployed environment. “Verified now” means a command or source inspection was performed during this inspection. Past database claims are retained as earlier reports and are not represented as live checks performed now.

## A. Project Overview

Medrella is a doctor–patient appointment booking application with an independently run Next.js frontend and Express API. Planned user journeys are: public landing page; Clerk sign-in/sign-up; first-time Patient or Doctor onboarding; role-based dashboards; doctor availability management; patient doctor discovery and appointment booking; appointment management by its authorized participants.

The repository currently contains a public homepage, Clerk entry points and onboarding, patient and doctor dashboards, patient doctor discovery/booking/appointment management, doctor appointment management, and doctor availability management. Profile editing remains a placeholder. The backend provides profile, availability, and appointment APIs.

| Layer | Current stack |
|---|---|
| Frontend | Next.js 16.4.3 App Router, React/React DOM 19.3.0, TypeScript 5, Tailwind CSS 4 (lockfile 4.3.3) |
| Frontend libraries | `@clerk/nextjs` 7.9.22, Zod 4.6.7, lucide-react 1.62.0 |
| Backend | Node.js, Express 5.1, JavaScript, PostgreSQL via `pg` 8.23, `@clerk/express` 2.1, Zod 4.6 |
| Package manager | npm; separate frontend and backend lockfiles, plus root orchestration scripts |

## B. Project Instructions and Architecture

The root [`AGENTS.md`](../AGENTS.md) is the active project instruction file. Key constraints:

- Implement only the phase requested; inspect and reuse existing architecture; preserve user changes.
- Frontend application code is TypeScript; backend application code remains JavaScript. Do not add backend TypeScript or another ORM, UI library, auth provider, icon library, or validator without approval.
- Reuse the semantic tokens in `frontend/app/globals.css`; prefer accessible semantic HTML, keyboard access, visible focus, responsive layouts, and lucide-react icons.
- Clerk is the identity provider. Verify identity server-side, derive user ownership from it, validate requests with Zod, use parameterized database access and transactions where required, and preserve appointment history.
- APIs use `/api/v1`. Database changes require migrations. Do not claim migrations, external configuration, or deployments succeeded without evidence.
- Confirmed privacy policy: a patient can access only their own patient profile; there is no admin role or general patient listing access for doctors/other patients.

No `backend/AGENTS.md` exists. `frontend/AGENTS.md` is currently deleted in the worktree; its contents are not available in this checkout. Do not restore it without instruction.

### Structure and entry points

- `frontend/app/`: App Router pages and root layout; `globals.css` contains mauve/pink semantic colors, light and `.dark` token values, status/sidebar colors, radius, and Tailwind v4 `@theme inline` mappings. No shadcn/ui component setup or `components.json` is present.
- `frontend/components/`: public site header, Clerk continuation screen, and onboarding flow.
- `frontend/lib/`: typed profile API client and Zod onboarding form schemas.
- `frontend/proxy.ts`: current Next.js 16 Clerk middleware integration. It protects the patient and doctor route trees with Clerk; role ownership is then checked against `GET /api/v1/users/me` by the shared app shell.
- `backend/src/app.js`: Express app, global Clerk middleware, CORS, JSON parsing, and `/api/v1` route mounts.
- `backend/src/routes/`, `controllers/`, `services/`, `validators/`, `middleware/`, `config/`, `utils/`: HTTP routing, request handling, appointment business rules, Zod schemas, authentication/errors, configuration/database pool, and Asia/Kolkata scheduling helpers.
- `backend/migrations/`: ordered SQL migrations. `backend/src/migrate.js` records completed filenames in `schema_migrations` and applies each missing migration transactionally.
- `backend/test/`: Node built-in test runner suites for profiles/authz, availability, appointments, and health/errors.

The root README still calls the project “Schedule Project.” Its ERD link targets `docs/schedule-project-erd.png`, which is not present in the current checkout. This handoff uses the agreed product name, Medrella.

## C. Product Decisions

- All visible product UI is English; product name is Medrella.
- Clerk handles authentication. PostgreSQL is hosted on Neon; the repository uses `pg` directly.
- Roles are `patient` and `doctor` only. Initial onboarding selects one; doctor onboarding requires specialty. No admin role or privileges exist. Role is not accepted by profile update schemas.
- New authenticated users complete local profile onboarding; existing local profiles skip role selection and route to the dashboard for their saved role. Phase 4 dashboard shells are implemented.
- Doctor availability consists of individually entered, dated start/end-time slots. Recurring schedules and automatic slot generation are out of scope.
- Appointment booking, patient cancellation/rescheduling, and doctor completion exist in the backend. Queue/check-in management, admin, clinic management, billing, medical records, and unrelated hospital workflows are out of scope.
- Application scheduling timezone is `Asia/Kolkata`. `backend/.env.example` sets it; runtime validation permits it to be omitted, but timezone-dependent availability/booking behavior then returns a configuration error.
- Patient records remain scoped to the patient’s own identity. No admin access policy has been approved.
- Preserve the established mauve/pink tokens and light/dark variable sets in `globals.css`; do not replace the palette.
- Appointment cancellation/rescheduling cutoff and queue check-in window remain blank/unconfirmed in `AGENTS.md`. Current backend permits a patient to cancel or reschedule any confirmed appointment; no cutoff policy is enforced.

## D. Phase-by-Phase Progress

Status labels distinguish source implementation from real-service verification.

| Phase | Status | Implemented and evidence | Remaining gaps |
|---|---|---|---|
| Backend foundation: profiles/onboarding | **Implemented but not fully verified** | User/patient/doctor tables and routes; Clerk identity mapping; transactional initial profile creation; user/profile updates; server validation and ownership tests. Main files: `backend/migrations/001_users_patients_doctors.sql`, `backend/src/routes/{user,patient,doctor}Routes.js`, matching controllers, `backend/src/middleware/auth.js`, `backend/src/validators/profileSchemas.js`. | No live Neon schema/status query was performed now. Clerk/API-to-live-database flow was not exercised. Earlier migration application report is retained below. |
| Backend dated availability | **Implemented but not fully verified** | Public future-slot lookup with date filters; doctor-owned batch creation, future/time/overlap validation and transaction locks; deletion restricted by ownership/history. Files: migration 002, `backend/src/controllers/availabilityController.js`, `backend/src/validators/availabilitySchemas.js`, `backend/src/utils/schedulingTime.js`. | No live database or deployed API test. Requires configured `APPLICATION_TIMEZONE`. |
| Backend appointment workflows | **Implemented but not fully verified** | Booking, own-appointment lists/details, patient cancel/reschedule, associated-doctor completion; transaction and ownership logic. Files: migrations 003–004, `backend/src/services/appointmentService.js`, appointment routes/controller/validators. | Tests use test fixtures/fakes; no live PostgreSQL concurrency or end-to-end service test. Cancellation/rescheduling cutoff remains undecided and unenforced. |
| Public homepage and Clerk entry | **Implemented but not fully verified** | Responsive public homepage, Clerk provider, sign-in/sign-up routes, token-aware header, Next 16 `proxy.ts`; sign-in/sign-up direct users to `/auth/continue`. Files: `frontend/app/page.tsx`, `frontend/app/layout.tsx`, `frontend/app/sign-in/`, `frontend/app/sign-up/`, `frontend/components/site-header.tsx`, `frontend/proxy.ts`. | Build/lint/type checks pass. No valid Clerk credentials or live auth flow verified. No shadcn setup exists; homepage currently uses Tailwind composition. |
| Frontend Phase 3: onboarding/profile creation | **Implemented but not fully verified** | `/auth/continue` checks `GET /users/me`; exact `404 PROFILE_NOT_FOUND` enters `/onboarding`; other failures are recoverable. Patient/Doctor selection, validated forms, create profile and optional profile updates use existing API. Files: `frontend/app/auth/continue/page.tsx`, `frontend/app/onboarding/page.tsx`, `frontend/components/{auth-continuation,onboarding-flow}.tsx`, `frontend/lib/{profile-api,onboarding-schemas}.ts`, and redirects in Clerk pages. | Frontend checks pass, but no live Clerk, backend, CORS, or Neon end-to-end test. Multi-request optional saves are recoverable, not transactional. A 200 response from backend with `profile: null` is treated by the client as an incomplete-response error (not as missing profile). |
| Phase 4: role dashboards/navigation | **Implemented but not fully verified** | Shared responsive authenticated shell; patient/doctor navigation and introductory dashboards; role-specific placeholders; Clerk auth protection for role route trees; backend profile lookup verifies the saved role and redirects wrong-role access; sign-in and onboarding route to the matching dashboard. Files: `frontend/proxy.ts`, `frontend/components/{protected-role-layout,role-application-shell,app-shell-loading,dashboard-pages,section-placeholder}.tsx`, `frontend/lib/roles.ts`, and `frontend/app/{patient,doctor}/`. | Later-phase booking, appointment management, and availability UI were placeholders at the Phase 4 checkpoint and are implemented in Phases 5–9 below. Profile editing remains a placeholder. Live Clerk/Neon role-routing and browser/device layout checks have not been performed. |
| Phase 5: patient dashboard and doctor directory | **Implemented but not fully verified** | Patient dashboard displays saved full name, Book Appointment link, and the next future confirmed appointment from the caller-owned appointment list in Asia/Kolkata. Doctor directory loads the existing doctor list and searches name/specialty client-side. Files: `frontend/components/{dashboard-pages,patient-dashboard-content,doctor-directory}.tsx`, `frontend/lib/profile-api.ts`, `frontend/app/patient/book-appointment/page.tsx`. | Requested frontend checks passed. No live Clerk/backend/Neon request or browser test was performed. Booking and doctor details remain out of scope. |

### Migration and test history

- Existing backend progress notes explicitly reported migrations 001, 002, 003, and 004 as “applied and verified” on Neon, with migration 004 removing `rescheduled_from_appointment_id`. Preserve that as a **previously reported** fact; it was not independently checked against Neon during this handoff.
- Those notes also reported 34 backend tests, JavaScript syntax checks, and `git diff --check` passing in earlier work. Do not confuse those historical reports with live database verification.
- **Verification performed now:** backend `npm test` passed 34 tests (9 suites). Its first sandboxed attempt failed before running tests with `spawn EPERM`; the approved rerun succeeded. Frontend `npm run lint`, `npx tsc --noEmit`, and `npm run build` all passed. Build emitted a non-fatal Turbopack notice that it ignored a parent `C:\Users\lap12\package-lock.json` outside the repository. No migration was run and no live Neon state was queried.

## E. API and Data Model Reference

All application endpoints are mounted under `/api/v1`. `backend/src/app.js` applies Clerk middleware globally. `requireClerkIdentity` requires a verified Clerk user ID; `requireLocalUser` resolves the database user from that identity and rejects missing/inactive accounts. Public doctor/availability reads do not call these guards; write and personal-data routes do.

Errors generally use `{ error: { code, message } }`; Zod boundary failures use HTTP 400 and include `details: [{ path, message }]`. The generic error handler hides internal failures.

| Method and path | Access | Request and behavior |
|---|---|---|
| `GET /api/v1/health` | Public | Runs `SELECT 1`; returns 200 `{status:"ok",database:"connected"}` or 503 unavailable. |
| `GET /api/v1/users/me` | Clerk identity + active local user | Returns user fields and role-specific `profile`; absent local user is 404 `PROFILE_NOT_FOUND`. `profile` can be `null` if its associated row is absent. |
| `POST /api/v1/users/me` | Clerk identity; no local profile required | Strict body `{role, first_name?, last_name?, specialty?}`. Role is patient/doctor; doctor requires specialty. Email and phone come from Clerk. Creates user plus patient/doctor row transactionally; 201 with user and profile. Duplicate local identity yields 409; Clerk names are fallback if body names omitted. |
| `PATCH /api/v1/users/me` | Clerk identity + active local user | Strict body with one or more of `first_name`, `last_name`, `phone`. Role and identity fields are not accepted. Returns updated user. |
| `GET /api/v1/patients` | Clerk identity + active patient | Returns only the current patient’s own profile in an array. Other roles receive 403. |
| `GET /api/v1/patients/:id` | Clerk identity + active patient | Returns only the authenticated patient’s own profile; another/missing ID returns 404. |
| `PUT /api/v1/patients/:id` | Clerk identity + active patient | Body accepts `date_of_birth` (ISO date or null) and/or `gender` (string up to 40 chars or null); at least one field. Ownership is enforced. |
| `GET /api/v1/doctors` | Public | Lists active doctors with ID, name, specialty, bio, timestamps. No server-side search parameter. |
| `GET /api/v1/doctors/:id` | Public | Returns active doctor details or 404. |
| `PUT /api/v1/doctors/:id` | Clerk identity + active doctor | Owner only. Body accepts one or both of `specialty` (required nonblank if provided, max 150) and `bio` (nullable, max 5000); at least one field. |
| `GET /api/v1/doctors/:id/slots?from=&to=` | Public | Lists future, unbooked slots; optional ISO date range. Requires timezone configuration; `TIMEZONE_NOT_CONFIGURED` is 503. |
| `POST /api/v1/doctors/:id/slots` | Clerk identity + active owning doctor | Body `{slots:[{date,start_time,end_time}]}`; 1–100 slots, ISO date and `HH:mm`, future, end after start, no duplicates/overlap. Transactional; overlap/duplicate conflict is 409. Returns created array with 201. |
| `DELETE /api/v1/doctors/:id/slots/:slotId` | Clerk identity + active owning doctor | Deletes own unreferenced slot; returns 204. Referenced slot conflicts with 409; missing slot is 404. |
| `GET /api/v1/appointments?status=&from=&to=` | Clerk identity + active local user | Lists caller-owned appointments (patient or associated doctor); filters status `confirmed`, `cancelled`, `completed` and date range. |
| `POST /api/v1/appointments` | Clerk identity + active patient | Body `{availability_id, reason?}`; reason nullable, max 2000. Creates a confirmed future-slot booking transactionally; slot unavailable is 409. Returns appointment details with 201. |
| `GET /api/v1/appointments/:id` | Clerk identity + active local user | Returns details only to the associated patient or doctor; otherwise 404. |
| `PUT /api/v1/appointments/:id/cancel` | Clerk identity + active owning patient | Cancels a confirmed appointment; no cutoff rule. Returns updated details; invalid state is 409. |
| `PUT /api/v1/appointments/:id/reschedule` | Clerk identity + active owning patient | Body `{availability_id}`. Transactionally cancels original and creates a confirmed replacement preserving reason; no cutoff rule. Returns replacement details. |
| `PUT /api/v1/appointments/:id/complete` | Clerk identity + active associated doctor | Completes a confirmed appointment; patient and unrelated doctor are denied/not found. |

Appointment detail responses contain appointment ID/status/reason/cancelled and audit timestamps, availability ID/date/start/end, doctor ID/name/specialty, and patient ID/name. Appointment statuses in the schema are `confirmed`, `cancelled`, `completed`; rescheduling is represented by a cancelled original plus a new confirmed row, not a `rescheduled` status.

### Current schema

- `users`: UUID, unique Clerk user ID, names, email, optional phone, role check (`patient`/`doctor`), active flag and timestamps; lowercased email unique index.
- `patients`: one-to-one user FK, optional birth date/gender and timestamps.
- `doctors`: one-to-one user FK, required specialty, optional bio and timestamps.
- `availability`: doctor FK, date, start/end times, end-after-start check and unique doctor/date/start index.
- `appointments`: patient and availability FKs, status check, reason, cancellation timestamp and audit timestamps; partial unique index permits only one non-cancelled appointment per slot. Foreign keys use restrictive deletion to retain history.
- Migration 004 drops `rescheduled_from_appointment_id`; it does not add a separate reschedule relationship.

Migration files present: `001_users_patients_doctors.sql`, `002_doctor_availability.sql`, `003_appointments.sql`, `004_remove_rescheduled_from_appointment_id.sql`. Their live applied state is not currently verified.

## F. Authentication and Onboarding Flow

1. Clerk components at `/sign-in` and `/sign-up` force successful sign-in/sign-up to `/auth/continue`.
2. `ClerkProvider` wraps the frontend. The client continuation component waits for Clerk, obtains a session token with `useAuth().getToken()`, and sends `Authorization: Bearer <token>` via `frontend/lib/profile-api.ts` to `GET {NEXT_PUBLIC_API_URL}/api/v1/users/me`.
3. A valid local user/profile routes to the dashboard for its saved role. Only HTTP 404 with code `PROFILE_NOT_FOUND` enters `/onboarding`. Other 401/network/server/malformed-response cases show retry/sign-in recovery; they are not treated as absent profiles.
4. `/onboarding` repeats the profile check to prevent direct navigation from presenting role selection to an already-onboarded user. It asks for Patient or Doctor, then required first/last name and required Doctor specialty. Email is displayed read-only from Clerk when available. Phone, Patient date of birth/gender, and Doctor bio are optional.
5. Creation sends role/name/specialty to `POST /users/me`; phone uses `PATCH /users/me`; Patient optional details use `PUT /patients/:id`; Doctor bio uses `PUT /doctors/:id`. The profile ID comes from the backend response, not user-entered input. Client Zod validation supplements server validation.
6. If profile creation may have committed but its response failed, the client rechecks `GET /users/me` before another create attempt. After a successful create, optional detail failures can be retried without another POST. These separate backend writes are not one transaction.
7. Successful onboarding routes to the dashboard for the saved role and provides a dashboard link in its completion state.

The Next.js Clerk proxy protects `/patient/*` and `/doctor/*`; server layouts also require an authenticated Clerk session. The shared client shell checks the backend profile role before rendering role content. Backend personal and mutation routes enforce Clerk identity, active local user, role, and ownership. Public homepage, sign-in, and sign-up stay accessible.

Unverified integration: valid Clerk credentials, browser session token acceptance by the configured Express Clerk instance, backend URL/CORS, and live PostgreSQL/Neon operations have not been tested end-to-end.

## G. Environment Setup

Names only; never put values/secrets in this document.

| Variable | Side | Purpose / requirement |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Frontend | Express origin used by the API client; example defaults to local port 3001. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Frontend | Clerk public browser key; required for real Clerk flows. |
| `CLERK_SECRET_KEY` | Frontend and backend configuration | Clerk server key; backend requires it. Never expose a value to browser code. Frontend `.env.example` includes the name for server-side Clerk setup. |
| `DATABASE_URL` | Backend | PostgreSQL/Neon connection URL; required. |
| `FRONTEND_ORIGIN` | Backend | CORS allowed origin; defaults in code to local frontend origin. |
| `PORT` | Backend | Express port; defaults to 3001. |
| `NODE_ENV` | Backend | Development/test/production mode; defaults to development. |
| `APPLICATION_TIMEZONE` | Backend | IANA timezone used for slot and booking rules; `.env.example` sets Asia/Kolkata, but runtime permits omission. |

The frontend example contains `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, and `CLERK_SECRET_KEY`. The backend example contains `DATABASE_URL`, `CLERK_SECRET_KEY`, and `APPLICATION_TIMEZONE`. Copy examples to local env files and use real credentials only in ignored local configuration. Do not read, copy, or commit real `.env` files.

### Available commands

From repository root:

```bash
npm run dev:frontend
npm run dev:backend
npm run start:frontend
npm run start:backend
```

From `frontend/`: `npm install`, `npm run dev`, `npm run lint`, `npx tsc --noEmit`, `npm run build`, `npm run start`. No frontend test script/framework exists.

From `backend/`: `npm install`, `npm run dev`, `npm start`, `npm test`, `npm run migrate`. Backend has no lint script; do not add a TypeScript build/check. `npm run migrate` changes a database and must only be used when explicitly intended and correctly configured.

**Commands run during this handoff:** frontend `npm run lint` (pass), `npx tsc --noEmit` (pass), `npm run build` (pass; non-fatal parent-lockfile Turbopack notice); backend `npm test` (34 pass). No install, migration, deployment, or live service call was performed.

## H. Git and Outstanding Work

- Current branch: `feat/appointment-booking`.
- Nothing was staged, committed, reset, or pushed. No app/backend/migration/env/package files were changed for this handoff; only this document was updated.
- Before Phase 4, the worktree had modified `frontend/.env.example`, `frontend/app/globals.css`, `frontend/app/layout.tsx`, `frontend/app/page.tsx`, `frontend/package.json`, `frontend/package-lock.json`; deleted `frontend/AGENTS.md`; and untracked `docs/`, frontend auth/onboarding/sign-in/sign-up routes, components, lib files, and `frontend/proxy.ts`. Phase 4 adds uncommitted role layouts/routes and shared dashboard components. These changes remain uncommitted; authorship/ownership is not inferred here.
- No live Neon migration status, Clerk credentials/configuration, deployed backend, or end-to-end frontend/API/DB flow was verified.
- Phase 4 verification performed now: frontend `npm run lint`, `npx tsc --noEmit`, and `npm run build` passed. Build reported the existing non-fatal Turbopack notice about a parent lockfile. No browser interaction, actual Clerk session, or role API request against Neon was exercised.
- The backend test suite passed now after an initial sandbox `spawn EPERM`; the successful approved rerun used the same `npm test` script. Tests do not establish that migrations were applied to Neon.
- The root README still uses “Schedule Project” branding; timezone-related business actions fail with a clear configuration error if `APPLICATION_TIMEZONE` is unset; appointment cancellation/rescheduling policy remains undecided.
- Do not overwrite or revert the existing `globals.css` change, deleted frontend instructions, onboarding/homepage work, or any other user changes.

## I. Phase 4 Implementation State and Follow-up

Phase 4 is implemented. The shared shell shows a desktop sidebar and mobile disclosure navigation, with role-specific menu order and active links. Patient and Doctor dashboard pages show the authenticated profile name and phase-appropriate links. Destinations without functionality are explicit placeholders. Sign-in continuation, returning onboarding visits, and successful onboarding now route by the backend profile's saved role. Clerk `proxy.ts` protects `/patient/*` and `/doctor/*`; server layouts also verify the Clerk session, and the shared client layout loads the backend profile before rendering role content. Wrong-role requests go to the dashboard matching that backend profile.

Routes implemented:

- Patient: `/patient/dashboard` (saved name and next upcoming appointment), `/patient/book-appointment` (doctor directory), `/patient/doctors/[id]` (details and booking), `/patient/appointments` (history, cancel, reschedule), `/patient/profile` (placeholder).
- Doctor: `/doctor/dashboard`, `/doctor/appointments` (scheduled/past appointments and completion), `/doctor/availability` (future unbooked slots), `/doctor/profile` (placeholder).

Backend authorization remains authoritative for data operations. Do not add queue, admin, clinic, billing, medical-record, or unrelated features. Valid Clerk configuration and live backend/Neon checks remain prerequisites for end-to-end verification.

## J. Phase 5 Implementation State and Follow-up

Phase 5 is implemented. The patient dashboard displays the saved full name and fetches `GET /api/v1/appointments`; it shows the nearest future `confirmed` appointment, an empty state, or a retryable error. Appointment date/time strings are interpreted and displayed in `Asia/Kolkata`. The doctor directory fetches `GET /api/v1/doctors`, displays name, specialty, and non-empty bio, and filters locally by trimmed, case-insensitive name or specialty. Loading, request error, empty directory, and no search matches have distinct states.

Next phase: implement patient appointment booking using the doctor directory and existing dated availability API. Booking and doctor detail interactions were not added in Phase 5.

## K. Phase 6 Implementation State and Follow-up

Implemented the patient doctor details and appointment booking flow at `/patient/doctors/[id]`. It loads doctor details from `GET /api/v1/doctors/:id`, future slots in a rolling 30-day window from `GET /api/v1/doctors/:id/slots?from=&to=`, and submits `{ availability_id, reason? }` to `POST /api/v1/appointments`. Booking confirmation uses the returned appointment record. Conflict responses explain that the slot may have been taken and allow availability refresh; submission is disabled and guarded against duplicate requests. The patient route tree and backend patient authorization remain in force.

Frontend lint, TypeScript, build, and `git diff --check` passed. No live Clerk, backend, Neon, or browser integration was exercised. Next phase: patient appointment list and history; cancellation and rescheduling remain separate scope.

## L. Phase 7 Implementation State and Follow-up

Implemented the patient appointments page with upcoming and past appointments from the authenticated `GET /api/v1/appointments` response, appointment details, status labels, and Asia/Kolkata date/time display. Confirmed appointments can be cancelled through `PUT /api/v1/appointments/:id/cancel` after confirmation, or rescheduled through `PUT /api/v1/appointments/:id/reschedule` using a future available slot from `GET /api/v1/doctors/:id/slots?from=&to=`. Rescheduling sends `{ availability_id }`; backend behavior cancels the original and creates a confirmed replacement in one transaction. The backend has no cancellation cutoff and allows actions only while status is confirmed. The frontend shows conflicts and refreshes appointment state; duplicate mutation requests are guarded.

Frontend lint, TypeScript, build, and `git diff --check` passed. No live Clerk, API, Neon, or browser integration was exercised. Next phase: doctor appointment management; appointment completion remains doctor-only backend functionality and was not implemented here.

## M. Phase 8 Implementation State and Follow-up

Implemented the doctor appointments page with scheduled and past appointments from the authenticated `GET /api/v1/appointments` response. It displays appointment date/time in `Asia/Kolkata`, status, reason when present, and the patient name included by the API. Doctors can mark confirmed appointments completed through `PUT /api/v1/appointments/:id/complete`; backend ownership and state checks remain authoritative. Loading, retryable errors, empty sections, completion progress, success, and conflict refresh states are included; duplicate completion submissions are guarded.

Frontend lint, TypeScript, build, and `git diff --check` passed. No live Clerk, backend API, Neon, or browser integration was exercised. Doctor availability management and profile editing remain out of scope.

## N. Phase 9 Implementation State and Follow-up

Implemented doctor-only availability management at `/doctor/availability`. The page loads future, unbooked slots from `GET /api/v1/doctors/:id/slots?from=` using the signed-in doctor profile ID, creates one slot per submission with `POST /api/v1/doctors/:id/slots` and `{ slots: [{ date, start_time, end_time }] }`, and deletes listed slots with `DELETE /api/v1/doctors/:id/slots/:slotId`. Client validation checks ISO dates, 24-hour `HH:mm` values, end-after-start, and future time in `Asia/Kolkata`; backend ownership, overlap, timezone, and appointment-history protections remain authoritative. The list refreshes after successful mutations. The existing list API returns only future unbooked slots, so booked and past availability cannot be shown here.

Frontend lint, TypeScript, build, and `git diff --check` passed. No live Clerk, API, Neon, or browser integration was exercised. No recurring availability was added.

## O. Post-Phase 9 Implementation Review

Source review confirms the frontend API client requires `NEXT_PUBLIC_API_URL`. That key is present in `frontend/.env.example` but absent from the current `frontend/.env.local`; as checked out, profile lookup and all API-backed flows cannot reach the Express API until it is configured. The current backend environment defines `APPLICATION_TIMEZONE` as `Asia/Kolkata`; no secret values are recorded here.

The completion endpoint checks that an appointment is confirmed and belongs to the authenticated doctor, but does not check appointment time. The doctor UI offers completion for confirmed appointments in both scheduled and past groups, so a doctor can mark a future appointment completed. Confirm whether completion should be time-gated before changing that behavior.

Lint, TypeScript, build, and `git diff --check` passed during this review. No live Clerk session, API request, Neon query, or browser workflow was exercised.
