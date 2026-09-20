CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO app_settings(key, value, updated_at)
VALUES ('ai_model', 'openai/gpt-5.6-luna', unixepoch());
