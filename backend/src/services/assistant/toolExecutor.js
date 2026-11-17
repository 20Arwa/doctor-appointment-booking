const appointmentService = require("../appointmentService");
const doctorService = require("../doctorService");
const { getDoctorSlots } = require("../../controllers/availabilityController");
const schedulingAssistant = require("../assistantSchedulingService");
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

  if (name === "get_doctor_appointments" || name === "get_doctor_appointment_statistics") {
    // The doctor ID is resolved from the verified local user, never from model arguments.
    if (actor?.role !== "doctor") throw Object.assign(new Error("Tool is unavailable"), { code: "TOOL_UNAVAILABLE" });
    const timeZone = "Asia/Kolkata";
    if (name === "get_doctor_appointments" && input.scope === "nearest") {
      const page = await appointmentService.listAppointments(database, actor, {
        view: "upcoming", status: "confirmed", limit: 1, offset: 0,
      }, timeZone);
      const row = page.items[0];
      const appointments = row ? [{
        date: row.date, start_time: row.start_time, end_time: row.end_time,
        status: row.status, ...(row.mode ? { mode: row.mode } : {}),
      }] : [];
      return {
        scope: "nearest",
        appointments,
        has_more: false,
        next_offset: null,
        ui_actions: row ? [{ type: "appointment", appointment_id: row.id }] : [],
      };
    }
    const relativeOffset = input.day === "tomorrow" ? 1 : input.day === "yesterday" ? -1 : 0;
    const requestedDate = input.date || (input.day ? addCalendarDays(dateInTimezone(now, timeZone), relativeOffset) : null);
    const from = requestedDate || input.from;
    const to = requestedDate || input.to;
    if (name === "get_doctor_appointments" && input.scope === "upcoming") {
      const offset = input.offset;
      const page = await appointmentService.listAppointments(database, actor, {
        view: "upcoming", status: "confirmed", ...(from ? { from } : {}), ...(to ? { to } : {}),
        limit: 15, offset,
      }, timeZone);
      const rows = page.items;
      return {
        scope: "upcoming", ...(from ? { from } : {}), ...(to ? { to } : {}),
        appointments: rows.map(({ date, start_time, end_time, status, mode }) => ({
          date, start_time, end_time, status, ...(mode ? { mode } : {}),
        })),
        has_more: page.has_more,
        next_offset: page.has_more ? page.next_offset : null,
        limit: 15,
        offset,
        ui_actions: rows.map((row) => ({ type: "appointment", appointment_id: row.id })),
      };
    }
    const values = [actor.id, from, to];
    const statusClause = input.status ? ` AND appointment.status = $${values.push(input.status)}` : "";
    if (name === "get_doctor_appointment_statistics") {
      const result = await database.query(
        `SELECT appointment.status, COUNT(*)::int AS count
         FROM appointments appointment
         JOIN availability av ON av.id = appointment.availability_id
         JOIN doctors doctor ON doctor.id = av.doctor_id
         WHERE doctor.user_id = $1 AND appointment.scheduled_date BETWEEN $2::date AND $3::date${statusClause}
         GROUP BY appointment.status ORDER BY appointment.status`, values,
      );
      const byStatus = { confirmed: 0, completed: 0, cancelled: 0 };
      for (const row of result.rows) if (Object.hasOwn(byStatus, row.status)) byStatus[row.status] = Number(row.count);
      return { from, to, total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), by_status: byStatus };
    }
    const limit = input.limit;
    const offset = input.offset;
    values.push(limit + 1, offset);
    const result = await database.query(
      `SELECT appointment.id, appointment.scheduled_date::text AS date,
              appointment.scheduled_start_time::text AS start_time,
              appointment.scheduled_end_time::text AS end_time,
              appointment.status, av.mode
       FROM appointments appointment
       JOIN availability av ON av.id = appointment.availability_id
       JOIN doctors doctor ON doctor.id = av.doctor_id
       WHERE doctor.user_id = $1 AND appointment.scheduled_date BETWEEN $2::date AND $3::date${statusClause}
       ORDER BY appointment.scheduled_date, appointment.scheduled_start_time, appointment.id LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const appointments = rows.map(({ date, start_time, end_time, status, mode }) => ({
      date, start_time, end_time, status, ...(mode ? { mode } : {}),
    }));
    return { from, to, appointments, has_more: hasMore, next_offset: hasMore ? offset + appointments.length : null, limit, offset,
      ui_actions: rows.map((row) => ({ type: "appointment", appointment_id: row.id })) };
  }

  if (["get_doctor_schedules", "get_doctor_schedule_exceptions", "get_doctor_schedule_conflicts", "get_doctor_nearest_slots"].includes(name)) {
    const doctorId = await schedulingAssistant.requireDoctorId(database, actor);
    if (name === "get_doctor_schedules") {
      const schedules = await schedulingAssistant.getSchedules(database, doctorId, input.from, input.to, input.limit + 1);
      return { schedules: schedules.slice(0, input.limit).map(({ id, ...schedule }) => schedule), has_more: schedules.length > input.limit, notice: schedulingAssistant.POINT_IN_TIME_NOTICE };
    }
    if (name === "get_doctor_schedule_exceptions") {
      const exceptions = await schedulingAssistant.getExceptions(database, doctorId, input.from, input.to, input.limit + 1);
      return { exceptions: exceptions.slice(0, input.limit), has_more: exceptions.length > input.limit, notice: schedulingAssistant.POINT_IN_TIME_NOTICE };
    }
    if (name === "get_doctor_schedule_conflicts") return schedulingAssistant.getConflicts(database, doctorId, input.from, input.to, input.limit);
    const timeZone = applicationTimezone || "Asia/Kolkata";
    const today = dateInTimezone(now, timeZone);
    const from = input.from || today;
    const to = input.to || addCalendarDays(today, input.days_ahead ?? 14);
    const pageSize = 100;
    const scanLimit = 1000;
    const slots = [];
    let offset = 0;
    let lastPageWasFull = false;
    while (slots.length < 5 && offset < scanLimit) {
      const limit = Math.min(pageSize, scanLimit - offset);
      const response = controllerResponse({ database, applicationTimezone: timeZone, user: actor,
        params: { id: doctorId }, query: { from, to, mode: input.mode, limit, offset } });
      let controllerError;
      await getDoctorSlots({}, response, (error) => { controllerError = error; });
      if (controllerError) throw controllerError;
      if ((response.statusCode || 200) >= 400) throw Object.assign(new Error("Availability could not be loaded"), { code: "TOOL_QUERY_FAILED" });
      const rows = response.body || [];
      offset += rows.length;
      lastPageWasFull = rows.length === limit;
      slots.push(...rows.filter((slot) => Number(slot.remaining_capacity) > 0).slice(0, 5 - slots.length)
        .map(({ id, date, start_time, end_time, mode, capacity, remaining_capacity }) => ({ id, date, start_time, end_time, mode: mode || "legacy", capacity, remaining_capacity })));
      if (rows.length < limit) break;
    }
    return { slots: slots.map(({ id: _id, ...slot }) => slot), ui_actions: slots.map(({ id }) => ({ type: "schedule_slot", availability_id: id })), scan_limit_reached: slots.length < 5 && offset >= scanLimit && lastPageWasFull, notice: schedulingAssistant.POINT_IN_TIME_NOTICE };
  }

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
    let rows = (response.body || []).filter((row) => Number(row.remaining_capacity) > 0);
    if (input.exact_start_time) rows = rows.filter((row) => String(row.start_time).slice(0, 5) === input.exact_start_time);
    return { slots: rows.slice(0, input.exact_start_time ? 2 : slotLimit).map(({ id, date, start_time, end_time, doctor_id, doctor_first_name, doctor_last_name, specialty, consultation_fee, mode, capacity, remaining_capacity }) => ({
      id, availability_id: id, date, start_time, end_time, doctor_id, doctor: { id: doctor_id, name: `Dr. ${doctor_first_name} ${doctor_last_name}`.trim() }, specialty, consultation_fee, mode: mode || "legacy", capacity, remaining_capacity,
    })) };
  }

  throw Object.assign(new Error("Tool is unavailable"), { code: "TOOL_UNAVAILABLE" });
}

module.exports = { executeTool, nextDaysRange, safeAppointment };
