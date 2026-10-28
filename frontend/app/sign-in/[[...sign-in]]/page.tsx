import { Suspense } from "react";
import { SignIn } from "@clerk/nextjs";

export default function SignInPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-5 py-14 sm:px-8">
      <div className="w-full max-w-md rounded-3xl border border-border bg-card p-5 shadow-sm sm:p-8">
        <div className="mb-7 text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">
            Welcome back
          </p>

          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-card-foreground">
            Sign in to Medrella
          </h1>

          <p className="mt-2 text-sm text-muted-foreground">
            Continue managing your care in one place.
          </p>
        </div>

        <Suspense
          fallback={
            <div aria-label="Loading sign-in form" className="h-72" />
          }
        >
          <SignIn
            routing="path"
            path="/sign-in"
            signUpUrl="/sign-up"
            forceRedirectUrl="/auth/continue"
            signUpForceRedirectUrl="/auth/continue"
            appearance={{
              options: {
                elevation: "flush",
                unsafe_disableDevelopmentModeWarnings: true,
              },
              variables: {
                colorPrimary: "var(--primary)",
                colorBackground: "var(--card)",
                colorForeground: "var(--card-foreground)",
                colorMutedForeground: "var(--muted-foreground)",
                colorInput: "var(--card)",
                colorInputForeground: "var(--card-foreground)",
                borderRadius: "var(--radius)",
                fontFamily: "var(--font-geist-sans)",
              },
              elements: {
                rootBox: "!w-full",
                cardBox: "!w-full !bg-transparent !border-0 !shadow-none !p-0",
                card: "!w-full !max-w-none !bg-transparent !border-0 !shadow-none !p-0 !rounded-none",
                headerTitle: "hidden",
                headerSubtitle: "hidden",
                footer: "!bg-transparent !border-0 !shadow-none",
              },
            }}
          />
        </Suspense>
      </div>
    </main>
  );
}