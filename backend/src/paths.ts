import path from "node:path";

function detectProjectRoot(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/").toLowerCase();
  if (normalized.endsWith("/backend")) return path.resolve(cwd, "..");
  return cwd;
}

export const PROJECT_ROOT = detectProjectRoot(process.cwd());
export const BACKEND_ROOT = path.resolve(PROJECT_ROOT, "backend");
export const BACKEND_DATA_DIR = path.resolve(BACKEND_ROOT, "data");
export const BACKEND_LINES_DIR = path.resolve(BACKEND_DATA_DIR, "lines");
export const BACKEND_PROCESSED_DIR = path.resolve(BACKEND_DATA_DIR, "processed");
