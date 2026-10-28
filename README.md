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