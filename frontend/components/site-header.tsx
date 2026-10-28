"use client";

import Link from "next/link";
import { Show, UserButton } from "@clerk/nextjs";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-6 sm:px-10 lg:px-12">
        <Link href="/" aria-label="Medrella home" className="text-xl font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          Medrella<span className="text-primary">.</span>
        </Link>
        <nav aria-label="Main navigation" className="flex items-center gap-2 sm:gap-5">
          <a href="#how-it-works" className="hidden text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:inline-flex">How it works</a>
          <Show when="signed-out">
            <Link href="/sign-in" className="rounded-lg px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Sign in</Link>
            <Link href="/sign-up" className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Get started</Link>
          </Show>
          <Show when="signed-in">
            <span className="hidden text-sm text-muted-foreground sm:inline">Welcome to Medrella</span>
            <UserButton />
          </Show>
        </nav>
      </div>
    </header>
  );
}
