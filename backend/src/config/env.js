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
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
  CLERK_SECRET_KEY: z.string().min(1),
  APPLICATION_TIMEZONE: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.string().min(1).refine(isValidTimeZone, "APPLICATION_TIMEZONE must be a valid IANA timezone").optional(),
  ),
  DATABASE_URL: z.string().url().refine((value) => value.startsWith("postgres://") || value.startsWith("postgresql://"), {
    message: "DATABASE_URL must use PostgreSQL",
  }),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const invalidKeys = result.error.issues.map((issue) => issue.path.join("."));
  throw new Error(`Invalid environment configuration: ${invalidKeys.join(", ")}`);
}

module.exports = result.data;
