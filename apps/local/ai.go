package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"
)

type aiImagePayload struct {
	MediaType string `json:"mediaType"`
	Data      string `json:"data"`
}

func (a *app) aiPlanHandler(w http.ResponseWriter, r *http.Request) {
	if !only(w, r, http.MethodPost) {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 18<<20)
	if err := r.ParseMultipartForm(18 << 20); err != nil {
		jsonError(w, http.StatusRequestEntityTooLarge, "La solicitud o las imágenes son demasiado grandes.")
		return
	}
	message := strings.TrimSpace(r.FormValue("message"))
	project := json.RawMessage(r.FormValue("project"))
	if len(message) > 5000 || !json.Valid(project) {
		jsonError(w, http.StatusBadRequest, "La solicitud no es válida.")
		return
	}
	var files []*multipart.FileHeader
	if r.MultipartForm != nil {
		files = r.MultipartForm.File["images"]
	}
	if len(files) > 4 {
		jsonError(w, http.StatusBadRequest, "Puedes adjuntar hasta cuatro imágenes.")
		return
	}
	images := make([]aiImagePayload, 0, len(files))
	for _, header := range files {
		file, err := header.Open()
		if err != nil {
			jsonError(w, http.StatusBadRequest, "No se pudo abrir una imagen adjunta.")
			return
		}
		data, readErr := io.ReadAll(io.LimitReader(file, (4<<20)+1))
		file.Close()
		if readErr != nil || len(data) > 4<<20 {
			jsonError(w, http.StatusBadRequest, "Cada imagen debe pesar menos de 4 MB.")
			return
		}
		mediaType := http.DetectContentType(data)
		if mediaType != "image/png" && mediaType != "image/jpeg" && mediaType != "image/webp" {
			jsonError(w, http.StatusBadRequest, "Usa imágenes PNG, JPG o WebP.")
			return
		}
		images = append(images, aiImagePayload{MediaType: mediaType, Data: base64.StdEncoding.EncodeToString(data)})
	}
	if message == "" && len(images) == 0 {
		jsonError(w, http.StatusBadRequest, "Escribe una instrucción o adjunta una imagen.")
		return
	}
	payload := struct {
		Message string           `json:"message"`
		Project json.RawMessage  `json:"project"`
		Images  []aiImagePayload `json:"images"`
	}{message, project, images}
	data, err := json.Marshal(payload)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "No se pudo preparar la solicitud.")
		return
	}
	a.proxyAI(w, data)
}

func (a *app) proxyAI(w http.ResponseWriter, payload []byte) {
	if a.worker == "" {
		jsonError(w, http.StatusServiceUnavailable, "El servidor remoto no está configurado.")
		return
	}
	request, err := http.NewRequest(http.MethodPost, strings.TrimRight(a.worker, "/")+"/v1/ai/plan", bytes.NewReader(payload))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "No se pudo preparar la solicitud.")
		return
	}
	request.Header.Set("Content-Type", "application/json")
	if token := a.db.setting("session_token"); token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	client := &http.Client{Timeout: 2 * time.Minute}
	response, err := client.Do(request)
	if err != nil {
		jsonError(w, http.StatusServiceUnavailable, "No se pudo conectar con la IA.")
		return
	}
	defer response.Body.Close()
	responseData, err := io.ReadAll(io.LimitReader(response.Body, 2<<20))
	if err != nil {
		jsonError(w, http.StatusBadGateway, "La respuesta de la IA no se pudo leer.")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(response.StatusCode)
	_, _ = w.Write(responseData)
}

func (a *app) aiSettingsHandler(w http.ResponseWriter, r *http.Request) {
	user, _ := a.cachedUser()
	if user.Role != "admin" {
		jsonError(w, http.StatusForbidden, "Solo un administrador puede cambiar el modelo.")
		return
	}
	if r.Method == http.MethodGet {
		data, status, err := a.remote(http.MethodGet, "/v1/admin/settings/ai", nil, true)
		if err != nil {
			jsonError(w, http.StatusServiceUnavailable, "No se pudo conectar.")
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(data)
		return
	}
	if r.Method == http.MethodPatch {
		var input struct {
			Model string `json:"model"`
		}
		if !decodeJSON(w, r, &input) {
			return
		}
		data, status, err := a.remote(http.MethodPatch, "/v1/admin/settings/ai", input, true)
		if err != nil {
			jsonError(w, http.StatusServiceUnavailable, "No se pudo conectar.")
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_, _ = w.Write(data)
		return
	}
	jsonError(w, http.StatusMethodNotAllowed, "Método no permitido.")
}
