import { Suspense } from "react";
import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-5 py-14 sm:px-8">
      <div className="w-full max-w-md rounded-3xl border border-border bg-card p-5 shadow-sm sm:p-8">
        <div className="mb-7 text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">A simpler way to plan care</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-card-foreground">Get started with Medrella</h1>
          <p className="mt-2 text-sm text-muted-foreground">Create an account to get started.</p>
        </div>
        <Suspense fallback={<div aria-label="Loading sign-up form" className="h-72" />}>
        <SignUp
          routing="path"
          path="/sign-up"
          signInUrl="/sign-in"
          forceRedirectUrl="/auth/continue"
          signInForceRedirectUrl="/auth/continue"
          appearance={{
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
              card: "!bg-transparent !shadow-none !p-0",
              headerTitle: "hidden",
              headerSubtitle: "hidden",
              footer: "!bg-transparent",
            },
          }}
        />
        </Suspense>
      </div>
    </main>
  );
}
