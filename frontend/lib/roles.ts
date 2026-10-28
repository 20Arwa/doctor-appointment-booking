import type { LocalProfile } from "@/lib/profile-api";

export type AppRole = LocalProfile["role"];

export function dashboardPath(role: AppRole) {
  return role === "patient" ? "/patient/dashboard" : "/doctor/dashboard";
}
