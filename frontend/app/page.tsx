import Link from "next/link";
import { ArrowRight, CalendarCheck2, Clock3, Search } from "lucide-react";
import { SiteHeader } from "@/components/site-header";

const steps = [
  {
    number: "01",
    icon: Search,
    title: "Find a doctor",
    description: "Explore doctors by specialty and find the right fit for your care.",
  },
  {
    number: "02",
    icon: Clock3,
    title: "Choose a time",
    description: "View available appointment times and choose what works for you.",
  },
  {
    number: "03",
    icon: CalendarCheck2,
    title: "Stay on top of care",
    description: "Keep your appointments together and manage them in one place.",
  },
];

export default function Home() {
  return (
    <div className="flex min-h-full flex-col">
      <SiteHeader />
      <main className="flex-1">
        <section className="relative isolate overflow-hidden border-b border-border">
          <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-32 -z-10 size-[30rem] rounded-full bg-accent/50 blur-3xl" />
          <div className="mx-auto grid w-full max-w-7xl items-center gap-14 px-6 py-20 sm:px-10 sm:py-28 lg:grid-cols-[1.05fr_0.95fr] lg:gap-20 lg:px-12 lg:py-32">
            <div className="max-w-2xl">
              <p className="mb-6 inline-flex items-center gap-2 rounded-full border border-border bg-card/80 px-4 py-2 text-sm font-medium text-secondary-foreground shadow-sm">
                <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
                Care, made easier to plan
              </p>
              <h1 className="text-5xl font-semibold leading-[1.08] tracking-tight text-foreground sm:text-6xl lg:text-7xl">
                Healthcare appointments, <span className="text-primary">made simpler.</span>
              </h1>
              <p className="mt-7 max-w-xl text-lg leading-8 text-muted-foreground sm:text-xl">
                Find a doctor, book your appointment, and manage your appointments in one place.
              </p>
              <div className="mt-9 flex flex-col gap-3 sm:flex-row">
                <Link href="/sign-up" className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-6 py-3 text-base font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  Get started <ArrowRight aria-hidden="true" className="size-4" />
                </Link>
                <Link href="/sign-in" className="inline-flex min-h-12 items-center justify-center rounded-lg border border-border bg-card px-6 py-3 text-base font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                  Sign in
                </Link>
              </div>
            </div>

            <div aria-label="A calmer way to plan your care" className="relative mx-auto w-full max-w-lg">
              <div className="absolute -left-5 top-10 size-24 rounded-full bg-secondary/80 blur-2xl sm:-left-10 sm:size-36" />
              <div className="relative rounded-[2rem] border border-border bg-card p-5 shadow-xl shadow-primary/10 sm:p-8">
                <div className="flex items-center justify-between border-b border-border pb-5">
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Your care, in one place</p>
                    <p className="mt-1 text-xl font-semibold text-card-foreground">A simpler next step</p>
                  </div>
                  <span className="flex size-12 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground">
                    <CalendarCheck2 aria-hidden="true" className="size-6" />
                  </span>
                </div>
                <div className="space-y-3 pt-5">
                  <div className="flex items-center gap-4 rounded-2xl bg-muted/70 p-4">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-card text-primary shadow-sm"><Search aria-hidden="true" className="size-5" /></span>
                    <div><p className="font-semibold text-card-foreground">Explore your options</p><p className="mt-1 text-sm text-muted-foreground">Find care that fits your needs</p></div>
                  </div>
                  <div className="ml-9 h-5 border-l-2 border-dashed border-border" />
                  <div className="flex items-center gap-4 rounded-2xl bg-muted/70 p-4">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-card text-primary shadow-sm"><Clock3 aria-hidden="true" className="size-5" /></span>
                    <div><p className="font-semibold text-card-foreground">Pick a time</p><p className="mt-1 text-sm text-muted-foreground">Choose from available appointments</p></div>
                  </div>
                  <div className="ml-9 h-5 border-l-2 border-dashed border-border" />
                  <div className="flex items-center gap-4 rounded-2xl bg-primary p-4 text-primary-foreground">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary-foreground/15"><CalendarCheck2 aria-hidden="true" className="size-5" /></span>
                    <div><p className="font-semibold">Keep it organized</p><p className="mt-1 text-sm text-primary-foreground/80">Manage your appointments in one place</p></div>
                  </div>
                </div>
              </div>
              <div className="absolute -bottom-5 -right-4 -z-10 size-28 rounded-full bg-accent/70 blur-2xl sm:-right-8 sm:size-40" />
            </div>
          </div>
        </section>

        <section id="how-it-works" className="mx-auto w-full max-w-7xl px-6 py-20 sm:px-10 sm:py-24 lg:px-12">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">A clearer path to care</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Three steps to a better planned visit</h2>
            <p className="mt-4 text-lg leading-7 text-muted-foreground">From finding a doctor to keeping track of your appointments, Medrella helps make the process feel straightforward.</p>
          </div>
          <ol className="mt-12 grid gap-5 md:grid-cols-3">
            {steps.map(({ number, icon: Icon, title, description }) => (
              <li key={number} className="rounded-2xl border border-border bg-card p-7 shadow-sm sm:p-8">
                <div className="flex items-center justify-between">
                  <span className="flex size-12 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><Icon aria-hidden="true" className="size-5" /></span>
                  <span className="text-sm font-semibold tabular-nums text-muted-foreground">{number}</span>
                </div>
                <h3 className="mt-6 text-xl font-semibold text-card-foreground">{title}</h3>
                <p className="mt-2 leading-7 text-muted-foreground">{description}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t border-border bg-card/60">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-7 sm:flex-row sm:items-center sm:justify-between sm:px-10 lg:px-12">
          <Link href="/" className="text-lg font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Medrella</Link>
          <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
            <a href="#how-it-works" className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">How it works</a>
            <Link href="/sign-in" className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Sign in</Link>
            <Link href="/sign-up" className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Get started</Link>
          </nav>
          <p className="text-sm text-muted-foreground">© Medrella</p>
        </div>
      </footer>
    </div>
  );
}
