const fs = require('fs');

const path = 'frontend/src/components/StopsMap.tsx';
let content = fs.readFileSync(path, 'utf8');

// 1. Eliminar map.setFilter
content = content.replace(
  /if \(lineFilterActive && activeLineId\) \{[\s\S]*?map\.setFilter\(STOPS_LAYER_ID, null\);\r?\n\s+\}/g,
  `if (lineFilterActive && activeLineId) {\n      map.setPaintProperty(STOPS_LAYER_ID, "circle-opacity", 1);\n    } else {\n      map.setPaintProperty(STOPS_LAYER_ID, "circle-opacity", 0.9);\n    }`
);

content = content.replace(
  /\/\/ Filtro nativo de MapLibre:.*?\r?\n.*?\r?\n.*?\r?\n/g,
  ""
);

// 2. Pre-filter Stops Source Data
const oldMapBlock = `    const features = stops
      .filter((stop) => stop.lat !== undefined && stop.lon !== undefined)
      .map((stop) => {
        const isInFilteredSet = filtered.has(stop.id);
        const isOnLine = isInFilteredSet; // Estricta validación binaria recibida del MainLayout

        // \`activeDirection\`: vacío si la parada no está en la línea, sentido si lo está.
        // MapLibre filtra sobre este string directamente.
        const activeDirection =
          lineFilterActive && activeLineId && isOnLine ? selectedLineDirection : "";

        return {
          type: "Feature" as const,
          properties: {
            id: stop.id,
            name: stop.name,
            lines: (stop.lines ?? []).join(", "),
            isOnLine,
            isNearby: nearby.has(stop.id),
            hasValidCoords: Number.isFinite(stop.lon) && Number.isFinite(stop.lat),
            activeDirection,
          },
          geometry: {
            type: "Point" as const,
            coordinates: [stop.lon as number, stop.lat as number],
          },
        };
      });

    const onLineCount = features.filter((f) => f.properties.isOnLine).length;
    console.log(
      \`[StopsMap/upsert] \${onLineCount} paradas marcadas para sentido "\${selectedLineDirection}" de línea "\${selectedLineId ?? 'ninguna'}"\`
    );`;

const newMapBlock = `    const features = stops
      .filter((stop) => {
        if (stop.lat === undefined || stop.lon === undefined) return false;
        if (lineFilterActive && activeLineId) {
          return filtered.has(stop.id) || nearby.has(stop.id) || stop.id === selectedStopId;
        }
        return true;
      })
      .map((stop) => {
        const isOnLine = filtered.has(stop.id);
        const activeDirection = lineFilterActive && activeLineId && isOnLine ? selectedLineDirection : "";

        return {
          type: "Feature" as const,
          properties: {
            id: stop.id,
            name: stop.name,
            lines: (stop.lines ?? []).join(", "),
            isOnLine,
            isNearby: nearby.has(stop.id),
            hasValidCoords: true,
            activeDirection,
          },
          geometry: {
            type: "Point" as const,
            coordinates: [stop.lon as number, stop.lat as number],
          },
        };
      });

    console.log('Dibujando paradas:', features.length);`;

content = content.replace(oldMapBlock, newMapBlock);

fs.writeFileSync(path, content);
console.log('StopsMap.tsx actualized!');
