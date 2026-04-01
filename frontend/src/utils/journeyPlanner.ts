import type { BusStop } from "@autobuses/shared";
import { haversineMeters } from "./geo";

export interface JourneyLeg {
  fromStop: BusStop;
  toStop: BusStop;
  lineId: string;
  direction: "ida" | "vuelta" | "?";
  numStops: number;
}

export interface JourneyRoute {
  type: "DIRECT" | "TRANSFER" | "FUZZY-DIRECT" | "FUZZY-TRANSFER";
  legs: JourneyLeg[];
  totalWalkMeters: number;
  totalBusMeters: number; // Nueva metrica para eficiencia
  estimatedMinutes: number;
  rankScore: number; // Interno para penalizar caminatas largas
}

interface StopRef {
  lineId: string;
  direction: "ida" | "vuelta";
  index: number;
}

// Velocidad base
const WALK_SPEED_M_PER_MIN = 80; // aprox 4.8km/h
const BUS_MIN_PER_STOP = 2; // tiempo conservador promedio entre paradas

export function planJourney(
  origin: { lat: number; lng: number } | null,
  destination: { lat: number; lng: number } | null,
  stops: BusStop[],
  sequences: Record<string, { ida?: string[]; vuelta?: string[] }>,
  maxWalkMeters = 500
): JourneyRoute[] {
  if (!origin || !destination || stops.length === 0) return [];

  const originStops = stops
    .filter(
      (s) => s.lat !== undefined && s.lon !== undefined && haversineMeters(s.lat, s.lon, origin.lat, origin.lng) <= maxWalkMeters
    )
    .sort((a, b) => haversineMeters(a.lat!, a.lon!, origin.lat, origin.lng) - haversineMeters(b.lat!, b.lon!, origin.lat, origin.lng));
    
  const destStops = stops
    .filter(
      (s) => s.lat !== undefined && s.lon !== undefined && haversineMeters(s.lat, s.lon, destination.lat, destination.lng) <= maxWalkMeters
    )
    .sort((a, b) => haversineMeters(a.lat!, a.lon!, destination.lat, destination.lng) - haversineMeters(b.lat!, b.lon!, destination.lat, destination.lng));

  if (originStops.length === 0 || destStops.length === 0) return [];

  const routes: JourneyRoute[] = [];
  
  // -- INDEXACIÓN OFICIAL (Para Secuencias Verificadas) --
  const stopIndexLookup = new Map<string, StopRef[]>();
  for (const [lineId, dirs] of Object.entries(sequences)) {
    if (dirs.ida && Array.isArray(dirs.ida)) {
      dirs.ida.forEach((stopId, index) => {
        if (!stopIndexLookup.has(stopId)) stopIndexLookup.set(stopId, []);
        stopIndexLookup.get(stopId)!.push({ lineId, direction: "ida", index });
      });
    }
    if (dirs.vuelta && Array.isArray(dirs.vuelta)) {
      dirs.vuelta.forEach((stopId, index) => {
        if (!stopIndexLookup.has(stopId)) stopIndexLookup.set(stopId, []);
        stopIndexLookup.get(stopId)!.push({ lineId, direction: "vuelta", index });
      });
    }
  }

  const directCombinations = new Set<string>();

  // 1. VIAJES DIRECTOS OFICIALES
  for (const oStop of originStops) {
    for (const dStop of destStops) {
      if (oStop.id === dStop.id) continue;
      const oLines = stopIndexLookup.get(oStop.id) || [];
      const dLines = stopIndexLookup.get(dStop.id) || [];

      for (const oRow of oLines) {
        const dRow = dLines.find((x) => x.lineId === oRow.lineId && x.direction === oRow.direction);
        if (dRow && dRow.index > oRow.index) {
          const comboId = `${oRow.lineId}-${oRow.direction}`;
          if (directCombinations.has(comboId)) continue;
          directCombinations.add(comboId);

          const numStops = dRow.index - oRow.index;
          const walkOrigin = haversineMeters(oStop.lat!, oStop.lon!, origin.lat, origin.lng);
          const walkDest = haversineMeters(dStop.lat!, dStop.lon!, destination.lat, destination.lng);
          
          const walkMinsOrig = Math.ceil(walkOrigin / WALK_SPEED_M_PER_MIN);
          const walkMinsDest = Math.ceil(walkDest / WALK_SPEED_M_PER_MIN);
          const estimatedMins = walkMinsOrig + walkMinsDest + numStops * BUS_MIN_PER_STOP;
          const busDist = haversineMeters(oStop.lat!, oStop.lon!, dStop.lat!, dStop.lon!);

          // Filtro de Eficiencia: No camines 1km para un bus de 500m
          if (walkOrigin + walkDest > busDist * 2 && walkOrigin + walkDest > 800) continue;

          routes.push({
            type: "DIRECT",
            legs: [{ fromStop: oStop, toStop: dStop, lineId: oRow.lineId, direction: oRow.direction, numStops }],
            totalWalkMeters: Math.round(walkOrigin + walkDest),
            totalBusMeters: Math.round(busDist),
            estimatedMinutes: estimatedMins,
            rankScore: estimatedMins + (walkMinsOrig * 2.5) + (walkMinsDest * 1.5), // Penalizamos mas el origen lejano
          });
        }
      }
    }
  }

  // 2. VIAJES CON TRASBORDO OFICIALES (1 Escala)
  // Solo se calcula si no hay muchas opciones directas, para salvaguardar CPU
  if (routes.length < 3) {
    const stopsById = new Map<string, BusStop>(stops.map(s => [s.id, s]));
    
    // Buscar intersecciones
    // Para no reventar el CPU y porque querés priorizar tu parada más cercana,
    // para los trasbordos limitaremos la explosión a las 2 paradas de origen más próximas a ti.
    const culledOriginStops = originStops.slice(0, 2);

    for (const oStop of culledOriginStops) {
      const oLines = stopIndexLookup.get(oStop.id) || [];
      
      for (const oRow of oLines) {
        // Obtenemos todas las paradas futuras de oLine
        const oLineData = sequences[oRow.lineId]?.[oRow.direction] || [];
        const futureStopIds = oLineData.slice(oRow.index + 1);
        
        for (let i = 0; i < futureStopIds.length; i++) {
          const transStopId = futureStopIds[i];
          const transStopRefs = stopIndexLookup.get(transStopId) || [];
          
          for (const dStop of destStops) {
            if (oStop.id === dStop.id || transStopId === dStop.id || transStopId === oStop.id) continue;
            
            const dLines = stopIndexLookup.get(dStop.id) || [];
            
            // Ver si hay una 2nda linea desde TransStop hasta dStop
            for (const tRow2 of transStopRefs) {
              if (tRow2.lineId === oRow.lineId) continue; // Evitar la misma linea
              const dRow = dLines.find(x => x.lineId === tRow2.lineId && x.direction === tRow2.direction);
              
              if (dRow && dRow.index > tRow2.index) {
                const transStop = stopsById.get(transStopId);
                if (!transStop) continue;

                const walkOrigin = haversineMeters(oStop.lat!, oStop.lon!, origin.lat, origin.lng);
                const walkDest = haversineMeters(dStop.lat!, dStop.lon!, destination.lat, destination.lng);
                
                const walkMinsOrig = Math.ceil(walkOrigin / WALK_SPEED_M_PER_MIN);
                const walkMinsDest = Math.ceil(walkDest / WALK_SPEED_M_PER_MIN);
                
                const leg1Stops = (i + 1);
                const leg2Stops = dRow.index - tRow2.index;
                const totalBusMins = (leg1Stops + leg2Stops) * BUS_MIN_PER_STOP;
                const busDist = haversineMeters(oStop.lat!, oStop.lon!, transStop.lat!, transStop.lon!) + 
                               haversineMeters(transStop.lat!, transStop.lon!, dStop.lat!, dStop.lon!);
                
                // Penalización de trasbordo: 5 mins de espera estadística
                const estimatedMins = walkMinsOrig + walkMinsDest + totalBusMins + 5;

                // Filtro de Eficiencia Transfer: El bus debe moverte significativamente
                if (walkOrigin + walkDest > busDist && walkOrigin + walkDest > 1000) continue;

                routes.push({
                  type: "TRANSFER",
                  legs: [
                    { fromStop: oStop, toStop: transStop, lineId: oRow.lineId, direction: oRow.direction, numStops: leg1Stops },
                    { fromStop: transStop, toStop: dStop, lineId: tRow2.lineId, direction: tRow2.direction, numStops: leg2Stops }
                  ],
                  totalWalkMeters: Math.round(walkOrigin + walkDest),
                  totalBusMeters: Math.round(busDist),
                  estimatedMinutes: estimatedMins,
                  rankScore: estimatedMins + (walkMinsOrig * 2.5) + (walkMinsDest * 1.5) + 15, // +15 penalty grave por trasbordo
                });
                
                // Limitar explosión combinatoria, un trasbordo válido por combinación Origen
                break;
              }
            }
          }
        }
      }
    }
  }

  // 3. FALLBACK: FUZZY DIRECT (Heurística ciega basada en tags geográficos)
  // Si no hay rutas oficiales (los JSONs fallan para esas zonas), adivinamos.
  if (routes.length === 0) {
    const fuzzyDirectCombinations = new Set<string>();
    
    for (const oStop of originStops) {
      for (const dStop of destStops) {
        if (oStop.id === dStop.id) continue;
        
        const oLines = oStop.lines || [];
        const dLines = dStop.lines || [];
        
        // Interseccion
        const sharedLines = oLines.filter(line => dLines.includes(line));
        
        for (const lineId of sharedLines) {
          if (fuzzyDirectCombinations.has(lineId)) continue;
          fuzzyDirectCombinations.add(lineId);
          
          const walkOrigin = haversineMeters(oStop.lat!, oStop.lon!, origin.lat, origin.lng);
          const walkDest = haversineMeters(dStop.lat!, dStop.lon!, destination.lat, destination.lng);
          const busDistance = haversineMeters(oStop.lat!, oStop.lon!, dStop.lat!, dStop.lon!);
          
          // Asumimos velocidad bus errático: 15km/h (Aprox 250m / minuto)
          const busMins = Math.ceil(busDistance / 250);
          
          const walkMinsOrig = Math.ceil(walkOrigin / WALK_SPEED_M_PER_MIN);
          const walkMinsDest = Math.ceil(walkDest / WALK_SPEED_M_PER_MIN);
          
          // Filtro de Eficiencia Fuzzy: Descartar si el bus es irrelevante
          if (walkOrigin + walkDest > busDistance && walkOrigin + walkDest > 600) continue;

          routes.push({
            type: "FUZZY-DIRECT",
            legs: [{ fromStop: oStop, toStop: dStop, lineId: lineId, direction: "?", numStops: Math.ceil(busMins / 1.5) }],
            totalWalkMeters: Math.round(walkOrigin + walkDest),
            totalBusMeters: Math.round(busDistance),
            estimatedMinutes: walkMinsOrig + walkMinsDest + busMins,
            rankScore: walkMinsOrig + walkMinsDest + busMins + (walkMinsOrig * 3) + 20, // Penalty altisimo por ser oscuro
          });
        }
      }
    }
  }

  // Deduplicamos rutas tontas similares (Mismas lineas pero paradas slightly diferentes) que duren más
  const bestRoutesMap = new Map<string, JourneyRoute>();
  for (const r of routes) {
    const signature = r.legs.map(l => l.lineId).join("->");
    const existing = bestRoutesMap.get(signature);
    if (!existing || r.rankScore < existing.rankScore) {
      bestRoutesMap.set(signature, r);
    }
  }

  return Array.from(bestRoutesMap.values())
    .sort((a, b) => a.rankScore - b.rankScore)
    .slice(0, 5); // Max 5 opciones ultra refinadas
}
