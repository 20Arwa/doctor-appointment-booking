const appointmentService = require("../appointmentService");
const doctorService = require("../doctorService");
const { getDoctorSlots } = require("../../controllers/availabilityController");
const { getTool } = require("./toolRegistry");

function safeAppointment(row) {
  return {
    id: row.id,
    appointment_id: row.id,
    date: row.date,
    start_time: row.start_time,
    end_time: row.end_time,
    status: row.status,
    ...(row.mode ? { mode: row.mode } : {}),
    doctor: { id: row.doctor_id, name: `Dr. ${row.doctor_first_name} ${row.doctor_last_name}`.trim(), specialty: row.specialty },
  };
}

function dateInTimezone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addCalendarDays(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

function nextDaysRange(days, timeZone, now = new Date()) {
  const today = dateInTimezone(now, timeZone);
  return { from: addCalendarDays(today, 1), to: addCalendarDays(today, days) };
}

function controllerResponse(locals) {
  return {
    locals,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function executeTool({ name, args, actor, database, applicationTimezone, paymentService, appointmentScopeOverride, now = new Date() }) {
  const definition = getTool(name, actor);
  if (!definition) throw Object.assign(new Error("Tool is unavailable"), { code: "TOOL_UNAVAILABLE" });
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) throw Object.assign(new Error("Tool arguments are invalid"), { code: "INVALID_TOOL_ARGUMENTS" });
  const input = parsed.data;

  if (name === "get_cancellation_refund_preview") {
    if (!paymentService?.previewCancellationRefund) throw Object.assign(new Error("Refund preview is unavailable"), { code: "TOOL_QUERY_FAILED" });
    const preview = await paymentService.previewCancellationRefund(actor, input.appointment_id);
    return {
      original_payment: preview.original_payment ? { amount: preview.original_payment.amount, currency: preview.original_payment.currency, status: preview.original_payment.status } : null,
      processed_refund_amount: preview.processed_refund_amount,
      pending_refund_amount: preview.pending_refund_amount,
      estimated_additional_refund_amount: preview.estimated_refund_amount,
      currency: preview.currency,
      refund_expected: preview.refund_expected,
      explanation: preview.explanation,
    };
  }

  const proposalTypes = {
    prepare_booking_action: "book",
    prepare_reschedule_action: "reschedule",
    prepare_cancellation_action: "cancel",
  };
  if (proposalTypes[name]) {
    return {
      proposal: { action_type: proposalTypes[name], action_args: input },
      requires_patient_confirmation: true,
    };
  }

  if (name === "get_patient_appointments") {
    const timeZone = applicationTimezone || "Asia/Kolkata";
    const appointmentQuery = appointmentScopeOverride === "all" ? { view: "upcoming", scope: "all", offset: input.offset } : input;
    const range = appointmentQuery.scope === "next_days" ? nextDaysRange(appointmentQuery.days_ahead, timeZone, now) : null;
    const limit = ["nearest", "last", "last_completed"].includes(appointmentQuery.scope) ? 1 : 20;
    const page = await appointmentService.listAppointments(database, actor, {
      view: appointmentQuery.view,
      ...(appointmentQuery.scope === "last_completed" ? { status: "completed" } : {}),
      ...(range ? { from: range.from, to: range.to } : {}),
      ...(!range && appointmentQuery.from && appointmentQuery.to ? { from: appointmentQuery.from, to: appointmentQuery.to } : {}),
      limit,
      offset: appointmentQuery.offset || 0,
    }, timeZone);
    let rows = page.items;
    if (range) rows = rows.filter((row) => row.date >= range.from && row.date <= range.to);
    if (["nearest", "last", "last_completed"].includes(appointmentQuery.scope)) rows = rows.slice(0, 1);
    return { appointments: rows.map(safeAppointment), has_more: page.has_more, next_offset: page.next_offset };
  }

  if (name === "search_doctors") {
    const normalizedName = input.name?.replace(/^\s*Dr\.?\s+/i, "").trim();
    const matches = await doctorService.listDoctors(database, { name: normalizedName || input.name, specialty: input.specialty, limit: 10 });
    const doctors = matches.map(({ id, first_name, last_name, specialty, consultation_fee, appointment_duration_minutes }) => ({
      id, name: `Dr. ${first_name} ${last_name}`.trim(), specialty, consultation_fee, appointment_duration_minutes,
    }));
    return { doctors };
  }

  if (name === "get_available_slots") {
    const slotLimit = 5;
    const queryLimit = input.exact_start_time ? 100 : slotLimit;
    const response = controllerResponse({
      database, applicationTimezone: applicationTimezone || "Asia/Kolkata", user: actor,
      params: { id: input.doctor_id }, query: { from: input.from, to: input.to, specialty: input.specialty, limit: queryLimit },
    });
    let controllerError;
    await getDoctorSlots({}, response, (error) => { controllerError = error; });
    if (controllerError) throw controllerError;
    if ((response.statusCode || 200) >= 400) throw Object.assign(new Error("Availability could not be loaded"), { code: "TOOL_QUERY_FAILED" });
    let rows = response.body || [];
    if (input.exact_start_time) rows = rows.filter((row) => String(row.start_time).slice(0, 5) === input.exact_start_time);
    return { slots: rows.slice(0, input.exact_start_time ? 2 : slotLimit).map(({ id, date, start_time, end_time, doctor_id, doctor_first_name, doctor_last_name, specialty, consultation_fee, mode, capacity, remaining_capacity }) => ({
      id, availability_id: id, date, start_time, end_time, doctor_id, doctor: { id: doctor_id, name: `Dr. ${doctor_first_name} ${doctor_last_name}`.trim() }, specialty, consultation_fee, mode: mode || "legacy", capacity, remaining_capacity,
    })) };
  }

  throw Object.assign(new Error("Tool is unavailable"), { code: "TOOL_UNAVAILABLE" });
}

module.exports = { executeTool, nextDaysRange, safeAppointment };
