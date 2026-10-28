import { z } from "zod";

export const onboardingFormSchema = z.object({
  first_name: z.string().trim().min(1, "Enter your first name.").max(100, "Use 100 characters or fewer."),
  last_name: z.string().trim().min(1, "Enter your last name.").max(100, "Use 100 characters or fewer."),
  phone: z.string().trim().max(40, "Use 40 characters or fewer."),
  date_of_birth: z.string().refine((value) => value === "" || z.iso.date().safeParse(value).success, "Enter a valid date."),
  gender: z.string().trim().max(40, "Use 40 characters or fewer."),
  specialty: z.string().trim().max(150, "Use 150 characters or fewer."),
  bio: z.string().trim().max(5000, "Use 5,000 characters or fewer."),
});

export type OnboardingFormValues = z.infer<typeof onboardingFormSchema>;

export const emptyOnboardingForm: OnboardingFormValues = {
  first_name: "",
  last_name: "",
  phone: "",
  date_of_birth: "",
  gender: "",
  specialty: "",
  bio: "",
};
