import { Suspense } from "react";
import { DoctorDirectory } from "@/components/doctor-directory";

export default function PatientBookAppointmentPage() {
  return (
    <Suspense fallback={<div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground" role="status">Loading doctor directory…</div>}>
      <DoctorDirectory />
    </Suspense>
  );
}
