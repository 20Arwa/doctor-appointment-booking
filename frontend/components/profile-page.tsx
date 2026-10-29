"use client";

import { useAuth } from "@clerk/nextjs";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { useDashboardProfile, useUpdateDashboardProfile } from "@/components/role-application-shell";
import { notifyError, notifySuccess } from "@/lib/notifications";
import {
  getCurrentProfile,
  ProfileApiError,
  updateRoleProfile,
  updateUserDetails,
  type LocalProfile,
} from "@/lib/profile-api";

const profileSchema = z.object({
  first_name: z.string().trim().min(1, "Enter your first name.").max(100, "Use 100 characters or fewer."),
  last_name: z.string().trim().min(1, "Enter your last name.").max(100, "Use 100 characters or fewer."),
  phone: z.string().trim().max(40, "Use 40 characters or fewer."),
  date_of_birth: z.string().refine((value) => value === "" || z.iso.date().safeParse(value).success, "Enter a valid date."),
  gender: z.string().trim().max(40, "Use 40 characters or fewer."),
  specialty: z.string().trim().max(150, "Use 150 characters or fewer."),
  bio: z.string().trim().max(5000, "Use 5,000 characters or fewer."),
});

type ProfileValues = z.infer<typeof profileSchema>;
type ProfileField = keyof ProfileValues;
type ProfileErrors = Partial<Record<ProfileField, string>>;

const fieldClassName = "mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-foreground shadow-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring";

function valuesFromProfile(profile: LocalProfile): ProfileValues {
  return {
    first_name: profile.first_name,
    last_name: profile.last_name,
    phone: profile.phone ?? "",
    date_of_birth: profile.role === "patient" ? profile.profile.date_of_birth ?? "" : "",
    gender: profile.role === "patient" ? profile.profile.gender ?? "" : "",
    specialty: profile.role === "doctor" ? profile.profile.specialty ?? "" : "",
    bio: profile.role === "doctor" ? profile.profile.bio ?? "" : "",
  };
}

function todayInApplicationZone() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Kolkata",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function validationErrors(error: ProfileApiError): ProfileErrors {
  const result: ProfileErrors = {};
  for (const detail of error.details) {
    const field = detail.path as ProfileField;
    if (profileSchema.shape[field]) result[field] = detail.message;
  }
  return result;
}

export function ProfilePage() {
  const profile = useDashboardProfile();
  const updateDashboardProfile = useUpdateDashboardProfile();
  const { getToken } = useAuth();
  const [values, setValues] = useState(() => valuesFromProfile(profile));
  const [errors, setErrors] = useState<ProfileErrors>({});
  const [saving, setSaving] = useState(false);

  function updateField(field: ProfileField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setErrors({});

    const parsed = profileSchema.safeParse(values);
    if (!parsed.success) {
      const nextErrors: ProfileErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as ProfileField | undefined;
        if (field && !nextErrors[field]) nextErrors[field] = issue.message;
      }
      setErrors(nextErrors);
      return;
    }
    if (profile.role === "doctor" && !parsed.data.specialty.trim()) {
      setErrors({ specialty: "Enter your specialty." });
      return;
    }
    if (profile.role === "patient" && parsed.data.date_of_birth && parsed.data.date_of_birth > todayInApplicationZone()) {
      setErrors({ date_of_birth: "Date of birth cannot be in the future." });
      return;
    }

    setSaving(true);
    try {
      const token = await getToken();
      if (!token) throw new Error("Your session could not be verified. Please sign in again.");
      await updateUserDetails(token, {
        first_name: parsed.data.first_name,
        last_name: parsed.data.last_name,
        phone: parsed.data.phone.trim() || null,
      });
      if (profile.role === "patient") {
        await updateRoleProfile(token, profile, {
          date_of_birth: parsed.data.date_of_birth || null,
          gender: parsed.data.gender.trim() || null,
        });
      } else {
        await updateRoleProfile(token, profile, {
          specialty: parsed.data.specialty.trim(),
          bio: parsed.data.bio.trim() || null,
        });
      }

      const updatedProfile = await getCurrentProfile(token);
      updateDashboardProfile(updatedProfile);
      setValues(valuesFromProfile(updatedProfile));
      notifySuccess("Your profile has been updated.", `profile-save-${profile.id}`);
    } catch (error) {
      if (error instanceof ProfileApiError && error.details.length > 0) {
        setErrors(validationErrors(error));
      }
      notifyError(error instanceof Error ? error.message : "We couldn't update your profile. Please try again.", `profile-save-${profile.id}`);
    } finally {
      setSaving(false);
    }
  }

  function inputChange(field: ProfileField) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => updateField(field, event.target.value);
  }

  function textField(field: ProfileField, label: string, options: { type?: string; autoComplete?: string; max?: string } = {}) {
    const id = `profile-${field}`;
    return (
      <div>
        <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
        <input id={id} name={field} type={options.type ?? "text"} autoComplete={options.autoComplete} max={options.max} value={values[field]} onChange={inputChange(field)} aria-invalid={Boolean(errors[field])} aria-describedby={errors[field] ? `${id}-error` : undefined} className={fieldClassName} />
        {errors[field] ? <p id={`${id}-error`} className="mt-1.5 text-sm text-destructive" role="alert">{errors[field]}</p> : null}
      </div>
    );
  }

  function textArea(field: ProfileField, label: string, hint: string) {
    const id = `profile-${field}`;
    return (
      <div className="sm:col-span-2">
        <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
        <textarea id={id} name={field} rows={5} value={values[field]} onChange={inputChange(field)} aria-invalid={Boolean(errors[field])} aria-describedby={errors[field] ? `${id}-error` : `${id}-hint`} className={`${fieldClassName} min-h-32 resize-y`} />
        {errors[field] ? <p id={`${id}-error`} className="mt-1.5 text-sm text-destructive" role="alert">{errors[field]}</p> : <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted-foreground">{hint}</p>}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">{profile.role === "patient" ? "Patient workspace" : "Doctor workspace"}</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Your profile</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Review and update the information associated with your Medrella account.</p>
      </header>

      <form onSubmit={(event) => void save(event)} className="space-y-6" noValidate>
        <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8" aria-labelledby="personal-details-title">
          <div className="mb-6">
            <h2 id="personal-details-title" className="text-xl font-semibold text-card-foreground">Personal details</h2>
            <p className="mt-1 text-sm text-muted-foreground">Your email is managed securely by your sign-in account.</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            {textField("first_name", "First name", { autoComplete: "given-name" })}
            {textField("last_name", "Last name", { autoComplete: "family-name" })}
            <div>
              <label htmlFor="profile-email" className="text-sm font-medium text-foreground">Email address</label>
              <input id="profile-email" type="email" value={profile.email} readOnly className={`${fieldClassName} cursor-not-allowed bg-muted text-muted-foreground`} />
            </div>
            {textField("phone", "Phone number", { type: "tel", autoComplete: "tel" })}
          </div>
        </section>

        {profile.role === "patient" ? (
          <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8" aria-labelledby="patient-details-title">
            <div className="mb-6">
              <h2 id="patient-details-title" className="text-xl font-semibold text-card-foreground">Patient details</h2>
              <p className="mt-1 text-sm text-muted-foreground">These optional details help keep your patient profile current.</p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              {textField("date_of_birth", "Date of birth", { type: "date", max: todayInApplicationZone() })}
              {textField("gender", "Gender")}
            </div>
          </section>
        ) : (
          <section className="rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-8" aria-labelledby="doctor-details-title">
            <div className="mb-6">
              <h2 id="doctor-details-title" className="text-xl font-semibold text-card-foreground">Professional details</h2>
              <p className="mt-1 text-sm text-muted-foreground">Keep your specialty and public profile description up to date.</p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              {textField("specialty", "Specialty")}
              <div>
                <p className="text-sm font-medium text-foreground">Consultation fee</p>
                <p className="mt-2 min-h-11 rounded-lg border border-border bg-muted px-3 py-2 text-foreground" aria-label="Consultation fee">{new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(profile.profile.consultation_fee ?? 500)}</p>
                <p className="mt-1.5 text-sm text-muted-foreground">Your standard consultation fee.</p>
              </div>
              {textArea("bio", "About you", "Share a short professional introduction. This may appear in the doctor directory.")}
            </div>
          </section>
        )}

        <div className="flex justify-end">
          <Button type="submit" size="lg" disabled={saving}>
            {saving ? <><span aria-hidden="true" className="size-4 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground motion-reduce:animate-none" /> Saving profile…</> : "Save changes"}
          </Button>
        </div>
      </form>
    </div>
  );
}
