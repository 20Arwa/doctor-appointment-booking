const appointmentService = require("../appointmentService");
const doctorService = require("../doctorService");
const { getDoctorSlots } = require("../../controllers/availabilityController");
const { getTool } = require("./toolRegistry");

function safeAppointment(row) {
  return {
    date: row.date,
    start_time: row.start_time,
    end_time: row.end_time,
    status: row.status,
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

async function executeTool({ name, args, actor, database, applicationTimezone, now = new Date() }) {
  const definition = getTool(name, actor);
  if (!definition) throw Object.assign(new Error("Tool is unavailable"), { code: "TOOL_UNAVAILABLE" });
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) throw Object.assign(new Error("Tool arguments are invalid"), { code: "INVALID_TOOL_ARGUMENTS" });
  const input = parsed.data;

  if (name === "get_patient_appointments") {
    const timeZone = applicationTimezone || "Asia/Kolkata";
    const range = input.scope === "next_days" ? nextDaysRange(input.days_ahead, timeZone, now) : null;
    const limit = input.scope === "nearest" ? 1 : 20;
    const page = await appointmentService.listAppointments(database, actor, {
      view: input.view,
      ...(range ? { from: range.from, to: range.to } : {}),
      limit,
      offset: 0,
    }, timeZone);
    let rows = page.items;
    if (range) rows = rows.filter((row) => row.date >= range.from && row.date <= range.to);
    if (input.scope === "nearest") rows = rows.slice(0, 1);
    return { appointments: rows.map(safeAppointment) };
  }

  if (name === "search_doctors") {
    const matches = await doctorService.listDoctors(database, { name: input.name, specialty: input.specialty, limit: 10 });
    const doctors = matches.map(({ id, first_name, last_name, specialty, consultation_fee, appointment_duration_minutes }) => ({
      id, name: `Dr. ${first_name} ${last_name}`.trim(), specialty, consultation_fee, appointment_duration_minutes,
    }));
    return { doctors };
  }

  if (name === "get_available_slots") {
    const slotLimit = input.from ? 30 : 1;
    const response = controllerResponse({
      database, applicationTimezone: applicationTimezone || "Asia/Kolkata", user: actor,
      params: { id: input.doctor_id }, query: { from: input.from, to: input.to, limit: slotLimit },
    });
    let controllerError;
    await getDoctorSlots({}, response, (error) => { controllerError = error; });
    if (controllerError) throw controllerError;
    if ((response.statusCode || 200) >= 400) throw Object.assign(new Error("Availability could not be loaded"), { code: "TOOL_QUERY_FAILED" });
    return { slots: (response.body || []).slice(0, slotLimit).map(({ date, start_time, end_time, doctor_id, remaining_capacity }) => ({
      date, start_time, end_time, doctor_id, remaining_capacity,
    })) };
  }

  throw Object.assign(new Error("Tool is unavailable"), { code: "TOOL_UNAVAILABLE" });
}

module.exports = { executeTool, nextDaysRange, safeAppointment };
