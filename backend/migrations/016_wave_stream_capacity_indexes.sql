-- Wave capacity is enforced by serialized allocation/hold checks in the API.
-- The legacy hold index limited each availability slot to one checkout at a time.
DROP INDEX IF EXISTS appointment_slot_holds_one_active_per_slot;
