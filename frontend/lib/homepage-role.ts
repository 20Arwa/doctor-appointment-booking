import type { AppRole } from "@/lib/roles";

export type HomepageRole = AppRole | "guest" | "unknown" | "loading";
export type HomepageProfileResolution = { userId: string; role: AppRole | null } | null;

export function resolveHomepageRole(isLoaded: boolean, isSignedIn: boolean, userId: string | undefined, profile: HomepageProfileResolution): HomepageRole {
  if (!isLoaded) return "loading";
  if (!isSignedIn) return "guest";
  if (!userId || profile?.userId !== userId) return "loading";
  return profile.role ?? "unknown";
}
