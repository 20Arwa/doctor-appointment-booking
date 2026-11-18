const env = require("../src/config/env");
const database = require("../src/config/database");
const { clerkClient } = require("@clerk/express");

async function provision(clerkUserId) {
  if (!/^user_[A-Za-z0-9]+$/.test(clerkUserId || "")) {
    throw new Error("Usage: npm run provision:receptionist -- <existing-clerk-user-id>");
  }

  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  if (!clerkUser.passwordEnabled) throw new Error("The Clerk user must have password sign-in enabled.");
  const primaryEmail = clerkUser.emailAddresses.find((email) => email.id === clerkUser.primaryEmailAddressId);
  if (!primaryEmail?.emailAddress || primaryEmail.verification?.status !== "verified") {
    throw new Error("The Clerk user must have a verified primary email address.");
  }
  const firstName = clerkUser.firstName?.trim();
  const lastName = clerkUser.lastName?.trim();
  if (!firstName || !lastName) throw new Error("The Clerk user must have a first and last name before provisioning.");
  const primaryPhone = clerkUser.phoneNumbers.find((phone) => phone.id === clerkUser.primaryPhoneNumberId);

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id, role, is_active FROM users WHERE clerk_user_id = $1 FOR UPDATE", [clerkUserId]);
    if (existing.rows[0]) {
      if (existing.rows[0].role !== "receptionist") throw new Error("This Clerk user already has a different local role; roles cannot be changed by provisioning.");
      if (!existing.rows[0].is_active) throw new Error("This receptionist profile is inactive; provisioning will not reactivate it.");
      await client.query("COMMIT");
      return "Receptionist profile already exists and is active.";
    }
    await client.query(
      `INSERT INTO users (clerk_user_id, first_name, last_name, email, phone, role)
       VALUES ($1, $2, $3, $4, $5, 'receptionist')`,
      [clerkUserId, firstName, lastName, primaryEmail.emailAddress.trim(), primaryPhone?.phoneNumber || null],
    );
    await client.query("COMMIT");
    return "Receptionist profile provisioned.";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

provision(process.argv[2]).then((message) => {
  process.stdout.write(`${message}\n`);
}).catch(async (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}).finally(() => database.end());
