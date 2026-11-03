"use client";

import { useAuth, useClerk, useUser } from "@clerk/nextjs";
import Link from "next/link";
import Image from "next/image";
import { ArrowRight, LogOut, LayoutDashboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { dashboardPath } from "@/lib/roles";
import { useHomepageRole } from "@/components/homepage-role-provider";

export function SiteAuthActions({ hero = false }: { hero?: boolean }) {
  const { isLoaded, isSignedIn } = useAuth();
  const { signOut } = useClerk();
  const { user } = useUser();
  const role = useHomepageRole();
  const destination = role === "patient" || role === "doctor" ? dashboardPath(role) : "/auth/continue";

  if (!isLoaded) return null;
  if (!isSignedIn) {
    return hero ? (
      <>
        <Button asChild size="lg"><Link href="/sign-up">Get started <ArrowRight aria-hidden="true" /></Link></Button>
        <Button asChild size="lg" variant="outline"><Link href="/sign-in">Sign in</Link></Button>
      </>
    ) : (
      <>
        <Link href="/sign-in" className="rounded-lg px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Sign in</Link>
        <Link href="/sign-up" className="rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">Get started</Link>
      </>
    );
  }

  if (hero) return <Button asChild size="lg"><Link href={destination}>Go to Dashboard <ArrowRight aria-hidden="true" /></Link></Button>;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="Open profile menu" className="flex size-10 items-center justify-center overflow-hidden rounded-full border border-border bg-secondary text-sm font-semibold text-secondary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {user?.imageUrl ? <Image src={user.imageUrl} alt="" width={40} height={40} unoptimized className="size-full object-cover" /> : user?.firstName?.slice(0, 1) ?? "U"}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild><Link href={destination} className="flex w-full items-center gap-2"><LayoutDashboard aria-hidden="true" className="size-4" />Dashboard</Link></DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut({ redirectUrl: "/" })} className="gap-2 text-destructive focus:text-destructive"><LogOut aria-hidden="true" className="size-4" />Log out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
