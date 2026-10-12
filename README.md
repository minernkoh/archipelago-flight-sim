# Archipelago Flight Sim

A browser flight simulator built with **Three.js**

## Features

- **5 flyable aircraft** with distinct handling.
- **Procedural archipelago**, a stylized Singapore, an alpine valley and real-world airfields.
- **Ring races** — timed courses through floating gates.
- **Flight school** — PPL-style guided lessons.
- **Living world** — smooth terrain with procedural grass, soil and rock detail,
  clear turquoise shallows, soft cumulus, streamed forests, a sky with stars at night, time-of-day
  lighting, and a live 3D scene behind the menu.
- **Cameras** — chase (wheel zoom, drag to look around), a full 3D cockpit,
  orbit, and a cinematic fly-by (`V`).
- **3D cockpits**: every aircraft has a modelled interior with live
  instruments: a steam six-pack with engine gauges and radios in the light
  aircraft, glass PFD/ND/engine displays in the jets and airliner. Yokes,
  sticks and throttles move with your inputs, and the panel is backlit at
  night. The wings, struts and engines stay visible through the glass.
- **Airshow touches** — wingtip vortices when you pull G, smoke trail on `K`.
- **Feel**: spring-damped chase camera with buffet shake, control expo, Shift for fine control.
- **Real-world scenery from OpenStreetMap** at the real airfields: towns
  extruded to their mapped heights with windows that light up at night, the
  airport's aprons, taxiways and other runways (with proper markings), roads,
  lakes, and fields and forests where they really are. Buildings are solid.
  Data © OpenStreetMap contributors (ODbL), credited on screen.
- **Engine sound modelled from physics**, not loops: you hear each cylinder
  fire through the exhaust and the propeller blades beat (a lumpy idle, a
  starter cranking, pops when you chop the throttle in the Extra), or a
  turbofan's fan tone and supersonic-tip buzzsaw ahead of the inlet and the
  jet roar behind it, with afterburner rumble, Doppler on fly-bys and a
  muffled cabin in the cockpit. `npm run sounds` renders samples to WAV.
- **Eye candy**: bloom and lens flare, ocean swell with coastal foam and spray, nav lights and strobes, retracting gear.
- **A living world**: villages, lighthouses, boats, circuit traffic and birds,
  and a Singapore skyline with curtain-wall glass and window-by-window lights at night.
- **Dynamic resolution** — keeps the frame rate up on weaker GPUs.
- **Lofted PBR airframes**: every aircraft is built from smooth lofted fuselage
  sections and real airfoil-section wings, in clear-coated paint that reflects the sky, with working flaps, ailerons, rudders, spinning
  wheels, airliner ground spoilers and turning fan faces.
- **Real airfields**: runway markings to the ICAO pattern (piano keys,
  designators, touchdown zone, aiming points) over a procedural asphalt with
  rubber deposits, plus edge and centreline lights, approach lights with
  sequenced flashers, and a PAPI that actually reads your glidepath.
- **Weather**: RAIN and STORM put an overcast deck over the field. Below it
  you get rain streaks, beads on the windscreen in the cockpit, a wet,
  reflective runway with longer braking distances, and lightning with
  thunder that arrives late from far-off strikes. Climb through the deck and
  you break out into sunshine on top. LIVE weather maps real rain and
  thunderstorms onto the same presets.
- **Instant replay** (`X`, or from the pause, crash and results screens):
  letterboxed playback of the last 150 s, with chase, tower telephoto, fly-by,
  onboard and orbit cameras plus an AUTO director that cuts between them.
  Scrub with the arrows, change speed, and touchdowns and crashes replay with
  their effects.

## Getting started

```bash
npm install
npm run serve      # → http://localhost:8123
```

## Development

```bash
npm test           # physics tests
npm run e2e        # end-to-end test (needs npm run serve)
node test/showroom.mjs <dir>              # aircraft art review screenshots
node test/shots.mjs <dir> [map] [time] [weather]   # in-flight review shots
node test/wxshots.mjs <dir>               # weather: cockpit rain, lightning, in-cloud
node test/replayshots.mjs <dir>           # instant replay cameras
```

## Layout

```
index.html
src/            # simulator source (aircraft, terrain, races, flight school)
test/           # physics + e2e tests
package.json
```

