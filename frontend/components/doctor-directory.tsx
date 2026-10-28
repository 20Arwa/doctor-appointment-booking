"use client";

import { useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { RefreshCw, Search, Stethoscope } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getDoctors, type DirectoryDoctor } from "@/lib/profile-api";

export function DoctorDirectory() {
  const { getToken } = useAuth();
  const [doctors, setDoctors] = useState<DirectoryDoctor[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    void getToken()
      .then((token) => {
        if (!token) throw new Error("Your session could not be verified. Please try again.");
        return getDoctors(token);
      })
      .then((result) => {
        if (active) setDoctors(result);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "We couldn't load the doctor directory. Please try again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [getToken, retryKey]);

  const normalizedSearch = search.trim().toLocaleLowerCase("en");
  const filteredDoctors = useMemo(() => {
    if (!normalizedSearch) return doctors;
    return doctors.filter((doctor) =>
      `${doctor.first_name} ${doctor.last_name}`.toLocaleLowerCase("en").includes(normalizedSearch)
      || doctor.specialty.toLocaleLowerCase("en").includes(normalizedSearch),
    );
  }, [doctors, normalizedSearch]);

  return (
    <div className="space-y-6">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Find care</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Doctor directory</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Browse doctors by name or specialty.</p>
      </header>

      <div className="relative max-w-xl">
        <label htmlFor="doctor-search" className="sr-only">Search doctors by name or specialty</label>
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-5 -translate-y-1/2 text-muted-foreground" />
        <input
          id="doctor-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name or specialty"
          className="min-h-12 w-full rounded-xl border border-input bg-background py-3 pl-11 pr-4 text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>

      {loading ? <p className="rounded-xl bg-muted p-5 text-sm text-muted-foreground" role="status">Loading doctors…</p> : null}

      {!loading && error ? (
        <div className="rounded-2xl border border-destructive/40 bg-destructive/5 p-5" role="alert">
          <p className="text-sm text-foreground">{error}</p>
          <button type="button" onClick={() => { setLoading(true); setError(null); setRetryKey((key) => key + 1); }} className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <RefreshCw aria-hidden="true" className="size-4" /> Try again
          </button>
        </div>
      ) : null}

      {!loading && !error && doctors.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card p-8 text-center">
          <Stethoscope aria-hidden="true" className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-3 font-semibold text-card-foreground">No doctors available yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">Please check back later.</p>
        </div>
      ) : null}

      {!loading && !error && doctors.length > 0 && filteredDoctors.length === 0 ? (
        <p className="rounded-xl bg-muted p-5 text-sm text-muted-foreground" role="status">No doctors match “{search.trim()}”. Try another name or specialty.</p>
      ) : null}

      {!loading && !error && filteredDoctors.length > 0 ? (
        <ul className="grid gap-4 lg:grid-cols-2" aria-label="Doctors">
          {filteredDoctors.map((doctor) => {
            const name = `${doctor.first_name} ${doctor.last_name}`.trim();
            const initials = `${doctor.first_name.trim().charAt(0)}${doctor.last_name.trim().charAt(0)}`.toLocaleUpperCase("en");
            return (
              <li key={doctor.id} className="rounded-2xl border border-border bg-card p-5 shadow-sm sm:p-6">
                <div className="flex items-start gap-4">
                  <span aria-hidden="true" className="flex size-12 shrink-0 items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground">{initials || <Stethoscope className="size-5" />}</span>
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-card-foreground">Dr. {name}</h2>
                    <p className="mt-1 text-sm font-medium text-primary">{doctor.specialty}</p>
                  </div>
                </div>
                {doctor.bio?.trim() ? <p className="mt-4 whitespace-pre-line text-sm leading-6 text-muted-foreground">{doctor.bio.trim()}</p> : null}
                <Link href={`/patient/doctors/${doctor.id}`} className="mt-5 inline-flex min-h-10 items-center rounded-lg border border-border px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">View details and times</Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
