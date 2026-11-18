CREATE TABLE IF NOT EXISTS records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  body TEXT NOT NULL CHECK(json_valid(body))
);
-- Abort a whole batch on conflicting IDs, including concurrent requests.
CREATE TRIGGER IF NOT EXISTS immutable_record
BEFORE UPDATE OF body ON records
WHEN old.body <> new.body
BEGIN
  SELECT RAISE(ABORT, 'record_id_conflict');
END;
