export const MEDICAL_SPECIALTIES = [
  "Cardiology",
  "Dermatology",
  "Endocrinology",
  "ENT",
  "Family Medicine",
  "Gastroenterology",
  "General Practice",
  "General Surgery",
  "Gynecology",
  "Internal Medicine",
  "Neurology",
  "Oncology",
  "Ophthalmology",
  "Orthopedics",
  "Pediatrics",
  "Psychiatry",
  "Pulmonology",
  "Urology",
] as const;

export function resolveMedicalSpecialty(value: string | null | undefined) {
  if (!value?.trim()) return "all";
  const normalized = value.trim().toLocaleLowerCase("en");
  return MEDICAL_SPECIALTIES.find((specialty) => specialty.toLocaleLowerCase("en") === normalized) ?? "all";
}

export function matchesMedicalSpecialty(doctorSpecialty: string, selectedSpecialty: string) {
  return selectedSpecialty === "all"
    || doctorSpecialty.trim().toLocaleLowerCase("en") === selectedSpecialty.trim().toLocaleLowerCase("en");
}
