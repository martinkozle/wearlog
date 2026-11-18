CREATE TABLE wardrobes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE wardrobe_members (
  wardrobe_id TEXT NOT NULL REFERENCES wardrobes(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  PRIMARY KEY (wardrobe_id, email)
);
CREATE INDEX wardrobes_by_member ON wardrobe_members(email, wardrobe_id);

CREATE TABLE wardrobe_invites (
  token_hash TEXT PRIMARY KEY,
  wardrobe_id TEXT NOT NULL REFERENCES wardrobes(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  redeemed_by TEXT
);

CREATE INDEX invites_by_expiry ON wardrobe_invites(expires_at);

CREATE TRIGGER join_wardrobe_on_redemption
AFTER UPDATE OF redeemed_by ON wardrobe_invites
WHEN OLD.redeemed_by IS NULL AND NEW.redeemed_by IS NOT NULL
BEGIN
  INSERT INTO wardrobe_members (wardrobe_id, email) VALUES (NEW.wardrobe_id, NEW.redeemed_by);
END;

CREATE TABLE wardrobe_records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  wardrobe_id TEXT NOT NULL REFERENCES wardrobes(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  body TEXT NOT NULL CHECK(json_valid(body)),
  actor_id TEXT,
  actor_name TEXT,
  UNIQUE (wardrobe_id, id)
);
CREATE INDEX wardrobe_sync_cursor ON wardrobe_records(wardrobe_id, seq);

CREATE TRIGGER immutable_wardrobe_record
BEFORE UPDATE OF body ON wardrobe_records
WHEN OLD.body <> NEW.body
BEGIN
  SELECT RAISE(ABORT, 'record_id_conflict');
END;

CREATE TABLE legacy_wardrobe_migration (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1)
);

CREATE TABLE wardrobe_photo_cleanup (
  wardrobe_id TEXT PRIMARY KEY,
  cursor TEXT,
  revision TEXT NOT NULL DEFAULT (lower(hex(randomblob(16))))
);

CREATE TRIGGER delete_empty_wardrobe
AFTER DELETE ON wardrobe_members
WHEN NOT EXISTS (SELECT 1 FROM wardrobe_members WHERE wardrobe_id = OLD.wardrobe_id)
BEGIN
  INSERT INTO wardrobe_photo_cleanup (wardrobe_id) VALUES (OLD.wardrobe_id);
  DELETE FROM wardrobes WHERE id = OLD.wardrobe_id;
END;
