import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  build: { target: "es2019", outDir: "../local/web/dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:3210", "/media": "http://127.0.0.1:3210" } },
})
