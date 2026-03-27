/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base del BFF (vacío en dev con proxy). Ej: https://api.midominio.com */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
