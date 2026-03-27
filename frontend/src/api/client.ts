import axios from "axios";

/**
 * Base URL del BFF: vacío + proxy de Vite en dev (`/api` → localhost:3001),
 * o `VITE_API_BASE_URL` en producción / Capacitor (p. ej. https://api.tudominio.com).
 */
const baseURL =
  import.meta.env.VITE_API_BASE_URL?.replace(/\/$/, "") ?? "";

export const apiClient = axios.create({
  baseURL,
  headers: { Accept: "application/json" },
  timeout: 30_000,
});
