import { z } from "zod";

const localProfileSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string().email(),
  phone: z.string().nullable(),
  role: z.enum(["patient", "doctor"]),
  is_active: z.boolean(),
  profile: z.object({
    id: z.string().uuid(),
    specialty: z.string().optional(),
    bio: z.string().nullable().optional(),
    date_of_birth: z.string().nullable().optional(),
    gender: z.string().nullable().optional(),
  }),
});

const doctorSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  specialty: z.string(),
  bio: z.string().nullable(),
});

const appointmentSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["confirmed", "cancelled", "completed"]),
  availability_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  doctor_id: z.string().uuid(),
  doctor_first_name: z.string(),
  doctor_last_name: z.string(),
  specialty: z.string(),
  patient_id: z.string().uuid(),
  patient_first_name: z.string(),
  patient_last_name: z.string(),
  reason: z.string().nullable(),
});

const availabilitySlotSchema = z.object({
  id: z.string().uuid(),
  doctor_id: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
});

export type LocalProfile = z.infer<typeof localProfileSchema>;
export type DirectoryDoctor = z.infer<typeof doctorSchema>;
export type PatientAppointment = z.infer<typeof appointmentSchema>;
export type AvailabilitySlot = z.infer<typeof availabilitySlotSchema>;

type ValidationDetail = { path: string; message: string };

export class ProfileApiError extends Error {
  status: number;
  code?: string;
  details: ValidationDetail[];

  constructor(status: number, message: string, code?: string, details: ValidationDetail[] = []) {
    super(message);
    this.name = "ProfileApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function apiBaseUrl() {
  const base = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("The backend API URL is not configured.");
  return `${base}/api/v1`;
}

async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");

  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
  } catch {
    throw new ProfileApiError(0, "We couldn't reach Medrella right now. Check your connection and try again.");
  }

  let payload: unknown;
  if (response.status === 204) return undefined as T;
  try {
    payload = await response.json();
  } catch {
    throw new ProfileApiError(response.status, "The server returned an unexpected response. Please try again.");
  }

  if (!response.ok) {
    const error = z.object({
      error: z.object({
        code: z.string().optional(),
        message: z.string().optional(),
        details: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
      }).optional(),
    }).safeParse(payload);
    throw new ProfileApiError(
      response.status,
      error.success ? error.data.error?.message ?? "The request could not be completed." : "The request could not be completed.",
      error.success ? error.data.error?.code : undefined,
      error.success ? error.data.error?.details : undefined,
    );
  }

  return payload as T;
}

export async function getCurrentProfile(token: string): Promise<LocalProfile> {
  const payload = await request<unknown>(token, "/users/me");
  const parsed = localProfileSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete profile response.");
  return parsed.data;
}

export async function getDoctors(token: string): Promise<DirectoryDoctor[]> {
  const payload = await request<unknown>(token, "/doctors");
  const parsed = z.array(doctorSchema).safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete doctor list.");
  return parsed.data;
}

export async function getDoctor(token: string, doctorId: string): Promise<DirectoryDoctor> {
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}`);
  const parsed = doctorSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete doctor profile.");
  return parsed.data;
}

export async function getDoctorSlots(token: string, doctorId: string, from: string, to?: string): Promise<AvailabilitySlot[]> {
  const query = new URLSearchParams({ from });
  if (to) query.set("to", to);
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}/slots?${query.toString()}`);
  const parsed = z.array(availabilitySlotSchema).safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete availability list.");
  return parsed.data;
}

export async function createDoctorSlot(token: string, doctorId: string, slot: {
  date: string;
  start_time: string;
  end_time: string;
}): Promise<AvailabilitySlot> {
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}/slots`, {
    method: "POST",
    body: JSON.stringify({ slots: [slot] }),
  });
  const parsed = z.array(availabilitySlotSchema).safeParse(payload);
  if (!parsed.success || parsed.data.length !== 1) {
    throw new ProfileApiError(502, "The server returned an incomplete availability response.");
  }
  return parsed.data[0];
}

export async function deleteDoctorSlot(token: string, doctorId: string, slotId: string): Promise<void> {
  await request<void>(token, `/doctors/${encodeURIComponent(doctorId)}/slots/${encodeURIComponent(slotId)}`, {
    method: "DELETE",
  });
}

export async function createAppointment(token: string, availabilityId: string, reason?: string): Promise<PatientAppointment> {
  const payload = await request<unknown>(token, "/appointments", {
    method: "POST",
    body: JSON.stringify({ availability_id: availabilityId, ...(reason ? { reason } : {}) }),
  });
  const parsed = appointmentSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete booking confirmation.");
  return parsed.data;
}

export async function getAppointments(token: string): Promise<PatientAppointment[]> {
  const payload = await request<unknown>(token, "/appointments");
  const parsed = z.array(appointmentSchema).safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete appointment list.");
  return parsed.data;
}

export async function cancelAppointment(token: string, appointmentId: string): Promise<PatientAppointment> {
  const payload = await request<unknown>(token, `/appointments/${encodeURIComponent(appointmentId)}/cancel`, { method: "PUT" });
  const parsed = appointmentSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete cancellation response.");
  return parsed.data;
}

export async function rescheduleAppointment(token: string, appointmentId: string, availabilityId: string): Promise<PatientAppointment> {
  const payload = await request<unknown>(token, `/appointments/${encodeURIComponent(appointmentId)}/reschedule`, {
    method: "PUT",
    body: JSON.stringify({ availability_id: availabilityId }),
  });
  const parsed = appointmentSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete rescheduling response.");
  return parsed.data;
}

export async function completeDoctorAppointment(token: string, appointmentId: string): Promise<PatientAppointment> {
  const payload = await request<unknown>(token, `/appointments/${encodeURIComponent(appointmentId)}/complete`, { method: "PUT" });
  const parsed = appointmentSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete completion response.");
  return parsed.data;
}

export async function createLocalProfile(token: string, body: {
  role: "patient" | "doctor";
  first_name: string;
  last_name: string;
  specialty?: string;
}): Promise<LocalProfile> {
  const payload = await request<unknown>(token, "/users/me", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const parsed = localProfileSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "Your profile may have been created, but the server returned an incomplete response. Retry to check your account before submitting again.");
  return parsed.data;
}

export async function updateUserDetails(token: string, body: {
  first_name: string;
  last_name: string;
  phone: string | null;
}) {
  await request<unknown>(token, "/users/me", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function updateUserPhone(token: string, phone: string) {
  await request<unknown>(token, "/users/me", {
    method: "PATCH",
    body: JSON.stringify({ phone }),
  });
}

export async function updateRoleProfile(token: string, profile: LocalProfile, body: Record<string, string | null>) {
  const collection = profile.role === "doctor" ? "doctors" : "patients";
  await request<unknown>(token, `/${collection}/${profile.profile.id}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}
