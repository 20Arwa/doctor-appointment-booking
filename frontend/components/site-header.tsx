"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { HeartPulse } from "lucide-react";
import { SiteAuthActions } from "@/components/site-auth-actions";
import { useHomepageRole } from "@/components/homepage-role-provider";
import { HomepageSectionNavigation } from "@/components/homepage-section-navigation";
import { NotificationBell } from "@/components/notification-bell";

export function SiteHeader() {
  const role = useHomepageRole();
  const { isLoaded, isSignedIn } = useAuth();
  const notificationRole = role === "patient" || role === "doctor" ? role : null;

  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
      <div className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-6 sm:px-10 lg:px-12">
        {/* <Link href="/" aria-label="Medrella home" className="text-xl font-semibold tracking-tight text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
          Medrellafgdg<span className="text-primary">.</span>
        </Link> */}
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
        <div className="ml-auto flex items-center gap-2 md:ml-0 md:gap-5">
          <HomepageSectionNavigation role={role} />
          {isLoaded && isSignedIn && role !== "unknown" && <NotificationBell role={notificationRole} />}
          <SiteAuthActions />
        </div>
      </div>
    </header>
  );
}
