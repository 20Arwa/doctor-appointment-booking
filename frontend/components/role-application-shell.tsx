"use client";

import { SignOutButton, useAuth } from "@clerk/nextjs";
import {
  CalendarDays,
  CalendarPlus,
  CalendarRange,
  HeartPulse,
  LayoutDashboard,
  Menu,
  ReceiptText,
  Stethoscope,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentProfile, ProfileApiError, type LocalProfile } from "@/lib/profile-api";
import { dashboardPath, type AppRole } from "@/lib/roles";
import { AppShellLoading } from "@/components/app-shell-loading";

type AppNavigationItem = {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
};

const patientNavigation: AppNavigationItem[] = [
  { label: "Dashboard", href: "/patient/dashboard", icon: LayoutDashboard },
  { label: "Book Appointment", href: "/patient/book-appointment", icon: CalendarPlus },
  { label: "My Appointments", href: "/patient/appointments", icon: CalendarDays },
  { label: "Payment History", href: "/patient/payments", icon: ReceiptText },
  { label: "Profile", href: "/patient/profile", icon: UserRound },
];

const doctorNavigation: AppNavigationItem[] = [
  { label: "Dashboard", href: "/doctor/dashboard", icon: LayoutDashboard },
  { label: "My Appointments", href: "/doctor/appointments", icon: CalendarDays },
  { label: "Manage Availability", href: "/doctor/availability", icon: CalendarRange },
  { label: "Profile", href: "/doctor/profile", icon: UserRound },
];

const ProfileContext = createContext<LocalProfile | null>(null);
const UpdateProfileContext = createContext<((profile: LocalProfile) => void) | null>(null);

export function useDashboardProfile() {
  const profile = useContext(ProfileContext);
  if (!profile) throw new Error("useDashboardProfile must be used inside the authenticated app shell");
  return profile;
}

export function useUpdateDashboardProfile() {
  const updateProfile = useContext(UpdateProfileContext);
  if (!updateProfile) throw new Error("useUpdateDashboardProfile must be used inside the authenticated app shell");
  return updateProfile;
}

export function RoleApplicationShell({ requiredRole, children }: { requiredRole: AppRole; children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const hasChecked = useRef(false);
  const mobileNavigation = useRef<HTMLDetailsElement>(null);
  const [status, setStatus] = useState<"checking" | "ready" | "error">("checking");
  const [profile, setProfile] = useState<LocalProfile | null>(null);
  const [error, setError] = useState<string | null>(null);

  const checkProfile = useCallback(async () => {
    try {
      const token = await getToken();
      setStatus("checking");
      setError(null);
      if (!token) throw new ProfileApiError(401, "Your secure sign-in session is not ready. Please sign in again.");

      const currentProfile = await getCurrentProfile(token);
      if (currentProfile.role !== requiredRole) {
        router.replace(dashboardPath(currentProfile.role));
        return;
      }
      setProfile(currentProfile);
      setStatus("ready");
    } catch (cause) {
      if (cause instanceof ProfileApiError && cause.status === 404 && cause.code === "PROFILE_NOT_FOUND") {
        router.replace("/onboarding");
        return;
      }
      setError(cause instanceof Error ? cause.message : "We couldn't verify your Medrella profile. Please try again.");
      setStatus("error");
    }
  }, [getToken, requiredRole, router]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.replace("/sign-in");
      return;
    }
    if (hasChecked.current) return;
    hasChecked.current = true;
    queueMicrotask(() => void checkProfile());
  }, [checkProfile, isLoaded, isSignedIn, router]);

  if (!isLoaded || !isSignedIn || status === "checking") return <AppShellLoading />;

  if (status === "error") {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16">
        <section className="w-full max-w-lg rounded-3xl border border-border bg-card p-8 text-center shadow-sm" aria-labelledby="workspace-error-title">
          <h1 id="workspace-error-title" className="text-2xl font-semibold text-card-foreground">We couldn’t load your workspace</h1>
          <p role="alert" className="mt-3 text-muted-foreground">{error}</p>
          <div className="mt-6 flex flex-col justify-center gap-3 sm:flex-row">
            <button type="button" onClick={() => void checkProfile()} className="min-h-11 rounded-lg bg-primary px-5 py-2.5 font-semibold text-primary-foreground hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Try again</button>
            <Link href="/sign-in" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-border px-5 py-2.5 font-semibold text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Sign in again</Link>
          </div>
        </section>
      </main>
    );
  }

  if (!profile) return <AppShellLoading />;

  const navigation = requiredRole === "patient" ? patientNavigation : doctorNavigation;
  const displayName = `${profile.first_name} ${profile.last_name}`.trim();
  const roleLabel = requiredRole === "patient" ? "Patient workspace" : "Doctor workspace";

  return (
    <ProfileContext.Provider value={profile}>
      <UpdateProfileContext.Provider value={setProfile}>
      <div className="min-h-screen bg-background text-foreground md:flex">
        <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col border-r border-sidebar-border bg-sidebar px-4 py-6 text-sidebar-foreground md:flex">
          <Link href={dashboardPath(requiredRole)} aria-label="Medrella dashboard" className="flex items-center gap-2 px-3 text-xl font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-sidebar-ring">
            <span className="flex size-9 items-center justify-center rounded-full bg-sidebar-primary text-sidebar-primary-foreground"><HeartPulse aria-hidden="true" className="size-5" /></span>
            Medrella
            {/* <span className="text-sidebar-primary">.</span> */}
          </Link>
          <p className="mt-8 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/65">{roleLabel}</p>
          <NavigationLinks items={navigation} pathname={pathname} />
          <div className="mt-auto border-t border-sidebar-border pt-5">
            <p className="truncate px-3 text-sm font-semibold">{displayName}</p>
            <p className="mt-1 truncate px-3 text-xs text-sidebar-foreground/65">{requiredRole === "patient" ? "Patient account" : "Doctor account"}</p>
            <SignOutButton redirectUrl="/">
              <button type="button" className="mt-4 min-h-11 w-full rounded-lg px-3 text-left text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-ring">Sign out</button>
            </SignOutButton>
          </div>
        </aside>

        <div className="min-w-0 flex-1 md:pl-64">
          <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-4 border-b border-border bg-background/95 px-4 backdrop-blur sm:px-6 md:px-8">
            <Link href={dashboardPath(requiredRole)} aria-label="Medrella dashboard" className="text-lg font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring md:hidden">Medrella<span className="text-primary">.</span></Link>
            <p className="hidden text-sm font-medium text-muted-foreground md:block">{roleLabel}</p>
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden max-w-64 truncate text-sm font-medium text-foreground sm:block">{displayName}</span>
              <details className="group relative md:hidden" ref={mobileNavigation}>
                <summary aria-label="Toggle application navigation" className="flex size-11 cursor-pointer list-none items-center justify-center rounded-lg border border-border text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                  <Menu aria-hidden="true" className="size-5 group-open:hidden" />
                  <X aria-hidden="true" className="hidden size-5 group-open:block" />
                </summary>
                <nav aria-label={`${roleLabel} navigation`} className="absolute right-0 top-14 z-40 w-64 rounded-2xl border border-border bg-card p-3 text-card-foreground shadow-xl">
                  <NavigationLinks items={navigation} pathname={pathname} onNavigate={() => mobileNavigation.current?.removeAttribute("open")} mobile />
                  <div className="mt-3 border-t border-border pt-3">
                    <p className="truncate px-3 py-2 text-sm font-semibold">{displayName}</p>
                    <SignOutButton redirectUrl="/">
                      <button type="button" className="min-h-11 w-full rounded-lg px-3 text-left text-sm font-medium text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Sign out</button>
                    </SignOutButton>
                  </div>
                </nav>
              </details>
            </div>
          </header>
          <main className="mx-auto w-full max-w-7xl px-5 py-7 sm:px-7 sm:py-9 lg:px-10 lg:py-11">{children}</main>
        </div>
      </div>
      </UpdateProfileContext.Provider>
    </ProfileContext.Provider>
  );
}

function NavigationLinks({ items, pathname, onNavigate, mobile = false }: {
  items: AppNavigationItem[];
  pathname: string;
  onNavigate?: () => void;
  mobile?: boolean;
}) {
  return (
    <nav aria-label={mobile ? undefined : "Application navigation"} className="mt-4 flex flex-col gap-1">
      {items.map(({ label, href, icon: Icon }) => {
        const isActive = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={isActive ? "page" : undefined}
            onClick={onNavigate}
            className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${mobile
              ? isActive ? "bg-secondary text-secondary-foreground focus-visible:outline-ring" : "text-foreground hover:bg-muted focus-visible:outline-ring"
              : isActive ? "bg-sidebar-accent text-sidebar-accent-foreground focus-visible:outline-sidebar-ring" : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-sidebar-ring"
            }`}
          >
            <Icon aria-hidden="true" className="size-5 shrink-0" />
            <span>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
