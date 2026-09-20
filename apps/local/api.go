package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var safeID = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

type user struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	Role     string `json:"role"`
}
type projectDocument struct {
	Version int     `json:"version"`
	ID      string  `json:"id"`
	Title   string  `json:"title"`
	Slides  []slide `json:"slides"`
}
type slide struct {
	ID       string    `json:"id"`
	Elements []element `json:"elements"`
}
type element struct {
	Type, ID                                  string
	X, Y, Width, Height                       float64
	Text, FontFamily, Color, Align            string
	FontSize, FontWeight                      int
	AssetID, Fit, YoutubeID, Title, PosterURL string
}
type song struct {
	ID              string `json:"id"`
	YoutubeID       string `json:"youtubeId"`
	YoutubeURL      string `json:"youtubeUrl"`
	Title           string `json:"title"`
	DurationSeconds int    `json:"durationSeconds,omitempty"`
	Downloaded      bool   `json:"downloaded"`
	PosterURL       string `json:"posterUrl,omitempty"`
}

func (e *element) UnmarshalJSON(data []byte) error {
	type wire struct {
		Type       string  `json:"type"`
		ID         string  `json:"id"`
		X          float64 `json:"x"`
		Y          float64 `json:"y"`
		Width      float64 `json:"width"`
		Height     float64 `json:"height"`
		Text       string  `json:"text"`
		FontFamily string  `json:"fontFamily"`
		FontSize   int     `json:"fontSize"`
		FontWeight int     `json:"fontWeight"`
		Color      string  `json:"color"`
		Align      string  `json:"align"`
		AssetID    string  `json:"assetId"`
		Fit        string  `json:"fit"`
		YoutubeID  string  `json:"youtubeId"`
		Title      string  `json:"title"`
		PosterURL  string  `json:"posterUrl"`
	}
	var w wire
	if err := json.Unmarshal(data, &w); err != nil {
		return err
	}
	*e = element{w.Type, w.ID, w.X, w.Y, w.Width, w.Height, w.Text, w.FontFamily, w.Color, w.Align, w.FontSize, w.FontWeight, w.AssetID, w.Fit, w.YoutubeID, w.Title, w.PosterURL}
	return nil
}
func (e element) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"type": e.Type, "id": e.ID, "x": e.X, "y": e.Y, "width": e.Width, "height": e.Height, "text": e.Text, "fontFamily": e.FontFamily, "fontSize": e.FontSize, "fontWeight": e.FontWeight, "color": e.Color, "align": e.Align, "assetId": e.AssetID, "fit": e.Fit, "youtubeId": e.YoutubeID, "title": e.Title, "posterUrl": e.PosterURL})
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		jsonResponse(w, http.StatusOK, map[string]any{"ok": true, "version": version})
	})
	mux.HandleFunc("/api/auth/login", a.login)
	mux.HandleFunc("/api/auth/me", a.me)
	mux.HandleFunc("/api/auth/logout", a.logout)
	mux.HandleFunc("/api/projects", a.requireAuth(a.projectsHandler))
	mux.HandleFunc("/api/projects/", a.requireAuth(a.projectHandler))
	mux.HandleFunc("/api/assets", a.requireAuth(a.assetsHandler))
	mux.HandleFunc("/api/songs", a.requireAuth(a.songsHandler))
	mux.HandleFunc("/api/songs/import", a.requireAuth(a.importSongHandler))
	mux.HandleFunc("/api/songs/", a.requireAuth(a.songActionHandler))
	mux.HandleFunc("/api/jobs/", a.requireAuth(a.jobEventsHandler))
	mux.HandleFunc("/api/admin/users", a.requireAuth(a.adminUsersHandler))
	mux.HandleFunc("/api/update", a.requireAuth(a.updateHandler))
	mux.HandleFunc("/api/update/start", a.requireAuth(a.startUpdateHandler))
	mux.HandleFunc("/media/assets/", a.requireAuth(a.assetFile))
	mux.HandleFunc("/media/posters/", a.requireAuth(a.posterFile))
	mux.HandleFunc("/api/exports/", a.requireAuth(a.exportFile))
	mux.HandleFunc("/", a.frontendHandler)
	return securityHeaders(mux)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
func jsonResponse(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func jsonError(w http.ResponseWriter, status int, message string) {
	jsonResponse(w, status, map[string]string{"error": message})
}
func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		jsonError(w, 400, "Los datos enviados no son válidos.")
		return false
	}
	return true
}
func only(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method != method {
		w.Header().Set("Allow", method)
		jsonError(w, 405, "Método no permitido.")
		return false
	}
	return true
}

func (a *app) remote(method, endpoint string, body any, authenticated bool) ([]byte, int, error) {
	if a.worker == "" {
		return nil, 0, fmt.Errorf("el servidor remoto no está configurado")
	}
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return nil, 0, err
		}
		reader = bytes.NewReader(data)
	}
	request, err := http.NewRequest(method, strings.TrimRight(a.worker, "/")+endpoint, reader)
	if err != nil {
		return nil, 0, err
	}
	request.Header.Set("Content-Type", "application/json")
	if authenticated {
		token := a.db.setting("session_token")
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
	}
	response, err := a.client.Do(request)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	return data, response.StatusCode, err
}

func (a *app) login(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	var input struct{ Username, Password string }
	if !decodeJSON(w, r, &input) {
		return
	}
	data, status, err := a.remote("POST", "/v1/auth/login", map[string]string{"username": input.Username, "password": input.Password}, false)
	if err != nil {
		jsonError(w, 503, "No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.")
		return
	}
	if status != 200 {
		var problem map[string]string
		_ = json.Unmarshal(data, &problem)
		message := problem["error"]
		if message == "" {
			message = "Usuario o contraseña incorrectos."
		}
		jsonError(w, status, message)
		return
	}
	var result struct {
		Token     string `json:"token"`
		User      user   `json:"user"`
		ExpiresAt int64  `json:"expiresAt"`
	}
	if json.Unmarshal(data, &result) != nil {
		jsonError(w, 502, "El servidor respondió con datos inválidos.")
		return
	}
	userData, _ := json.Marshal(result.User)
	_ = a.db.setSetting("session_token", result.Token)
	_ = a.db.setSetting("session_user", string(userData))
	_ = a.db.setSetting("session_expires", fmt.Sprint(result.ExpiresAt))
	jsonResponse(w, 200, result.User)
}

func (a *app) cachedUser() (user, bool) {
	var u user
	value := a.db.setting("session_user")
	if value == "" || json.Unmarshal([]byte(value), &u) != nil {
		return u, false
	}
	var expires int64
	fmt.Sscan(a.db.setting("session_expires"), &expires)
	return u, expires > time.Now().Unix()
}
func (a *app) me(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	u, ok := a.cachedUser()
	if !ok {
		jsonError(w, 401, "Inicia sesión para continuar.")
		return
	}
	if data, status, err := a.remote("GET", "/v1/auth/me", nil, true); err == nil {
		if status == 200 {
			var fresh user
			if json.Unmarshal(data, &fresh) == nil {
				encoded, _ := json.Marshal(fresh)
				_ = a.db.setSetting("session_user", string(encoded))
				_ = a.db.setSetting("session_expires", fmt.Sprint(time.Now().Add(365*24*time.Hour).Unix()))
				jsonResponse(w, 200, fresh)
				return
			}
		}
		if status == 401 {
			a.clearSession()
			jsonError(w, 401, "Tu sesión terminó. Vuelve a entrar.")
			return
		}
	}
	jsonResponse(w, 200, u)
}
func (a *app) logout(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	a.clearSession()
	jsonResponse(w, 200, map[string]bool{"ok": true})
}
func (a *app) clearSession() {
	a.db.deleteSetting("session_token")
	a.db.deleteSetting("session_user")
	a.db.deleteSetting("session_expires")
}
func (a *app) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, ok := a.cachedUser(); !ok {
			jsonError(w, 401, "Inicia sesión para continuar.")
			return
		}
		next(w, r)
	}
}

func projectJSON(row projectRow) map[string]any {
	var document any
	_ = json.Unmarshal(row.Document, &document)
	return map[string]any{"id": row.ID, "title": row.Title, "document": document, "createdAt": row.CreatedAt, "updatedAt": row.UpdatedAt}
}
func (a *app) projectsHandler(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case "GET":
		items, err := a.db.projects()
		if err != nil {
			jsonError(w, 500, "No se pudieron abrir los proyectos.")
			return
		}
		result := make([]any, 0, len(items))
		for _, item := range items {
			result = append(result, projectJSON(item))
		}
		jsonResponse(w, 200, result)
	case "POST":
		now := time.Now()
		id := randomID()
		title := spanishDate(now)
		doc := projectDocument{1, id, title, []slide{{ID: randomID(), Elements: []element{}}}}
		data, _ := json.Marshal(doc)
		row, err := a.db.insertProject(id, title, data)
		if err != nil {
			jsonError(w, 500, "No se pudo crear el proyecto.")
			return
		}
		jsonResponse(w, 201, projectJSON(row))
	default:
		jsonError(w, 405, "Método no permitido.")
	}
}

func (a *app) projectHandler(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/projects/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) == 2 && parts[1] == "export" {
		if r.Method != "POST" {
			jsonError(w, 405, "Método no permitido.")
			return
		}
		a.exportProjectHandler(w, r, parts[0])
		return
	}
	id := parts[0]
	if !safeID.MatchString(id) {
		jsonError(w, 400, "Proyecto inválido.")
		return
	}
	if r.Method == "GET" {
		row, err := a.db.project(id)
		if err == sql.ErrNoRows {
			jsonError(w, 404, "No encontramos ese proyecto.")
			return
		}
		if err != nil {
			jsonError(w, 500, "No se pudo abrir el proyecto.")
			return
		}
		jsonResponse(w, 200, projectJSON(row))
		return
	}
	if r.Method == "PUT" {
		var doc projectDocument
		if !decodeJSON(w, r, &doc) {
			return
		}
		if doc.ID != id || doc.Version != 1 || len(doc.Slides) == 0 {
			jsonError(w, 400, "El proyecto no es válido.")
			return
		}
		data, _ := json.Marshal(doc)
		if err := a.db.saveProject(id, doc.Title, data); err != nil {
			jsonError(w, 500, "No se pudo guardar el proyecto.")
			return
		}
		jsonResponse(w, 200, map[string]bool{"ok": true})
		return
	}
	jsonError(w, 405, "Método no permitido.")
}

func (a *app) assetsHandler(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 20<<20)
	if err := r.ParseMultipartForm(20 << 20); err != nil {
		jsonError(w, 400, "La imagen es demasiado grande.")
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		jsonError(w, 400, "Selecciona una imagen.")
		return
	}
	defer file.Close()
	ext := strings.ToLower(filepath.Ext(header.Filename))
	if ext != ".jpg" && ext != ".jpeg" && ext != ".png" {
		jsonError(w, 400, "Usa una imagen JPG o PNG.")
		return
	}
	id := randomID()
	target := filepath.Join(a.root, "assets", id+ext)
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		jsonError(w, 500, "No se pudo guardar la imagen.")
		return
	}
	_, copyErr := io.Copy(out, file)
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(target)
		jsonError(w, 500, "No se pudo guardar la imagen.")
		return
	}
	jsonResponse(w, 201, map[string]string{"assetId": id + ext, "url": "/media/assets/" + id + ext})
}

func serveSafeFile(w http.ResponseWriter, r *http.Request, base, name string, download bool) {
	if path.Base(name) != name || name == "" {
		http.NotFound(w, r)
		return
	}
	file := filepath.Join(base, name)
	if download {
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, strings.ReplaceAll(name, "\"", "")))
	}
	http.ServeFile(w, r, file)
}
func (a *app) assetFile(w http.ResponseWriter, r *http.Request) {
	serveSafeFile(w, r, filepath.Join(a.root, "assets"), strings.TrimPrefix(r.URL.Path, "/media/assets/"), false)
}
func (a *app) posterFile(w http.ResponseWriter, r *http.Request) {
	serveSafeFile(w, r, filepath.Join(a.root, "cache", "thumbnails"), strings.TrimPrefix(r.URL.Path, "/media/posters/"), false)
}
func (a *app) exportFile(w http.ResponseWriter, r *http.Request) {
	serveSafeFile(w, r, filepath.Join(a.root, "exports"), strings.TrimPrefix(r.URL.Path, "/api/exports/"), true)
}

func (a *app) adminUsersHandler(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	u, _ := a.cachedUser()
	if u.Role != "admin" {
		jsonError(w, 403, "Solo un administrador puede crear usuarios.")
		return
	}
	var input struct{ Username, Password, Role string }
	if !decodeJSON(w, r, &input) {
		return
	}
	data, status, err := a.remote("POST", "/v1/admin/users", input, true)
	if err != nil {
		jsonError(w, 503, "No se pudo conectar.")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func (a *app) frontendHandler(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") || strings.HasPrefix(r.URL.Path, "/media/") {
		http.NotFound(w, r)
		return
	}
	name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if name == "" {
		name = "index.html"
	}
	if _, err := fsStat(a.frontend, name); err != nil {
		name = "index.html"
	}
	file, err := a.frontend.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	if strings.HasPrefix(name, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	if contentType := mime.TypeByExtension(filepath.Ext(name)); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	_, _ = io.Copy(w, file)
}
func fsStat(filesystem fs.FS, name string) (fs.FileInfo, error) { return fs.Stat(filesystem, name) }

func randomID() string {
	return fmt.Sprintf("%x", time.Now().UnixNano()) + fmt.Sprintf("%x", time.Now().UnixNano()%7919)
}
func spanishDate(t time.Time) string {
	months := []string{"enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"}
	hour := t.Hour()
	period := "a. m."
	if hour >= 12 {
		period = "p. m."
	}
	hour %= 12
	if hour == 0 {
		hour = 12
	}
	return fmt.Sprintf("%d de %s de %d · %d:%02d %s", t.Day(), months[int(t.Month())-1], t.Year(), hour, t.Minute(), period)
}
