import Link from "next/link";
import { ArrowLeft, HeartPulse } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="relative flex min-h-screen flex-1 items-center justify-center overflow-hidden px-6 py-16">
      <div aria-hidden="true" className="pointer-events-none absolute -right-24 -top-28 size-96 rounded-full bg-accent/40 blur-3xl" />
      <section className="relative w-full max-w-xl rounded-3xl border border-border bg-card p-8 text-center shadow-sm sm:p-12" aria-labelledby="not-found-title">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-secondary text-secondary-foreground"><HeartPulse aria-hidden="true" className="size-7" /></span>
        <p className="mt-6 text-sm font-semibold uppercase tracking-[0.16em] text-primary">404 · Page not found</p>
        <h1 id="not-found-title" className="mt-3 text-3xl font-semibold tracking-tight text-card-foreground sm:text-4xl">We can’t find that page</h1>
        <p className="mt-4 text-base leading-7 text-muted-foreground">The page may have moved, or the address may be incorrect.</p>
        <Button asChild size="lg" className="mt-8"><Link href="/"><ArrowLeft aria-hidden="true" /> Return to homepage</Link></Button>
      </section>
    </main>
  );
}
