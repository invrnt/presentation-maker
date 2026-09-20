package main

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

//go:embed web/dist
var webFiles embed.FS

//go:embed template.pptx
var pptxTemplate []byte

var version = "dev"
var workerURL = ""

type app struct {
	db       *store
	root     string
	worker   string
	client   *http.Client
	jobs     *jobManager
	frontend fs.FS
}

func main() {
	root, err := appRoot()
	if err != nil {
		log.Fatal(err)
	}
	for _, name := range []string{"data", "cache/media", "cache/thumbnails", "assets", "exports", "bin"} {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(name)), 0755); err != nil {
			log.Fatal(err)
		}
	}

	address := "127.0.0.1:3210"
	listener, err := net.Listen("tcp", address)
	if err != nil {
		if isRunning("http://" + address + "/api/health") {
			openBrowser("http://" + address)
			return
		}
		log.Fatalf("no se pudo iniciar la aplicación: %v", err)
	}
	db, err := openStore(filepath.Join(root, "data", "app.db"))
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	frontend, err := fs.Sub(webFiles, "web/dist")
	if err != nil {
		log.Fatal(err)
	}
	remote := os.Getenv("PRESENTATION_MAKER_API_URL")
	if remote == "" {
		remote = workerURL
	}
	a := &app{db: db, root: root, worker: remote, client: &http.Client{Timeout: 5 * time.Second}, jobs: newJobManager(), frontend: frontend}
	server := &http.Server{Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	go func() { time.Sleep(250 * time.Millisecond); openBrowser("http://" + address) }()
	log.Printf("Presentation Maker %s en http://%s", version, address)
	if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func appRoot() (string, error) {
	if value := os.Getenv("PRESENTATION_MAKER_DATA_DIR"); value != "" {
		return filepath.Abs(value)
	}
	if runtime.GOOS == "windows" {
		base := os.Getenv("LOCALAPPDATA")
		if base == "" {
			return "", errors.New("LOCALAPPDATA no está disponible")
		}
		return filepath.Join(base, "PresentationMaker"), nil
	}
	base, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "PresentationMaker"), nil
}

func isRunning(url string) bool {
	client := http.Client{Timeout: 600 * time.Millisecond}
	response, err := client.Get(url)
	if err != nil {
		return false
	}
	response.Body.Close()
	return response.StatusCode == http.StatusOK
}

func openBrowser(url string) {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		command = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	case "darwin":
		command = exec.Command("open", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	_ = command.Start()
}

func (a *app) bin(name string) string {
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	local := filepath.Join(a.root, "bin", name)
	if _, err := os.Stat(local); err == nil {
		return local
	}
	return name
}

func (a *app) String() string { return fmt.Sprintf("Presentation Maker %s", version) }
