"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, ArrowUpRight, Baby, Bone, Brain, Ear, Eye, HeartPulse, Microscope, Ribbon, Stethoscope, Wind } from "lucide-react";
import { getDoctors, type DirectoryDoctor } from "@/lib/profile-api";
import { useHomepageRole } from "@/components/homepage-role-provider";
import { MEDICAL_SPECIALTIES } from "@/lib/medical-specialties";

const specialtyIcons: Record<(typeof MEDICAL_SPECIALTIES)[number], typeof Stethoscope> = {
  Cardiology: HeartPulse,
  Dermatology: Activity,
  Endocrinology: Microscope,
  ENT: Ear,
  "Family Medicine": HeartPulse,
  Gastroenterology: Activity,
  "General Practice": Stethoscope,
  "General Surgery": Activity,
  Gynecology: HeartPulse,
  "Internal Medicine": Stethoscope,
  Neurology: Brain,
  Oncology: Ribbon,
  Ophthalmology: Eye,
  Orthopedics: Bone,
  Pediatrics: Baby,
  Psychiatry: Brain,
  Pulmonology: Wind,
  Urology: Activity,
};

function normalizeSpecialty(value: string) {
  return value.trim().toLocaleLowerCase("en");
}

export function HomeSpecialties() {
  const role = useHomepageRole();
  const [doctors, setDoctors] = useState<DirectoryDoctor[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    void getDoctors()
      .then((result) => { if (active) setDoctors(result); })
      .catch(() => { if (active) setUnavailable(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const specialtiesWithDoctors = new Set(doctors.map((doctor) => normalizeSpecialty(doctor.specialty)));
  const availableSpecialties = MEDICAL_SPECIALTIES.filter((specialty) => specialtiesWithDoctors.has(normalizeSpecialty(specialty)));
  if (role !== "guest" && role !== "patient") return null;

  return (
    <section id="browse-by-specialty" className="scroll-mt-16 border-b border-border bg-secondary/20">
      <div className="mx-auto w-full max-w-7xl px-6 py-20 sm:px-10 sm:py-24 lg:px-12">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-primary">Explore care</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">Browse by specialty</h2>
            <p className="mt-4 text-lg leading-7 text-muted-foreground">Start with the kind of care you are looking for, then explore doctors and available appointment times.</p>
          </div>
          <Link href="/patient/book-appointment" className="inline-flex min-h-10 items-center text-sm font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">Browse all doctors <ArrowUpRight aria-hidden="true" className="ml-1 size-4" /></Link>
        </div>

        {loading ? <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Loading doctor specialties">{[0, 1, 2].map((item) => <div key={item} className="h-36 animate-pulse rounded-2xl border border-border bg-card motion-reduce:animate-none" />)}</div> : null}
        {!loading && unavailable ? <p className="mt-10 rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground" role="status">Doctor specialties are temporarily unavailable. You can still browse the full doctor directory.</p> : null}
        {!loading && !unavailable && availableSpecialties.length === 0 ? <p className="mt-10 rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground" role="status">No doctor specialties are currently available.</p> : null}
        {!loading && !unavailable && availableSpecialties.length > 0 ? (
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {availableSpecialties.map((specialty) => {
              const Icon = specialtyIcons[specialty];
              return (
                <li key={specialty}>
                  <Link href={`/patient/book-appointment?specialty=${encodeURIComponent(specialty)}`} className="group relative flex min-h-36 items-center gap-5 overflow-hidden rounded-2xl border border-border border-l-4 border-l-primary bg-card p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:bg-secondary/35 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring motion-reduce:transform-none sm:p-6">
                    <span aria-hidden="true" className="absolute -right-8 -top-8 size-28 rounded-full border-[18px] border-secondary/60 transition-transform group-hover:scale-110 motion-reduce:transform-none" />
                    <span className="relative flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-sm"><Icon aria-hidden="true" className="size-6" /></span>
                    <span className="relative min-w-0 flex-1">
                      <span className="block text-lg font-semibold tracking-tight text-card-foreground">{specialty}</span>
                      <span className="mt-1.5 block text-sm text-muted-foreground">Explore available doctors</span>
                    </span>
                    <ArrowUpRight aria-hidden="true" className="relative size-5 shrink-0 text-primary transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 motion-reduce:transform-none" />
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
