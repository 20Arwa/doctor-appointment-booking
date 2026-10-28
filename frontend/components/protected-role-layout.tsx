import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import type { AppRole } from "@/lib/roles";
import { RoleApplicationShell } from "@/components/role-application-shell";

export async function ProtectedRoleLayout({ role, children }: { role: AppRole; children: ReactNode }) {
  const clerkAuth = await auth();
  if (!clerkAuth.isAuthenticated) redirect("/sign-in");

  return <RoleApplicationShell requiredRole={role}>{children}</RoleApplicationShell>;
}
