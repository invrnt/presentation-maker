CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'normal')),
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE INDEX sessions_token_hash_idx ON sessions(token_hash);
CREATE INDEX sessions_user_id_idx ON sessions(user_id);

CREATE TABLE songs (
  id TEXT PRIMARY KEY,
  youtube_id TEXT NOT NULL UNIQUE,
  youtube_url TEXT NOT NULL,
  title TEXT NOT NULL,
  duration_seconds INTEGER,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

