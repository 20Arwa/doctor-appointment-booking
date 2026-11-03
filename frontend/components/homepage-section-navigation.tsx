"use client";

import Link from "next/link";
import { Menu } from "lucide-react";
import type { MouseEvent } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type HomepageRoleForNavigation = "guest" | "patient" | "doctor" | "unknown" | "loading";

const sectionLinks = [
  { label: "How it works", href: "/#how-it-works" },
  { label: "Browse by Specialty", href: "/#browse-by-specialty", patientOnly: true },
  { label: "Why Medrella", href: "/#why-medrella" },
  { label: "FAQ", href: "/#faq" },
];

export function HomepageSectionNavigation({ role }: { role: HomepageRoleForNavigation }) {
  const links = sectionLinks.filter((item) => !item.patientOnly || role === "guest" || role === "patient");

  function handleSectionClick(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (window.location.pathname !== "/") return;
    const targetId = href.split("#")[1];
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) return;

    event.preventDefault();
    window.history.pushState(window.history.state, "", href);
    window.dispatchEvent(new Event("homepage-section-navigation"));
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    target.scrollIntoView({ behavior, block: "start" });
  }

  return (
    <>
      <nav aria-label="Homepage sections" className="hidden items-center gap-4 lg:flex">
        {links.map((item) => <Link key={item.href} href={item.href} onClick={(event) => handleSectionClick(event, item.href)} className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">{item.label}</Link>)}
      </nav>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Open homepage sections" className="flex size-10 items-center justify-center rounded-lg border border-border text-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring lg:hidden">
          <Menu aria-hidden="true" className="size-5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {links.map((item) => <DropdownMenuItem key={item.href} asChild><Link href={item.href} onClick={(event) => handleSectionClick(event, item.href)}>{item.label}</Link></DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
