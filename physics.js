/* Integrated motion: falling bodies and toppling tiles.
   Loaded as a classic script, so every top-level name here shares the one
   global scope with the other files — the split changes no semantics. */

const G = 320, REST = .08;                        // gravity (world units/s²) and the felt's low restitution
let drops = [], topples = [], simT = 0;

/* A dropped body. Falls under gravity from where it is to restY; any horizontal
   travel is spread across the fall so it arrives exactly as it lands, one parabola.
   `rot` (Euler target) turns linearly over that same fall, so a tossed tile is
   already flat when it meets the felt. Then it bounces — low, once or twice — and
   the wool takes it. */
function fall(m, { y, x = m.position.x, z = m.position.z, rot = null, delay = 0 } = {}) {
    const T = Math.sqrt(2 * Math.max(m.position.y - y, .001) / G);
    drops.push({
        m, restY: y, toX: x, toZ: z,
        vx: (x - m.position.x) / T, vz: (z - m.position.z) / T, vy: 0,
        rot, rot0: rot && m.rotation.clone(), T, t: 0, landed: false, wait: delay
    });
}

/* A rod toppling about its lower edge: α = (3g/2L)·sinθ. Starts at rest at vertical
   with a nudge, accelerates through the quarter turn, and slaps flat — no rebound,
   because it lands on its whole face, not an edge. Drives one axis of the pivot. */
function topple(pivot, axis, sign) {
    topples.push({ pivot, axis, sign, th: .001, w: 1.4, k: 1.5 * G / TILE_H });
}

function stepPhysics(dt) {
    for (let i = drops.length - 1; i >= 0; i--) {
        const b = drops[i];
        if (b.wait > 0) { b.wait -= dt; continue; }
        b.vy -= G * dt; b.t += dt;
        b.m.position.x += b.vx * dt; b.m.position.z += b.vz * dt; b.m.position.y += b.vy * dt;
        if (b.rot) {
            const k = Math.min(b.t / b.T, 1);
            b.m.rotation.set(
                b.rot0.x + (b.rot.x - b.rot0.x) * k,
                b.rot0.y + (b.rot.y - b.rot0.y) * k,
                b.rot0.z + (b.rot.z - b.rot0.z) * k);
        }
        if (b.m.position.y <= b.restY && b.vy < 0) {
            b.m.position.y = b.restY;
            if (!b.landed) { b.landed = true; b.m.position.x = b.toX; b.m.position.z = b.toZ; b.vx = b.vz = 0; if (b.rot) b.m.rotation.copy(b.rot); }
            if (-b.vy > 14) b.vy = -b.vy * REST; else drops.splice(i, 1);
        }
    }
    for (let i = topples.length - 1; i >= 0; i--) {
        const b = topples[i];
        b.w += b.k * Math.sin(b.th) * dt; b.th += b.w * dt;
        if (b.th >= Math.PI / 2) { b.th = Math.PI / 2; topples.splice(i, 1); }
        b.pivot.rotation[b.axis] = b.sign * b.th;
    }
}
