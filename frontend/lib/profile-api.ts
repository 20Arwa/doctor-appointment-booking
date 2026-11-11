import { z } from "zod";

const localProfileSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string().email(),
  phone: z.string().nullable(),
  sms_consent: z.boolean(),
  role: z.enum(["patient", "doctor"]),
  is_active: z.boolean(),
  profile: z.object({
    id: z.string().uuid(),
    specialty: z.string().optional(),
    bio: z.string().nullable().optional(),
    consultation_fee: z.number().optional(),
    appointment_duration_minutes: z.number().int().optional(),
    date_of_birth: z.iso.date().nullable().optional(),
    gender: z.string().nullable().optional(),
  }),
});

const doctorSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string(),
  last_name: z.string(),
  specialty: z.string(),
  bio: z.string().nullable(),
  consultation_fee: z.number(),
  appointment_duration_minutes: z.number().int().optional(),
});

const doctorPatientSchema = z.object({
  first_name: z.string(),
  last_name: z.string(),
  email: z.string().email(),
  phone: z.string().nullable(),
  date_of_birth: z.iso.date().nullable(),
  gender: z.string().nullable(),
});

const appointmentSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["confirmed", "cancelled", "completed"]),
  availability_id: z.string().uuid(),
  mode: z.enum(["wave", "stream"]).nullable().optional(),
  appointment_duration_minutes: z.number().int().positive().nullable().optional(),
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
  patient_date_of_birth: z.string().nullable().optional(),
  patient_gender: z.string().nullable().optional(),
  consultation_fee: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  consultation_currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
});

const availabilitySlotSchema = z.object({
  id: z.string().uuid(),
  doctor_id: z.string().uuid(),
  schedule_id: z.string().uuid().nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  mode: z.enum(["wave", "stream"]).nullable().optional(),
  capacity: z.number().int().nonnegative().nullable().optional(),
  remaining_capacity: z.number().int().nonnegative().nullable().optional(),
  hold_status: z.literal("active").nullable().optional(),
  hold_expires_at: z.string().nullable().optional(),
  reservation_only: z.boolean().optional(),
  has_confirmed_appointment: z.boolean().optional(),
  has_active_allocation: z.boolean().optional(),
  active_allocation_count: z.number().int().nonnegative().optional(),
  has_active_held_allocation: z.boolean().optional(),
  preserved_reservation_count: z.number().int().nonnegative().optional(),
});

const paymentOrderSchema = z.object({
  payment_id: z.string().uuid(),
  session_id: z.string().startsWith("cs_test_"),
  checkout_url: z.string().url().refine((value) => {
    try {
      const checkoutUrl = new URL(value);
      return checkoutUrl.protocol === "https:" && checkoutUrl.hostname === "checkout.stripe.com";
    } catch {
      return false;
    }
  }, "The server returned an invalid Stripe Checkout URL."),
  expires_at: z.string(),
});

const paymentStatusSchema = z.object({
  status: z.enum(["created", "pending", "authorized", "captured", "failed", "cancelled", "expired", "partially_refunded", "refunded"]),
  appointment: appointmentSchema.nullable(),
  reconciliation_id: z.string().uuid().nullable().optional(),
});

const paymentHistoryRefundSchema = z.object({
  id: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(["pending", "processed", "failed", "cancelled"]),
  reason: z.string().nullable(),
  created_at: z.string(),
  processed_at: z.string().nullable(),
});

const inAppNotificationSchema = z.object({
  id: z.string().uuid(), appointment_id: z.string().uuid(), event_type: z.string(), title: z.string(),
  message: z.string(), created_at: z.string(), read_at: z.string().nullable(),
});
export type InAppNotification = z.infer<typeof inAppNotificationSchema>;

const paymentHistoryAppointmentSchema = z.object({
  id: z.string().uuid().nullable().optional(),
  status: z.enum(["confirmed", "cancelled", "completed"]).nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  end_time: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  doctor: z.object({
    id: z.string().uuid(),
    first_name: z.string(),
    last_name: z.string(),
    specialty: z.string(),
  }).nullable(),
});

const paymentHistoryItemSchema = z.object({
  id: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  status: z.enum(["created", "pending", "authorized", "captured", "failed", "cancelled", "expired", "partially_refunded", "refunded"]),
  date: z.string(),
  receipt_url: z.string().url().refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "pay.stripe.com";
    } catch {
      return false;
    }
  }).nullable(),
  appointment: paymentHistoryAppointmentSchema.nullable(),
  refunds: z.array(paymentHistoryRefundSchema),
});

const appointmentPageSchema = z.object({
  items: z.array(appointmentSchema),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative(),
});
const paymentHistoryPageSchema = z.object({
  items: z.array(paymentHistoryItemSchema),
  has_more: z.boolean(),
  next_offset: z.number().int().nonnegative(),
});

const cancellationRefundPreviewSchema = z.object({
  original_payment: z.object({
    amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
    currency: z.string().regex(/^[A-Z]{3}$/),
    status: z.enum(["created", "pending", "authorized", "captured", "failed", "cancelled", "expired", "partially_refunded", "refunded"]),
  }).nullable(),
  refund_percentage: z.number().int().min(0).max(100),
  estimated_refund_amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  refund_expected: z.boolean(),
  explanation: z.string(),
});

export type LocalProfile = z.infer<typeof localProfileSchema>;
export type DirectoryDoctor = z.infer<typeof doctorSchema>;
export type DoctorPatient = z.infer<typeof doctorPatientSchema>;
export type PatientAppointment = z.infer<typeof appointmentSchema>;
export type AvailabilitySlot = z.infer<typeof availabilitySlotSchema>;

const assistedSuggestionSchema = z.object({
  id: z.string().uuid(), availability_id: z.string().uuid(), mode: z.enum(["wave", "stream"]),
  date: z.iso.date(), start_time: z.string(), end_time: z.string(),
  remaining_capacity_at_suggestion: z.number().int().nonnegative(), rank: z.number().int().positive(),
});
const assistedRequestStatusSchema = z.enum(["pending_patient", "no_alternatives", "accepted", "declined", "expired", "superseded"]);
const assistedPatientRequestSchema = z.object({
  id: z.string().uuid(), appointment_id: z.string().uuid(), status: assistedRequestStatusSchema,
  mode: z.enum(["wave", "stream"]), previous_date: z.iso.date(), previous_start_time: z.string(), previous_end_time: z.string(),
  appointment_updated_at: z.string(), expires_at: z.string(), appointment_status: z.enum(["confirmed", "cancelled", "completed"]),
  created_at: z.string(), updated_at: z.string(),
  doctor_first_name: z.string(), doctor_last_name: z.string(), suggestions: z.array(assistedSuggestionSchema),
});
export type AssistedRescheduleSuggestion = z.infer<typeof assistedSuggestionSchema>;
export type AssistedPatientRequest = z.infer<typeof assistedPatientRequestSchema>;
export type AssistedDoctorRequest = {
  id: string; appointment_id: string; patient_id: string; previous_date: string;
  previous_start_time: string; previous_end_time: string; mode: "wave" | "stream";
  status: z.infer<typeof assistedRequestStatusSchema>; created_at: string; updated_at: string;
  expires_at: string; patient_first_name: string; patient_last_name: string; appointment_status: string; suggestion_count: number;
};
const scheduleDateSchema = z.iso.date();
const schedulePeriodSchema = z.object({ weekday: z.number().int().min(0).max(6).nullable().optional(), service_date: scheduleDateSchema.nullable().optional(), start_time: z.string(), end_time: z.string() });
const doctorScheduleSchema = z.object({ id: z.string().uuid(), mode: z.enum(["wave", "stream"]), recurrence_type: z.enum(["weekly", "specific_dates"]), visibility: z.enum(["public", "private"]), active: z.boolean(), starts_on: scheduleDateSchema.nullable(), ends_on: scheduleDateSchema.nullable(), updated_at: z.string().optional(), wave_capacity_per_slot: z.number().int(), stream_capacity_per_window: z.number().int(), periods: z.array(schedulePeriodSchema) });
export type DoctorSchedule = z.infer<typeof doctorScheduleSchema>;
const elasticScheduleInputSchema = z.object({
  mode: z.enum(["wave", "stream"]), expected_updated_at: z.string(), starts_on: z.iso.date(), ends_on: z.iso.date(),
  periods: z.array(z.object({ weekday: z.number().int().min(0).max(6), start_time: z.string(), end_time: z.string() })),
});
const scheduleWindowSchema = z.object({ date: z.iso.date(), start_time: z.string(), end_time: z.string() });
const elasticSchedulePreviewSchema = z.object({
  schedule_id: z.string().uuid(), schedule_updated_at: z.string(), mode: z.enum(["wave", "stream"]),
  wave_appointment_duration_minutes: z.number().int().positive().nullable(),
  added_availability: z.array(scheduleWindowSchema),
  resized_availability: z.array(z.object({ availability_id: z.string().uuid(), date: z.iso.date(), previous_start_time: z.string(), previous_end_time: z.string(), start_time: z.string(), end_time: z.string() })),
  blocked_availability: z.array(scheduleWindowSchema.extend({ reasons: z.array(z.string()) })),
  saved_schedule_period_conflicts: z.array(z.object({ weekday: z.number().int(), proposed_start_time: z.string(), proposed_end_time: z.string(), existing_schedule_id: z.string().uuid(), existing_recurrence_type: z.string(), existing_weekday: z.number().int().nullable(), existing_service_date: z.string().nullable(), existing_start_time: z.string(), existing_end_time: z.string() })),
  can_update: z.boolean(),
  removed_availability: z.array(z.object({ availability_id: z.string().uuid(), date: z.iso.date(), start_time: z.string(), end_time: z.string(), has_confirmed_appointment: z.boolean(), has_active_allocation: z.boolean(), has_active_payment_hold: z.boolean() })),
  affected_appointments: z.array(z.object({ id: z.string().uuid(), availability_id: z.string().uuid(), status: z.literal("confirmed"), date: z.iso.date(), start_time: z.string(), end_time: z.string() })),
  active_payment_holds: z.array(z.object({ id: z.string().uuid(), availability_id: z.string().uuid(), date: z.iso.date(), start_time: z.string(), end_time: z.string(), expires_at: z.string() })),
  active_allocations: z.array(z.object({ id: z.string().uuid(), availability_id: z.string().uuid(), status: z.enum(["confirmed", "held"]), expires_at: z.string().nullable(), date: z.iso.date(), start_time: z.string(), end_time: z.string() })),
  unchanged_count: z.number().int().nonnegative(), exceptions_preserved: z.boolean(),
});
export type ElasticScheduleInput = z.infer<typeof elasticScheduleInputSchema>;
export type ElasticSchedulePreview = z.infer<typeof elasticSchedulePreviewSchema>;
const elasticScheduleUpdateSchema = z.object({ schedule_id: z.string().uuid(), generated: z.array(scheduleWindowSchema.extend({ availability_id: z.string().uuid() })), added_count: z.number().int().nonnegative(), resized_count: z.number().int().nonnegative(), retired: elasticSchedulePreviewSchema.shape.removed_availability, removed_count: z.number().int().nonnegative(), unchanged_count: z.number().int().nonnegative(), blocked_availability: elasticSchedulePreviewSchema.shape.blocked_availability, wave_appointment_duration_minutes: z.number().int().positive().nullable(), exceptions_preserved: z.boolean() });
export type PaymentOrder = z.infer<typeof paymentOrderSchema>;
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export type PatientPaymentHistoryItem = z.infer<typeof paymentHistoryItemSchema>;
export type PatientPaymentHistoryPage = z.infer<typeof paymentHistoryPageSchema>;
export type AppointmentPage = z.infer<typeof appointmentPageSchema>;
export type CancellationRefundPreview = z.infer<typeof cancellationRefundPreviewSchema>;

type ValidationDetail = { path: string; message: string };
type ProtectedAppointmentDetail = { appointment_id: string; date: string; start_time: string; end_time: string };

export class ProfileApiError extends Error {
  status: number;
  code?: string;
  details: ValidationDetail[];
  protectedAppointments: ProtectedAppointmentDetail[];

  constructor(status: number, message: string, code?: string, details: ValidationDetail[] = [], protectedAppointments: ProtectedAppointmentDetail[] = []) {
    super(message);
    this.name = "ProfileApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.protectedAppointments = protectedAppointments;
  }
}

function apiBaseUrl() {
  const base = process.env.NEXT_PUBLIC_API_URL?.trim().replace(/\/+$/, "");
  if (!base) throw new Error("The backend API URL is not configured.");
  return `${base}/api/v1`;
}

async function request<T>(token: string | undefined, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
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
        details: z.unknown().optional(),
      }).optional(),
    }).safeParse(payload);
    const details = error.success ? error.data.error?.details : undefined;
    const validationDetails = z.array(z.object({ path: z.string(), message: z.string() })).safeParse(details);
    const protectedDetails = z.object({
      protected_appointments: z.array(z.object({
        appointment_id: z.string(), date: z.string(), start_time: z.string(), end_time: z.string(),
      })),
    }).safeParse(details);
    throw new ProfileApiError(
      response.status,
      error.success ? error.data.error?.message ?? "The request could not be completed." : "The request could not be completed.",
      error.success ? error.data.error?.code : undefined,
      validationDetails.success ? validationDetails.data : [],
      protectedDetails.success ? protectedDetails.data.protected_appointments : [],
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

export async function getInAppNotifications(token: string, limit = 20, offset = 0) {
  const payload = await request<unknown>(token, `/notifications?limit=${limit}&offset=${offset}`);
  const parsed = z.object({ notifications: z.array(inAppNotificationSchema), unreadCount: z.number().int(), totalCount: z.number().int() }).safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete notification list.");
  return parsed.data;
}

export async function markInAppNotificationRead(token: string, id: string) {
  const payload = await request<unknown>(token, `/notifications/${encodeURIComponent(id)}/read`, { method: "PATCH" });
  const parsed = inAppNotificationSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete notification.");
  return parsed.data;
}

export async function markAllInAppNotificationsRead(token: string) {
  return request<{ updated: number }>(token, "/notifications/read-all", { method: "PATCH" });
}

export async function getDoctors(token?: string): Promise<DirectoryDoctor[]> {
  const payload = await request<unknown>(token, "/doctors");
  const parsed = z.array(doctorSchema).safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete doctor list.");
  return parsed.data;
}

export async function getDoctorPatient(token: string, patientId: string): Promise<DoctorPatient> {
  const payload = await request<unknown>(token, `/doctors/patients/${encodeURIComponent(patientId)}`);
  const parsed = doctorPatientSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete patient profile.");
  return parsed.data;
}

export async function getDoctorPatientAppointmentsPage(token: string, patientId: string, view: "scheduled" | "past" | "cancelled", offset: number, limit = 5): Promise<AppointmentPage> {
  const query = new URLSearchParams({ view, limit: String(limit), offset: String(offset) });
  const payload = await request<unknown>(token, `/doctors/patients/${encodeURIComponent(patientId)}/appointments?${query.toString()}`);
  const parsed = appointmentPageSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete patient appointment page.");
  return parsed.data;
}

export async function getDoctor(token: string, doctorId: string): Promise<DirectoryDoctor> {
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}`);
  const parsed = doctorSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete doctor profile.");
  return parsed.data;
}

export async function getDoctorSlots(token: string, doctorId: string, from: string, to?: string, excludeAppointmentId?: string): Promise<AvailabilitySlot[]> {
  const query = new URLSearchParams({ from });
  if (to) query.set("to", to);
  if (excludeAppointmentId) query.set("exclude_appointment_id", excludeAppointmentId);
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}/slots?${query.toString()}`);
  const parsed = z.array(availabilitySlotSchema).safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete availability list.");
  return parsed.data;
}

export async function getDoctorAssistedRequests(token: string, doctorId: string): Promise<AssistedDoctorRequest[]> {
  const payload = await request<{ items: unknown[] }>(token, `/doctors/${encodeURIComponent(doctorId)}/assisted-reschedule-requests?limit=100&offset=0`);
  const parsed = z.array(z.object({
    id: z.string().uuid(), appointment_id: z.string().uuid(), patient_id: z.string().uuid(),
    previous_date: z.iso.date(), previous_start_time: z.string(), previous_end_time: z.string(),
    mode: z.enum(["wave", "stream"]), status: assistedRequestStatusSchema,
    expires_at: z.string(),
    created_at: z.string(), updated_at: z.string(), patient_first_name: z.string(), patient_last_name: z.string(),
    appointment_status: z.string(), suggestion_count: z.coerce.number().int().nonnegative(),
  })).safeParse(payload.items);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete assisted rescheduling list.");
  return parsed.data;
}

export async function getPatientAssistedRequest(token: string, appointmentId: string): Promise<AssistedPatientRequest> {
  const payload = await request<unknown>(token, `/appointments/${encodeURIComponent(appointmentId)}/assisted-reschedule-request`);
  const parsed = assistedPatientRequestSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete assisted rescheduling request.");
  return parsed.data;
}

export async function confirmPatientAssistedReschedule(token: string, requestId: string, suggestionId: string): Promise<PatientAppointment> {
  const payload = await request<unknown>(token, `/appointments/assisted-reschedule-requests/${encodeURIComponent(requestId)}/confirm`, {
    method: "POST", body: JSON.stringify({ suggestion_id: suggestionId }),
  });
  const parsed = appointmentSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete rescheduling response.");
  return parsed.data;
}

export async function declinePatientAssistedReschedule(token: string, requestId: string): Promise<void> {
  await request<unknown>(token, `/appointments/assisted-reschedule-requests/${encodeURIComponent(requestId)}/decline`, { method: "POST" });
}

export async function getDoctorSchedules(token: string, doctorId: string): Promise<DoctorSchedule[]> {
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}/schedules`);
  const parsed = z.array(doctorScheduleSchema).safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete schedule list.");
  return parsed.data;
}

export async function previewDoctorScheduleUpdate(token: string, doctorId: string, scheduleId: string, input: ElasticScheduleInput): Promise<ElasticSchedulePreview> {
  const validInput = elasticScheduleInputSchema.safeParse(input);
  if (!validInput.success) throw new ProfileApiError(400, "The schedule changes are invalid.");
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}/schedules/${encodeURIComponent(scheduleId)}/preview`, { method: "POST", body: JSON.stringify(validInput.data) });
  const parsed = elasticSchedulePreviewSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete schedule preview.");
  return parsed.data;
}

export async function updateDoctorSchedule(token: string, doctorId: string, scheduleId: string, input: ElasticScheduleInput): Promise<z.infer<typeof elasticScheduleUpdateSchema>> {
  const validInput = elasticScheduleInputSchema.safeParse(input);
  if (!validInput.success) throw new ProfileApiError(400, "The schedule changes are invalid.");
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}/schedules/${encodeURIComponent(scheduleId)}`, { method: "PUT", body: JSON.stringify(validInput.data) });
  const parsed = elasticScheduleUpdateSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete schedule update.");
  return parsed.data;
}

export async function createDoctorSchedule(token: string, doctorId: string, schedule: {
  request_id?: string;
  mode: "wave" | "stream"; recurrence_type: "weekly" | "specific_dates"; visibility: "public" | "private";
  starts_on?: string; ends_on?: string; wave_capacity_per_slot: number; stream_capacity_per_window: number;
  periods: { weekday?: number; service_date?: string; start_time: string; end_time: string }[];
}): Promise<DoctorSchedule> {
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}/schedules`, { method: "POST", body: JSON.stringify(schedule) });
  const parsed = doctorScheduleSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete schedule response.");
  return parsed.data;
}

export async function createScheduleException(token: string, doctorId: string, scheduleId: string, exception: {
  service_date: string; exception_type: "day_off" | "override" | "additional"; periods: { start_time: string; end_time: string }[];
}): Promise<{ id: string; service_date: string; exception_type: "day_off" | "override" | "additional"; periods: { start_time: string; end_time: string }[]; generation?: { mode: "wave" | "stream"; generated_slots?: number; generated_windows?: number; skipped_conflicts?: number; skipped_conflict_details?: { date: string; start_time: string; end_time: string; reason: string }[] } }> {
  const generationSchema = z.discriminatedUnion("mode", [
    z.object({ schedule_id: z.string().uuid(), mode: z.literal("wave"), generated_slots: z.number().int().nonnegative(), skipped_conflicts: z.number().int().nonnegative().optional(), skipped_conflict_details: z.array(z.object({ date: z.string(), start_time: z.string(), end_time: z.string(), reason: z.string() })).optional() }),
    z.object({ schedule_id: z.string().uuid(), mode: z.literal("stream"), generated_windows: z.number().int().nonnegative(), skipped_conflicts: z.number().int().nonnegative().optional(), skipped_conflict_details: z.array(z.object({ date: z.string(), start_time: z.string(), end_time: z.string(), reason: z.string() })).optional() }),
  ]);
  const schema = z.object({ id: z.string().uuid(), service_date: z.string(), exception_type: z.enum(["day_off", "override", "additional"]), periods: z.array(z.object({ start_time: z.string(), end_time: z.string() })), generation: generationSchema.optional() });
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}/schedules/${encodeURIComponent(scheduleId)}/exceptions`, { method: "POST", body: JSON.stringify(exception) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete schedule exception response.");
  return parsed.data;
}

export async function generateDoctorAvailability(token: string, doctorId: string, scheduleId: string, from: string, to: string): Promise<{ schedule_id: string; mode: "wave" | "stream"; generated_slots?: number; generated_windows?: number; skipped_conflicts?: number; skipped_conflict_details?: { date: string; start_time: string; end_time: string; reason: string }[] }> {
  const schema = z.discriminatedUnion("mode", [
    z.object({ schedule_id: z.string().uuid(), mode: z.literal("wave"), generated_slots: z.number().int().nonnegative(), skipped_conflicts: z.number().int().nonnegative().optional(), skipped_conflict_details: z.array(z.object({ date: z.string(), start_time: z.string(), end_time: z.string(), reason: z.string() })).optional() }),
    z.object({ schedule_id: z.string().uuid(), mode: z.literal("stream"), generated_windows: z.number().int().nonnegative(), skipped_conflicts: z.number().int().nonnegative().optional(), skipped_conflict_details: z.array(z.object({ date: z.string(), start_time: z.string(), end_time: z.string(), reason: z.string() })).optional() }),
  ]);
  const payload = await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}/schedules/${encodeURIComponent(scheduleId)}/generate`, { method: "POST", body: JSON.stringify({ from, to }) });
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete availability generation response.");
  return parsed.data;
}

export async function updateDoctorProfile(token: string, doctorId: string, update: { appointment_duration_minutes: number }): Promise<void> {
  await request<unknown>(token, `/doctors/${encodeURIComponent(doctorId)}`, { method: "PUT", body: JSON.stringify(update) });
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

export async function createAppointmentPaymentOrder(token: string, availabilityId: string, reason: string | undefined, idempotencyKey: string): Promise<PaymentOrder> {
  const payload = await request<unknown>(token, "/payments/orders", {
    method: "POST",
    body: JSON.stringify({ availability_id: availabilityId, idempotency_key: idempotencyKey, ...(reason ? { reason } : {}) }),
  });
  const parsed = paymentOrderSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete payment order.");
  return parsed.data;
}

export async function getAppointmentPaymentStatus(token: string, paymentId: string): Promise<PaymentStatus> {
  const payload = await request<unknown>(token, `/payments/${encodeURIComponent(paymentId)}/status`);
  const parsed = paymentStatusSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete payment status response.");
  return parsed.data;
}

export async function getPatientPaymentHistory(token: string): Promise<PatientPaymentHistoryItem[]> {
  const payload = await request<unknown>(token, "/payments/history");
  const parsed = z.array(paymentHistoryItemSchema).safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete payment history.");
  return parsed.data;
}

export async function getPatientPaymentHistoryPage(token: string, offset: number, limit = 5): Promise<PatientPaymentHistoryPage> {
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  const payload = await request<unknown>(token, `/payments/history?${query.toString()}`);
  const parsed = paymentHistoryPageSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete payment history page.");
  return parsed.data;
}

export async function getAppointmentCancellationRefundPreview(token: string, appointmentId: string): Promise<CancellationRefundPreview> {
  const payload = await request<unknown>(token, `/appointments/${encodeURIComponent(appointmentId)}/cancellation-preview`);
  const parsed = cancellationRefundPreviewSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete cancellation refund estimate.");
  return parsed.data;
}

export async function cancelAppointmentPaymentOrder(token: string, paymentId: string): Promise<void> {
  await request<unknown>(token, `/payments/${encodeURIComponent(paymentId)}/cancel`, { method: "POST" });
}

export async function getAppointments(token: string): Promise<PatientAppointment[]> {
  const payload = await request<unknown>(token, "/appointments");
  const parsed = z.array(appointmentSchema).safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete appointment list.");
  return parsed.data;
}

export async function getAppointment(token: string, appointmentId: string): Promise<PatientAppointment> {
  const payload = await request<unknown>(token, `/appointments/${encodeURIComponent(appointmentId)}`);
  const parsed = appointmentSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete appointment.");
  return parsed.data;
}

export async function getAppointmentsView(token: string, view: "upcoming"): Promise<PatientAppointment[]> {
  const query = new URLSearchParams({ view });
  const payload = await request<unknown>(token, `/appointments?${query.toString()}`);
  const parsed = z.array(appointmentSchema).safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete appointment list.");
  return parsed.data;
}

export async function getAppointmentHistoryPage(token: string, view: "past" | "cancelled", offset: number, limit = 5): Promise<AppointmentPage> {
  const query = new URLSearchParams({ view, limit: String(limit), offset: String(offset) });
  const payload = await request<unknown>(token, `/appointments?${query.toString()}`);
  const parsed = appointmentPageSchema.safeParse(payload);
  if (!parsed.success) throw new ProfileApiError(502, "The server returned an incomplete appointment history page.");
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

export async function doctorRescheduleAppointment(token: string, appointmentId: string, schedule: { availability_id: string }): Promise<PatientAppointment> {
  const payload = await request<unknown>(token, `/appointments/${encodeURIComponent(appointmentId)}/reschedule`, {
    method: "PUT", body: JSON.stringify(schedule),
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
  sms_consent: boolean;
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
