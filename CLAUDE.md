# ARCHIPELAGO — browser flight simulator

Three.js flight sim, plain ES modules via import map (no bundler, no build step).
v2: 5 aircraft, 2 maps (procedural archipelago + stylized Singapore), free flight,
ring race, and a 7-lesson flight school.

## Run / test

- `npm run serve` → python http.server on :8123, open http://localhost:8123
- `npm test` → headless physics suite (Node, no browser, ~1 min; must stay green)
- `npm run e2e` → puppeteer E2E against :8123 (server must be running; writes test/shots/*.png)
- `node test/bootcheck.mjs` → fast boot/menu/aircraft-swap smoke check

## Architecture (who owns what)

- `src/physics/` — pure JS flight dynamics, **no Three.js imports ever** (headless tests depend on this). flightModel.js = forces/moments/integration; groundContact.js = gear/probes from `ac.p.gear`/`ac.p.probes`.
- `src/physics/wind.js` — THREE-free wind field (steady/gusts/turbulence); aero uses air-relative velocity, gear stays inertial; trim rides on `controls.trim`; trainer can set `ac.engineFailed`.
- `src/aircraft/params.js` — per-aircraft physics presets, also THREE-free. catalog.js joins params + mesh builder + HUD/camera meta. meshes.js = the 5 low-poly builders.
- `src/maps/` — map modules implementing the FlightMap contract (typedef in archipelago.js). Render height (`map.height`) is separate from collision height (`max(height, obstacleTop)`); ground effect/AGL use terrain only.
- `src/terrain.js` — generic chunk streamer; `src/rings.js` — parameterized gates (race + training themes); `src/modes.js` — menu/state machine; `src/main.js` — swap lifecycle + frame loop.
- Body frame: +x forward, +y up, +z right. Body rate r about +y: **positive = nose LEFT** (sign mistakes here are the #1 physics bug source).

## Hard-won gotchas (do not re-learn these)

- **Headless Chrome starves rAF** unpredictably; the main loop has a 250 ms setTimeout watchdog with a generation ticket (see main.js `schedule()`). Never drive boot/pre-gen loops with rAF.
- **Never use page.click/page.keyboard in tests** — headless input dispatch waits on compositor frames and hangs when the compositor stalls. Dispatch DOM events via `page.evaluate` (see test/e2e.mjs helpers).
- Puppeteer launches need `--enable-unsafe-swiftshader` and generous `protocolTimeout`; screenshots may fail when the compositor is stalled (wrap in try/catch).
- Physics runs at fixed 120 Hz with dt clamp 0.25 s; sim-time ≈ wall-time only if the frame loop ticks ≥4 fps.
- Elevator authority: `Cmde` ≈ 0.35–0.55 in these normalized units; higher over-rotates and tail-strikes.
- E2E "flies" by teleporting: always set orientation (yaw quaternion) to match velocity, else sideslip aerodynamics veer the plane off course; approach gates from ≤150 m or lift trim balloons the plane above the ring.

## Conventions

- Verify with the scripts above, not by eyeballing — extend test/physics.test.js for physics changes, test/e2e.mjs for flow changes.
- localStorage keys: `archipelago.best.{map}.{aircraft}` (+ `.splits`), `archipelago.training`, `archipelago.sel`, `archipelago.settings`, `archipelago.logbook`, `archipelago.plan.{map}`.
- Aesthetic: PFD/avionics HUD (B612 font, amber cautions, red warnings, magenta race guidance); low-poly flat-shaded world. Keep new UI in that system.
