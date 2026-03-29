import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import axios from "axios";
import { buildLinesAndStopIndexArtifacts } from "../lines.js";
import { fetchParadasJson, jsonToBusStops } from "../paradas.js";
import { BACKEND_LINES_DIR } from "../paths.js";

interface CkanResource {
  id?: string;
  name?: string;
  format?: string;
  url?: string;
  last_modified?: string;
  metadata_modified?: string;
  created?: string;
}

interface CkanPackage {
  id?: string;
  title?: string;
  resources?: CkanResource[];
}

interface CkanSearchResponse {
  success: boolean;
  result?: {
    count?: number;
    results?: CkanPackage[];
  };
}

interface SyncManifestEntry {
  resourceId: string;
  sourceUrl: string;
  lastModified: string;
  checksum: string;
  fileName: string;
}

interface SyncManifest {
  entries: Record<string, SyncManifestEntry>;
}

const CKAN_BASE_URL = process.env.CKAN_BASE_URL?.trim() || "https://datos-ckan.vigo.org";
const CKAN_SEARCH_URL =
  process.env.CKAN_SEARCH_URL?.trim() ||
  `${CKAN_BASE_URL.replace(/\/$/, "")}/api/3/action/package_search`;
const DEFAULT_LINES_DIR = BACKEND_LINES_DIR;
const MANIFEST_FILE = path.resolve(DEFAULT_LINES_DIR, ".sync-manifest.json");

function sanitizeFileName(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function pickLastModified(resource: CkanResource): string {
  return (
    resource.metadata_modified?.trim() ||
    resource.last_modified?.trim() ||
    resource.created?.trim() ||
    ""
  );
}

function resourceIsKml(resource: CkanResource): boolean {
  const format = resource.format?.toUpperCase() || "";
  const url = resource.url?.toLowerCase() || "";
  return format.includes("KML") || url.endsWith(".kml") || url.includes(".kml?");
}

function checksum(content: Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

async function readManifest(): Promise<SyncManifest> {
  try {
    const raw = await fs.readFile(MANIFEST_FILE, "utf8");
    const parsed = JSON.parse(raw) as SyncManifest;
    if (!parsed?.entries || typeof parsed.entries !== "object") {
      return { entries: {} };
    }
    return parsed;
  } catch {
    return { entries: {} };
  }
}

async function writeManifest(manifest: SyncManifest): Promise<void> {
  await fs.writeFile(MANIFEST_FILE, JSON.stringify(manifest, null, 2), "utf8");
}

async function fetchKmlResources(): Promise<CkanResource[]> {
  const pageSize = 100;
  const allPackages: CkanPackage[] = [];
  let start = 0;
  let total = Number.POSITIVE_INFINITY;

  while (start < total) {
    const response = await axios.get<CkanSearchResponse>(CKAN_SEARCH_URL, {
      params: {
        q: "",
        fq: "groups:transporte",
        rows: pageSize,
        start,
        sort: "metadata_modified desc",
      },
      timeout: 30_000,
      headers: { Accept: "application/json" },
    });

    const result = response.data.result;
    const page = result?.results ?? [];
    total = result?.count ?? page.length;
    allPackages.push(...page);
    start += pageSize;
    if (page.length === 0) break;
  }

  if (allPackages.length === 0) {
    const fallback = await axios.get<CkanSearchResponse>(CKAN_SEARCH_URL, {
      params: {
        q: "lineas autobus vigo kml",
        rows: 500,
        sort: "metadata_modified desc",
      },
      timeout: 30_000,
      headers: { Accept: "application/json" },
    });
    allPackages.push(...(fallback.data.result?.results ?? []));
  }

  const resources = allPackages.flatMap((pkg) => pkg.resources ?? []);
  const deduped = new Map<string, CkanResource>();
  for (const resource of resources) {
    const key = resource.id ?? resource.url ?? "";
    if (!key) continue;
    if (!deduped.has(key)) deduped.set(key, resource);
  }

  return Array.from(deduped.values())
    .filter((resource) => resource.url && resourceIsKml(resource))
    .sort((a, b) => pickLastModified(b).localeCompare(pickLastModified(a)));
}

async function downloadKmlResource(
  resource: CkanResource,
  manifest: SyncManifest,
): Promise<"downloaded" | "skipped"> {
  const resourceId = resource.id ?? resource.url ?? "";
  const url = resource.url;
  if (!resourceId || !url) return "skipped";

  const changedAt = pickLastModified(resource);
  const existing = manifest.entries[resourceId];
  if (existing && existing.lastModified && changedAt && existing.lastModified === changedAt) {
    return "skipped";
  }

  const fileStem = sanitizeFileName(resource.name || resourceId);
  const fileName = `${fileStem || "linea"}-${resourceId.slice(0, 8)}.kml`;
  const filePath = path.join(DEFAULT_LINES_DIR, fileName);

  const res = await axios.get<ArrayBuffer>(url, {
    responseType: "arraybuffer",
    timeout: 60_000,
  });
  const content = Buffer.from(res.data);
  const hash = checksum(content);

  if (existing && existing.checksum === hash && existing.fileName) {
    manifest.entries[resourceId] = {
      ...existing,
      lastModified: changedAt || existing.lastModified,
      sourceUrl: url,
    };
    return "skipped";
  }

  await fs.writeFile(filePath, content);
  manifest.entries[resourceId] = {
    resourceId,
    sourceUrl: url,
    lastModified: changedAt,
    checksum: hash,
    fileName,
  };
  return "downloaded";
}

async function main(): Promise<void> {
  await fs.mkdir(DEFAULT_LINES_DIR, { recursive: true });
  const manifest = await readManifest();
  const resources = await fetchKmlResources();

  let downloaded = 0;
  let skipped = 0;
  for (const resource of resources) {
    const result = await downloadKmlResource(resource, manifest);
    if (result === "downloaded") downloaded += 1;
    else skipped += 1;
  }

  await writeManifest(manifest);
  const rawStops = await fetchParadasJson();
  const stops = jsonToBusStops(rawStops);
  await buildLinesAndStopIndexArtifacts(stops);

  console.log(
    `sync:ckan completado -> recursos KML: ${resources.length}, descargados: ${downloaded}, omitidos: ${skipped}, artefactos de paradas actualizados`,
  );
}

await main();
