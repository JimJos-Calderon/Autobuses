import cors from "cors";
import express from "express";
import { fetchParadasJson, jsonToBusStops } from "./paradas.js";

const PORT = Number(process.env.PORT) || 3001;

const app = express();
app.use(cors({ origin: true }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * BFF: obtiene paradas.json del ayuntamiento y devuelve la que coincida con :id
 * (comparación por string, p. ej. "123" === 123).
 */
app.get("/api/v1/stops/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const raw = await fetchParadasJson();
    const stops = jsonToBusStops(raw);
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

app.listen(PORT, () => {
  console.log(`BFF escuchando en http://localhost:${PORT}`);
});
