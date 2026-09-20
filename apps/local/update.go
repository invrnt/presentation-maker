package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const releasesAPI = "https://api.github.com/repos/invrnt/presentation-maker/releases/latest"

type updateInfo struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion,omitempty"`
	Available      bool   `json:"available"`
	Notes          string `json:"notes,omitempty"`
	PublishedAt    string `json:"publishedAt,omitempty"`
	SourceURL      string `json:"-"`
	SourceSHA256   string `json:"-"`
}

type githubRelease struct {
	TagName     string `json:"tag_name"`
	Body        string `json:"body"`
	PublishedAt string `json:"published_at"`
	Assets      []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Digest             string `json:"digest"`
	} `json:"assets"`
}

func (a *app) updateHandler(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "GET") {
		return
	}
	info, err := a.latestUpdate()
	if err != nil {
		jsonError(w, http.StatusBadGateway, "No se pudo buscar actualizaciones. Inténtalo más tarde.")
		return
	}
	jsonResponse(w, http.StatusOK, info)
}

func (a *app) startUpdateHandler(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, "POST") {
		return
	}
	info, err := a.latestUpdate()
	if err != nil {
		jsonError(w, http.StatusBadGateway, "No se pudo preparar la actualización.")
		return
	}
	if !info.Available {
		jsonError(w, http.StatusConflict, "Ya tienes la versión más reciente.")
		return
	}
	updaterName := "PresentationMakerUpdater"
	if runtime.GOOS == "windows" {
		updaterName += ".exe"
	}
	updaterPath := filepath.Join(a.root, updaterName)
	if _, err := os.Stat(updaterPath); err != nil {
		jsonError(w, http.StatusConflict, "El actualizador no está instalado. Ejecuta de nuevo el instalador una vez.")
		return
	}
	command := exec.Command(updaterPath,
		"--install-dir", a.root,
		"--source-url", info.SourceURL,
		"--source-sha256", info.SourceSHA256,
		"--version", info.LatestVersion,
		"--api-url", a.worker,
	)
	if err := command.Start(); err != nil {
		jsonError(w, http.StatusInternalServerError, "No se pudo abrir el actualizador.")
		return
	}
	jsonResponse(w, http.StatusAccepted, map[string]string{"url": "http://127.0.0.1:3211"})
	go func() {
		time.Sleep(900 * time.Millisecond)
		os.Exit(0)
	}()
}

func (a *app) latestUpdate() (updateInfo, error) {
	info := updateInfo{CurrentVersion: version}
	request, err := http.NewRequest(http.MethodGet, releasesAPI, nil)
	if err != nil {
		return info, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("X-GitHub-Api-Version", "2026-03-10")
	request.Header.Set("User-Agent", "PresentationMaker/"+version)
	response, err := a.client.Do(request)
	if err != nil {
		return info, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return info, nil
	}
	if response.StatusCode != http.StatusOK {
		return info, fmt.Errorf("github respondió %s", response.Status)
	}
	var release githubRelease
	if err := json.NewDecoder(response.Body).Decode(&release); err != nil {
		return info, err
	}
	info.LatestVersion = strings.TrimPrefix(release.TagName, "v")
	info.Notes = release.Body
	info.PublishedAt = release.PublishedAt
	info.Available = newerVersion(info.LatestVersion, version)
	if !info.Available {
		return info, nil
	}
	for _, asset := range release.Assets {
		if asset.Name == "source.zip" {
			info.SourceURL = asset.BrowserDownloadURL
			info.SourceSHA256 = strings.TrimPrefix(asset.Digest, "sha256:")
			break
		}
	}
	if info.SourceURL == "" || len(info.SourceSHA256) != 64 {
		return info, errors.New("la release no contiene source.zip con digest SHA-256")
	}
	return info, nil
}

func newerVersion(candidate, current string) bool {
	if current == "dev" {
		return candidate != ""
	}
	a := versionParts(candidate)
	b := versionParts(current)
	for index := 0; index < 3; index++ {
		if a[index] != b[index] {
			return a[index] > b[index]
		}
	}
	return false
}

func versionParts(value string) [3]int {
	var result [3]int
	parts := strings.Split(strings.TrimPrefix(value, "v"), ".")
	for index := 0; index < len(parts) && index < 3; index++ {
		number := strings.SplitN(parts[index], "-", 2)[0]
		result[index], _ = strconv.Atoi(number)
	}
	return result
}

func promoteUpdater(root string) {
	if runtime.GOOS != "windows" {
		return
	}
	_ = os.Remove(filepath.Join(root, "PresentationMaker.previous.exe"))
	next := filepath.Join(root, "PresentationMakerUpdater.next.exe")
	current := filepath.Join(root, "PresentationMakerUpdater.exe")
	if _, err := os.Stat(next); err != nil {
		return
	}
	for attempt := 0; attempt < 15; attempt++ {
		if err := os.Remove(current); err == nil || os.IsNotExist(err) {
			if os.Rename(next, current) == nil {
				return
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
}
