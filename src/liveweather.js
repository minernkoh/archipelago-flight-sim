// Live weather: pull current conditions at a lat/lon from Open-Meteo (free,
// keyless, CORS) and map them onto the sim's wind field + visibility. mapWeather
// is pure (node-testable); fetchLiveWeather is the thin browser fetch.

const API = 'https://api.open-meteo.com/v1/forecast';
const MS2KT = 1.94384;

// Keep live wind inside the envelope the aircraft is proven to handle even
// parked at spawn: the 'gusty' preset (turb 1.0, 12 kt gusts) is the strongest
// air the physics tests fly without departing, so cap gust/turbulence there.
// Steady wind can run a little higher (it doesn't buffet a parked plane).
const STEADY_CAP = 30;   // kt
const GUST_CAP = 12;     // kt above steady
const TURB_CAP = 1.0;    // matches the 'gusty' preset

// Open-Meteo `current` block (m/s wind) -> { wind, vis, clamped }.
export function mapWeather(cur = {}) {
  const steadyKt = Math.max(0, (cur.wind_speed_10m || 0) * MS2KT);
  const gustAbove = Math.max(0, (cur.wind_gusts_10m || 0) - (cur.wind_speed_10m || 0)) * MS2KT;
  const kts = Math.min(Math.round(steadyKt), STEADY_CAP);
  const gustKts = Math.min(Math.round(gustAbove), GUST_CAP);
  const dirDeg = Math.round(((cur.wind_direction_10m || 0) % 360 + 360) % 360);
  const turb = Math.max(0, Math.min(TURB_CAP, gustKts / 12)); // gustier air => more mechanical turbulence
  return {
    wind: { kts, gustKts, turb, dirDeg },
    vis: { visibilityM: cur.visibility, cloudCover: cur.cloud_cover },
    clamped: Math.round(steadyKt) > STEADY_CAP || Math.round(gustAbove) > GUST_CAP,
  };
}

export async function fetchLiveWeather(lat, lon) {
  const q = `?latitude=${lat}&longitude=${lon}` +
    '&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m,visibility,cloud_cover&wind_speed_unit=ms';
  const res = await fetch(API + q, { mode: 'cors' });
  if (!res.ok) throw new Error('weather ' + res.status);
  const j = await res.json();
  return mapWeather(j.current || {});
}
