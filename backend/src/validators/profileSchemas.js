const { z } = require("zod");

const name = z.string().trim().min(1).max(100);
const phone = z.string().trim().max(40).nullable().optional();

const onboardingSchema = z.object({
  role: z.enum(["patient", "doctor"]),
  first_name: name.optional(),
  last_name: name.optional(),
  specialty: z.string().trim().min(1).max(150).optional(),
}).strict().superRefine((body, context) => {
  if (body.role === "doctor" && !body.specialty) {
    context.addIssue({ code: "custom", path: ["specialty"], message: "Specialty is required for doctor onboarding" });
  }
});

const userPatchSchema = z.object({ first_name: name.optional(), last_name: name.optional(), phone }).strict()
  .refine((body) => Object.keys(body).length > 0, "At least one permitted field is required");
const patientUpdateSchema = z.object({
  date_of_birth: z.iso.date().nullable().optional(),
  gender: z.string().trim().max(40).nullable().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, "At least one field is required");
const doctorUpdateSchema = z.object({ specialty: z.string().trim().min(1).max(150).optional(), bio: z.string().trim().max(5000).nullable().optional() })
  .strict().refine((body) => Object.keys(body).length > 0, "At least one field is required");
const idParamsSchema = z.object({ id: z.uuid() }).strict();

module.exports = { doctorUpdateSchema, idParamsSchema, onboardingSchema, patientUpdateSchema, userPatchSchema };
