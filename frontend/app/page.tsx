import Link from "next/link";
import { CalendarDays, CalendarCheck2, Clock3, Cross, HeartPulse, Pill, Search, Stethoscope } from "lucide-react";
import { SiteHeader } from "@/components/site-header";
import { SiteAuthActions } from "@/components/site-auth-actions";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { HomeSpecialties } from "@/components/home-specialties";
import { HomepageRoleProvider } from "@/components/homepage-role-provider";
import { HomepageScrollSpy } from "@/components/homepage-scroll-spy";

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

const benefits = [
  { icon: Search, title: "Find the right doctor", description: "Browse doctors by name or specialty, and review their profiles and consultation fees." },
  { icon: Clock3, title: "Choose a time that works", description: "View a doctor’s available appointment slots and request a different time for an upcoming confirmed visit." },
  { icon: CalendarCheck2, title: "Keep visits organized", description: "Review upcoming, past, and cancelled appointments from your patient workspace." },
  { icon: HeartPulse, title: "See payment records", description: "Check appointment payment history with the related visit and doctor details." },
];

const faqs = [
  { question: "How do I create a patient or doctor account?", answer: "Sign up through Medrella, then complete onboarding and choose either a patient or doctor profile. Doctor onboarding also asks for a specialty." },
  { question: "How can I find doctors by specialty?", answer: "Open Book Appointment to search by doctor name or choose a specialty. You can also start from a specialty card on this page." },
  { question: "How do I book a visit?", answer: "Choose a doctor, select one of their available times, and complete the payment flow. The appointment is confirmed after payment is verified." },
  { question: "Can I reschedule an appointment?", answer: "For an upcoming confirmed appointment, choose Reschedule in My Appointments and select from the available times shown." },
  { question: "How does cancellation work?", answer: "For an eligible confirmed appointment, review the cancellation estimate shown before confirming. The amount is recalculated when cancellation is submitted; the estimate does not guarantee a refund." },
  { question: "Where can I review past visits and payments?", answer: "Patient workspaces show upcoming, past, and cancelled appointments. Payment History lists payment records with related visit details when available." },
  { question: "What can doctors manage in Medrella?", answer: "Doctors can manage their availability, review scheduled and past appointments, reschedule appointments, and mark eligible visits as completed." },
];

export default function Home() {
  return (
    <HomepageRoleProvider>
    <div className="flex min-h-full flex-col">
      <HomepageScrollSpy />
      <SiteHeader />
      <main className="flex-1">
        <section id="hero" className="scroll-mt-16 relative isolate overflow-hidden border-b border-border">
          <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-32 -z-10 size-[30rem] rounded-full bg-accent/50 blur-3xl" />
          <div className="mx-auto grid w-full max-w-7xl items-center gap-14 px-6 py-20 sm:px-10 sm:py-28 lg:grid-cols-[1.05fr_0.95fr] lg:gap-20 lg:px-12 lg:py-7.5">
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
                <SiteAuthActions hero />
              </div>
            </div>

            <div aria-label="Illustrative preview of Medrella appointment tools" className="relative mx-auto flex min-h-[25rem] w-full max-w-xl items-center justify-center sm:min-h-[30rem]">
              <div aria-hidden="true" className="absolute inset-x-10 inset-y-8 rounded-full bg-secondary/50 blur-3xl" />
              <div className="relative z-10 w-[min(100%,22rem)] rounded-2xl border border-border bg-card p-5 shadow-xl shadow-primary/10 sm:p-6">
                <div className="flex items-center justify-between border-b border-border pb-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Illustrative preview</p>
                    <p className="mt-1 text-lg font-semibold text-card-foreground">Appointment</p>
                  </div>
                  <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground">
                    <CalendarCheck2 aria-hidden="true" className="size-5" />
                  </span>
                </div>
                <div className="mt-4 flex items-center gap-3 rounded-xl bg-muted/60 p-3">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground"><Stethoscope aria-hidden="true" className="size-5" /></span>
                  <div className="min-w-0"><p className="truncate font-semibold text-card-foreground">Sample doctor profile</p><p className="mt-0.5 text-sm text-muted-foreground">Sample specialty</p></div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div className="rounded-xl border border-border p-3">
                    <p className="text-xs text-muted-foreground">Date</p>
                    <p className="mt-1 font-medium text-card-foreground">Sample date</p>
                  </div>
                  <div className="rounded-xl border border-border p-3">
                    <p className="text-xs text-muted-foreground">Time</p>
                    <p className="mt-1 font-medium text-card-foreground">Sample time</p>
                  </div>
                </div>
                <div className="mt-4 flex items-center gap-2 rounded-lg bg-secondary/60 px-3 py-2 text-sm text-secondary-foreground">
                  <CalendarDays aria-hidden="true" className="size-4 shrink-0" />
                  <span>Illustrative appointment details</span>
                </div>
              </div>

              <div className="absolute right-0 top-4 z-20 w-40 rounded-xl border border-border bg-card p-3 shadow-lg shadow-primary/10 sm:-right-2 sm:top-8 sm:w-48">
                <div className="flex items-center gap-2 text-sm font-semibold text-card-foreground">
                  <span className="flex size-8 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"><Search aria-hidden="true" className="size-4" /></span>
                  Doctor
                </div>
                <p className="mt-3 rounded-lg border border-border bg-background px-3 py-2 text-sm text-muted-foreground">Example doctor</p>
              </div>

              <div className="absolute bottom-2 left-0 z-20 w-44 rounded-xl border border-border bg-card p-3 shadow-lg shadow-primary/10 sm:-left-2 sm:bottom-5 sm:w-52">
                <div className="flex items-center gap-3">
                  <span className="flex size-10 items-center justify-center rounded-xl bg-secondary text-secondary-foreground"><CalendarDays aria-hidden="true" className="size-5" /></span>
                  <div><p className="text-sm font-semibold text-card-foreground">Availability</p><p className="mt-0.5 text-xs text-muted-foreground">Illustrative calendar</p></div>
                </div>
                <div aria-hidden="true" className="mt-3 grid grid-cols-7 gap-1 text-center text-[10px] text-muted-foreground">
                  {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <span key={`${day}-${index}`} className="py-1">{day}</span>)}
                  {Array.from({ length: 7 }, (_, index) => <span key={index} className={`rounded-md py-1 ${index === 2 ? "bg-primary text-primary-foreground" : ""}`}>{index + 1}</span>)}
                </div>
              </div>

              <span aria-hidden="true" className="absolute left-5 top-10 z-20 flex size-10 items-center justify-center rounded-xl border border-primary/15 bg-secondary text-secondary-foreground shadow-sm sm:left-8 sm:top-12 sm:size-11"><HeartPulse className="size-5" /></span>
              <span aria-hidden="true" className="absolute right-2 top-[38%] z-20 flex size-9 items-center justify-center rounded-xl border border-primary/15 bg-accent/70 text-accent-foreground shadow-sm sm:right-4 sm:size-10"><Pill className="size-4 sm:size-5" /></span>
              <span aria-hidden="true" className="absolute left-3 top-[54%] z-20 flex size-9 items-center justify-center rounded-xl border border-primary/15 bg-secondary text-secondary-foreground shadow-sm sm:left-5 sm:size-10"><Stethoscope className="size-4 sm:size-5" /></span>
              <span aria-hidden="true" className="absolute bottom-8 right-8 z-20 flex size-10 items-center justify-center rounded-xl border border-primary/15 bg-secondary text-secondary-foreground shadow-sm sm:bottom-12 sm:right-12"><Cross className="size-5" /></span>
              <span aria-hidden="true" className="absolute right-5 top-[62%] z-20 hidden size-9 items-center justify-center rounded-xl border border-primary/15 bg-accent/70 text-accent-foreground shadow-sm sm:flex"><CalendarCheck2 className="size-4" /></span>
            </div>
          </div>
        </section>

        <section id="how-it-works" className="scroll-mt-16 border-b border-border bg-card/40">
          <div className="mx-auto w-full max-w-7xl px-6 py-20 sm:px-10 sm:py-24 lg:px-12">
          <div className="mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">A clearer path to care</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Three steps to a better planned visit</h2>
            <p className="mt-4 text-lg leading-7 text-muted-foreground">From finding a doctor to keeping track of your appointments, Medrella helps make the process feel straightforward.</p>
          </div>
          <ol className="relative mt-14 grid gap-5 before:absolute before:left-[16.7%] before:right-[16.7%] before:top-[3.25rem] before:hidden before:h-px before:bg-primary/35 before:content-[''] md:grid-cols-3 md:gap-6 md:before:block">
            {steps.map(({ number, icon: Icon, title, description }) => (
              <li key={number} className="relative rounded-2xl border border-primary/20 border-t-4 border-t-primary bg-card p-6 shadow-sm transition-shadow hover:shadow-md sm:p-8">
                <div className="flex items-center gap-3">
                  <span className="relative z-10 flex size-12 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm"><Icon aria-hidden="true" className="size-5" /></span>
                  <span className="rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-bold tabular-nums tracking-[0.12em] text-primary">STEP {number}</span>
                </div>
                <h3 className="mt-7 text-xl font-semibold tracking-tight text-card-foreground">{title}</h3>
                <p className="mt-3 leading-7 text-muted-foreground">{description}</p>
              </li>
            ))}
          </ol>
          </div>
        </section>

        <HomeSpecialties />

        <section id="why-medrella" className="scroll-mt-16 relative isolate overflow-hidden border-y border-primary/20 bg-primary text-primary-foreground">
          <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-32 -z-10 size-96 rounded-full border-[3rem] border-primary-foreground/5" />
          <div className="mx-auto grid w-full max-w-7xl gap-10 px-6 py-20 sm:px-10 sm:py-24 lg:grid-cols-[0.78fr_1.22fr] lg:items-center lg:gap-16 lg:px-12">
            <div className="max-w-lg">
              <p className="inline-flex items-center gap-2 rounded-full border border-primary-foreground/20 bg-primary-foreground/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.14em] text-primary-foreground/90">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-primary-foreground" />Designed around your visit
              </p>
              <h2 className="mt-5 text-3xl font-semibold tracking-tight sm:text-4xl">Why choose Medrella?</h2>
              <p className="mt-4 text-base leading-7 text-primary-foreground/75 sm:text-lg">From finding a doctor to keeping track of the details, the tools you need stay in one thoughtful workspace.</p>
              <div className="mt-7 h-px w-20 bg-primary-foreground/35" />
              <p className="mt-4 text-sm font-medium text-primary-foreground/85">A clearer path from discovery to follow-up.</p>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2">
              {benefits.map(({ icon: Icon, title, description }, index) => (
                <li key={title} className={`group relative overflow-hidden rounded-2xl border border-primary-foreground/20 p-5 transition-colors hover:bg-primary-foreground/15 sm:p-6 ${index === 0 ? "bg-primary-foreground/15" : "bg-primary-foreground/8"}`}>
                  <div className="flex items-start justify-between gap-4">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-primary-foreground/15 bg-primary-foreground/15 text-primary-foreground shadow-sm transition-colors group-hover:bg-primary-foreground/20"><Icon aria-hidden="true" className="size-5" /></span>
                    <span className="text-xs font-bold tabular-nums tracking-[0.14em] text-primary-foreground/55">0{index + 1}</span>
                  </div>
                  <h3 className="mt-5 text-lg font-semibold tracking-tight">{title}</h3>
                  <p className="mt-2 text-sm leading-6 text-primary-foreground/75">{description}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section id="faq" className="scroll-mt-16 border-b border-border bg-secondary/25">
          <div className="mx-auto grid w-full max-w-7xl gap-9 px-6 py-20 sm:px-10 sm:py-24 lg:grid-cols-[0.72fr_1.28fr] lg:gap-16 lg:px-12">
            <div className="max-w-md">
              <span className="flex size-12 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 text-primary"><HeartPulse aria-hidden="true" className="size-5" /></span>
              <p className="mt-6 text-sm font-semibold uppercase tracking-[0.16em] text-primary">Helpful details</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Frequently asked questions</h2>
              <p className="mt-4 leading-7 text-muted-foreground">Quick, practical answers for patients and doctors using Medrella.</p>
            </div>
            <Accordion type="single" collapsible className="rounded-2xl border border-border border-l-4 border-l-primary bg-card px-5 shadow-sm sm:px-7">
              {faqs.map(({ question, answer }, index) => (
                <AccordionItem key={question} value={`faq-${index}`}>
                  <AccordionTrigger className="py-5 sm:py-6">
                    <span className="flex items-center gap-4">
                      <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-xs font-bold tabular-nums text-secondary-foreground">{String(index + 1).padStart(2, "0")}</span>
                      <span>{question}</span>
                    </span>
                  </AccordionTrigger>
                  <AccordionContent>{answer}</AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>
      </main>

      <footer className="border-t border-border bg-card/60">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-5 px-6 py-7 sm:flex-row sm:items-center sm:justify-between sm:px-10 lg:px-12">
          {/* <Link href="/" className="text-lg font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Medrella</Link> */}
          <Link
            href="/"
            aria-label="Medrella home"
            className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground"
          >
            <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <HeartPulse className="size-5" aria-hidden="true" />
            </span>

            <span>
              Medrella
              {/* <span className="text-primary">.</span> */}
            </span>
          </Link>
          <nav aria-label="Footer navigation" className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-muted-foreground">
            {/* <a href="#how-it-works" className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">How it works</a> */}
            {/* <Link href="/sign-in" className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Sign in</Link> */}
            {/* <Link href="/sign-up" className="transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Get started</Link> */}
          </nav>
          <p className="text-sm text-muted-foreground">© Medrella</p>
        </div>
      </footer>
    </div>
    </HomepageRoleProvider>
  );
}
