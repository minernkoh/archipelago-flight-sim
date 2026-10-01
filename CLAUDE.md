# ARCHIPELAGO — browser flight simulator

Three.js flight sim, plain ES modules via import map (no bundler, no build step).
v2: 5 aircraft, 2 maps (procedural archipelago + stylized Singapore), free flight,
ring race, and a 7-lesson flight school. v7: faceted low-poly terrain, scattering-style sky + stars,
low-poly cumulus, instanced forests, clear-water shallows, cockpit frames, fly-by camera,
wingtip vortices / airshow smoke, live 3D menu backdrop, dynamic resolution.

## Run / test

- `npm run serve` → python http.server on :8123, open http://localhost:8123
- `npm test` → headless physics suite (Node, no browser, ~1 min; must stay green)
- `npm run e2e` → puppeteer E2E against :8123 (server must be running; writes test/shots/*.png)
- `node test/bootcheck.mjs` → fast boot/menu/aircraft-swap smoke check

## Architecture (who owns what)

- `src/physics/` — pure JS flight dynamics, **no Three.js imports ever** (headless tests depend on this). flightModel.js = forces/moments/integration; groundContact.js = gear/probes from `ac.p.gear`/`ac.p.probes`.
- `src/physics/envelope.js` — Vne/Vfe/Mach/g limits, the damage accumulator and `vSpeeds()`. THREE-free; `modes.js`, `panel.js` and the tests all read V-speeds from here so the menu card, the ASI arcs and the airframe limits cannot disagree.
- `src/physics/wind.js` — THREE-free wind field (steady/gusts/turbulence); aero uses air-relative velocity, gear stays inertial; trim rides on `controls.trim`; trainer can set `ac.engineFailed`.
- `src/aircraft/params.js` — per-aircraft physics presets, also THREE-free. catalog.js joins params + mesh builder + HUD/camera meta. meshes.js = the 5 low-poly builders.
- `src/maps/` — map modules implementing the FlightMap contract (typedef in archipelago.js). Render height (`map.height`) is separate from collision height (`max(height, obstacleTop)`); ground effect/AGL use terrain only.
- `src/terrain.js` — generic chunk streamer, plus instanced trees on a ±1.5 km ring of fine chunks (optional `map.forest(x,z,h,slope)` → 0..1 and `map.conifer(h)`; a map without `forest` grows none; LOW quality turns them off). `src/maps/noise.js` is shared noise for COSMETIC layers only (forest, meadow) — never feed it into `map.height`, the state hashes depend on heights.
- **Art direction: crisp faceted low-poly.** terrain.js builds the fine tier non-indexed with ONE colour per triangle (map `color()` is called per face at its centroid with the face's own slope); the coarse tier stays smooth and is sunk ~250 m wherever the fine tier covers it (vertex shader), or its 200 m interpolation pokes through valleys. All maps paint from `src/maps/palette.js` (`PAL`, `seabed()`, `beach()`, `facetJitter()`, `decalMaterial()` — runway slabs need its polygon offset or they z-fight with the flat apron at range).
- `src/environment.js` — sky dome shader, low-poly faceted cumulus (opaque, stylised top/underside shading), semi-transparent ocean (the turquoise seabed shows through as shallows near the aircraft; opaque beyond ~2 km), time-of-day palettes. `src/trails.js` — ribbon trails (wingtip vortices on G/alpha, `K` smoke); pooled, no per-frame allocation.
- `src/camera.js` — `C` cycles CHASE/COCKPIT/ORBIT (tests rely on exactly that cycle), `V` toggles FLYBY, wheel zoom, left-drag free-look, per-aircraft cockpit frame (`catalog camera.cockpit.frame`: cabin/canopy/airliner), `updateMenu()` = the slow showcase orbit behind the menu. The menu backdrop is fed by `world.preview(sel)` (aircraft + time of day only; maps still load on START).
- `src/rings.js` — parameterized gates (race + training themes); `src/modes.js` — menu/state machine; `src/main.js` — swap lifecycle + frame loop.
- Body frame: +x forward, +y up, +z right. Body rate r about +y: **positive = nose LEFT** (sign mistakes here are the #1 physics bug source).

## Hard-won gotchas (do not re-learn these)

- **Headless Chrome starves rAF** unpredictably; the main loop has a 250 ms setTimeout watchdog with a generation ticket (see main.js `schedule()`). Never drive boot/pre-gen loops with rAF.
- **Never use page.click/page.keyboard in tests** — headless input dispatch waits on compositor frames and hangs when the compositor stalls. Dispatch DOM events via `page.evaluate` (see test/e2e.mjs helpers).
- **In e2e, always `press(k)` (keydown+keyup), never a bare `keyEv('keydown', …)`** — controls.js tracks held keys, so a keydown without its keyup leaves that axis stuck for the REST of the suite. A stray held ArrowDown in a menu test cancelled the ArrowUp during rotation and rolled the aircraft off the runway, failing "airborne and climbing", "HUD live" and the minimap check ~40 lines later. `hold()`/`release()` exist for deliberately-held keys.
- Puppeteer resolves a pinned Chrome build that may not be installed. If a browser test dies with "Could not find Chrome (ver. …)", run it with `PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"` rather than downloading one.
- Puppeteer launches need `--enable-unsafe-swiftshader` and generous `protocolTimeout`; screenshots may fail when the compositor is stalled (wrap in try/catch).
- Physics runs at fixed 120 Hz with dt clamp 0.25 s; sim-time ≈ wall-time only if the frame loop ticks ≥4 fps.
- **The scene is fill-rate bound** (sky, ocean, clouds, terrain all cover the screen). Under SwiftShader that is what decides whether timing-sensitive e2e checks (cold-start crank, lesson-1 taxi) pass. Dynamic resolution (main.js `adaptResolution`, setting `autoRes`) drops render scale to 0.6 when fps sags, which put headless runs at ~6 fps vs ~3.7 before v7. Measure with a perf probe before adding anything screen-covering; tree shadow casting alone cost ~0.3 fps and was removed.
- Custom `ShaderMaterial`s here come out tone-mapped + sRGB-encoded like the built-ins, so palette hex values are NOT what lands on screen (ACES darkens/saturates). Tune sky/cloud colours by sampling rendered pixels, not by reading hex.
- Elevator authority: `Cmde` ≈ 0.35–0.55 in these normalized units; higher over-rotates and tail-strikes. **This binds the propwash factor too** — `qWash` scales `Cmde`, so its cap must keep the product under ~0.55 or every takeoff ends in a strike just after rotation.
- **v6 flight model — the two firewall invariants.** Post-stall drag and the two-station strip roll damping are both written so they are *provably* inert below the stall (`sep === 0`, and the strip pair collapses algebraically to `Clp*(pb/2V)`). That is what lets the stall/roll/envelope work coexist with the byte-identical cruise state hash. `test/physics.test.js` section 18c asserts both directly — if you change `liftCoeff`, keep them true.
- **A hands-off single no longer flies straight.** Slipstream swirl gives a real left-turning tendency, and the C172 is slightly spirally divergent, so any test that flies fixed controls for more than ~20 s needs a wings-leveler and coordinated rudder or it will spiral. Several existing tests had to gain one. Engine torque roll is deliberately *not* modelled — there is no aileron trim to hold against it.
- Turbulence rolls the aircraft through a spanwise gust gradient sampled at the wingtips. It must stay **slow** (~200 m eddies): an early version varied at ~29 Hz as the aircraft flew through it and the roll mode, time constant under 0.1 s, filtered it out entirely.
- E2E "flies" by teleporting: always set orientation (yaw quaternion) to match velocity, else sideslip aerodynamics veer the plane off course; approach gates from ≤150 m or lift trim balloons the plane above the ring.

## Conventions

- Verify with the scripts above, not by eyeballing — extend test/physics.test.js for physics changes, test/e2e.mjs for flow changes.
- localStorage keys: `archipelago.best.{map}.{aircraft}` (+ `.splits`), `archipelago.training`, `archipelago.sel`, `archipelago.settings`, `archipelago.logbook`, `archipelago.plan.{map}`.
- Menu/pause/crash/results screens are translucent over the live scene — keep new overlay screens legible with a left-weighted scrim rather than an opaque background.
- Aesthetic: PFD/avionics HUD (B612 font, amber cautions, red warnings, magenta race guidance); low-poly flat-shaded world. Keep new UI in that system.
