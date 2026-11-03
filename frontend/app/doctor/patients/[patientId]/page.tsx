import { DoctorPatientDetailsPage } from "@/components/doctor-patient-details-page";

export default async function DoctorPatientDetailsRoute({ params }: { params: Promise<{ patientId: string }> }) {
  const { patientId } = await params;
  return <DoctorPatientDetailsPage patientId={patientId} />;
}
