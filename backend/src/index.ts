import cors from "cors";
import express from "express";
import { haversineMeters } from "./geo.js";
import { findLineGeometryById, listLines } from "./lines.js";
import { fetchLiveArrivalsSafe } from "./live.js";
import { fetchEnrichedStops } from "./paradas.js";

const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(cors({ origin: true }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/stops", async (_req, res) => {
  try {
    const stops = await fetchEnrichedStops();
    res.json(stops);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error desconocido";
    res.status(502).json({ error: "No se pudo obtener paradas", detail: message });
  }
});

app.get("/api/v1/stops/nearby", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    res.status(400).json({ error: "Parametros lat/lng invalidos" });
    return;
  }

  try {
    const stops = await fetchEnrichedStops();
    const nearby = stops
      .filter((stop) => stop.lat !== undefined && stop.lon !== undefined)
      .map((stop) => ({
        ...stop,
        distance_m: Math.round(
          haversineMeters(lat, lng, stop.lat as number, stop.lon as number),
        ),
      }))
      .sort((a, b) => a.distance_m - b.distance_m);
    res.json(nearby);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error desconocido";
    res.status(502).json({ error: "No se pudieron calcular paradas cercanas", detail: message });
  }
});

/**
 * BFF: obtiene paradas.json del ayuntamiento y devuelve la que coincida con :id
 * (comparacion por string, p. ej. "123" === 123).
 */
app.get("/api/v1/stops/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const stops = await fetchEnrichedStops();
    const found = stops.find((s) => s.id === id);
    if (!found) {
      res.status(404).json({ error: "Parada no encontrada", id });
      return;
    }
    res.json(found);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error desconocido";
    res.status(502).json({ error: "No se pudo obtener paradas", detail: message });
  }
});

app.get("/api/live/:stopId", async (req, res) => {
  const { stopId } = req.params;
  console.log(`[api/live] request stopId=${stopId}`);
  const result = await fetchLiveArrivalsSafe(stopId);
  if (result.arrivals.length === 0 && result.isTheoretical) {
    console.warn(`[api/live] returning empty theoretical fallback stopId=${stopId}`);
  }
  res.status(200).json(result);
});

app.get("/api/v1/lines", async (_req, res) => {
  try {
    const lines = await listLines();
    res.json(lines);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error desconocido";
    res.status(502).json({ error: "No se pudieron obtener las lineas", detail: message });
  }
});

app.get("/api/v1/lines/:id/geometry", async (req, res) => {
  const { id } = req.params;
  try {
    const geo = await findLineGeometryById(id);
    if (!geo) {
      res.status(404).json({ error: "Linea no encontrada", id });
      return;
    }
    res.json(geo);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Error desconocido";
    res.status(502).json({ error: "No se pudo obtener geometria de linea", detail: message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`BFF escuchando en http://localhost:${PORT}`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Puerto ${PORT} en uso. Cierra el otro Node/proceso o arranca con PORT=3002`,
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});
