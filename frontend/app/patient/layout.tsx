import { Suspense, type ReactNode } from "react";
import { AppShellLoading } from "@/components/app-shell-loading";
import { ProtectedRoleLayout } from "@/components/protected-role-layout";

export default function PatientLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<AppShellLoading />}>
      <ProtectedRoleLayout role="patient">{children}</ProtectedRoleLayout>
    </Suspense>
  );
}
