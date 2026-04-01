import fs from "node:fs";
import path from "node:path";

const RAW_FILE = "data/raw-vitrasa-line-10.json";
const SEQUENCES_FILE = "data/processed/official-sequences.json";
const METADATA_FILE = "data/processed/vitrasa-stops-metadata.json";

function main() {
  const raw = JSON.parse(fs.readFileSync(RAW_FILE, "utf8"));
  const sequences = {};
  const metadata = {};

  const processTrayecto = (trayectoKey, trayectoId) => {
    const data = raw[trayectoKey];
    if (!data || !data.detalleLineaResponse) return;
    
    const geo = JSON.parse(data.detalleLineaResponse);
    const collection = geo.outTrip || geo.backTrip || geo.returnTrip;
    
    if (!sequences[trayectoId]) sequences[trayectoId] = { ida: [], vuelta: [] };
    
    const isIda = trayectoKey === "ida";
    const targetArray = isIda ? sequences[trayectoId].ida : sequences[trayectoId].vuelta;

    collection.features.forEach(f => {
      if (f.geometry.type === "Point") {
        const id = String(f.properties.idBusStop);
        const name = f.properties.desBusStop;
        const [lon, lat] = f.geometry.coordinates;
        
        targetArray.push(id);
        metadata[id] = { id, name, lat, lon };
      }
    });
  };

  processTrayecto("ida", "10");
  processTrayecto("vuelta", "10");

  fs.writeFileSync(SEQUENCES_FILE, JSON.stringify(sequences, null, 2));
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
  
  console.log("¡Archivos procesados con éxito!");
}

main();
