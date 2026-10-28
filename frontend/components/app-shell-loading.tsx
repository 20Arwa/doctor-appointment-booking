export function AppShellLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16">
      <div role="status" aria-live="polite" className="flex items-center gap-3 rounded-2xl border border-border bg-card px-6 py-5 text-foreground shadow-sm">
        <span aria-hidden="true" className="size-5 animate-spin rounded-full border-2 border-primary/25 border-t-primary motion-reduce:animate-none" />
        <span>Loading your Medrella workspace…</span>
      </div>
    </main>
  );
}
