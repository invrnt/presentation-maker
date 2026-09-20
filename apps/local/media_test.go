package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPowerPointCopyable(t *testing.T) {
	tests := []struct {
		video string
		audio string
		want  bool
	}{
		{"h264", "aac", true},
		{"h264", "", true},
		{"av1", "opus", false},
		{"vp9", "aac", false},
		{"h264", "opus", false},
	}
	for _, test := range tests {
		if got := powerpointCopyable(test.video, test.audio); got != test.want {
			t.Fatalf("powerpointCopyable(%q, %q) = %v, want %v", test.video, test.audio, got, test.want)
		}
	}
}

func TestDownloadSongE2E(t *testing.T) {
	if os.Getenv("PRESENTATION_MAKER_MEDIA_E2E") != "1" {
		t.Skip("activa PRESENTATION_MAKER_MEDIA_E2E=1 para probar una descarga real")
	}
	for _, tool := range []string{"yt-dlp", "ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s no está instalado", tool)
		}
	}
	root := t.TempDir()
	for _, directory := range []string{"data", "cache/media", "cache/thumbnails"} {
		if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(directory)), 0755); err != nil {
			t.Fatal(err)
		}
	}
	database, err := openStore(filepath.Join(root, "data", "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	testApp := &app{db: database, root: root, jobs: newJobManager()}
	work := testApp.jobs.create()
	testApp.downloadSong(work.ID, song{ID: "e2e-song", YoutubeID: "jNQXAC9IVRw", YoutubeURL: "https://www.youtube.com/watch?v=jNQXAC9IVRw", Title: "Me at the zoo"})
	result, found := testApp.jobs.get(work.ID)
	if !found || !result.Done || result.Error != "" {
		t.Fatalf("la descarga no terminó correctamente: %+v", result)
	}
	media, err := database.media("jNQXAC9IVRw")
	if err != nil {
		t.Fatal(err)
	}
	width, height, duration, videoCodec, audioCodec := testApp.probe(media.Path)
	if width < 1 || height < 1 || duration < 1 || !powerpointCopyable(videoCodec, audioCodec) {
		t.Fatalf("MP4 incompatible: %dx%d, %ds, %s/%s", width, height, duration, videoCodec, audioCodec)
	}
}
