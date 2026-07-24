/* Constants, scene, game flow, input. The parts that share mutable state.
   Loaded as a classic script, so every top-level name here shares the one
   global scope with the other files — the split changes no semantics. */

/* ── seat table: every per-owner branch in the app derives from this ──
   ax   spread axis          fx   fixed axis
   dir  +1 if slot 0 sits on the negative side of the spread axis, -1 if mirrored.
        A hand always runs low→high from ITS OWNER'S left, so seats facing the
        opposite way read right→left from the camera.
   flip pivot rotation [axis, sign] used when a tile is turned face-up.
   Everything else — which way a seat faces, where its marker lands — follows from
   the sign of its fixed-axis coordinate. */
const SEATS = {
    p1: { name: 'South',   angle: 0,          x: 0,   z: 14,  ax: 'x', fx: 'z', dir:  1, flip: ['x', -1] },
    p2: { name: 'West',  angle: -Math.PI/2, x: -19, z: 0,   ax: 'z', fx: 'x', dir:  1, flip: ['z', -1] },
    p3: { name: 'North', angle: Math.PI,    x: 0,   z: -14, ax: 'x', fx: 'z', dir: -1, flip: ['x',  1] },
    p4: { name: 'East',  angle: Math.PI/2,  x: 19,  z: 0,   ax: 'z', fx: 'x', dir: -1, flip: ['z',  1] }
};
const PLAYERS = Object.keys(SEATS);               // turn order = seating order: South → West → North → East
const SPACING = 3, HALF_D = .3, TILE_W = 2.1, TILE_H = 3.2, TILE_Y = 2.3, DECK_GAP = 2.5;
const HAND = 6, LIFT_Z = SEATS.p1.z + 1, MARK_GAP = 3.5, MARK_R = 1.3;
const BASE_FOV = 40, BASE_ASPECT = 1.5, MAX_FOV = 78, DRAG_PX = 6;
const SWING = Math.PI / 7;        // how far the seat lets you lean, either way
const RANK_LO = -1;                               // sentinel just below the lowest rank (0)
const GOLD = '#c08b3e', RED = '#a8322a';

/* table dimensions, in world units — the felt is an oval because a six-tile
   hand needs more room across than the room between seats allows. */
const FELT_R = 20, FELT_SX = 1.25, FELT_SZ = .95;
const HALF_X = FELT_R * FELT_SX, HALF_Z = FELT_R * FELT_SZ;
const LAMP_Y = 27, SHADE_R = 5.4, RAIL_R = 21.6, BEAM_R = 21.5;
const INK = '214,178,106';        // the one brass every mark on the felt is struck in

const $ = id => document.getElementById(id);
const rnd = n => Math.random() * n | 0;
const shuffle = a => a.sort(() => Math.random() - .5);
const rank = ({ value, color }) => value * 2 + (color === 'black' ? 0 : 1);   // joker → negative
const keyOf = ({ color, value }) => color + '_' + value;
const slotX = i => (i - (HAND - 1) / 2) * SPACING;
const deckX = i => i * DECK_GAP - DECK_GAP / 2;   // the two spare tiles, printed and dealt from here
const dpr = () => Math.min(devicePixelRatio * 2, 3);

let scene, camera, renderer, controls, marker, dust;
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -LIFT_Z);

let allTiles = [], tileByKey = {}, pivots = [], hands = {};
let phase = 'setup', turn = 0, uiOpen = false, target = null, gen = 0;
let drag = null, dragging = false, pressTimer = null, pressId = null, pressX = 0, pressY = 0, toastTimer = null;

/* ── helpers ────────────────────────────────────────────────── */
const hidden = o => hands[o].filter(t => !t.userData.isRevealed);
const isOut = o => !hidden(o).length;
const others = of => PLAYERS.filter(p => p !== of && !isOut(p));

/* Every deferred game-flow step goes through later(). newGame() bumps `gen`,
   which invalidates the whole pending chain — no per-callback phase guards. */
const later = (fn, ms) => { const g = gen; setTimeout(() => g === gen && fn(), ms); };

function toast(msg, ms = 2600, alert = false) {
    const el = $('toast');
    clearTimeout(toastTimer);
    if (!msg) { el.style.display = 'none'; return; }
    el.innerText = msg;
    el.classList.toggle('alert', alert);
    el.style.display = 'block';
    if (ms) toastTimer = setTimeout(() => el.style.display = 'none', ms);
}
const openModal = id => { uiOpen = true; $(id).style.display = 'flex'; requestAnimationFrame(() => $(id).classList.add('active')); };
const closeModal = (id, done) => {
    $(id).classList.remove('active');
    setTimeout(() => { $(id).style.display = 'none'; uiOpen = false; done && done(); }, 400);
};
const tween = (o, to, ms, ease) => new TWEEN.Tween(o).to(to, ms).easing(ease || TWEEN.Easing.Cubic.Out).start();

/* Two kinds of motion share this table, and they are not the same physics.

   A hand PLACES the standing tiles, sets a lifted one back, combs the row into
   order: a controlled motion that decelerates to a dead stop. That is an ease-out,
   and it must not overshoot — a standing tile that bounces would topple. TWEEN
   handles these, below, with PLACE and SLIDE.

   Gravity DROPS the two spare tiles and the marker, and TOPPLES a revealed tile.
   Those are not eased — they are integrated. A dropped weight accelerates, lands,
   and gives one low bounce (ivory and clay on wool have little restitution); a
   toppling tile is a rod pivoting on its bottom edge, held back by inertia near
   vertical and whipping down as its mass passes the edge. Neither is a curve you
   can pick from a menu, so the loop steps them by hand. */
const E = TWEEN.Easing;
const PLACE = E.Quartic.Out;                      // a hand setting a piece down: firm, exact, no overshoot
const SLIDE = E.Cubic.Out;                        // a piece pushed across felt, friction bringing it up short

/* jokers (negative rank) slot in at random; numbers run low→high, black before white */
function ordered(list, get = x => x) {
    const out = list.filter(x => rank(get(x)) >= 0).sort((a, b) => rank(get(a)) - rank(get(b)));
    list.filter(x => rank(get(x)) < 0).forEach(j => out.splice(rnd(out.length + 1), 0, j));
    return out;
}

function buildTiles() {
    const geo = new THREE.BoxGeometry(TILE_W, TILE_H, HALF_D * 2);
    for (const color of ['black', 'white']) {
        const dark = color === 'black';
        const stock = tex(cv(4, 4), 1, 1);                  // the four sawn edges
        const sc = stock.image.getContext('2d');
        sc.fillStyle = dark ? '#100d0b' : '#e8ddc6'; sc.fillRect(0, 0, 4, 4);
        stock.needsUpdate = true;

        /* Both are dielectrics finished by hand, and the finish is the whole
           difference: ebony is French-polished to a lacquer film — a clearcoat,
           near-mirror — while ivory is buffed with wax, which is a weak, broad
           sheen over a much rougher body. Paper and glass is what you get if you
           give one no clearcoat and the other a hard one.

           Emissive rests at 0. It only exists so a lifted tile reads as lifted;
           left standing at .5 it made ebony emit 10.7x its own albedo — a warm
           brown lamp in the shape of a tile, which can never go dark, never take
           a terminator, and never look like wood. Nothing in a room like this
           glows. The light comes off the shade above. */
        const finish = extra => new THREE.MeshPhysicalMaterial(Object.assign({
            metalness: 0,
            roughness: dark ? .3 : .5,
            clearcoat: dark ? 1 : .35,
            clearcoatRoughness: dark ? .1 : .38,
            emissive: new THREE.Color(0x2a1e10),
            emissiveIntensity: 0
        }, extra));

        const side = finish({ map: stock });
        const cut = ({ face, bump }) =>
            finish({ map: tex(face), bumpMap: tex(bump, 1, 1, false), bumpScale: .035 });

        /* One back per colour, not per tile: the figure is random, so a back drawn
           per tile would be a fingerprint, and the whole game rests on backs being
           indistinguishable. BoxGeometry orders its faces +x -x +y -y +z -z, so 4
           is the face and 5 is the back. */
        const back = cut(tileFaces(null, color));
        for (let value = -1; value <= 11; value++) {
            const faceMat = cut(tileFaces(value, color));
            const m = new THREE.Mesh(geo, [side, side, side, side, faceMat, back]);
            m.castShadow = m.receiveShadow = true;
            m.userData = { value, color, owner: null, slot: -1, isRevealed: false, homeZ: 0 };
            allTiles.push(m);
            tileByKey[keyOf(m.userData)] = m;
            scene.add(m);
        }
    }
}

/* ── the markers ── one per value the player can call: 0-11 and the joker.
   All thirteen share the clay body and the brass inlay; only the number struck on
   the face differs, so the body/edge/inlay are built once and the face material is
   swapped per value. */
let markerFace, markerSolids, markerSpotRing, markerPulse = null, markerFaceMats = {};

function markerFaceTex(v) {
    const c = cv(256, 256), x = c.getContext('2d');
    x.fillStyle = '#c9a13a'; x.fillRect(0, 0, 256, 256);
    x.strokeStyle = 'rgba(60,40,8,.5)'; x.lineWidth = 3;
    x.beginPath(); x.arc(128, 128, 108, 0, 7); x.stroke();
    x.fillStyle = '#3a2a08';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    if (v !== null) {                              // null = a blank marker, before a value is called
        if (v === -1) x.fillRect(128 - 46, 118 - 11, 92, 22);   // joker: a struck bar, like the tiles
        else { x.font = `700 118px 'Bodoni Moda', serif`; x.fillText(String(v), 128, 122); }
    }
    x.font = `600 24px 'Barlow Semi Condensed', sans-serif`;
    x.fillText('TABLE VII', 128, 214);
    return tex(c);
}

/* The preview spot echoes the dotted marker circle already printed on the felt —
   same brass, same dashed language — drawn as a texture on a flat quad so it reads
   as one more printed mark, not a solid UI ring. Alpha carries the dots; RGB is the
   brass everywhere, so it composites clean over the baize (same reason the felt
   print is built that way). */
function buildSpotRing() {
    const S = 256, c = cv(S, S), x = c.getContext('2d');
    x.strokeStyle = '#fff';                        // white on transparent → alpha-only, tinted by the mesh
    x.lineWidth = 7; x.lineCap = 'round';
    x.setLineDash([5, 11]);
    x.beginPath(); x.arc(S / 2, S / 2, S / 2.1, 0, Math.PI * 2); x.stroke();
    const [r, gr, b] = INK.split(',').map(Number);
    const ring = new THREE.Mesh(
        new THREE.PlaneGeometry(MARK_R * 2.1, MARK_R * 2.1),
        new THREE.MeshBasicMaterial({
            map: tex(c), color: new THREE.Color(r / 255, gr / 255, b / 255),
            transparent: true, opacity: 0, depthWrite: false
        })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = .72;                         // just above the printed layout, flat on the felt
    ring.visible = false;
    return ring;
}

function buildMarker() {
    const g = new THREE.Group();
    const clay = cv(256, 256), q = clay.getContext('2d');
    q.fillStyle = '#6d0f14'; q.fillRect(0, 0, 256, 256);
    grain(q, 256, 256, 26);
    g.add(new THREE.Mesh(
        new THREE.CylinderGeometry(MARK_R, MARK_R, .26, 64),
        new THREE.MeshStandardMaterial({ map: tex(clay, 3, 3), roughness: .86, metalness: .02 })
    ));
    const sGeo = new THREE.BoxGeometry(.34, .27, .12);
    const sMat = new THREE.MeshStandardMaterial({ color: 0xf3ece0, roughness: .7 });
    for (let i = 0; i < 12; i++) {
        const s = new THREE.Mesh(sGeo, sMat), a = i / 12 * Math.PI * 2;
        s.position.set(Math.cos(a) * (MARK_R - .06), 0, Math.sin(a) * (MARK_R - .06));
        s.lookAt(0, 0, 0);
        g.add(s);
    }
    const inlay = new THREE.Mesh(
        new THREE.CylinderGeometry(.82, .82, .06, 48),
        new THREE.MeshStandardMaterial({ color: 0xc7972f, metalness: 1, roughness: .26 })
    );
    inlay.position.y = .135;
    g.add(inlay);

    for (let v = -1; v <= 11; v++)
        markerFaceMats[v] = new THREE.MeshStandardMaterial({ map: markerFaceTex(v), metalness: .85, roughness: .3 });
    markerFaceMats.blank = new THREE.MeshStandardMaterial({ map: markerFaceTex(null), metalness: .85, roughness: .3 });
    markerFace = new THREE.Mesh(new THREE.CircleGeometry(.72, 48), markerFaceMats.blank);
    markerFace.rotation.x = -Math.PI / 2; markerFace.position.y = .17;
    g.add(markerFace);

    markerSolids = [...g.children];
    g.traverse(o => o.isMesh && (o.castShadow = true));
    g.visible = false;
    return g;
}

/* Set the value shown, and whether the marker is a translucent preview (where it
   WILL sit, while the player is still choosing) or the solid, committed piece. */
function setMarker(v) { markerFace.material = markerFaceMats[v]; }

/* Lands just past the tile as its owner sees it — i.e. one step further from
   that seat, which is the centre side of the table — with the legend turned to
   read upright for the seat under fire. `angle` already means "faces this seat":
   it is what orients the tiles themselves. */
/* markerSpot: the x,z a marker rests at for a tile — one source, so the preview
   and the dropped piece can never disagree. */
function markerSpot(t) {
    const cfg = SEATS[t.userData.owner], d = -Math.sign(cfg[cfg.fx]) * MARK_GAP;
    return { x: t.position.x + (cfg.fx === 'x' ? d : 0), z: t.position.z + (cfg.fx === 'z' ? d : 0), angle: cfg.angle };
}

/* Preview: sits translucent exactly where it will end up, showing the value called
   so far. It does not fall until the value is committed. */
function previewMarker(t) {                        // the printed spot, pulsing where the piece will land
    const p = markerSpot(t);
    marker.visible = false;                        // no piece yet — only the marked spot
    markerSpotRing.position.set(p.x, .72, p.z);
    markerSpotRing.visible = true;
    const m = markerSpotRing.material;
    m.opacity = 0;
    // ink in, then breathe: brighten and dim on a slow loop while the player decides
    tween(m, { opacity: .8 }, 380, E.Cubic.Out).onComplete(() => {
        markerPulse = new TWEEN.Tween(m).to({ opacity: 0 }, 900).easing(E.Sinusoidal.InOut)
            .yoyo(true).repeat(Infinity).start();
    });
}

/* Drop: the value is locked, so the marker turns solid and falls onto the spot. */
function dropMarker(t, v) {
    const p = markerSpot(t);
    if (markerPulse) { markerPulse.stop(); markerPulse = null; }
    markerSpotRing.visible = false;
    marker.position.set(p.x, 10, p.z);
    marker.rotation.y = p.angle;
    setMarker(v);
    marker.visible = true;
    fall(marker, { y: .8 });
}

function hideMarker() {
    if (markerPulse) { markerPulse.stop(); markerPulse = null; }
    markerSpotRing.visible = false;
    if (marker.visible) tween(marker.position, { y: -2 }, 260, E.Quadratic.In).onComplete(() => marker.visible = false);
}

/* ── the room ── */
function fitCamera() {
    const a = camera.aspect = innerWidth / innerHeight;
    const hFov = 2 * Math.atan(Math.tan(BASE_FOV * Math.PI / 360) * BASE_ASPECT);
    camera.fov = a < BASE_ASPECT ? Math.min(MAX_FOV, 2 * Math.atan(Math.tan(hFov / 2) / a) * 180 / Math.PI) : BASE_FOV;
    camera.updateProjectionMatrix();
}

function buildTable() {
    const g = new THREE.Group();

    const felt = new THREE.Mesh(
        new THREE.CylinderGeometry(FELT_R, FELT_R * .995, 1.5, 96),
        new THREE.MeshStandardMaterial({ map: tex(baizeCanvas(), 8, 8), roughness: .97, metalness: 0 })
    );
    felt.scale.set(FELT_SX, 1, FELT_SZ);
    felt.position.y = -.05;
    felt.castShadow = felt.receiveShadow = true;
    g.add(felt);

    const print = new THREE.Mesh(
        new THREE.PlaneGeometry(HALF_X * 2, HALF_Z * 2),
        new THREE.MeshStandardMaterial({
            map: printTexture(), transparent: true, roughness: .95, metalness: 0,
            depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2
        })
    );
    print.rotation.x = -Math.PI / 2;
    print.receiveShadow = true;
    print.position.y = .71;
    g.add(print);

    const wood = woodCanvas();
    const trim = new THREE.Mesh(
        new THREE.TorusGeometry(20.5, .55, 12, 120),
        new THREE.MeshStandardMaterial({ map: tex(wood, 1, 60), roughness: .28, metalness: .06 })
    );
    trim.rotation.x = Math.PI / 2;
    trim.scale.set(FELT_SX, FELT_SZ, 1);
    trim.position.y = .5;
    trim.castShadow = trim.receiveShadow = true;
    g.add(trim);

    const rail = new THREE.Mesh(
        new THREE.TorusGeometry(RAIL_R, 1.7, 20, 140),
        new THREE.MeshStandardMaterial({ map: tex(leatherCanvas(), 14, 2), roughness: .58, metalness: .04 })
    );
    rail.rotation.x = Math.PI / 2;
    rail.scale.set(FELT_SX, FELT_SZ, 1);
    rail.position.y = -.05;
    rail.castShadow = rail.receiveShadow = true;
    g.add(rail);

    const skirt = new THREE.Mesh(
        new THREE.CylinderGeometry(21.4, 20.2, 5.4, 96, 1, true),
        new THREE.MeshStandardMaterial({ map: tex(wood, 40, 1), roughness: .3, metalness: .05, side: THREE.DoubleSide })
    );
    skirt.scale.set(FELT_SX, 1, FELT_SZ);
    skirt.castShadow = true;
    skirt.position.y = -3.4;
    g.add(skirt);

    // a brass name plaque set into the rail at every seat — same stock, four names
    const brass = new THREE.MeshStandardMaterial({ color: 0x9a742f, metalness: 1, roughness: .38 });
    const plaqueGeo = new THREE.BoxGeometry(5.4, .16, 1.3);
    for (const cfg of Object.values(SEATS)) {
        const c = cv(512, 128), x = c.getContext('2d');
        const grad = x.createLinearGradient(0, 0, 0, 128);
        grad.addColorStop(0, '#e0c07a'); grad.addColorStop(.5, '#8e6a2c'); grad.addColorStop(1, '#c9a556');
        x.fillStyle = grad; x.fillRect(0, 0, 512, 128);
        grain(x, 512, 128, 10);
        x.fillStyle = 'rgba(255,244,214,.5)';
        x.font = `600 52px 'Barlow Semi Condensed', sans-serif`; x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillText(cfg.name.toUpperCase().split('').join(' '), 256, 68);
        x.fillStyle = '#3a2a0e';
        x.fillText(cfg.name.toUpperCase().split('').join(' '), 256, 65);

        const top = new THREE.MeshStandardMaterial({ map: tex(c), metalness: .95, roughness: .32 });
        const p = new THREE.Mesh(plaqueGeo, [brass, brass, top, brass, brass, brass]);
        const r = RAIL_R * (cfg.fx === 'x' ? FELT_SX : FELT_SZ);
        p.position.set(cfg.fx === 'x' ? Math.sign(cfg.x) * r : 0, 1.62, cfg.fx === 'z' ? Math.sign(cfg.z) * r : 0);
        p.rotation.y = cfg.angle;
        p.castShadow = true;
        g.add(p);
    }
    return g;
}

/* the pendant: the whole room is only lit because this thing is hanging there */
function buildLamp() {
    const g = new THREE.Group();
    const brass = new THREE.MeshStandardMaterial({ color: 0xb08535, metalness: 1, roughness: .3 });

    const rod = new THREE.Mesh(new THREE.CylinderGeometry(.13, .13, 22, 12), brass);
    rod.position.y = LAMP_Y + 11;
    g.add(rod);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(.5, 20, 12), brass);
    cap.position.y = LAMP_Y + 3.4;
    g.add(cap);

    const shade = new THREE.Mesh(
        new THREE.CylinderGeometry(1.5, SHADE_R, 3.4, 64, 1, true),
        new THREE.MeshStandardMaterial({ color: 0x1b1209, metalness: .7, roughness: .5, side: THREE.FrontSide })
    );
    shade.position.y = LAMP_Y + 1.5;
    g.add(shade);
    const liner = new THREE.Mesh(
        new THREE.CylinderGeometry(1.44, SHADE_R - .06, 3.36, 64, 1, true),
        new THREE.MeshBasicMaterial({ color: 0xffd79a, side: THREE.BackSide })
    );
    liner.position.y = LAMP_Y + 1.5;
    g.add(liner);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(.62, 20, 16), new THREE.MeshBasicMaterial({ color: 0xfff3d8 }));
    bulb.position.y = LAMP_Y + .5;
    g.add(bulb);

    // the beam, fading out before it reaches the felt
    const fall = cv(4, 128), fc = fall.getContext('2d');
    const fg = fc.createLinearGradient(0, 0, 0, 128);
    fg.addColorStop(0, '#fff'); fg.addColorStop(.62, '#7a7a7a'); fg.addColorStop(1, '#000');
    fc.fillStyle = fg; fc.fillRect(0, 0, 4, 128);
    const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(SHADE_R - .6, BEAM_R, LAMP_Y, 56, 1, true),
        new THREE.MeshBasicMaterial({
            color: 0xffca82, transparent: true, opacity: .07,
            alphaMap: new THREE.CanvasTexture(fall),
            side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending
        })
    );
    beam.position.y = LAMP_Y / 2;
    g.add(beam);

    // dust, because a room like this always has some
    const N = 420, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        const y = Math.random() * LAMP_Y, r = (SHADE_R + (BEAM_R - SHADE_R) * (1 - y / LAMP_Y)) * Math.sqrt(Math.random());
        const a = Math.random() * Math.PI * 2;
        pos.set([Math.cos(a) * r, y, Math.sin(a) * r], i * 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    /* No mipmaps. A 64px sprite drawn into a ~2.6px quad sits at LOD ≈ 4.6, so a
       mipmapped sample returns the 2×2 level — the mean of the whole gradient,
       alpha ≈ .14 instead of 1 at the core, which is invisible once multiplied by
       opacity. Mipmapping guards against aliasing from high-frequency content;
       a radial ramp has none, so undersampling it costs nothing and filtering it
       destroys the very falloff the sprite exists for. */
    const spark = tex(dustCanvas());
    spark.generateMipmaps = false;
    spark.minFilter = THREE.LinearFilter;
    spark.wrapS = spark.wrapT = THREE.ClampToEdgeWrapping;
    dust = new THREE.Points(geo, new THREE.PointsMaterial({
        map: spark,
        color: 0xffdba8, size: .075, transparent: true, opacity: .45,
        depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true
    }));
    g.add(dust);
    return g;
}

function buildScene() {
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x080503, .012);

    camera = new THREE.PerspectiveCamera(BASE_FOV, 1, .1, 400);
    camera.position.set(0, 16, 42);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(innerWidth, innerHeight);
    /* antialias:true is MSAA, and MSAA only ever touches geometry edges: the
       fragment shader runs once however many coverage samples it lands on, so
       every specular highlight — 26 near-mirror tiles carrying bump maps, brass
       at metalness 1 — aliases straight through it. The only cure is to shade
       more often than the display asks for and let the browser resolve it down.
       2x the device grid is a full supersample: four shaded samples per pixel the
       display can actually show. The ceiling of 3 is where this stops paying —
       a 3x phone is already finer than the eye resolves, so doubling it again
       would buy nothing and cost four times the fill. */
    renderer.setPixelRatio(dpr());
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    $('webgl-container').append(renderer.domElement);
    fitCamera();

    const envTex = new THREE.CanvasTexture(envCanvas());
    envTex.mapping = THREE.EquirectangularReflectionMapping;
    envTex.encoding = THREE.sRGBEncoding;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    scene.environment = pmrem.fromEquirectangular(envTex).texture;
    envTex.dispose(); pmrem.dispose();

    /* The shade is a foot wide, so its shadow has a penumbra that widens as it
       falls. A single point source cannot produce one — it gives a hard radial
       smear, and shadow.radius is ignored under PCFSoftShadowMap, so asking for
       softness there does nothing. Sample the shade with three lights at a third
       of the power: their umbrae coincide at the tile's foot and separate as the
       shadow runs out, which is what a penumbra is. Each depth range is clamped
       to the lamp-to-floor slab — the default far of 500 is what was eating the
       precision and causing the acne and the detached contact. */
    const RIG = 3, SAMPLE_R = 1.7;
    for (let i = 0; i < RIG; i++) {
        const a = i / RIG * Math.PI * 2;
        const l = new THREE.SpotLight(0xffd8a0, 3.6 / RIG, 95, Math.PI / 4.1, .55, 1);
        l.position.set(Math.cos(a) * SAMPLE_R, LAMP_Y - 1.5, Math.sin(a) * SAMPLE_R);
        l.target.position.set(l.position.x, 0, l.position.z);     // keep the cones vertical
        l.castShadow = true;
        l.shadow.mapSize.set(1024, 1024);
        l.shadow.camera.near = 12;
        l.shadow.camera.far = 46;                                 // lamp → floor, nothing beyond
        l.shadow.bias = -.0004;
        l.shadow.normalBias = .03;
        scene.add(l, l.target);
    }

    /* Fill is the room itself (scene.environment) plus what the baize kicks back.
       Anything stronger and the shadows stop reading as shadows. */
    const bounce = new THREE.PointLight(0x3f7357, .3, 44);
    bounce.position.set(0, 2.6, 0);
    scene.add(new THREE.AmbientLight(0x171208, .55), bounce);

    const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(400, 400),
        new THREE.MeshStandardMaterial({ map: tex(carpetCanvas(), 34, 34), roughness: .95, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -6.2;
    floor.receiveShadow = true;
    scene.add(floor, buildTable(), buildLamp(), marker = buildMarker(), markerSpotRing = buildSpotRing());

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    Object.assign(controls, {
        enableDamping: true, enablePan: false, enableZoom: false,
        minPolarAngle: Math.PI / 4, maxPolarAngle: Math.PI / 2.3,
        minAzimuthAngle: -SWING, maxAzimuthAngle: SWING
    });
    controls.target.set(0, 1, 0);
}

function bindInput() {
    renderer.domElement.addEventListener('pointerdown', onDown);
    addEventListener('pointermove', onMove);
    ['pointerup', 'pointercancel', 'blur'].forEach(e => addEventListener(e, onUp));
    addEventListener('resize', () => {
        fitCamera();
        renderer.setPixelRatio(dpr());               // may have moved to another display
        renderer.setSize(innerWidth, innerHeight);
    });

    $('btn-new').onclick = newGame;
    $('btn-sort').onclick = alignAssets;
    $('btn-lock').onclick = lockConfiguration;
    $('btn-cancel').onclick = closeGuess;
    $('btn-again').onclick = () => closeModal('result-popup', newGame);
    $('btn-continue').onclick = () => closeModal('continue-popup', () => toast('Pick another tile'));
    $('btn-pass').onclick = () => closeModal('continue-popup', endTurn);
}

const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
function loop(t) {
    requestAnimationFrame(loop);
    TWEEN.update(t);
    const dt = Math.min((t - simT) / 1000, .04);      // clamp so a backgrounded tab can't tunnel
    simT = t;
    if (dt > 0) stepPhysics(dt);
    if (dust && !calm) { dust.rotation.y = t * 4e-5; dust.position.y = Math.sin(t * 3e-4) * .5; }
    controls.update();
    renderer.render(scene, camera);
}

/* ── flow ───────────────────────────────────────────────────── */
const PHASE_UI = {
    setup:   () => ['Setup Phase', GOLD],
    play:    () => PLAYERS[turn] === 'p1' ? ['Your Move', RED] : [SEATS[PLAYERS[turn]].name + ' Is Thinking', GOLD],
    penalty: () => ['Forfeit A Tile', RED],
    over:    () => ['Table Closed', GOLD]
};
function updatePhase() {
    const [text, color] = PHASE_UI[phase](), el = $('phase-indicator');
    el.innerText = text;
    el.style.color = color;
    syncLedger();
}

/* Reads live state only — how many tiles each seat still holds face-down, and
   who is to act. Nothing here feeds back into the game. */
function syncLedger() {
    $('seat-rows').innerHTML = PLAYERS.map(p => {
        const held = hidden(p).length;
        const cls = isOut(p) ? 'dead' : (phase !== 'setup' && PLAYERS[turn] === p ? 'live' : '');
        const pips = [...Array(HAND)].map((_, i) => `<i class="pip${i < held ? ' held' : ''}"></i>`).join('');
        return `<div class="seat ${cls}"><span class="who">${SEATS[p].name}</span><span class="pips">${pips}</span></div>`;
    }).join('');
}

/* pure: 'victory' | 'defeat' | null (still running) */
function outcome() {
    const alive = PLAYERS.filter(p => !isOut(p));
    if (isOut('p1')) return 'defeat';
    return alive.length <= 1 ? (alive[0] === 'p1' ? 'victory' : 'defeat') : null;
}
function finish() {
    const r = outcome();
    if (!r) return false;
    phase = 'over';
    hideMarker(); toast(''); updatePhase();
    const el = $('result-text');
    el.innerText = r.toUpperCase();
    el.style.color = r === 'victory' ? '#6d4b1c' : RED;
    openModal('result-popup');
    return true;
}

function endTurn() {
    if (finish()) return;
    for (let i = 1; i <= PLAYERS.length; i++) {
        const n = (turn + i) % PLAYERS.length;
        if (!isOut(PLAYERS[n])) { turn = n; break; }
    }
    phase = 'play';
    updatePhase();
    const p = PLAYERS[turn];
    p === 'p1' ? toast('Pick an opponent tile to decrypt') : later(() => aiTurn(p), 1100);
}

const opponentTiles = of => others(of).flatMap(hidden);

/* ── AI ─────────────────────────────────────────────────────── */
function aiTurn(who, g = bestGuess(who)) {
    if (!g) return endTurn();
    const u = g.tile.userData;
    dropMarker(g.tile, g.value);
    toast(`${SEATS[who].name} → ${SEATS[u.owner].name} #${u.slot + 1} : "${g.value === -1 ? '-' : g.value}" (${Math.round(g.prob * 100)}%)`);

    later(() => {
        hideMarker();
        if (u.value !== g.value) {
            reveal(safestReveal(who));
            toast(SEATS[who].name + ' misses — reveals own tile', 2600, true);
            return later(endTurn, 1000);
        }
        reveal(g.tile);
        toast(SEATS[who].name + ' hits');
        later(() => {
            if (finish()) return;
            const nxt = opponentTiles(who).length && bestGuess(who);
            nxt && nxt.prob >= pressBar(who) ? aiTurn(who, nxt) : endTurn();
        }, 1000);
    }, 1500);
}

function guessValue(v) {
    if (!target) return;
    const t = target;
    const hit = t.userData.value === v;
    dropMarker(t, v);                              // the called value, now solid, falls onto the spot
    closeModal('guess-popup', () => target = null);
    later(() => {                                 // the same beat the AI holds after dropping its marker
        if (!hit) {
            hideMarker();
            phase = 'penalty';
            updatePhase();
            toast('Miss — reveal one of your own tiles', 0, true);
            return;
        }
        reveal(t);
        toast('Hit');
        hideMarker();                            // the call landed — retire the marker
        later(() => {
            if (finish()) return;
            opponentTiles('p1').length ? openModal('continue-popup') : endTurn();
        }, 900);
    }, 1500);
}

function reveal(tile) {
    const u = tile.userData;
    if (u.isRevealed) return;
    u.isRevealed = true;

    const cfg = SEATS[u.owner], side = cfg.fx === 'x', s = Math.sign(cfg[cfg.fx]);
    const pivot = new THREE.Object3D();
    pivot.position.set(
        side ? cfg.x - s * HALF_D : tile.position.x,
        .7,
        side ? tile.position.z : cfg.z - s * HALF_D
    );
    pivot.rotation.y = side ? 0 : cfg.angle;
    scene.add(pivot);
    pivots.push(pivot);

    if (side) { tile.position.set(s * HALF_D, 1.6, 0); tile.rotation.set(0, cfg.angle, 0); }
    else { tile.position.set(0, 1.6, HALF_D); tile.rotation.set(0, 0, 0); }
    pivot.add(tile);

    pivot.rotation[cfg.flip[0]] = 0;               // the pendulum drives it from here
    topple(pivot, cfg.flip[0], cfg.flip[1]);       // rod on its edge: slow off vertical, whips flat, slaps down
    syncLedger();
}

/* ── guess UI ───────────────────────────────────────────────── */
function buildGuessGrid() {
    const grid = $('guess-grid');
    [...Array(12).keys(), -1].forEach(v => {
        const b = document.createElement('button');
        b.className = 'guess-btn' + (v < 0 ? ' joker-btn' : '');
        b.textContent = v < 0 ? '\u2014' : v;
        b.dataset.val = v;
        b.onclick = e => { e.currentTarget.blur(); guessValue(v); };
        grid.append(b);
    });
}
function openGuess(t) {
    const u = t.userData;
    const feasible = analyse(u.owner, knownKeys('p1')).counts[u.slot];
    $('guess-sub').innerText = `${SEATS[u.owner].name} · Slot ${u.slot + 1} · ${u.color.toUpperCase()}`;
    document.querySelectorAll('.guess-btn').forEach(b => {
        b.blur();
        b.classList.toggle('dimmed', !feasible.has(+b.dataset.val));
    });
    previewMarker(t);                              // blank translucent piece waiting at its spot
    openModal('guess-popup');
}
const closeGuess = () => { hideMarker(); closeModal('guess-popup', () => target = null); };  // cancel: preview vanishes

/* ── input ──────────────────────────────────────────────────── */
function pick(e) {
    ptr.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    return ray.intersectObjects(allTiles.filter(t => t.userData.owner))[0]?.object;
}

/* Lifting a tile lights the whole piece, not just its face. Its side and back
   materials are shared by every tile of its colour, so glowing them in place would
   light all of them; instead the lifted tile is given its own clones while held,
   and the shared originals are restored when it is set down. */
function glow(m, on) {
    if (on && !m.userData.shared) {
        m.userData.shared = m.material;                 // remember the shared array
        m.material = m.material.map(mat => { const c = mat.clone(); c.emissiveIntensity = 1.2; return c; });
    } else if (!on && m.userData.shared) {
        m.material.forEach(mat => mat.dispose());        // the clones are ours to free
        m.material = m.userData.shared;
        m.userData.shared = null;
    }
}

/* one handler per phase — the only place tile clicks branch */
const ON_TILE = {
    setup(t) {
        if (t.userData.owner !== 'p1') return;
        pressTimer = setTimeout(() => {
            drag = t; dragging = true; controls.enabled = false;
            glow(drag, true);
            tween(drag.position, { y: 2.5, z: LIFT_Z }, 170, E.Quartic.Out);   // picked up sharply
        }, 200);
    },
    play(t) {
        const u = t.userData;
        if (target || PLAYERS[turn] !== 'p1' || u.owner === 'p1' || u.owner === 'deck' || u.isRevealed) return;
        target = t;                                // set first — a second tap this frame now bails on `target`
        openGuess(t);                              // also seeds the preview at the spot
    },
    penalty(t) {
        const u = t.userData;
        if (u.owner !== 'p1' || u.isRevealed) return;
        phase = 'play';                            // exit penalty at once — the 900ms handoff below is
        reveal(t);                                 // too late, a fast second tap would forfeit two tiles
        toast('');
        later(endTurn, 900);
    }
};

function onDown(e) {
    if (uiOpen || phase === 'over') return;
    pressId = e.pointerId; pressX = e.clientX; pressY = e.clientY;
    const t = pick(e);
    if (t) ON_TILE[phase](t);
}

function onMove(e) {
    if (pressId !== null && e.pointerId !== pressId) return;
    if (!dragging) {
        if (pressTimer && Math.hypot(e.clientX - pressX, e.clientY - pressY) > DRAG_PX) {
            clearTimeout(pressTimer); pressTimer = null;
        }
        return;
    }
    const p = new THREE.Vector3();
    ptr.set(e.clientX / innerWidth * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    if (!ray.ray.intersectPlane(dragPlane, p)) return;
    drag.position.set(p.x, 2.5, LIFT_Z);

    [...hands.p1].sort((a, b) => a.position.x - b.position.x).forEach((m, i) => {
        if (m !== drag) m.position.x += (slotX(i) - m.position.x) * .2;
    });
}

function onUp() {
    clearTimeout(pressTimer); pressTimer = null; pressId = null;
    if (dragging && drag) {
        glow(drag, false);
        hands.p1.sort((a, b) => a.position.x - b.position.x);
        hands.p1.forEach((m, i) => tween(m.position, { x: slotX(i), y: TILE_Y, z: m.userData.homeZ }, 240, PLACE));
    }
    dragging = false; drag = null; controls.enabled = true;
}

/* ── setup actions ──────────────────────────────────────────── */
function alignAssets() {
    if (phase !== 'setup') return;
    hands.p1 = ordered(hands.p1, t => t.userData);
    /* Each tile shoved to its place and stopped by friction — the near ones settle
       first, so the row combs into order rather than snapping to it in unison. */
    hands.p1.forEach((m, i) => tween(m.position, { x: slotX(i) }, 520 + Math.abs(slotX(i) - m.position.x) * 26, SLIDE));
}

function lockConfiguration() {
    if (phase !== 'setup') return;
    const nums = hands.p1.filter(t => rank(t.userData) >= 0);
    if (nums.some((t, i) => i && rank(t.userData) < rank(nums[i - 1].userData)))
        return toast('Numbers must run low to high, black before white', 2600, true);

    hands.p1.forEach((t, i) => t.userData.slot = i);
    turn = 0; phase = 'play';
    $('btn-sort').classList.add('hidden');
    $('btn-lock').classList.add('hidden');
    updatePhase();
    toast('Pick an opponent tile to decrypt');
}

function newGame() {
    gen++;                                  // invalidates every pending later()
    TWEEN.removeAll();
    drops = []; topples = [];
    pivots.forEach(p => scene.remove(p));
    pivots = [];

    phase = 'setup'; turn = 0;
    dragging = uiOpen = false;
    drag = target = null;
    controls.enabled = true;
    clearTimeout(pressTimer); pressTimer = null;
    hideMarker(); toast('');
    ['guess-popup', 'continue-popup', 'result-popup'].forEach(id => {
        $(id).classList.remove('active'); $(id).style.display = 'none';
    });
    $('btn-sort').classList.remove('hidden');
    $('btn-lock').classList.remove('hidden');

    allTiles.forEach(m => {
        scene.add(m);                       // re-parents out of any reveal pivot
        m.rotation.set(0, 0, 0);
        glow(m, false);                     // restore shared materials if a tile was mid-lift
        Object.assign(m.userData, { owner: null, slot: -1, isRevealed: false });
    });
    hands = Object.fromEntries(PLAYERS.map(p => [p, []]));

    const deck = {};
    ['black', 'white'].forEach(color =>
        deck[color] = shuffle([...Array(12).keys(), -1].map(value => ({ color, value }))));

    PLAYERS.forEach(id => {
        const cfg = SEATS[id];
        const cards = [...deck.black.splice(0, 3), ...deck.white.splice(0, 3)];
        (id === 'p1' ? shuffle(cards) : ordered(cards)).forEach((card, i) => {
            const m = tileByKey[keyOf(card)];
            Object.assign(m.userData, { owner: id, slot: i, homeZ: cfg.z });
            m.position.set(0, 15, 0);
            m.rotation.set(0, cfg.angle, 0);
            hands[id].push(m);
            const off = slotX(i) * cfg.dir;
            const tx = cfg.ax === 'x' ? off : cfg.x, tz = cfg.ax === 'x' ? cfg.z : off;
            // placed standing, one tile at a time — a firm hand, decelerating to rest
            new TWEEN.Tween(m.position).to({ x: tx, y: TILE_Y, z: tz }, 440)
                .delay(i * 95).easing(PLACE).start();
        });
    });

    [deck.black.shift(), deck.white.shift()].forEach((card, i) => {
        const m = tileByKey[keyOf(card)];
        Object.assign(m.userData, { owner: 'deck', isRevealed: true });
        m.position.set(0, 15, 0);
        m.rotation.set(0, 0, 0);
        // tossed to the centre, turning flat on the way down — one parabola, one low bounce
        fall(m, { y: 1, x: deckX(i), z: 0, rot: new THREE.Euler(Math.PI / 2, 0, 0), delay: .12 + i * .11 });
    });

    updatePhase();
}

/* ── boot ───────────────────────────────────────────────────── */
const boot = () => { buildScene(); buildTiles(); buildGuessGrid(); bindInput(); newGame(); loop(); };
document.fonts?.ready.then(boot).catch(boot) ?? boot();
