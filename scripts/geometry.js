// Pure helpers for directional scans, jamming and swarms. No Foundry globals, so node can test them.

const TAU = Math.PI * 2;

// Foundry's token rotation is degrees clockwise from facing down (south). Our bearings are atan2(dy, dx) on the map.
export const facingAngle = (rotationDeg) => ((rotationDeg + 90) * Math.PI) / 180;

// Smallest absolute difference between two angles, 0..PI.
export function angleDiff(a, b) {
  const d = (((a - b) % TAU) + TAU) % TAU;
  return d > Math.PI ? TAU - d : d;
}

export const inArc = (bearing, facing, width) => angleDiff(bearing, facing) <= width / 2;

// Static: random error on distance (up to +-meters) and bearing (up to +-radians).
export function jamNoise({d, b}, meters = 6, radians = 0.35, rand = Math.random) {
  return {d: Math.max(0, d + (rand() * 2 - 1) * meters), b: b + (rand() * 2 - 1) * radians};
}

// Contacts of one swarm beyond `near` merge into one blip at their average position, with n = how many.
// Members within `near` stay separate. Contacts without a swarm pass through untouched.
export function mergeSwarms(contacts, near) {
  const out = [];
  const far = new Map();
  for (const c of contacts) {
    if (c.swarm && c.d > near) far.set(c.swarm, [...(far.get(c.swarm) ?? []), c]);
    else out.push(c);
  }
  for (const group of far.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const x = group.reduce((s, c) => s + Math.cos(c.b) * c.d, 0) / group.length;
    const y = group.reduce((s, c) => s + Math.sin(c.b) * c.d, 0) / group.length;
    const nearest = group.reduce((m, c) => (c.d < m.d ? c : m));
    out.push({...nearest, d: Math.hypot(x, y), b: Math.atan2(y, x), n: group.length});
  }
  return out.sort((a, b) => a.d - b.d);
}
