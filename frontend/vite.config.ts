import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/icon-192.svg", "icons/icon-512.svg"],
      manifest: {
        name: "BusVigo Dashboard",
        short_name: "BusVigo",
        description: "Paradas, lineas y tiempos en vivo de transporte urbano en Vigo.",
        start_url: "/",
        display: "standalone",
        background_color: "#f6f8fb",
        theme_color: "#2b5bd7",
        icons: [
          {
            src: "/icons/icon-192.svg",
            sizes: "192x192",
            type: "image/svg+xml",
            purpose: "any",
          },
          {
            src: "/icons/icon-512.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            urlPattern: /\/api\/stops$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "stops-cache",
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 },
            },
          },
        ],
      },
      // Evita warnings de Workbox en `vite dev` cuando `dev-dist` no contiene
      // los artefactos esperados. La PWA sigue activa en build/preview.
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    // DX: todas las llamadas `/api` van al backend local sin env vars en desarrollo.
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
