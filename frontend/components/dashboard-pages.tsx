"use client";

import { CalendarDays, CalendarRange, UserRound } from "lucide-react";
import Link from "next/link";
import { useDashboardProfile } from "@/components/role-application-shell";
import { PatientDashboardContent } from "@/components/patient-dashboard-content";

export function PatientDashboardPage() {
  const profile = useDashboardProfile();
  const name = `${profile.first_name} ${profile.last_name}`.trim();

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Patient dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Welcome back, {name}</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Your appointment workspace is ready. Find a doctor and keep your care plans organized in one place.</p>
      </header>

      <PatientDashboardContent />

      <section aria-labelledby="patient-shortcuts-title">
        <h2 id="patient-shortcuts-title" className="text-lg font-semibold text-foreground">Quick links</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <ShortcutCard href="/patient/appointments" title="My Appointments" description="View your appointment workspace." icon={CalendarDays} />
          <ShortcutCard href="/patient/profile" title="Profile" description="View your profile section." icon={UserRound} />
        </div>
      </section>
    </div>
  );
}

export function DoctorDashboardPage() {
  const profile = useDashboardProfile();
  const name = `${profile.first_name} ${profile.last_name}`.trim();

  return (
    <div className="space-y-8">
      <header>
        <p className="text-sm font-semibold uppercase tracking-[0.14em] text-primary">Doctor dashboard</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Welcome back, {name}</h1>
        <p className="mt-3 max-w-2xl text-base leading-7 text-muted-foreground">Your appointment workspace is ready. Manage your availability and keep track of your appointments in one place.</p>
      </header>

      <section aria-labelledby="doctor-shortcuts-title">
        <h2 id="doctor-shortcuts-title" className="text-lg font-semibold text-foreground">Your workspace</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <ShortcutCard href="/doctor/appointments" title="My Appointments" description="Open your appointment section." icon={CalendarDays} />
          <ShortcutCard href="/doctor/availability" title="Manage Availability" description="Open your availability section." icon={CalendarRange} />
          <ShortcutCard href="/doctor/profile" title="Profile" description="View your profile section." icon={UserRound} />
        </div>
      </section>
    </div>
  );
}

function ShortcutCard({ href, title, description, icon: Icon }: {
  href: string;
  title: string;
  description: string;
  icon: typeof CalendarDays;
}) {
  return (
    <Link href={href} className="group flex min-h-32 items-start gap-4 rounded-2xl border border-border bg-card p-5 shadow-sm transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><Icon aria-hidden="true" className="size-5" /></span>
      <span>
        <span className="block font-semibold text-card-foreground group-hover:text-primary">{title}</span>
        <span className="mt-1 block text-sm leading-6 text-muted-foreground">{description}</span>
      </span>
    </Link>
  );
}
