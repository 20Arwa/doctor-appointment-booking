const { getAuth, clerkClient } = require("@clerk/express");

function requireClerkIdentity(request, response, next) {
  const auth = request.auth || getAuth(request);
  if (!auth.isAuthenticated || !auth.userId) {
    return response.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Authentication is required" } });
  }
  response.locals.clerkUserId = auth.userId;
  return next();
}

async function getClerkProfile(clerkUserId) {
  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  const primaryEmail = clerkUser.emailAddresses.find((email) => email.id === clerkUser.primaryEmailAddressId);
  if (!primaryEmail?.emailAddress) {
    const error = new Error("A primary email address is required");
    error.status = 422;
    error.code = "EMAIL_REQUIRED";
    throw error;
  }
  const primaryPhone = clerkUser.phoneNumbers.find((phone) => phone.id === clerkUser.primaryPhoneNumberId);
  return {
    firstName: clerkUser.firstName?.trim() || "",
    lastName: clerkUser.lastName?.trim() || "",
    email: primaryEmail.emailAddress.trim(),
    phone: primaryPhone?.phoneNumber || null,
  };
}

async function requireLocalUser(request, response, next) {
  try {
    const result = await response.locals.database.query(
      "SELECT id, first_name, last_name, email, phone, role, is_active, created_at, updated_at FROM users WHERE clerk_user_id = $1",
      [response.locals.clerkUserId],
    );
    const user = result.rows[0];
    if (!user) {
      return response.status(404).json({ error: { code: "PROFILE_NOT_FOUND", message: "Complete onboarding first" } });
    }
    if (!user.is_active) {
      return response.status(403).json({ error: { code: "ACCOUNT_INACTIVE", message: "This account is inactive" } });
    }
    response.locals.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { getClerkProfile, requireClerkIdentity, requireLocalUser };
