const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch (_error) {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  FRONTEND_ORIGIN: z.string().url().optional().refine((value) => {
    if (!value) return true;
    const origin = new URL(value);
    return (origin.protocol === "http:" || origin.protocol === "https:")
      && origin.pathname === "/" && !origin.search && !origin.hash
      && !origin.username && !origin.password;
  }, "FRONTEND_ORIGIN must be an HTTP(S) origin without a path"),
  CLERK_SECRET_KEY: z.string().min(1),
  BREVO_API_KEY: z.string().optional(),
  BREVO_SENDER_EMAIL: z.string().optional(),
  BREVO_SENDER_NAME: z.string().optional(),
  SMS_PROVIDER: z.enum(["mock"]).default("mock"),
  REMINDER_CRON_SECRET: z.string().min(32).optional(),
  NOTIFICATION_RECOVERY_CRON_SECRET: z.string().min(32).optional(),
  STRIPE_SECRET_KEY: z.string().optional().refine((value) => !value || value.startsWith("sk_test_"), "STRIPE_SECRET_KEY must be a Stripe Test Mode key"),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  APPLICATION_TIMEZONE: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(1).refine(isValidTimeZone, "APPLICATION_TIMEZONE must be a valid IANA timezone").optional(),
  ),
  DATABASE_URL: z.string().url().refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
    message: "DATABASE_URL must use PostgreSQL",
  }),
}).superRefine((environment, context) => {
  if (environment.NODE_ENV !== "production") return;
  if (!environment.FRONTEND_ORIGIN) {
    context.addIssue({ code: "custom", path: ["FRONTEND_ORIGIN"], message: "FRONTEND_ORIGIN is required in production" });
    return;
  }
  if (new URL(environment.FRONTEND_ORIGIN).protocol !== "https:") {
    context.addIssue({ code: "custom", path: ["FRONTEND_ORIGIN"], message: "FRONTEND_ORIGIN must use HTTPS in production" });
  }
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const invalidKeys = result.error.issues.map((issue) => issue.path.join("."));
  throw new Error(`Invalid environment configuration: ${invalidKeys.join(", ")}`);
}

module.exports = {
  ...result.data,
  FRONTEND_ORIGIN: result.data.FRONTEND_ORIGIN || "http://localhost:3000",
};
