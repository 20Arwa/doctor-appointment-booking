# AGENTS.md

Project-wide instructions for Codex and other coding agents working on
this repository.

## 1. Project Overview

This repository contains a Doctor--Patient Appointment Booking
Application. Build it incrementally, prioritize complete and secure
end-to-end workflows, and follow the existing repository structure
instead of creating parallel implementations.

## 2. Technology Stack

Use these technologies unless the repository already contains an agreed,
working alternative:

-   Frontend: Next.js, React, TypeScript (`.ts` and `.tsx`)
-   Backend: Node.js + Express.js, JavaScript (`.js` and `.mjs` only
    when appropriate)
-   Authentication: Clerk
-   Database: PostgreSQL hosted on Neon
-   Styling: Tailwind CSS
-   UI components: shadcn/ui
-   Icons: Lucide (`lucide-react`)
-   Validation: Zod

**Important language boundary:** - Use TypeScript for frontend
application code. - Use JavaScript for all backend application code. -
Do not create backend `.ts` or `.tsx` files, add `tsconfig`
configuration for the backend, or introduce a TypeScript compilation
step for the backend. - Do not convert existing backend JavaScript files
to TypeScript. - Zod validation must work in JavaScript; do not rely on
TypeScript-only type inference or annotations. - If the repository
already has a backend setup, preserve its established JavaScript
conventions.

Do not introduce another ORM, component library, authentication
provider, icon library, or validation library without a clear need and
explicit approval.

Use the package manager already configured in the relevant project.
Inspect `package.json` and the existing source tree before installing
dependencies or changing configuration.

## 3. Follow Existing Project Conventions

-   Inspect the repository and relevant files before making changes.
-   Reuse existing components, utilities, hooks, design tokens,
    middleware, and database setup where appropriate.
-   Keep changes focused on the task requested. Do not refactor
    unrelated code.
-   Use `.ts` and `.tsx` for new frontend TypeScript code.
-   Use `.js` for new backend code. Do not use TypeScript in the
    backend.
-   Keep components, routes, controllers, services, models, validators,
    and database migrations in the project's established locations.
-   Avoid duplicated logic. Extract shared logic when it has a clear
    purpose and is used in multiple places.
-   Do not create placeholder implementations and claim they are
    complete.
-   Do not modify generated files or lockfiles manually when the package
    manager can update them correctly.

## 4. Colors and Design Tokens

The frontend has a shared `global.css` file containing the project's
established color variables/design tokens.

-   **Do not hardcode fixed colors for normal UI styling** when a
    suitable token already exists in `global.css`.
-   Prefer the existing CSS variables and semantic Tailwind/shadcn theme
    classes, such as the project's equivalents of `bg-background`,
    `text-foreground`, `bg-primary`, `text-muted-foreground`,
    `border-border`, and `ring-ring`. First verify which tokens and
    classes actually exist in this repository.
-   If a color is missing and has a clear semantic purpose and is likely
    to be reused, add a named CSS variable to `global.css` and connect
    it to the existing Tailwind/shadcn theming approach where necessary.
-   Do not add a new global color variable for every one-off detail.
-   A fixed color is acceptable for a small, local decorative detail or
    simple illustration that is unlikely to be reused, provided it does
    not conflict with the established theme or accessibility.
-   Avoid scattering arbitrary hex values throughout components.
-   Preserve the existing color palette and Light/Dark mode behavior if
    the project supports both.
-   Do not replace or rename existing design tokens without a clear
    reason. If a token needs changing, update its usage consistently.
-   Ensure text, controls, borders, and focus indicators remain readable
    and accessible.

Before adding or changing colors, inspect `global.css` and the
Tailwind/shadcn theme configuration.

## 5. UI Components and Icons

-   Before creating a new UI component, check whether an appropriate
    shadcn/ui component already exists in the project or can be added
    using the project's established shadcn/ui setup.
-   Prefer existing shadcn/ui components and compose them when possible
    instead of recreating their behavior and accessibility from scratch.
-   If the required component does not exist, add it following the
    project's shadcn/ui conventions, then customize it to fit the
    design.
-   Do not install a second component library for a component that
    shadcn/ui can provide.
-   Use Lucide icons from `lucide-react`. Do not introduce emoji or
    another icon package as substitutes for interface icons unless
    explicitly requested.
-   Use semantic HTML, accessible labels, keyboard interaction, visible
    focus states, and appropriate ARIA attributes where needed.
-   Use the project's existing spacing, typography, radius, and color
    tokens rather than inventing a separate design system.
-   Avoid unnecessary animation and respect reduced-motion preferences.

## 6. Tailwind CSS

-   Use Tailwind utility classes consistent with the project's
    configured version.
-   Prefer semantic theme utilities backed by the project's design
    tokens over arbitrary color values.
-   Avoid adding custom CSS when an existing Tailwind utility or
    shadcn/ui pattern is suitable.
-   Put reusable design values in the existing design-token system
    rather than repeating arbitrary values across files.
-   Do not use deprecated or unsupported Tailwind syntax for the version
    installed in the repository.
-   Keep responsive behavior intentional and test relevant mobile and
    desktop layouts.

## 7. Authentication, Authorization, and Security

-   Clerk is the authentication provider. Verify authentication on the
    server using the configured, supported Clerk integration.
-   Never trust a user ID, role, doctor ID, or patient ID supplied by
    the client when it should be derived from the verified identity.
-   Never store Clerk passwords or implement a second password system.
-   Keep secrets in environment variables. Never commit API keys,
    database credentials, Clerk secrets, or real `.env` files.
-   Maintain a safe `.env.example` containing variable names and
    non-secret placeholders only.
-   Validate all untrusted request data with Zod at the appropriate
    boundary.
-   Enforce authorization on every protected backend endpoint.
    Authentication alone does not grant permission to access another
    user's records.
-   Do not expose sensitive patient information in logs, error messages,
    or responses to unauthorized users.
-   Use parameterized queries or the project's established safe
    database-access mechanism.
-   Return consistent errors and suitable HTTP status codes without
    exposing stack traces or internal configuration in production.
-   Preserve appointment and queue history. Avoid destructive deletes
    that would erase records required for historical or relational
    integrity.

## 8. Database and API

-   PostgreSQL is hosted on Neon. Reuse the existing Neon connection
    configuration and database access layer.
-   Make schema changes through migrations using the repository's chosen
    migration approach. Do not assume that changing a model or ERD
    automatically changes the live database.
-   Keep database constraints and application validation consistent
    where practical.
-   Use transactions for operations that must succeed or fail as a unit,
    especially booking, rescheduling, cancellation, and queue
    transitions.
-   Protect against race conditions and double-booking with database
    constraints as well as application logic.
-   Keep controllers focused on HTTP handling and responses. Put
    reusable business rules in services and database access in the
    established model/data-access layer.
-   API endpoints must use the agreed `/api/v1` prefix unless the
    project explicitly establishes another convention.
-   Do not expose credentials, internal database errors, or unnecessary
    private fields in API responses.

## 9. Validation and Error Handling

-   Use Zod for request body, route parameter, and query parameter
    validation.
-   Validate dates, times, IDs, enums, and state transitions.
-   Return clear, consistent validation errors.
-   Do not silently accept malformed or unexpected fields when doing so
    could cause security or data-integrity problems.
-   Handle expected database conflicts, such as a slot already being
    booked, with an appropriate response instead of an unhandled server
    error.

## 10. Working in Phases

The application is implemented incrementally.

-   Implement only the phase requested in the current prompt.
-   Do not start future modules automatically.
-   Before coding, inspect completed phases and reuse their code.
-   Do not duplicate routes, middleware, models, migrations, or
    infrastructure already present.
-   If a requirement conflicts with the existing architecture or an
    earlier decision, explain the conflict and choose the least
    disruptive safe approach. Ask for clarification when the decision
    materially affects the architecture.
-   Do not overwrite the user's existing work or discard unrelated
    changes.
-   Do not change frontend files during a backend-only task unless
    explicitly requested.

After each phase: 1. Summarize what changed. 2. List files created or
modified. 3. List implemented endpoints and access rules, where
applicable. 4. Report migrations and tests run, including failures. 5.
Identify remaining decisions or blockers. 6. Stop and wait for the next
instruction.

## 11. Quality Checks

Before reporting a task as complete:

-   Run the relevant linting, tests, and build commands available in the
    relevant frontend or backend project.
-   For the frontend, run the available TypeScript checks and relevant
    tests.
-   For the backend, run the available JavaScript linting and tests. Do
    not add a backend TypeScript check or compilation step.
-   Fix issues introduced by the changes.
-   If a check cannot be run, state why; do not claim it passed.
-   Check for accidental secrets, unrelated file changes, and duplicated
    implementations.
-   Keep code readable and maintainable. In backend JavaScript, avoid
    unnecessary untyped assumptions; use clear variable names, input
    validation, and Zod schemas.
-   Do not claim deployment, database migration, or external service
    configuration succeeded unless it was actually verified.

## 12. Decisions to Fill In

Project-specific decisions not yet confirmed:

-   Database access layer / ORM: \[\_\_\_\_\_\_\_\_\_\_\]
-   Testing framework: \[\_\_\_\_\_\_\_\_\_\_\]
-   Package manager: \[\_\_\_\_\_\_\_\_\_\_\]
-   Frontend directory: \[\_\_\_\_\_\_\_\_\_\_\]
-   Backend directory: \[\_\_\_\_\_\_\_\_\_\_\]
-   Application timezone: \[\_\_\_\_\_\_\_\_\_\_\]
-   Doctor account provisioning policy: During initial Clerk-authenticated onboarding, users may select `patient` or `doctor`; doctor selection requires a specialty and grants no administrative privileges. Role is immutable through profile updates.
-   Patient listing and administrative access policy:
    Until an administrative policy is approved, patients may access only their own profile; doctors and other patients cannot access patient records. No administrative role is implemented.
-   Appointment cancellation/rescheduling policy:
    \[\_\_\_\_\_\_\_\_\_\_\]
-   Queue check-in time window: \[\_\_\_\_\_\_\_\_\_\_\]