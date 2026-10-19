-- AlterTable
ALTER TABLE "instances" ADD COLUMN     "firstConnectedAt" TIMESTAMPTZ(3);

-- Hand-written: the outbound rate limit uses "firstConnectedAt" for the warm-up of a new number.
-- An instance that is connected or was connected before this migration counts as warm.
UPDATE "instances" SET "firstConnectedAt" = "createdAt"
WHERE "status" IN ('connected', 'disconnected') AND "firstConnectedAt" IS NULL;

-- The first change to the status `connected` sets "firstConnectedAt". A later change does not move it.
-- Thus the instances slice does not need to know about the warm-up.
CREATE FUNCTION instances_set_first_connected_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" = 'connected' AND NEW."firstConnectedAt" IS NULL THEN
    NEW."firstConnectedAt" := now();
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instances_first_connected_at
BEFORE INSERT OR UPDATE OF "status" ON "instances"
FOR EACH ROW EXECUTE FUNCTION instances_set_first_connected_at();
