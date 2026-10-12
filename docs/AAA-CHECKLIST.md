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
| Engine start (cold and dark), battery, mags, mixture | Partial | Battery, mags (OFF/R/L/BOTH/START), mixture, primer (unprimed cranks 3.5 s, two strokes 1.6 s, over-primed floods for 6 s), fuel selector (OFF starves the engine after 12 s), carb heat against modelled carb icing. Physics suite + e2e "start sequence" and "two PRIME strokes". Mixture leaning (`mixtureState`): best-power mixture follows air density, so leaning at 8,000 ft gains ~4% power and cuts fuel flow ~18%; EGT peaks lean of best power; too lean runs rough, then quits. Full rich is exactly the reference, so the cruise hash is untouched. Live oil pressure and temperature (warm-up, cold-oil pressure, an oil-leak failure that ends in a seizure), and an EGT readout. No fuel pump because the carbureted Skyhawk is gravity-fed and has none. Vacuum gauge and ammeter (`engineAux`): suction from the engine pump, starter draw, recharge after a start, and a steady discharge on a dead alternator, so the vacuum and alternator failures can be diagnosed on the panel. Four cylinder head temperatures (heated by the exhaust, cooled by airflow, rear cylinder hottest), shock cooling detection and an engine-wear accumulator (shock cooling, heads over 460 F) that costs power; the hottest CHT shows under the EGT and turns amber. Magneto check: a single magneto drops ~85 rpm and a little power (physics suite). Still simplified next to study-level aircraft: wear is one number rather than per-component, and there is no propeller governor (the Skyhawk has a fixed-pitch prop, so none is owed). |
| Autopilot: HDG, ALT, IAS, LNAV flight plans, coupled ILS approach (LOC + GS to minimums) | Met | Every type hands over at 200 ft within 12 m of the centreline and 6 m of the glidepath, calm and 15 kt crosswind (physics suite `autopilot APR`). No VNAV or autoland. |
| Failures: engine, partial power, alternator, vacuum, pitot, static, flaps, hydraulics; random mode; annunciators | Met | `physics/failures.js`, physics suite `failure:` checks, e2e. Gear failure not modelled (gear is not simulated as retractable). |

## Aircraft

| Area | Rating | Evidence |
|---|---|---|
| Exterior models: PBR paint, animated controls, gear, lights | Met | `src/aircraft/meshes.js`, `test/showroom.mjs` |
| 3D cockpits with live instruments and clickable controls | Partial | `src/cockpit.js`. Clickable: AP mode buttons, HDG/ALT selectors, battery, mags, starter, mixture, flaps, COM/NAV radios on the steam panels and NAV 1 tuning on the glass ones (frequencies shown on the ND; NAV must be on the field's ILS for APR), and AVN/AP/FLAP circuit breakers with real effects in every cockpit. Steam cockpits add LAND/NAV/STRB/BCN light switches (they drive the real lights), a fuel selector that starves the engine when OFF, and trim. The Skyhawk adds carb heat against modelled carburettor icing (moist air, low power), a primer (unprimed starts crank longer, over-priming floods) and a transponder (7700 gets an emergency clearance from the tower). An ALT STATIC switch selects the alternate static source, the real recovery for the blocked-static failure (altimeter and VSI come back reading ~50 ft high, as the POH says). Seven breakers with real effects: AVN (avionics bus), AP, FLAP, LTS (exterior lights), COM (radios dark, no ILS, no APR), XPDR (no squawk to ATC, TCAS dead) and, on steam panels, TC (the electric turn coordinator stops). The transponder takes any code from four octal knobs as well as stepping through 1200/7000/7600/7700. CABIN HT works the defrost: in moist air (rain, storm) the windscreen mists over a few minutes with it off, and it clears in ~30 s (physics suite; drawn on the cockpit glass under the rain beads). PITOT HT against modelled pitot icing (visible moisture below +5 C ices the pitot in about a minute and freezes the airspeed, silently, as in the aeroplane; the heater clears and prevents it, draws ~10 A on the ammeter and has its own breaker), and fresh-air VENTs that help clear the mist. Not the full study-level panel of MSFS/X-Plane aircraft: still fewer breakers than the real aircraft (eight, with real effects). |
| Five distinct aircraft (trainer, aerobatic, fighter, airliner, flying wing) | Met | `src/aircraft/params.js` |

## World

| Area | Rating | Evidence |
|---|---|---|
| Real elevation at real airfields (5) | Met | `src/maps/realworld.js`, e2e real-world block |
| Buildings, roads, pavement and land cover from OpenStreetMap | Unverified | `src/maps/osm.js`. Tested only with a hand-written fixture and a synthetic 40k-building city: this environment's network policy blocks Overpass. |
| Planet-wide coverage, satellite imagery, photogrammetry | Not met (scope) | Needs licensed imagery and streaming servers |
| Detailed fictional maps (archipelago, Singapore, alpine) | Met | `src/maps/`. Singapore has an autogen city fill (`autogen.js`): ~2,500 housing-board slabs, condo towers and low-rise blocks over the urban land, clear of water, forest, the airfield, the approaches, the landmarks and the race course, in a handful of merged draw calls with the facade shader (lit windows at night), each one solid. Generated in ~100 ms; a physics-suite check keeps every race leg and both approaches clear. The alpine valley gets villages from the same generator: ~140 gabled chalets, farmhouses and barns in clusters on the valley floor, with windows (lit at night, facade shader), solid, clear of the runway, its approach and the slalom. |
| Airports: ICAO markings, approach lights, PAPI, aprons, hangars | Met | `runwayPaint.js`, `runwayLights.js`, `airfieldKit.js` |
| AI traffic | Partial | Two club aircraft fly touch-and-goes; an airliner flies a straight-in ILS arrival, rolls out, exits at a connector and taxis a real taxiway network to its stand (`taxinet.js`: graph routing, filleted turns, a speed profile that slows for corners), parks, is turned on the stand when its route out needs it, taxis out, holds short with its nose behind the bar, lines up and departs. The fictional fields have a drawn parallel taxiway, connectors, hold bars and a stand; real-world fields route over the OSM taxiways to the biggest apron. Slotting keeps the airliner off the runway and 600 m clear of the club aircraft on departure; if anything slips, the club aircraft go around rather than land on an occupied runway, and they step away vertically from you and from the airborne airliner. The tower works whichever matters: hold short, number two (wake caution behind the airliner), runway-occupied go-around, traffic calls, emergency squawk (physics suite + e2e). TCAS (`tcas.js`): range-tau plus vertical logic gives traffic advisories about 40 s out (amber TRAFFIC box, "Traffic, traffic", ND symbols with relative altitude and trend) and, on transport jets above 1000 ft AGL, resolution advisories about 25 s out with the correct climb/descend sense ("Climb, climb" / "Descend, descend", then "Clear of conflict"); light aircraft get TA only, as with a real TAS (physics suite scenarios + e2e). RAs are coordinated: the intruder an RA names flies the complementary sense (you CLIMB, it descends), the airliner included (e2e). Two active runways at Singapore: a second airliner works the parallel 02C (`map.extraRunways`) with its own taxiway and stand, alternating with the 02L arrivals; the tower treats it as traffic to call, never one to hold or sequence you for. The circuit traffic responds to you: while you hold the runway or short final, the tower gives a club aircraft on downwind a left 360 for spacing (flown as a real orbit, rejoining where it left) or sends one already on base around, and you hear those instructions on frequency (`createSequencer`, physics suite: never lands on you, no jumps, spacing kept). Still largely scripted rather than autonomous agents: one airliner per runway, and OSM taxi routing is tested only against the hand-written fixture. |

## Atmosphere and rendering

| Area | Rating | Evidence |
|---|---|---|
| Time of day, sky, stars, night lighting | Met | `environment.js` |
| Clouds | Met | Raymarched volumetric cumulus with self-shadowing, forward scattering and fly-through (`volclouds.js`, e2e checks it on full detail). Cloud shadows fall on the terrain (`cloudshadow.js`). The RAIN/STORM overcast is a raymarched volume too on full detail (`weather.js` deck volume): a slab whose base and top are noise heightfields (ragged scud below, turrets above), Beer-Lambert light with the rest of the column above added analytically so the base stays dark, refine-on-hit marching so turret tops are not sliced into stripes, and a closed-layer rule so the deck stays solid to the horizon. You can fly up through it and out on top. The lite path keeps the shaded surfaces. Not done: the deck is one layer at a fixed base, with no multi-layer stratus, virga, or cloud that moves with the wind field. |
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
   remaining candidates are fully clickable study-level cockpits and autonomous
   AI traffic (more than one airliner, more than one active runway).
