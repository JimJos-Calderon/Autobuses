export interface GeocoderResult {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  boundingbox: [string, string, string, string]; // [south, north, west, east]
}

const geocodeCache = new Map<string, GeocoderResult[]>();

export async function geocodeVigo(query: string): Promise<GeocoderResult[]> {
  if (!query || query.trim().length < 3) return [];

  const normalizedQuery = query.trim().toLowerCase();
  if (geocodeCache.has(normalizedQuery)) {
    return geocodeCache.get(normalizedQuery)!;
  }

  // Restringimos al bounding box aproximado de Vigo y alrededores
  const VIGO_VIEWBOX = "-8.8354,42.2743,-8.6017,42.1643"; // minLon,maxLat,maxLon,minLat
  
  const headers = {
    "Accept": "application/json",
    "User-Agent": "AutobusesVigoApp/1.0 (contacto@local.dev)",
  };

  try {
    // 1er Intento: Estricto. Exige que esté dentro del viewbox. Bueno para calles.
    const urlStrict = new URL("https://nominatim.openstreetmap.org/search");
    urlStrict.searchParams.set("q", `${query}, Vigo`); 
    urlStrict.searchParams.set("format", "jsonv2");
    urlStrict.searchParams.set("viewbox", VIGO_VIEWBOX);
    urlStrict.searchParams.set("bounded", "1"); 
    urlStrict.searchParams.set("limit", "5");
    urlStrict.searchParams.set("addressdetails", "0");

    let res = await fetch(urlStrict.toString(), { headers });
    let data: GeocoderResult[] = res.ok ? await res.json() : [];

    // 2do Intento (Fallback): Si falla o no trae nada, buscamos sin la clausula bounded=1
    // y sin forzar la coma ", Vigo" por si es un POI mundial como "Corte Inglés"
    if (data.length === 0) {
      const urlLoose = new URL("https://nominatim.openstreetmap.org/search");
      // Mantenemos "Vigo" pero mas relajado para que OSM no se enrede si no es una calle oficial
      urlLoose.searchParams.set("q", `${query} Vigo España`); 
      urlLoose.searchParams.set("format", "jsonv2");
      urlLoose.searchParams.set("limit", "5");
      urlLoose.searchParams.set("addressdetails", "0");
      
      res = await fetch(urlLoose.toString(), { headers });
      if (res.ok) {
        data = await res.json();
      }
    }

    // Filtrar falsos positivos locos que estén fuera de Galicia (Lat 41-44, Lon -9 a -6)
    // Opcional, pero previene que nos traiga algo de Madrid.
    const filteredData = data.filter(d => {
       const lat = parseFloat(d.lat);
       const lon = parseFloat(d.lon);
       return lat > 41.5 && lat < 43.5 && lon > -9.5 && lon < -7.0;
    });

    geocodeCache.set(normalizedQuery, filteredData);
    return filteredData;
  } catch (err) {
    console.error("[Geocoder] Error:", err);
    return [];
  }
}
