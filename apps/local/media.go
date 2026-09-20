package main

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

const ytDLPVersion = "2026.08.19"

var ytDLPUpdateMu sync.Mutex
var ytDLPReady bool

type job struct {
	ID, Message, Error string
	Done               bool
	Updated            int64
}
type jobManager struct {
	mu        sync.RWMutex
	jobs      map[string]*job
	mediaLock sync.Mutex
}

func newJobManager() *jobManager { return &jobManager{jobs: map[string]*job{}} }
func (m *jobManager) create() *job {
	j := &job{ID: randomID(), Message: "En cola…", Updated: time.Now().UnixNano()}
	m.mu.Lock()
	m.jobs[j.ID] = j
	m.mu.Unlock()
	return j
}
func (m *jobManager) update(id, message, problem string, done bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if j := m.jobs[id]; j != nil {
		j.Message = message
		j.Error = problem
		j.Done = done
		j.Updated = time.Now().UnixNano()
	}
}
func (m *jobManager) get(id string) (job, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	j, ok := m.jobs[id]
	if !ok {
		return job{}, false
	}
	return *j, true
}

func (a *app) songsHandler(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	if data, status, err := a.remote("GET", "/v1/songs", nil, true); err == nil && status == 200 {
		var remoteSongs []song
		if json.Unmarshal(data, &remoteSongs) == nil {
			for _, item := range remoteSongs {
				_, _ = a.db.Exec(`INSERT INTO songs_cache(id,youtube_id,youtube_url,title,duration_seconds,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET youtube_id=excluded.youtube_id,youtube_url=excluded.youtube_url,title=excluded.title,duration_seconds=excluded.duration_seconds,updated_at=excluded.updated_at`, item.ID, item.YoutubeID, item.YoutubeURL, item.Title, item.DurationSeconds, time.Now().Unix())
			}
		}
	}
	rows, err := a.db.Query(`SELECT s.id,s.youtube_id,s.youtube_url,s.title,COALESCE(s.duration_seconds,0),COALESCE(m.path,''),COALESCE(m.thumbnail_path,''),COALESCE(m.status,'') FROM songs_cache s LEFT JOIN media_cache m ON m.youtube_id=s.youtube_id ORDER BY s.title COLLATE NOCASE`)
	if err != nil {
		jsonError(w, 500, "No se pudo abrir el repertorio.")
		return
	}
	defer rows.Close()
	items := []song{}
	for rows.Next() {
		var item song
		var mediaPath, thumbnailPath, mediaStatus string
		if rows.Scan(&item.ID, &item.YoutubeID, &item.YoutubeURL, &item.Title, &item.DurationSeconds, &mediaPath, &thumbnailPath, &mediaStatus) != nil {
			continue
		}
		if mediaStatus == "ready" {
			if _, err := os.Stat(mediaPath); err == nil {
				item.Downloaded = true
				if thumbnailPath != "" {
					item.PosterURL = "/media/posters/" + filepath.Base(thumbnailPath)
				}
			}
		}
		items = append(items, item)
	}
	jsonResponse(w, 200, items)
}

func (a *app) importSongHandler(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	var input struct {
		URL string `json:"url"`
	}
	if !decodeJSON(w, r, &input) {
		return
	}
	parsed, err := url.Parse(input.URL)
	host := strings.ToLower(parsed.Hostname())
	if err != nil || parsed.Scheme != "https" || (host != "youtu.be" && host != "youtube.com" && !strings.HasSuffix(host, ".youtube.com")) {
		jsonError(w, 400, "Pega un enlace válido de YouTube.")
		return
	}
	if err := a.ensureYTDLP(); err != nil {
		jsonError(w, 503, err.Error())
		return
	}
	command := exec.Command(a.bin("yt-dlp"), "--dump-single-json", "--skip-download", "--no-playlist", "--no-colors", "--", input.URL)
	output, err := command.CombinedOutput()
	if err != nil {
		jsonError(w, 502, "No se pudo leer ese video: "+lastLine(string(output)))
		return
	}
	var metadata struct {
		ID, Title string
		Duration  float64
	}
	if json.Unmarshal(output, &metadata) != nil || !youtubeIDPattern.MatchString(metadata.ID) {
		jsonError(w, 502, "YouTube devolvió información inválida.")
		return
	}
	payload := map[string]any{"youtubeId": metadata.ID, "youtubeUrl": input.URL, "title": metadata.Title, "durationSeconds": int(metadata.Duration)}
	data, status, err := a.remote("POST", "/v1/songs", payload, true)
	if err != nil {
		jsonError(w, 503, "No se pudo guardar la canción porque no hay conexión.")
		return
	}
	if status != 200 && status != 201 {
		var problem map[string]string
		_ = json.Unmarshal(data, &problem)
		jsonError(w, status, problem["error"])
		return
	}
	var item song
	if json.Unmarshal(data, &item) != nil {
		jsonError(w, 502, "El servidor devolvió datos inválidos.")
		return
	}
	_, _ = a.db.Exec(`INSERT INTO songs_cache(id,youtube_id,youtube_url,title,duration_seconds,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,duration_seconds=excluded.duration_seconds,updated_at=excluded.updated_at`, item.ID, item.YoutubeID, item.YoutubeURL, item.Title, item.DurationSeconds, time.Now().Unix())
	jsonResponse(w, 201, item)
}

var youtubeIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{6,20}$`)

func (a *app) songActionHandler(w http.ResponseWriter, r *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/songs/"), "/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[1] != "download" || !safeID.MatchString(parts[0]) {
		http.NotFound(w, r)
		return
	}
	if !only(w, r, "POST") {
		return
	}
	var item song
	err := a.db.QueryRow(`SELECT id,youtube_id,youtube_url,title,COALESCE(duration_seconds,0) FROM songs_cache WHERE id=?`, parts[0]).Scan(&item.ID, &item.YoutubeID, &item.YoutubeURL, &item.Title, &item.DurationSeconds)
	if err == sql.ErrNoRows {
		jsonError(w, 404, "No encontramos esa canción.")
		return
	}
	if err != nil {
		jsonError(w, 500, "No se pudo abrir la canción.")
		return
	}
	if media, err := a.db.media(item.YoutubeID); err == nil && media.Status == "ready" {
		if _, err := os.Stat(media.Path); err == nil {
			j := a.jobs.create()
			a.jobs.update(j.ID, "Listo", "", true)
			jsonResponse(w, 202, map[string]string{"jobId": j.ID})
			return
		}
	}
	j := a.jobs.create()
	go a.downloadSong(j.ID, item)
	jsonResponse(w, 202, map[string]string{"jobId": j.ID})
}

func (a *app) downloadSong(jobID string, item song) {
	a.jobs.mediaLock.Lock()
	defer a.jobs.mediaLock.Unlock()
	fail := func(message string) { a.jobs.update(jobID, "", message, true) }
	a.jobs.update(jobID, "Comprobando el descargador…", "", false)
	if err := a.ensureYTDLP(); err != nil {
		fail(err.Error())
		return
	}
	a.jobs.update(jobID, "Descargando video…", "", false)
	base := filepath.Join(a.root, "cache", "media", item.YoutubeID)
	output := base + ".mp4"
	temporary := base + ".download.mp4"
	removeDownloads := func() {
		matches, _ := filepath.Glob(base + ".download*")
		for _, match := range matches {
			_ = os.Remove(match)
		}
	}
	removeDownloads()
	ffmpegLocation := a.bin("ffmpeg")
	if resolved, lookupErr := exec.LookPath(ffmpegLocation); lookupErr == nil {
		ffmpegLocation = resolved
	}
	args := []string{"--no-playlist", "--newline", "--no-colors", "--concurrent-fragments", "4", "--retries", "5", "--fragment-retries", "5", "--ffmpeg-location", ffmpegLocation, "-f", "bv*[height<=?1080]+ba/b[height<=?1080]/18/b", "-S", "res:1080,vcodec:h264,acodec:aac", "--merge-output-format", "mp4", "-o", temporary, "--", item.YoutubeURL}
	command := exec.Command(a.bin("yt-dlp"), args...)
	pipe, err := command.StdoutPipe()
	if err != nil {
		fail("No se pudo iniciar la descarga.")
		return
	}
	command.Stderr = command.Stdout
	if err := command.Start(); err != nil {
		fail("yt-dlp no está instalado. Ejecuta de nuevo el instalador.")
		return
	}
	scanner := bufio.NewScanner(pipe)
	progress := regexp.MustCompile(`\[download\]\s+([0-9.]+)%`)
	lastOutput := ""
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lastOutput = line
		}
		if match := progress.FindStringSubmatch(line); len(match) == 2 {
			a.jobs.update(jobID, "Descargando "+strings.TrimSuffix(match[1], ".0")+"%", "", false)
		} else if strings.Contains(line, "Merging formats") {
			a.jobs.update(jobID, "Combinando video…", "", false)
		}
	}
	if err := command.Wait(); err != nil {
		removeDownloads()
		fail("La descarga falló: " + lastLine(lastOutput))
		return
	}
	if _, err := os.Stat(temporary); err != nil {
		removeDownloads()
		fail("yt-dlp no pudo combinar el video: " + lastLine(lastOutput))
		return
	}
	a.jobs.update(jobID, "Preparando para PowerPoint…", "", false)
	width, height, duration, vcodec, acodec := a.probe(temporary)
	if width < 1 || height < 1 || duration < 1 || vcodec == "" {
		removeDownloads()
		fail("El archivo descargado no contiene un video válido.")
		return
	}
	converted := base + ".converted.mp4"
	ffmpegArgs := []string{"-y", "-i", temporary, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"}
	if powerpointCopyable(vcodec, acodec) {
		ffmpegArgs = append(ffmpegArgs, "-c:v", "copy", "-c:a", "copy")
	} else {
		ffmpegArgs = append(ffmpegArgs, "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-profile:v", "high", "-level", "4.1", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k")
	}
	ffmpegArgs = append(ffmpegArgs, "-tag:v", "avc1", "-movflags", "+faststart", converted)
	if outputBytes, err := exec.Command(a.bin("ffmpeg"), ffmpegArgs...).CombinedOutput(); err != nil {
		_ = os.Remove(temporary)
		_ = os.Remove(converted)
		fail("FFmpeg no pudo preparar el video: " + lastLine(string(outputBytes)))
		return
	}
	_ = os.Remove(temporary)
	width, height, duration, vcodec, acodec = a.probe(converted)
	if width < 1 || height < 1 || duration < 1 || !powerpointCopyable(vcodec, acodec) {
		_ = os.Remove(converted)
		fail("El video no pudo convertirse a MP4 compatible con PowerPoint.")
		return
	}
	_ = os.Remove(output)
	if err := os.Rename(converted, output); err != nil {
		fail("No se pudo guardar el video.")
		return
	}
	poster := filepath.Join(a.root, "cache", "thumbnails", item.YoutubeID+".jpg")
	if err := exec.Command(a.bin("ffmpeg"), "-y", "-ss", "1", "-i", output, "-frames:v", "1", "-q:v", "3", poster).Run(); err != nil {
		poster = ""
	}
	if err := a.db.saveMedia(cachedMedia{YoutubeID: item.YoutubeID, SongID: item.ID, Path: output, ThumbnailPath: poster, Width: width, Height: height, Duration: duration, Status: "ready"}); err != nil {
		fail("El video terminó, pero no se pudo registrar en el catálogo.")
		return
	}
	a.jobs.update(jobID, "Listo", "", true)
}

func (a *app) ensureYTDLP() error {
	if runtime.GOOS != "windows" {
		return nil
	}
	ytDLPUpdateMu.Lock()
	defer ytDLPUpdateMu.Unlock()
	if ytDLPReady {
		return nil
	}
	tool := a.bin("yt-dlp")
	version, err := exec.Command(tool, "--version").Output()
	if err != nil {
		return fmt.Errorf("yt-dlp no está instalado. Ejecuta de nuevo el instalador")
	}
	currentVersion := strings.TrimSpace(string(version))
	if newerVersion(ytDLPVersion, currentVersion) {
		result, updateErr := exec.Command(tool, "--update-to", "stable@"+ytDLPVersion).CombinedOutput()
		if updateErr != nil {
			return fmt.Errorf("no se pudo actualizar yt-dlp: %s", lastLine(string(result)))
		}
		version, err = exec.Command(tool, "--version").Output()
		if err != nil || newerVersion(ytDLPVersion, strings.TrimSpace(string(version))) {
			return fmt.Errorf("yt-dlp no quedó actualizado")
		}
	}
	ytDLPReady = true
	return nil
}

func powerpointCopyable(videoCodec, audioCodec string) bool {
	return strings.HasPrefix(videoCodec, "h264") && (audioCodec == "" || strings.HasPrefix(audioCodec, "aac"))
}

func (a *app) probe(file string) (width, height, duration int, vcodec, acodec string) {
	cmd := exec.Command(a.bin("ffprobe"), "-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", "-of", "json", file)
	data, err := cmd.Output()
	if err != nil {
		return
	}
	var result struct {
		Streams []struct {
			CodecType string `json:"codec_type"`
			CodecName string `json:"codec_name"`
			Width     int    `json:"width"`
			Height    int    `json:"height"`
		}
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if json.Unmarshal(data, &result) != nil {
		return
	}
	for _, stream := range result.Streams {
		if stream.CodecType == "video" {
			width, height, vcodec = stream.Width, stream.Height, stream.CodecName
		}
		if stream.CodecType == "audio" {
			acodec = stream.CodecName
		}
	}
	seconds, _ := strconv.ParseFloat(result.Format.Duration, 64)
	duration = int(seconds)
	return
}

func lastLine(value string) string {
	lines := strings.Split(strings.TrimSpace(value), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[len(lines)-1]) == "" {
		return "error desconocido"
	}
	line := strings.TrimSpace(lines[len(lines)-1])
	if len(line) > 180 {
		return line[:180]
	}
	return line
}

func (a *app) jobEventsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != "GET" {
		jsonError(w, 405, "Método no permitido.")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/jobs/"), "/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[1] != "events" || !safeID.MatchString(parts[0]) {
		http.NotFound(w, r)
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		jsonError(w, 500, "El navegador no admite progreso en vivo.")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	last := int64(0)
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	timeout := time.NewTimer(2 * time.Hour)
	defer timeout.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-timeout.C:
			return
		case <-ticker.C:
			item, exists := a.jobs.get(parts[0])
			if !exists {
				fmt.Fprintf(w, "data: {\"done\":true,\"error\":\"Trabajo no encontrado.\"}\n\n")
				flusher.Flush()
				return
			}
			if item.Updated != last {
				data, _ := json.Marshal(map[string]any{"message": item.Message, "done": item.Done, "error": item.Error})
				fmt.Fprintf(w, "data: %s\n\n", data)
				flusher.Flush()
				last = item.Updated
				if item.Done {
					return
				}
			}
		}
	}
}
