"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useHomepageRole } from "@/components/homepage-role-provider";

const SECTION_IDS = ["hero", "how-it-works", "browse-by-specialty", "why-medrella", "faq"];

function scrollToHashTarget(behavior: ScrollBehavior = "smooth") {
  const id = window.location.hash.slice(1);
  if (!id) return;
  const motionBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : behavior;
  document.getElementById(decodeURIComponent(id))?.scrollIntoView({ behavior: motionBehavior, block: "start" });
}

export function HomepageScrollSpy() {
  const pathname = usePathname();
  const role = useHomepageRole();

  useEffect(() => {
    if (pathname !== "/" || role === "loading") return;

    let frame = 0;
    let isInitializingHash = Boolean(window.location.hash);
    const scheduleHashScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        scrollToHashTarget("smooth");
        window.setTimeout(() => { isInitializingHash = false; }, 900);
      });
    };

    if (isInitializingHash) scheduleHashScroll();

    const sections = SECTION_IDS
      .map((id) => document.getElementById(id))
      .filter((section): section is HTMLElement => section !== null);

    const observer = new IntersectionObserver(() => {
      if (isInitializingHash) return;

      const activationLine = (document.querySelector("header.sticky")?.getBoundingClientRect().bottom ?? 64) + 8;
      const containingSection = sections.find((section) => {
        const bounds = section.getBoundingClientRect();
        return bounds.top <= activationLine && bounds.bottom > activationLine;
      });
      const activeSection = containingSection ?? sections
        .map((section) => ({ section, distance: Math.abs(section.getBoundingClientRect().top - activationLine) }))
        .sort((first, second) => first.distance - second.distance)[0]?.section;

      if (!activeSection) return;
      const nextUrl = activeSection.id === "hero" ? "/" : `/#${activeSection.id}`;
      const currentUrl = `${window.location.pathname}${window.location.hash}`;
      if (currentUrl !== nextUrl) {
        window.history.replaceState(window.history.state, "", nextUrl);
      }
    }, { threshold: 0, rootMargin: "-1px 0px -1px 0px" });

    sections.forEach((section) => observer.observe(section));

    const onHistoryNavigation = () => {
      isInitializingHash = Boolean(window.location.hash);
      if (isInitializingHash) scheduleHashScroll();
    };
    const onSectionNavigation = () => {
      isInitializingHash = true;
      scheduleHashScroll();
    };
    window.addEventListener("popstate", onHistoryNavigation);
    window.addEventListener("hashchange", onHistoryNavigation);
    window.addEventListener("homepage-section-navigation", onSectionNavigation);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("popstate", onHistoryNavigation);
      window.removeEventListener("hashchange", onHistoryNavigation);
      window.removeEventListener("homepage-section-navigation", onSectionNavigation);
    };
  }, [pathname, role]);

  return null;
}
