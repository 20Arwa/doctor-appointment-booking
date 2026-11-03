const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const appointmentService = require("../src/services/appointmentService");
const { doctorPatientAppointmentsQuerySchema, doctorPatientParamsSchema } = require("../src/validators/doctorPatientSchemas");

const doctorUser = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "doctor" };
const patientId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("doctor patient details", () => {
  it("validates route IDs and defaults history pages to five records", () => {
    assert.equal(doctorPatientParamsSchema.safeParse({ patientId }).success, true);
    assert.equal(doctorPatientParamsSchema.safeParse({ patientId, extra: true }).success, false);
    assert.deepEqual(doctorPatientAppointmentsQuerySchema.parse({ view: "scheduled" }), { view: "scheduled", limit: 5, offset: 0 });
    assert.equal(doctorPatientAppointmentsQuerySchema.safeParse({ view: "all", limit: 5, offset: 0 }).success, false);
    assert.equal(doctorPatientAppointmentsQuerySchema.safeParse({ view: "past", limit: 51, offset: 0 }).success, false);
  });

  it("returns only allowed profile fields after confirming the doctor-patient relationship", async () => {
    let capturedSql;
    let capturedValues;
    const database = { async query(sql, values) {
      capturedSql = sql;
      capturedValues = values;
      return { rows: [{ first_name: "Pia", last_name: "Patient", email: "pia@example.test", phone: null, date_of_birth: "1990-02-03", gender: "Female" }] };
    } };
    const patient = await appointmentService.getDoctorPatient(database, doctorUser, patientId);
    assert.deepEqual(capturedValues, [patientId, doctorUser.id]);
    assert.match(capturedSql, /EXISTS/);
    assert.match(capturedSql, /a\.patient_id = p\.id AND d\.user_id = \$2/);
    assert.match(capturedSql, /pu\.email, pu\.phone/);
    assert.deepEqual(Object.keys(patient).sort(), ["date_of_birth", "email", "first_name", "gender", "last_name", "phone"]);
  });

  it("denies non-doctors and hides unrelated patient IDs", async () => {
    let queried = false;
    const database = { async query() { queried = true; return { rows: [] }; } };
    await assert.rejects(appointmentService.getDoctorPatient(database, { ...doctorUser, role: "patient" }, patientId), (error) => error.status === 403);
    assert.equal(queried, false);
    await assert.rejects(appointmentService.getDoctorPatient(database, doctorUser, patientId), (error) => error.status === 404 && error.code === "PATIENT_NOT_FOUND");
  });

  it("paginates newest-first appointments scoped to both doctor and patient", async () => {
    const queries = [];
    const database = { async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes("SELECT 1")) return { rows: [{ "?column?": 1 }] };
      return { rows: Array.from({ length: 6 }, (_, index) => ({ id: `appointment-${index}` })) };
    } };
    const page = await appointmentService.listDoctorPatientAppointments(database, doctorUser, patientId, { view: "past", limit: 5, offset: 5 }, "Asia/Kolkata");
    assert.equal(queries.length, 2);
    const historyQuery = queries[1];
    assert.deepEqual(historyQuery.values, [doctorUser.id, patientId, "Asia/Kolkata", 6, 5]);
    assert.match(historyQuery.sql, /d\.user_id = \$1/);
    assert.match(historyQuery.sql, /p\.id = \$2/);
    assert.match(historyQuery.sql, /a\.status = 'completed' OR/);
    assert.match(historyQuery.sql, /ORDER BY a\.scheduled_date DESC, a\.scheduled_start_time DESC/);
    assert.match(historyQuery.sql, /LIMIT \$4 OFFSET \$5/);
    assert.equal(page.items.length, 5);
    assert.equal(page.has_more, true);
    assert.equal(page.next_offset, 10);
  });

  it("uses scheduled and cancelled filters independently", async () => {
    for (const [view, predicate] of [["scheduled", /a\.status = 'confirmed'.* > NOW\(\)/s], ["cancelled", /a\.status = 'cancelled'/]]) {
      const queries = [];
      const database = { async query(sql, values) {
        queries.push({ sql, values });
        return { rows: sql.includes("SELECT 1") ? [{ ok: true }] : [] };
      } };
      await appointmentService.listDoctorPatientAppointments(database, doctorUser, patientId, { view, limit: 5, offset: 0 }, "Asia/Kolkata");
      assert.match(queries[1].sql, predicate);
    }
  });
});
