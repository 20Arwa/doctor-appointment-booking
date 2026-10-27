function localDateTime(timeZone, instant = new Date()) {
  if (!timeZone) return null;
  try {
    const values = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant).filter((part) => part.type !== "literal").map(({ type, value }) => [type, value]));
    return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
  } catch (_error) {
    return null;
  }
}

function slotStartsInFuture(slot, now) {
  return slot.date > now.date || (slot.date === now.date && slot.start_time > now.time);
}

module.exports = { localDateTime, slotStartsInFuture };
