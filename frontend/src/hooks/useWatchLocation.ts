import { useEffect, useState } from "react";

export interface WatchedLocation {
  lat: number;
  lng: number;
  accuracy: number;
}

export function useWatchLocation(enabled: boolean) {
  const [location, setLocation] = useState<WatchedLocation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!navigator.geolocation) {
      setError("Geolocalizacion no disponible en este navegador.");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        setError(null);
        setLocation({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => {
        setError("No se pudo seguir tu ubicacion.");
      },
      {
        enableHighAccuracy: true,
        timeout: 12_000,
        maximumAge: 8_000,
      },
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [enabled]);

  return { location, error };
}
