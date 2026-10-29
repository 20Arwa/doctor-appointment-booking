const { getClerkProfile } = require("../middleware/auth");

function sendDatabaseError(error, response, next) {
  if (error.code === "23505") {
    return response.status(409).json({ error: { code: "PROFILE_CONFLICT", message: "A profile already exists for this identity or email" } });
  }
  return next(error);
}

async function getMe(_request, response, next) {
  try {
    const user = response.locals.user;
    const table = user.role === "doctor" ? "doctors" : "patients";
    const profileColumns = user.role === "doctor"
      ? "id, specialty, bio, consultation_fee::float8 AS consultation_fee, created_at, updated_at"
      : "id, date_of_birth, gender, created_at, updated_at";
    const profile = await response.locals.database.query(`SELECT ${profileColumns} FROM ${table} WHERE user_id = $1`, [user.id]);
    return response.json({ ...user, profile: profile.rows[0] || null });
  } catch (error) { return next(error); }
}

async function createMe(_request, response, next) {
  const body = response.locals.body;
  const client = await response.locals.database.connect();
  try {
    const clerkProfile = await response.locals.clerkProfileResolver(response.locals.clerkUserId);
    const firstName = body.first_name || clerkProfile.firstName;
    const lastName = body.last_name || clerkProfile.lastName;
    if (!firstName || !lastName) {
      return response.status(422).json({ error: { code: "NAME_REQUIRED", message: "First and last name are required to create a profile" } });
    }
    await client.query("BEGIN");
    const existing = await client.query("SELECT is_active FROM users WHERE clerk_user_id = $1 FOR UPDATE", [response.locals.clerkUserId]);
    if (existing.rows[0]) {
      await client.query("ROLLBACK");
      const inactive = !existing.rows[0].is_active;
      return response.status(inactive ? 403 : 409).json({
        error: inactive
          ? { code: "ACCOUNT_INACTIVE", message: "This account is inactive" }
          : { code: "PROFILE_EXISTS", message: "This account has already completed onboarding" },
      });
    }
    const created = await client.query(
      "INSERT INTO users (clerk_user_id, first_name, last_name, email, phone, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, first_name, last_name, email, phone, role, is_active, created_at, updated_at",
      [response.locals.clerkUserId, firstName, lastName, clerkProfile.email, clerkProfile.phone, body.role],
    );
    const user = created.rows[0];
    let profile;
    if (body.role === "doctor") {
      profile = (await client.query("INSERT INTO doctors (user_id, specialty) VALUES ($1, $2) RETURNING id, specialty, bio, consultation_fee::float8 AS consultation_fee, created_at, updated_at", [user.id, body.specialty])).rows[0];
    } else {
      profile = (await client.query("INSERT INTO patients (user_id) VALUES ($1) RETURNING id, date_of_birth, gender, created_at, updated_at", [user.id])).rows[0];
    }
    await client.query("COMMIT");
    return response.status(201).json({ ...user, profile });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return sendDatabaseError(error, response, next);
  } finally { client.release(); }
}

async function patchMe(request, response, next) {
  const fields = response.locals.body;
  const columns = Object.keys(fields);
  const values = columns.map((column) => fields[column]);
  const assignments = columns.map((column, index) => `${column} = $${index + 1}`);
  values.push(response.locals.user.id);
  try {
    const result = await response.locals.database.query(
      `UPDATE users SET ${assignments.join(", ")}, updated_at = NOW() WHERE id = $${values.length} RETURNING id, first_name, last_name, email, phone, role, is_active, created_at, updated_at`,
      values,
    );
    return response.json(result.rows[0]);
  } catch (error) { return sendDatabaseError(error, response, next); }
}

module.exports = { createMe, getMe, patchMe };
