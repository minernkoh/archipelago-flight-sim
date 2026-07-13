// Curated real-world airfields for the real-world terrain mode. Coordinates are
// the runway MIDPOINT (the map's ENU origin); bearing is the takeoff runway's
// true heading; elev is field elevation (m). Values are approximate to a few
// metres — enough for the terrain to read as the real place. Chosen for
// dramatic, recognisable terrain that shows off streamed real elevation.

export const AIRPORTS = [
  {
    id: 'courchevel', name: 'COURCHEVEL', icao: 'LFLJ',
    lat: 45.3967, lon: 6.6347, elev: 2008, bearingDeg: 41, lengthM: 537, widthM: 30,
    rwyName: '04', zoom: 13,
    desc: 'LFLJ — the notorious 537 m alpine altiport, 2008 m up',
  },
  {
    id: 'innsbruck', name: 'INNSBRUCK', icao: 'LOWI',
    lat: 47.2602, lon: 11.3439, elev: 581, bearingDeg: 75, lengthM: 2000, widthM: 45,
    rwyName: '08', zoom: 12,
    desc: 'LOWI — a valley approach walled by the Tyrolean Alps',
  },
  {
    id: 'queenstown', name: 'QUEENSTOWN', icao: 'NZQN',
    lat: -45.0211, lon: 168.7392, elev: 357, bearingDeg: 50, lengthM: 1900, widthM: 45,
    rwyName: '05', zoom: 12,
    desc: 'NZQN — lake and Remarkables ranges, New Zealand',
  },
  {
    id: 'sanfrancisco', name: 'SAN FRANCISCO', icao: 'KSFO',
    lat: 37.6189, lon: -122.3750, elev: 4, bearingDeg: 284, lengthM: 3618, widthM: 60,
    rwyName: '28L', zoom: 12,
    desc: 'KSFO — the bay, the peninsula hills, sea-level threshold',
  },
  {
    id: 'changi', name: 'SINGAPORE CHANGI', icao: 'WSSS',
    lat: 1.3592, lon: 103.9894, elev: 7, bearingDeg: 23, lengthM: 4000, widthM: 60,
    rwyName: '02L', zoom: 12,
    desc: 'WSSS — the real Changi, flat and tropical by the strait',
  },
];
