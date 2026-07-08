// Runway-relative coordinate frame. One definition shared by the flight-school
// geometry (pattern/takeoff/landing lessons) and the landing debrief card, so
// centerline math never drifts between the two.
//
// Body/world convention (see physics/flightModel.js header): heading 0 = +x,
// and +z is "right". A yaw of `h` about +y sends local +x -> (cos h, -sin h)
// and local +z -> (sin h, cos h) — that's `fwd`/`right` below.
//
// Takes a runway object ({ headingRad, spawn:{x,z} }); both maps' runway
// definitions supply these, so the frame is valid on either map.
export function runwayFrame(rwy) {
  const h = rwy.headingRad;
  const fwd = { x: Math.cos(h), z: -Math.sin(h) };
  const right = { x: Math.sin(h), z: Math.cos(h) };
  const ox = rwy.spawn.x, oz = rwy.spawn.z;
  return {
    fwd, right,
    // signed distance right of the extended centerline (metres)
    cross(pos) { return (pos.x - ox) * right.x + (pos.z - oz) * right.z; },
    // signed distance down the runway from the threshold/spawn (metres)
    along(pos) { return (pos.x - ox) * fwd.x + (pos.z - oz) * fwd.z; },
  };
}
