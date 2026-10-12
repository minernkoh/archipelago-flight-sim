# What "AAA flight simulator" means here

The goal for this project was "make the simulator like a AAA simulator". That
phrase has no fixed definition, so this file pins one down. It lists the
feature areas that Microsoft Flight Simulator (2020/2024) and X-Plane 12 are
judged on, and rates ARCHIPELAGO against each one. Every rating points at
the evidence: a test, a script or a file.

Ratings:
- **Met**: comparable in kind to the reference sims and verified by a test or a render.
- **Partial**: present, but clearly below the reference in scope or fidelity.
- **Not met**: absent.
- **Unverified**: built, but not yet checked against real-world input.

Some gaps can't be closed by a browser app with no backend or licensed data:
- planet-wide photogrammetry and satellite imagery
- licensed recorded audio
- multiplayer servers

Those are marked as scope limits, not as defects.

## Flight and systems

| Area | Rating | Evidence |
|---|---|---|
| 6-DOF flight model: stall, spin, post-stall, ground effect, propwash, slipstream swirl | Met | `src/physics/`, `npm test` (envelope, stall and roll invariants) |
| Wind, gusts, turbulence; aerodynamics use air-relative velocity | Met | `src/physics/wind.js`, physics suite |
| Ground handling: gear, brakes, wet runway, crosswind landing | Met | `groundContact.js`, school lesson 7 (`npm run school`) |
| Airframe limits: Vne, flap speeds, g limits, damage | Met | `envelope.js`, physics suite |
| Engine start (cold and dark), battery, mags, mixture | Partial | Simplified next to study-level aircraft. e2e "start sequence" |
| Autopilot: HDG, ALT, IAS, LNAV flight plans, coupled ILS approach (LOC + GS to minimums) | Met | Every type hands over at 200 ft within 12 m of the centreline and 6 m of the glidepath, calm and 15 kt crosswind (physics suite `autopilot APR`). No VNAV or autoland. |
| Failures: engine, partial power, alternator, vacuum, pitot, static, flaps, hydraulics; random mode; annunciators | Met | `physics/failures.js`, physics suite `failure:` checks, e2e. Gear failure not modelled (gear is not simulated as retractable). |

## Aircraft

| Area | Rating | Evidence |
|---|---|---|
| Exterior models: PBR paint, animated controls, gear, lights | Met | `src/aircraft/meshes.js`, `test/showroom.mjs` |
| 3D cockpits with live instruments and clickable controls | Partial | `src/cockpit.js`. AP mode buttons, HDG and ALT selector knobs, battery, mags, starter, mixture and flap switches are clickable; individual knobs, radios and breakers are not, unlike study-level MSFS/X-Plane aircraft. |
| Five distinct aircraft (trainer, aerobatic, fighter, airliner, flying wing) | Met | `src/aircraft/params.js` |

## World

| Area | Rating | Evidence |
|---|---|---|
| Real elevation at real airfields (5) | Met | `src/maps/realworld.js`, e2e real-world block |
| Buildings, roads, pavement and land cover from OpenStreetMap | Unverified | `src/maps/osm.js`. Tested only with a hand-written fixture and a synthetic 40k-building city: this environment's network policy blocks Overpass. |
| Planet-wide coverage, satellite imagery, photogrammetry | Not met (scope) | Needs licensed imagery and streaming servers |
| Detailed fictional maps (archipelago, Singapore, alpine) | Met | `src/maps/` |
| Airports: ICAO markings, approach lights, PAPI, aprons, hangars | Met | `runwayPaint.js`, `runwayLights.js`, `airfieldKit.js` |
| AI traffic | Partial | Two AI aircraft fly real touch-and-goes, half a circuit apart, and the tower works the one that matters: hold short, number two, runway-occupied go-around, traffic calls (`aitraffic.js`, physics suite + e2e). Scripted paths, no airliner/IFR traffic, no collision avoidance. |

## Atmosphere and rendering

| Area | Rating | Evidence |
|---|---|---|
| Time of day, sky, stars, night lighting | Met | `environment.js` |
| Clouds | Met (cumulus) | Raymarched volumetric cumulus with self-shadowing, forward scattering and fly-through (`volclouds.js`, e2e checks it on full detail). Cloud shadows fall on the terrain (`cloudshadow.js`). The overcast deck is volumetrically SHADED (light marched through 3D noise: lit domes on top, thickness-darkened base) but its silhouette is still a displaced surface, not a raymarched volume. |
| Weather: rain, storms, lightning, overcast, live real weather | Met | `weather.js`, `liveweather.js`, e2e live weather |
| Water: reflections, swell, shallows, foam | Met | Planar reflection (e2e reflection check) |
| Post FX: bloom, grade, flare; dynamic resolution | Met | `post.js`, `main.js adaptResolution` |

## Sound

| Area | Rating | Evidence |
|---|---|---|
| Engine sound driven by engine state (rpm, load, N1), Doppler, cockpit vs exterior | Unverified | `engineSynth.js`. The physics suite checks firing frequency, fan tone, buzzsaw, directivity and Doppler. Not yet judged by a listener (`npm run sounds` renders WAVs). |
| Recorded sample sets | Not met (scope) | Licensing |
| ATC voice | Met | `atc.js`, `npm run checks` |

## Experience

| Area | Rating | Evidence |
|---|---|---|
| Flight school (7 lessons) with instructor and grading | Met | `npm run school` |
| Instant replay with cinematic cameras | Met | `replay.js`, e2e |
| Gamepad and joystick input | Met | `controls.js` (Gamepad API) |
| Multiplayer, VR | Not met (scope) | Needs servers / WebXR work |

## Open items a person has to close

1. **OSM:** fly a real-world airfield (San Francisco, Changi) in a normal
   browser and check the scenery and frame rate.
2. **Sound:** listen to the engine (in the sim, or the WAVs from
   `npm run sounds`) and say whether it is good enough.
3. **Priorities:** choose which "Partial" rows matter for "AAA". The obvious
   remaining candidates are fully clickable study-level cockpits, ATC-controlled
   AI traffic, and volumetric overcast.
