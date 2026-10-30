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

Ensure the required reminder migration is applied before enabling the Cron Job. Check the migration ledger first and apply only missing migrations individually. Do not rerun migrations that have already been applied. `BREVO_API_KEY`, `BREVO_SENDER_EMAIL`, and `BREVO_SENDER_NAME` use the existing Brevo configuration. When any of these values or a patient email is missing, the scheduler skips delivery and retries on a later run. Reminders are sent 24 hours and 1 hour before the appointment, using `APPLICATION_TIMEZONE` (configured as `Asia/Kolkata` for this application). PostgreSQL stores unique delivery keys and processing leases so scheduler retries and multiple instances do not issue duplicate reminder sends.

### Appointment payment records and slot holds

Migration 008 adds payment, refund, provider-event, and appointment-slot-hold records. Migration 009 adds hold reason metadata and sets the default hold duration to **40 minutes**. This flow configures Stripe Checkout Sessions to expire after 35 minutes, leaving a five-minute buffer for the local hold. The longer local hold prevents a Checkout Session from remaining payable after its slot hold is released. Checkout expiration events release the hold earlier, and captured payments received after a competing booking are recorded for reconciliation without creating a conflicting appointment. Payment amounts are taken from and snapshot the doctor's consultation fee stored in PostgreSQL.

### Stripe Test Mode

Paid booking uses Stripe-hosted Checkout in one-time payment mode. The backend creates each session from the server-side consultation fee, stores its session ID in `payments.provider_order_id`, and stores the associated PaymentIntent ID in `payments.provider_payment_id`. The frontend receives only the hosted Checkout URL and redirects there; it does not need a publishable key. Return URLs are not treated as payment proof: payment status is retrieved and checked by the backend, while signed webhooks process `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, and `checkout.session.expired`.

Before enabling paid booking in any target database, verify that migrations 008, 009, and 010 have been applied. Check the migration ledger first and apply only missing migration files individually, in dependency order. Do not rerun migrations that have already been applied. The development Neon database already has all three migrations applied.

Patient appointment cancellation creates a refund for captured Stripe payments according to the cancellation time in `Asia/Kolkata`: at least 24 hours before the scheduled start returns 100%, 6 to less than 24 hours returns 50%, and less than 6 hours or after the start returns 0%. Refund amounts use the captured payment amount and currency. Cancellation success does not indicate that a refund has completed; the cancellation response reports the refund state separately.

Configure `STRIPE_SECRET_KEY=sk_test_...` and `STRIPE_WEBHOOK_SECRET=whsec_...` on the backend. The backend rejects non-test secret keys. Do not set live Stripe credentials.

For local webhook testing, install and authenticate the [Stripe CLI](https://docs.stripe.com/stripe-cli), then run:

```bash
stripe listen --forward-to localhost:3001/api/v1/payments/webhook
```

Copy the printed `whsec_...` value into the backend's local environment. Trigger or complete test Checkout payments and keep the CLI listener running.

For deployment, create a Test Mode webhook endpoint at `https://<backend-service-host>/api/v1/payments/webhook` in the Stripe Dashboard and subscribe it to the four Checkout Session events above plus `refund.created`, `refund.updated`, `refund.failed`, `charge.refund.updated`, and `charge.refunded`. Use that endpoint's signing secret as `STRIPE_WEBHOOK_SECRET`. The Dashboard secret differs from the local CLI forwarding secret.
