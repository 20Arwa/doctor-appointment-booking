import { ArrowLeft, Clock3 } from "lucide-react";
import Link from "next/link";
import { dashboardPath, type AppRole } from "@/lib/roles";

export function SectionPlaceholder({ role, title, description }: {
  role: AppRole;
  title: string;
  description: string;
}) {
  return (
    <section className="mx-auto max-w-2xl rounded-3xl border border-border bg-card p-7 shadow-sm sm:p-10" aria-labelledby="section-title">
      <span aria-hidden="true" className="flex size-12 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><Clock3 className="size-5" /></span>
      <p className="mt-6 text-sm font-semibold uppercase tracking-[0.14em] text-primary">Coming in a later phase</p>
      <h1 id="section-title" className="mt-2 text-3xl font-semibold tracking-tight text-card-foreground">{title}</h1>
      <p className="mt-3 leading-7 text-muted-foreground">{description}</p>
      <p className="mt-4 rounded-xl bg-muted p-4 text-sm leading-6 text-muted-foreground">This section is not available yet. No appointments, profiles, or availability are being changed here.</p>
      <Link href={dashboardPath(role)} className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-lg px-4 py-2.5 font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <ArrowLeft aria-hidden="true" className="size-4" /> Back to dashboard
      </Link>
    </section>
  );
}
