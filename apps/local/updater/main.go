package main

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const goURL = "https://go.dev/dl/go1.20.14.windows-amd64.zip"
const goSHA256 = "0e0d0190406ead891d94ecf00f961bb5cfa15ddd47499d2649f12eee80aee110"

var version = "dev"

type progressState struct {
	sync.RWMutex
	Progress int    `json:"progress"`
	Message  string `json:"message"`
	Done     bool   `json:"done"`
	Error    string `json:"error,omitempty"`
	Version  string `json:"version"`
}

var progress = &progressState{Progress: 2, Message: "Preparando la actualización…"}

func main() {
	installDir := flag.String("install-dir", "", "directorio de instalación")
	sourceURL := flag.String("source-url", "", "source.zip de la release")
	sourceSHA := flag.String("source-sha256", "", "SHA-256 de source.zip")
	targetVersion := flag.String("version", "", "versión de destino")
	apiURL := flag.String("api-url", "", "URL del Worker")
	flag.Parse()
	progress.Version = *targetVersion

	listener, err := net.Listen("tcp", "127.0.0.1:3211")
	if err != nil {
		return
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", pageHandler)
	mux.HandleFunc("/api/status", statusHandler)
	mux.HandleFunc("/api/open", openHandler(*installDir))
	server := &http.Server{Handler: securityHeaders(mux), ReadHeaderTimeout: 5 * time.Second}
	go runUpdate(*installDir, *sourceURL, *sourceSHA, *targetVersion, *apiURL)
	_ = server.Serve(listener)
}

func runUpdate(installDir, sourceURL, sourceSHA, targetVersion, apiURL string) {
	fail := func(err error) { setProgress(100, "La actualización no pudo completarse.", true, err.Error()) }
	if err := validateInputs(installDir, sourceURL, sourceSHA, targetVersion, apiURL); err != nil {
		fail(err)
		return
	}
	temporary, err := os.MkdirTemp("", "PresentationMakerUpdate-")
	if err != nil {
		fail(err)
		return
	}
	defer os.RemoveAll(temporary)

	sourceZip := filepath.Join(temporary, "source.zip")
	setProgress(8, "Descargando la nueva versión…", false, "")
	if err := downloadFile(sourceURL, sourceZip, sourceSHA, 8, 28); err != nil {
		fail(err)
		return
	}

	goZip := filepath.Join(temporary, "go.zip")
	setProgress(30, "Descargando el compilador…", false, "")
	if err := downloadFile(goURL, goZip, goSHA256, 30, 55); err != nil {
		fail(err)
		return
	}

	toolchain := filepath.Join(temporary, "toolchain")
	sourceDir := filepath.Join(temporary, "source")
	setProgress(58, "Preparando los archivos…", false, "")
	if err := extractZip(goZip, toolchain); err != nil {
		fail(err)
		return
	}
	if err := extractZip(sourceZip, sourceDir); err != nil {
		fail(err)
		return
	}

	goExe := filepath.Join(toolchain, "go", "bin", "go.exe")
	builtApp := filepath.Join(temporary, "PresentationMaker.exe")
	builtUpdater := filepath.Join(temporary, "PresentationMakerUpdater.exe")
	setProgress(64, "Compilando la aplicación…", false, "")
	if err := build(goExe, sourceDir, builtApp, ".", targetVersion, apiURL); err != nil {
		fail(err)
		return
	}
	setProgress(83, "Compilando el actualizador…", false, "")
	if err := build(goExe, sourceDir, builtUpdater, "./updater", targetVersion, apiURL); err != nil {
		fail(err)
		return
	}

	setProgress(91, "Instalando la nueva versión…", false, "")
	if err := installBuild(installDir, builtApp, builtUpdater); err != nil {
		fail(err)
		return
	}
	setProgress(100, "Actualización completada.", true, "")
}

func validateInputs(installDir, sourceURL, sourceSHA, targetVersion, apiURL string) error {
	parsedSource, err := url.Parse(sourceURL)
	if err != nil || parsedSource.Scheme != "https" || !strings.EqualFold(parsedSource.Hostname(), "github.com") {
		return errors.New("la URL de la release no es válida")
	}
	if len(sourceSHA) != 64 {
		return errors.New("la release no incluye un SHA-256 válido")
	}
	if targetVersion == "" || strings.ContainsAny(targetVersion, " \\/\"") {
		return errors.New("la versión de destino no es válida")
	}
	parsedAPI, err := url.Parse(apiURL)
	if err != nil || parsedAPI.Scheme != "https" {
		return errors.New("la URL del servidor no es válida")
	}
	if info, err := os.Stat(installDir); err != nil || !info.IsDir() {
		return errors.New("no se encontró la instalación actual")
	}
	return nil
}

func downloadFile(address, target, expectedHash string, start, end int) error {
	request, err := http.NewRequest(http.MethodGet, address, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "PresentationMakerUpdater/"+version)
	client := &http.Client{Timeout: 20 * time.Minute}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("la descarga respondió %s", response.Status)
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	written := int64(0)
	buffer := make([]byte, 128*1024)
	for {
		count, readErr := response.Body.Read(buffer)
		if count > 0 {
			if _, err := file.Write(buffer[:count]); err != nil {
				file.Close()
				return err
			}
			_, _ = hash.Write(buffer[:count])
			written += int64(count)
			if response.ContentLength > 0 {
				percent := start + int(float64(end-start)*float64(written)/float64(response.ContentLength))
				setProgress(percent, progressMessage(), false, "")
			}
		}
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			file.Close()
			return readErr
		}
	}
	if err := file.Close(); err != nil {
		return err
	}
	actual := hex.EncodeToString(hash.Sum(nil))
	if !strings.EqualFold(actual, expectedHash) {
		return errors.New("la descarga no coincide con su SHA-256")
	}
	return nil
}

func progressMessage() string {
	progress.RLock()
	defer progress.RUnlock()
	return progress.Message
}

func extractZip(filename, destination string) error {
	archive, err := zip.OpenReader(filename)
	if err != nil {
		return err
	}
	defer archive.Close()
	cleanRoot, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	for _, item := range archive.File {
		target := filepath.Join(cleanRoot, filepath.FromSlash(item.Name))
		cleanTarget, err := filepath.Abs(target)
		if err != nil || (cleanTarget != cleanRoot && !strings.HasPrefix(cleanTarget, cleanRoot+string(os.PathSeparator))) {
			return errors.New("el ZIP contiene una ruta no válida")
		}
		if item.FileInfo().IsDir() {
			if err := os.MkdirAll(cleanTarget, 0755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(cleanTarget), 0755); err != nil {
			return err
		}
		input, err := item.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(cleanTarget, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, item.Mode())
		if err == nil {
			_, err = io.Copy(output, input)
			if closeErr := output.Close(); err == nil {
				err = closeErr
			}
		}
		input.Close()
		if err != nil {
			return err
		}
	}
	return nil
}

func build(goExe, sourceDir, output, packageName, targetVersion, apiURL string) error {
	ldflags := fmt.Sprintf("-s -w -H windowsgui -X main.version=%s", targetVersion)
	if packageName == "." {
		ldflags += " -X main.workerURL=" + apiURL
	}
	command := exec.Command(goExe, "build", "-trimpath", "-ldflags", ldflags, "-o", output, packageName)
	command.Dir = sourceDir
	command.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=windows", "GOARCH=amd64")
	result, err := command.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(result))
		if len(message) > 500 {
			message = message[len(message)-500:]
		}
		return fmt.Errorf("Go no pudo compilar: %s", message)
	}
	return nil
}

func installBuild(installDir, builtApp, builtUpdater string) error {
	if err := waitForAppExit(); err != nil {
		return err
	}
	app := filepath.Join(installDir, "PresentationMaker.exe")
	newApp := filepath.Join(installDir, "PresentationMaker.new.exe")
	previous := filepath.Join(installDir, "PresentationMaker.previous.exe")
	nextUpdater := filepath.Join(installDir, "PresentationMakerUpdater.next.exe")
	if err := copyFile(builtApp, newApp); err != nil {
		return err
	}
	_ = os.Remove(previous)
	if err := os.Rename(app, previous); err != nil {
		_ = os.Remove(newApp)
		return fmt.Errorf("no se pudo cerrar la versión anterior: %w", err)
	}
	if err := os.Rename(newApp, app); err != nil {
		_ = os.Rename(previous, app)
		return fmt.Errorf("no se pudo instalar la nueva versión: %w", err)
	}
	if err := copyFile(builtUpdater, nextUpdater); err != nil {
		return fmt.Errorf("la aplicación se actualizó, pero el actualizador no: %w", err)
	}
	return nil
}

func waitForAppExit() error {
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		connection, err := net.DialTimeout("tcp", "127.0.0.1:3210", 250*time.Millisecond)
		if err != nil {
			return nil
		}
		connection.Close()
		time.Sleep(300 * time.Millisecond)
	}
	return errors.New("Presentation Maker no terminó de cerrarse")
}

func copyFile(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	temporary := target + ".tmp"
	output, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		_ = os.Remove(temporary)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(temporary)
		return closeErr
	}
	_ = os.Remove(target)
	return os.Rename(temporary, target)
}

func setProgress(value int, message string, done bool, problem string) {
	progress.Lock()
	progress.Progress = value
	progress.Message = message
	progress.Done = done
	progress.Error = problem
	progress.Unlock()
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
		next.ServeHTTP(w, r)
	})
}

func statusHandler(w http.ResponseWriter, r *http.Request) {
	progress.RLock()
	defer progress.RUnlock()
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(progress)
}

func openHandler(installDir string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Método no permitido", http.StatusMethodNotAllowed)
			return
		}
		progress.RLock()
		ready := progress.Done && progress.Error == ""
		progress.RUnlock()
		if !ready {
			http.Error(w, "La actualización no ha terminado", http.StatusConflict)
			return
		}
		app := filepath.Join(installDir, "PresentationMaker.exe")
		if err := exec.Command(app).Start(); err != nil {
			http.Error(w, "No se pudo abrir la aplicación", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
		go func() { time.Sleep(time.Second); os.Exit(0) }()
	}
}

func pageHandler(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, updaterPage)
}

const updaterPage = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Actualizando Presentation Maker</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f1ea;color:#18211b;font-family:"Segoe UI",Arial,sans-serif}.card{width:min(520px,calc(100vw - 40px));background:#fff;border:1px solid #dfddd6;border-radius:20px;padding:38px;box-shadow:0 18px 60px rgba(40,48,43,.11)}.mark{display:grid;place-items:center;width:46px;height:46px;border-radius:13px;background:#246f4e;color:white;font:26px Georgia;margin-bottom:24px}small{color:#7b847e;font-weight:700;letter-spacing:.12em}h1{font:32px Georgia;margin:10px 0 12px}.message{color:#626c65;min-height:24px}.track{height:10px;background:#e6e9e5;border-radius:999px;overflow:hidden;margin:28px 0 10px}.bar{height:100%;width:2%;background:#246f4e;border-radius:inherit;transition:width .3s}.percent{text-align:right;color:#69726c;font-size:13px}.error{color:#ad3434;white-space:pre-wrap;font-size:13px}.done{display:none;width:100%;border:0;border-radius:10px;padding:12px;background:#246f4e;color:white;font-weight:700;cursor:pointer;margin-top:18px}</style></head><body><main class="card"><div class="mark">P</div><small>PRESENTATION MAKER</small><h1>Instalando la actualización</h1><p class="message" id="message">Preparando la actualización…</p><div class="track"><div class="bar" id="bar"></div></div><div class="percent" id="percent">2%</div><p class="error" id="error"></p><button class="done" id="open">Abrir Presentation Maker</button></main><script>const message=document.getElementById('message'),bar=document.getElementById('bar'),percent=document.getElementById('percent'),error=document.getElementById('error'),open=document.getElementById('open');async function poll(){try{const r=await fetch('/api/status',{cache:'no-store'}),s=await r.json();message.textContent=s.message;bar.style.width=s.progress+'%';percent.textContent=s.progress+'%';error.textContent=s.error||'';if(s.done){if(!s.error)open.style.display='block';return}}catch{}setTimeout(poll,500)}open.onclick=async()=>{open.disabled=true;await fetch('/api/open',{method:'POST'});message.textContent='Abriendo…';setTimeout(()=>location.href='http://127.0.0.1:3210',1000)};poll()</script></body></html>`
