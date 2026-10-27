const { z } = require("zod");

const date = z.iso.date();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Time must use HH:mm format");

const doctorIdParamsSchema = z.object({ id: z.uuid() }).strict();
const slotParamsSchema = z.object({ id: z.uuid(), slotId: z.uuid() }).strict();
const slotQuerySchema = z.object({ from: date.optional(), to: date.optional() }).strict()
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    path: ["to"],
    message: "to must be on or after from",
  });

const slotsBodySchema = z.object({
  slots: z.array(z.object({ date, start_time: time, end_time: time }).strict()).min(1).max(100),
}).strict().superRefine(({ slots }, context) => {
  const toMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const start = toMinutes(slot.start_time);
    const end = toMinutes(slot.end_time);
    if (end <= start) {
      context.addIssue({ code: "custom", path: ["slots", index, "end_time"], message: "end_time must be later than start_time" });
    }
    for (let otherIndex = 0; otherIndex < index; otherIndex += 1) {
      const other = slots[otherIndex];
      if (slot.date !== other.date) continue;
      const otherStart = toMinutes(other.start_time);
      const otherEnd = toMinutes(other.end_time);
      if (slot.start_time === other.start_time) {
        context.addIssue({ code: "custom", path: ["slots", index, "start_time"], message: "Duplicate slot start for this date" });
      }
      if (start < otherEnd && otherStart < end) {
        context.addIssue({ code: "custom", path: ["slots", index], message: "Slots on the same date cannot overlap" });
      }
    }
  }
});

module.exports = { doctorIdParamsSchema, slotParamsSchema, slotQuerySchema, slotsBodySchema };
