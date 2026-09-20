package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

type store struct{ *sql.DB }
type projectRow struct {
	ID, Title            string
	Document             json.RawMessage
	CreatedAt, UpdatedAt int64
}
type cachedMedia struct {
	YoutubeID, SongID, Path, ThumbnailPath string
	Width, Height, Duration                int
	Status                                 string
	UpdatedAt                              int64
}

func openStore(path string) (*store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	schema := `
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, document_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS media_cache (youtube_id TEXT PRIMARY KEY, song_id TEXT NOT NULL, path TEXT NOT NULL, thumbnail_path TEXT NOT NULL DEFAULT '', width INTEGER NOT NULL DEFAULT 0, height INTEGER NOT NULL DEFAULT 0, duration INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS songs_cache (id TEXT PRIMARY KEY, youtube_id TEXT NOT NULL UNIQUE, youtube_url TEXT NOT NULL, title TEXT NOT NULL, duration_seconds INTEGER, updated_at INTEGER NOT NULL);`
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &store{db}, nil
}

func (s *store) projects() ([]projectRow, error) {
	rows, err := s.Query(`SELECT id,title,document_json,created_at,updated_at FROM projects ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []projectRow{}
	for rows.Next() {
		var item projectRow
		if err := rows.Scan(&item.ID, &item.Title, &item.Document, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *store) project(id string) (projectRow, error) {
	var item projectRow
	err := s.QueryRow(`SELECT id,title,document_json,created_at,updated_at FROM projects WHERE id=?`, id).Scan(&item.ID, &item.Title, &item.Document, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

func (s *store) insertProject(id, title string, document []byte) (projectRow, error) {
	now := time.Now().Unix()
	_, err := s.Exec(`INSERT INTO projects(id,title,document_json,created_at,updated_at) VALUES(?,?,?,?,?)`, id, title, document, now, now)
	return projectRow{id, title, document, now, now}, err
}

func (s *store) saveProject(id, title string, document []byte) error {
	result, err := s.Exec(`UPDATE projects SET title=?,document_json=?,updated_at=? WHERE id=?`, title, document, time.Now().Unix(), id)
	if err != nil {
		return err
	}
	changed, _ := result.RowsAffected()
	if changed != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *store) setting(key string) string {
	var value string
	_ = s.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&value)
	return value
}
func (s *store) setSetting(key, value string) error {
	_, err := s.Exec(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}
func (s *store) deleteSetting(key string) { _, _ = s.Exec(`DELETE FROM settings WHERE key=?`, key) }

func (s *store) media(youtubeID string) (cachedMedia, error) {
	var m cachedMedia
	err := s.QueryRow(`SELECT youtube_id,song_id,path,thumbnail_path,width,height,duration,status,updated_at FROM media_cache WHERE youtube_id=?`, youtubeID).Scan(&m.YoutubeID, &m.SongID, &m.Path, &m.ThumbnailPath, &m.Width, &m.Height, &m.Duration, &m.Status, &m.UpdatedAt)
	return m, err
}

func (s *store) saveMedia(m cachedMedia) error {
	_, err := s.Exec(`INSERT INTO media_cache(youtube_id,song_id,path,thumbnail_path,width,height,duration,status,updated_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(youtube_id) DO UPDATE SET song_id=excluded.song_id,path=excluded.path,thumbnail_path=excluded.thumbnail_path,width=excluded.width,height=excluded.height,duration=excluded.duration,status=excluded.status,updated_at=excluded.updated_at`, m.YoutubeID, m.SongID, m.Path, m.ThumbnailPath, m.Width, m.Height, m.Duration, m.Status, time.Now().Unix())
	return err
}

func scanJSON(value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("serializar: %w", err)
	}
	return data, nil
}
