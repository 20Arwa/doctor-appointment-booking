import { DoctorBookingPage } from "@/components/doctor-booking-page";

export default async function PatientDoctorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <DoctorBookingPage doctorId={id} />;
}
