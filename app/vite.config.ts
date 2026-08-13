import { defineConfig } from 'vite'

export default defineConfig({
  // Zeitstempel des Builds. Steht in der Diagnose und beantwortet die
  // Frage, die uns beim Einrichten mehrfach aufgehalten hat: Sieht das
  // Gerät überhaupt den frisch deployten Stand?
  define: {
    __BUILD__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    // Ein einziges JS-Bundle. Kein Code-Splitting — bei dieser Größe
    // kostet ein zweiter Request mehr als er spart, gerade auf dem
    // Fire Tablet mit lahmer Verbindung zum Server.
    target: 'es2020',
    modulePreload: false,
    rollupOptions: {
      output: { manualChunks: undefined },
    },
  },
  server: {
    host: true,
    // Beim lokalen Entwickeln: /api an go2rtc weiterreichen, damit die
    // App auch im Dev-Server same-origin läuft (spart CORS-Sonderfälle).
    proxy: {
      '/api': {
        target: 'http://192.168.2.166:1984',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
