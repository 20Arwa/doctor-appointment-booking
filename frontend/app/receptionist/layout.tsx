import { Suspense, type ReactNode } from "react";
import { AppShellLoading } from "@/components/app-shell-loading";
import { ProtectedRoleLayout } from "@/components/protected-role-layout";

export default function ReceptionistLayout({ children }: { children: ReactNode }) {
  return <Suspense fallback={<AppShellLoading />}><ProtectedRoleLayout role="receptionist">{children}</ProtectedRoleLayout></Suspense>;
}
