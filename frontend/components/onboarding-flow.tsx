"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Check, Stethoscope, UserRound } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  createLocalProfile,
  getCurrentProfile,
  ProfileApiError,
  updateRoleProfile,
  updateUserPhone,
  type LocalProfile,
} from "@/lib/profile-api";
import { emptyOnboardingForm, onboardingFormSchema, type OnboardingFormValues } from "@/lib/onboarding-schemas";
import { dashboardPath } from "@/lib/roles";

type Role = "patient" | "doctor";
type FieldName = keyof OnboardingFormValues;
type FieldErrors = Partial<Record<FieldName, string>>;
type PageStatus = "checking" | "ready" | "error";

function LoadingPanel({ label }: { label: string }) {
  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-2xl border border-border bg-card px-6 py-5 text-foreground shadow-sm">
        <span aria-hidden="true" className="size-5 animate-spin rounded-full border-2 border-primary/25 border-t-primary motion-reduce:animate-none" />
        <span>{label}</span>
      </div>
    </main>
  );
}

export function OnboardingFlow() {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const router = useRouter();
  const hasChecked = useRef(false);
  const [pageStatus, setPageStatus] = useState<PageStatus>("checking");
  const [pageError, setPageError] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [step, setStep] = useState<"role" | "profile">("role");
  const [values, setValues] = useState<OnboardingFormValues>(emptyOnboardingForm);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [createdProfile, setCreatedProfile] = useState<LocalProfile | null>(null);
  const [complete, setComplete] = useState(false);

  const checkExistingProfile = useCallback(async () => {
    try {
      const token = await getToken();
      setPageStatus("checking");
      setPageError(null);
      if (!token) throw new ProfileApiError(401, "Your secure sign-in session is not ready. Please sign in again.");
      const profile = await getCurrentProfile(token);
      router.replace(dashboardPath(profile.role));
    } catch (cause) {
      if (cause instanceof ProfileApiError && cause.status === 404 && cause.code === "PROFILE_NOT_FOUND") {
        setPageStatus("ready");
        return;
      }
      setPageError(cause instanceof Error ? cause.message : "We couldn't check your profile. Please try again.");
      setPageStatus("error");
    }
  }, [getToken, router]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.replace("/sign-in");
      return;
    }
    if (hasChecked.current) return;
    hasChecked.current = true;
    void checkExistingProfile();
  }, [checkExistingProfile, isLoaded, isSignedIn, router]);

  function updateField(field: FieldName, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
    setSubmitError(null);
  }

  function validateForm() {
    const result = onboardingFormSchema.safeParse(values);
    const nextErrors: FieldErrors = {};
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path[0] as FieldName | undefined;
        if (field && !nextErrors[field]) nextErrors[field] = issue.message;
      }
    }
    if (role === "doctor" && !values.specialty.trim()) {
      nextErrors.specialty = "Enter your specialty.";
    }
    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function applyApiFieldErrors(error: ProfileApiError) {
    const nextErrors: FieldErrors = {};
    for (const detail of error.details) {
      const field = detail.path.split(".")[0] as FieldName;
      if (field in emptyOnboardingForm && !nextErrors[field]) nextErrors[field] = detail.message;
    }
    setFieldErrors(nextErrors);
  }

  async function saveOptionalProfileFields(token: string, profile: LocalProfile) {
    const phone = values.phone.trim();
    if (phone) await updateUserPhone(token, phone);

    if (profile.role === "patient") {
      const patientFields: Record<string, string> = {};
      if (values.date_of_birth) patientFields.date_of_birth = values.date_of_birth;
      if (values.gender.trim()) patientFields.gender = values.gender.trim();
      if (Object.keys(patientFields).length) await updateRoleProfile(token, profile, patientFields);
    } else if (values.bio.trim()) {
      await updateRoleProfile(token, profile, { bio: values.bio.trim() });
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!role || submitting || !validateForm()) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const token = await getToken();
      if (!token) throw new ProfileApiError(401, "Your secure sign-in session has expired. Sign in again to continue.");

      let profile = createdProfile;
      if (!profile) {
        const createBody = {
          role,
          first_name: values.first_name.trim(),
          last_name: values.last_name.trim(),
          ...(role === "doctor" ? { specialty: values.specialty.trim() } : {}),
        };
        try {
          profile = await createLocalProfile(token, createBody);
        } catch (createError) {
          // The connection can fail after the backend commits. Recheck before any retry
          // so the client never submits a second profile creation blindly.
          try {
            const existing = await getCurrentProfile(token);
            if (existing.role !== role) {
              throw new ProfileApiError(409, "A profile already exists for this account with a different role. Roles cannot be changed after onboarding.");
            }
            profile = existing;
          } catch (lookupError) {
            if (lookupError instanceof ProfileApiError && lookupError.status === 409) throw lookupError;
            if (lookupError instanceof ProfileApiError && lookupError.status === 404 && lookupError.code === "PROFILE_NOT_FOUND") {
              throw createError;
            }
            throw createError;
          }
        }
        setCreatedProfile(profile);
      }

      await saveOptionalProfileFields(token, profile);
      setComplete(true);
      router.replace(dashboardPath(profile.role));
    } catch (cause) {
      if (cause instanceof ProfileApiError) applyApiFieldErrors(cause);
      setSubmitError(cause instanceof Error ? cause.message : "We couldn't save your profile. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!isLoaded || !isSignedIn || pageStatus === "checking") {
    return <LoadingPanel label="Checking your Medrella profile…" />;
  }

  if (pageStatus === "error") {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <section className="w-full max-w-lg rounded-3xl border border-border bg-card p-8 text-center shadow-sm" aria-labelledby="profile-check-title">
          <h1 id="profile-check-title" className="text-2xl font-semibold text-card-foreground">We couldn’t check your profile</h1>
          <p role="alert" className="mt-3 text-muted-foreground">{pageError}</p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <button type="button" onClick={() => void checkExistingProfile()} className="min-h-11 rounded-lg bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Try again</button>
            <Link href="/sign-in" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-5 py-2.5 font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Sign in again</Link>
          </div>
        </section>
      </main>
    );
  }

  if (complete) {
    return (
      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <section className="w-full max-w-xl rounded-3xl border border-border bg-card p-8 text-center shadow-sm sm:p-10" aria-labelledby="complete-title">
          <span aria-hidden="true" className="mx-auto flex size-14 items-center justify-center rounded-full bg-secondary text-secondary-foreground"><Check className="size-7" /></span>
          <p className="mt-6 text-sm font-semibold uppercase tracking-[0.16em] text-primary">You’re all set</p>
          <h1 id="complete-title" className="mt-2 text-3xl font-semibold tracking-tight text-card-foreground">Your Medrella profile is ready</h1>
          <p className="mt-3 text-muted-foreground">Your profile has been saved. Opening your dashboard…</p>
          {createdProfile && <Link href={dashboardPath(createdProfile.role)} className="mt-7 inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Continue to your dashboard <ArrowRight aria-hidden="true" className="size-4" /></Link>}
        </section>
      </main>
    );
  }

  const email = user?.primaryEmailAddress?.emailAddress ?? "";

  return (
    <main className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8 sm:py-16">
      <div className="w-full max-w-3xl">
        <div className="mb-8 text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">Let’s get you set up</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Create your Medrella profile</h1>
          <p className="mt-3 text-muted-foreground">A few details will help us personalize your experience.</p>
        </div>

        <div className="mb-6 flex items-center justify-center gap-3 text-sm font-medium text-muted-foreground" aria-label={`Step ${step === "role" ? "1" : "2"} of 2`}>
          <span className={`flex size-8 items-center justify-center rounded-full ${step === "role" ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"}`}>{step === "profile" ? <Check aria-hidden="true" className="size-4" /> : "1"}</span>
          <span className={step === "role" ? "text-foreground" : ""}>Choose your role</span>
          <span aria-hidden="true" className="h-px w-8 bg-border" />
          <span className={`flex size-8 items-center justify-center rounded-full ${step === "profile" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>2</span>
          <span className={step === "profile" ? "text-foreground" : ""}>Your details</span>
        </div>

        <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-9">
          {step === "role" ? (
            <div>
              <fieldset>
                <legend className="text-2xl font-semibold tracking-tight text-card-foreground">How would you like to join Medrella?</legend>
                <p className="mt-2 text-muted-foreground">Choose the option that best describes you.</p>
                <div className="mt-7 grid gap-4 sm:grid-cols-2">
                <label className={`cursor-pointer rounded-2xl border p-5 text-left transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring ${role === "patient" ? "border-primary bg-secondary/60 ring-2 ring-ring" : "border-border bg-background hover:bg-muted"}`}>
                  <input className="peer sr-only" type="radio" name="role" value="patient" checked={role === "patient"} onChange={() => setRole("patient")} />
                  <span className="flex size-11 items-center justify-center rounded-xl bg-card text-primary shadow-sm"><UserRound aria-hidden="true" className="size-5" /></span>
                  <span className="mt-4 block font-semibold text-card-foreground">I’m a Patient</span>
                  <span className="mt-1 block text-sm leading-6 text-muted-foreground">Find doctors and manage your appointments.</span>
                </label>
                <label className={`cursor-pointer rounded-2xl border p-5 text-left transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring ${role === "doctor" ? "border-primary bg-secondary/60 ring-2 ring-ring" : "border-border bg-background hover:bg-muted"}`}>
                  <input className="peer sr-only" type="radio" name="role" value="doctor" checked={role === "doctor"} onChange={() => setRole("doctor")} />
                  <span className="flex size-11 items-center justify-center rounded-xl bg-card text-primary shadow-sm"><Stethoscope aria-hidden="true" className="size-5" /></span>
                  <span className="mt-4 block font-semibold text-card-foreground">I’m a Doctor</span>
                  <span className="mt-1 block text-sm leading-6 text-muted-foreground">Manage your availability and appointments.</span>
                </label>
                </div>
              </fieldset>
              <button type="button" disabled={!role} onClick={() => setStep("profile")} className="mt-7 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-auto">
                Continue <ArrowRight aria-hidden="true" className="size-4" />
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate>
              {!createdProfile && (
                <button type="button" onClick={() => setStep("role")} className="mb-5 inline-flex min-h-10 items-center gap-2 rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  <ArrowLeft aria-hidden="true" className="size-4" /> Back to role
                </button>
              )}
              <div className="mb-6">
                <p className="text-sm font-medium text-primary">Step 2 of 2 · {role === "doctor" ? "Doctor" : "Patient"}</p>
                <h2 className="mt-1 text-2xl font-semibold tracking-tight text-card-foreground">Your profile details</h2>
              </div>

              {submitError && <p role="alert" className="mb-5 rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">{createdProfile ? `Your ${role} profile has been created, but some additional details could not be saved. ${submitError} Your role and name are already saved; retry to save the optional details.` : submitError}</p>}

              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="First name" name="first_name" value={values.first_name} error={fieldErrors.first_name} disabled={Boolean(createdProfile)} onChange={(value) => updateField("first_name", value)} autoComplete="given-name" />
                <Field label="Last name" name="last_name" value={values.last_name} error={fieldErrors.last_name} disabled={Boolean(createdProfile)} onChange={(value) => updateField("last_name", value)} autoComplete="family-name" />
                {email && (
                  <div className="sm:col-span-2">
                    <label htmlFor="account-email" className="mb-1.5 block text-sm font-medium text-foreground">Email</label>
                    <input id="account-email" type="email" value={email} readOnly aria-readonly="true" className="min-h-11 w-full rounded-lg border border-input bg-muted px-3.5 py-2.5 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
                    <p className="mt-1.5 text-xs text-muted-foreground">This email is managed by your sign-in account.</p>
                  </div>
                )}
                <Field label="Phone (optional)" name="phone" value={values.phone} error={fieldErrors.phone} onChange={(value) => updateField("phone", value)} autoComplete="tel" type="tel" />
                {role === "doctor" ? (
                  <>
                    <Field label="Specialty" name="specialty" value={values.specialty} error={fieldErrors.specialty} required onChange={(value) => updateField("specialty", value)} />
                    <TextAreaField label="Bio (optional)" name="bio" value={values.bio} error={fieldErrors.bio} onChange={(value) => updateField("bio", value)} rows={4} />
                  </>
                ) : (
                  <>
                    <Field label="Date of birth (optional)" name="date_of_birth" value={values.date_of_birth} error={fieldErrors.date_of_birth} onChange={(value) => updateField("date_of_birth", value)} type="date" />
                    <Field label="Gender (optional)" name="gender" value={values.gender} error={fieldErrors.gender} onChange={(value) => updateField("gender", value)} />
                  </>
                )}
              </div>

              <button type="submit" disabled={submitting} className="mt-8 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:w-auto">
                {submitting ? <><span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground motion-reduce:animate-none" /> Saving profile…</> : createdProfile ? "Retry saving details" : "Create profile"}
              </button>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}

function Field({
  label,
  name,
  value,
  error,
  required = false,
  disabled = false,
  onChange,
  autoComplete,
  type = "text",
}: {
  label: string;
  name: FieldName;
  value: string;
  error?: string;
  required?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
  autoComplete?: string;
  type?: string;
}) {
  const errorId = `${name}-error`;
  return (
    <div>
      <label htmlFor={name} className="mb-1.5 block text-sm font-medium text-foreground">{label}{required && <span aria-hidden="true"> *</span>}</label>
      <input
        id={name}
        name={name}
        type={type}
        value={value}
        required={required}
        disabled={disabled}
        autoComplete={autoComplete}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="min-h-11 w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
      />
      {error && <p id={errorId} className="mt-1.5 text-sm text-destructive">{error}</p>}
    </div>
  );
}

function TextAreaField({
  label,
  name,
  value,
  error,
  onChange,
  rows,
}: {
  label: string;
  name: FieldName;
  value: string;
  error?: string;
  onChange: (value: string) => void;
  rows: number;
}) {
  const errorId = `${name}-error`;
  return (
    <div className="sm:col-span-2">
      <label htmlFor={name} className="mb-1.5 block text-sm font-medium text-foreground">{label}</label>
      <textarea
        id={name}
        name={name}
        value={value}
        rows={rows}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="w-full resize-y rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
      />
      {error && <p id={errorId} className="mt-1.5 text-sm text-destructive">{error}</p>}
    </div>
  );
}
