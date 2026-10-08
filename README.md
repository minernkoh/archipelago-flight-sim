# Archipelago Flight Sim

A browser flight simulator built with **Three.js**

## Features

- **5 flyable aircraft** with distinct handling.
- **Procedural archipelago**, a stylized Singapore, an alpine valley and real-world airfields.
- **Ring races** — timed courses through floating gates.
- **Flight school** — PPL-style guided lessons.
- **Living world** — crisp faceted low-poly terrain, clear turquoise shallows,
  low-poly cumulus, streamed forests, a sky with stars at night, time-of-day
  lighting, and a live 3D scene behind the menu.
- **Cameras** — chase (wheel zoom, drag to look around), cockpit with a framed
  canopy, orbit, and a cinematic fly-by (`V`).
- **Airshow touches** — wingtip vortices when you pull G, smoke trail on `K`.
- **Feel**: spring-damped chase camera with buffet shake, control expo, Shift for fine control, prop audio with Doppler.
- **Eye candy**: bloom and lens flare, ocean swell with coastal foam and spray, nav lights and strobes, retracting gear.
- **A living world**: villages, lighthouses, boats, circuit traffic and birds.
- **Dynamic resolution** — keeps the frame rate up on weaker GPUs.

## Getting started

```bash
npm install
npm run serve      # → http://localhost:8123
```

## Development

```bash
npm test           # physics tests
npm run e2e        # end-to-end test (needs npm run serve)
```

## Layout

```
index.html
src/            # simulator source (aircraft, terrain, races, flight school)
test/           # physics + e2e tests
package.json
```

