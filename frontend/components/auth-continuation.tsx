"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getCurrentProfile, ProfileApiError } from "@/lib/profile-api";
import { dashboardPath } from "@/lib/roles";

export function AuthContinuation() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  const checkProfile = useCallback(async () => {
    try {
      const token = await getToken();
      setError(null);
      if (!token) {
        setError("Your sign-in session is not ready. Please sign in again.");
        return;
      }
      const profile = await getCurrentProfile(token);
      router.replace(dashboardPath(profile.role));
    } catch (cause) {
      if (cause instanceof ProfileApiError && cause.status === 404 && cause.code === "PROFILE_NOT_FOUND") {
        router.replace("/onboarding");
        return;
      }
      setError(cause instanceof Error ? cause.message : "We couldn't check your profile. Please try again.");
    }
  }, [getToken, router]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.replace("/sign-in");
      return;
    }
    queueMicrotask(() => void checkProfile());
  }, [checkProfile, isLoaded, isSignedIn, router]);

  if (error) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <section className="w-full max-w-lg rounded-3xl border border-border bg-card p-8 text-center shadow-sm" aria-labelledby="continue-title">
          <h1 id="continue-title" className="text-2xl font-semibold text-card-foreground">We couldn’t check your profile</h1>
          <p role="alert" className="mt-3 text-muted-foreground">{error}</p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <button type="button" onClick={() => void checkProfile()} className="min-h-11 rounded-lg bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Try again</button>
            <Link href="/sign-in" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-5 py-2.5 font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Sign in again</Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-2xl border border-border bg-card px-6 py-5 text-foreground shadow-sm">
        <span aria-hidden="true" className="size-5 animate-spin rounded-full border-2 border-primary/25 border-t-primary motion-reduce:animate-none" />
        <span>{isLoaded ? "Checking your Medrella profile…" : "Preparing your secure session…"}</span>
      </div>
    </main>
  );
}
