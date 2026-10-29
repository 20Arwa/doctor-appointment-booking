# Doctor Appointment Booking

The project consists of an independently run Next.js frontend and an Express.js API backend. Both use npm and can be started from the repository root or from their respective directories.

## Requirements

- Node.js LTS
- npm

## Installation

Install the frontend and backend dependencies:

```bash
cd frontend
npm install

cd ../backend
npm install
```

## Run in Development

Start the frontend and backend in separate terminals from the repository root:

```bash
npm run dev:frontend
```

```bash
npm run dev:backend
```

Alternatively, start each application from its own directory:

```bash
# Frontend
cd frontend
npm run dev
```

```bash
# Backend
cd backend
npm run dev
```

The frontend runs at [http://localhost:3000](http://localhost:3000).

The API health endpoint is available at [http://localhost:3001/health](http://localhost:3001/health).

### Environment Variables

The API defaults to port `3001` and allows browser requests from `http://localhost:3000`.

To customize the backend configuration, copy `backend/.env.example` to `backend/.env` and update the relevant values:

- `PORT` — the backend port.
- `FRONTEND_ORIGIN` — the allowed frontend origin.

To configure the frontend API URL, copy `frontend/.env.example` to `frontend/.env.local` and set:

- `NEXT_PUBLIC_API_URL` — the base URL used by frontend code to call the API.

## Production

Build the frontend:

```bash
npm --prefix frontend run build
```

Start the frontend:

```bash
npm run start:frontend
```

Start the backend API in a separate process:

```bash
npm run start:backend
```

Configure `NEXT_PUBLIC_API_URL` at frontend build time. Configure `PORT` and `FRONTEND_ORIGIN` in the backend environment as needed for your deployment environment.

### Appointment email reminders

The backend exposes `POST /api/v1/internal/reminders/run` for an external scheduler. Configure a Render Cron Job to POST to `https://<backend-service-host>/api/v1/internal/reminders/run` every five minutes, with the header `Authorization: Bearer <REMINDER_CRON_SECRET>`. Generate a random secret of at least 32 characters and set the same value as `REMINDER_CRON_SECRET` on the API service and Cron Job. The endpoint returns a count summary and is protected with a constant-time bearer-token comparison.

Apply backend migrations with `npm --prefix backend run migrate` before enabling the Cron Job. `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, and `BREVO_SENDER_NAME` use the existing Brevo configuration. When any of these values or a patient email is missing, the scheduler skips delivery and retries on a later run. Reminders are sent 24 hours and 1 hour before the appointment, using `APPLICATION_TIMEZONE` (configured as `Asia/Kolkata` for this application). PostgreSQL stores unique delivery keys and processing leases so scheduler retries and multiple instances do not issue duplicate reminder sends.

### Future payment schema

Migration 008 prepares payment, refund, provider-event, and appointment-slot-hold records; it does not change the current immediate-confirmation booking flow. The recommended temporary checkout hold is **10 minutes**. Future hold creation must claim the availability slot transactionally, and expired active holds must be marked expired before another patient can claim the slot. Payment attempts can be retried after `failed` or `expired` status; a pending, captured, or refunded payment remains unique per appointment or hold. Payment amounts should snapshot the doctor's consultation fee when the future payment flow is implemented.
