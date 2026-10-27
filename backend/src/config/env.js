const dotenv = require("dotenv");
const { z } = require("zod");

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  FRONTEND_ORIGIN: z.string().url().default("http://localhost:3000"),
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
