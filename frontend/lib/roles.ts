import type { LocalProfile } from "@/lib/profile-api";

export type AppRole = LocalProfile["role"];

export function dashboardPath(role: AppRole) {
  if (role === "patient") return "/patient/dashboard";
  if (role === "receptionist") return "/receptionist/dashboard";
  return "/doctor/dashboard";
}
