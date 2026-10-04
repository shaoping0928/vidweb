CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT,
  title TEXT,
  size INTEGER DEFAULT 0,
  mtime INTEGER DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  last_position_ms INTEGER DEFAULT 0,
  play_count INTEGER DEFAULT 0,
  last_played_at INTEGER DEFAULT 0,
  added_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  color TEXT,
  created_at INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_tags (
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, tag_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  position_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER DEFAULT 0,
  updated_at INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_comments_file ON comments(file_id, position_ms);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag_id);
