/* Canvas painters. Nothing is downloaded; every surface is drawn here.
   Loaded as a classic script, so every top-level name here shares the one
   global scope with the other files — the split changes no semantics. */

/* ── drawn materials: nothing is downloaded, every surface is painted ── */
const cv = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h });

function grain(x, w, h, amount, alpha = 1) {
    const img = x.getImageData(0, 0, w, h), d = img.data;
    for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() - .5) * amount;
        d[i] += n; d[i + 1] += n; d[i + 2] += n;
        if (alpha < 1) d[i + 3] *= alpha;
    }
    x.putImageData(img, 0, 0);
}
const tex = (canvas, rx = 1, ry = 1, srgb = true) => {
    const t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(rx, ry);
    if (srgb) t.encoding = THREE.sRGBEncoding;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return t;
};

/* wool baize: a fine directional nap, seen tiling under the lamp */
function baizeCanvas() {
    const S = 512, c = cv(S, S), x = c.getContext('2d');
    x.fillStyle = '#14372c'; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 9000; i++) {                       // felt fibres
        const a = Math.random() * Math.PI;
        x.strokeStyle = `rgba(${Math.random() < .5 ? '210,235,220' : '4,18,12'},${.02 + Math.random() * .05})`;
        x.lineWidth = .7;
        const px = Math.random() * S, py = Math.random() * S, l = 2 + Math.random() * 5;
        x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l); x.stroke();
    }
    grain(x, S, S, 12);
    return c;
}

/* the layout printed on the felt — drawn as a top-down map, north up.
   The plane's UVs make canvas +x = world +x and canvas +y = world +z. */
function layoutCanvas() {
    const PX = 40, W = HALF_X * 2 * PX, H = HALF_Z * 2 * PX;
    const c = cv(W, H), x = c.getContext('2d');
    const X = wx => (wx + HALF_X) * PX, Z = wz => (wz + HALF_Z) * PX;
    const ell = (rx, rz) => { x.beginPath(); x.ellipse(W / 2, H / 2, rx * PX, rz * PX, 0, 0, 7); };

    x.clearRect(0, 0, W, H);
    x.lineJoin = 'round';
    x.lineCap = 'butt';
    /* Every mark on the felt is struck in one brass; only its weight changes.
       printTexture() below leans on that. */
    const ink = a => `rgba(${INK},${a})`;
    const HAIRLINE = ink(.3);                     // the grid: where tiles live
    const MARKER   = ink(.16);                    // laid on top of it, so it speaks quieter
    const LW = 1.7, LW_M = 1.4;

    /* The hinge is centred on its own line, so its stroke splits .85/.85 across two
       texel rows and never reaches full coverage — it lands ~15% lighter than the
       grown cell edges beside it, which end flush on a texel. Compensate on alpha,
       not on width: an even 2px width would cover both rows fully, but full
       coverage means zero partial coverage, and partial coverage is what is
       anti-aliasing these lines. This texture is never sampled 1:1 — it sits on a
       plane raked ~45° and minified — so crispness in texture space buys nothing
       and costs the pre-filtering that keeps the print from shimmering. */
    const HINGE = ink(.35);                       // .3 ÷ .85 — same peak as a grown edge

    /* A canvas stroke straddles its path, so a line drawn on an object's edge
       ends up half underneath it. Every outline below is grown by half its own
       width, which puts the line's INNER edge exactly on the object and all of
       the ink outside — the fit is to the tile, not to the centre of the line. */
    const fit = ([px, py, pw, ph], lw) => [px - lw / 2, py - lw / 2, pw + lw, ph + lw];

    // house rings, sized to clear the outermost tile cell corners at |offset| 8.55
    const RING_X = 23.4, RING_Z = 16.8;
    x.strokeStyle = ink(.34); x.lineWidth = 2.5; ell(RING_X + .7, RING_Z + .7); x.stroke();
    x.strokeStyle = ink(.16); x.lineWidth = 1;   ell(RING_X, RING_Z); x.stroke();

    // centre rosette: where the two spare tiles land
    x.strokeStyle = ink(.3); x.lineWidth = 1.4;
    x.textAlign = 'center'; x.textBaseline = 'middle';
    ell(4.6, 4.6); x.stroke();
    ell(4.1, 4.1); x.stroke();

    /* The two spare tiles are dealt face-up to the centre, turned a quarter over,
       so each lies 2.1 across by 3.2 deep at x = ±1.25. */
    x.strokeStyle = HAIRLINE; x.lineWidth = LW;
    x.beginPath();
    for (let i = 0; i < 2; i++)
        x.rect(...fit([X(deckX(i) - TILE_W / 2), Z(-TILE_H / 2), TILE_W * PX, TILE_H * PX], LW));
    x.stroke();

    // house name sits in the open field between the rosette and the far cells
    x.fillStyle = ink(.44);
    x.font = `700 ${1.5 * PX}px 'Bodoni Moda', serif`;
    x.fillText('BGD PRÉSENTE', W / 2, Z(-7.4));

    // limits, printed to read from this side of the table
    x.fillStyle = ink(.4);
    x.font = `500 ${.8 * PX}px 'Barlow Semi Condensed', sans-serif`;
    x.fillText('ÇA PASSE OU ÇA CASSE', W / 2, Z(15.4));

    /* Six cells per seat, straight off the mesh. reveal() hinges a tile about its
       inner bottom edge, so the box it lands in and the strip it stands on share
       that edge exactly — the print is the same geometry the game already uses. */
    for (const cfg of Object.values(SEATS)) {
        const f = cfg.fx, s = Math.sign(cfg[f]);
        const hinge = cfg[f] - s * HALF_D;                 // the axis reveal() turns the tile about
        const cell = (o, from, to) => {                    // world span → canvas rect
            const [b0, b1] = from < to ? [from, to] : [to, from];
            return f === 'z'
                ? [X(o - TILE_W / 2), Z(b0), TILE_W * PX, (b1 - b0) * PX]
                : [X(b0), Z(o - TILE_W / 2), (b1 - b0) * PX, TILE_W * PX];
        };
        /* One path per seat, one stroke. Two abutting strokeRects would lay the
           shared hinge edge down twice and composite it to ~.51 alpha against
           the .3 of every other line; within a single stroke, overlap does not
           accumulate. So: outline the union of both cells, then draw the hinge
           across it once. */
        /* Two paths, stroked separately so the fold can carry its own alpha. They
           never overlap: the cell outlines sit entirely outside the tile, the fold
           runs exactly the tile's width, so the two only abut. */
        const grid = new Path2D(), fold = new Path2D();
        for (let i = 0; i < HAND; i++) {
            const o = slotX(i) * cfg.dir;
            grid.rect(...fit(cell(o, hinge + s * HALF_D * 2, hinge - s * TILE_H), LW));   // 2.1 × 3.8
            /* The hinge is the one line here that is not a boundary — it is the
               fold the tile turns about, with tile on either side of it in turn,
               so it stays centred rather than being grown to one side. */
            const [hx, hy, hw, hh] = cell(o, hinge, hinge);                   // zero span = the fold
            fold.moveTo(hx, hy); fold.lineTo(hx + hw, hy + hh);
        }
        x.lineWidth = LW;
        x.strokeStyle = HAIRLINE; x.stroke(grid);
        x.strokeStyle = HINGE;    x.stroke(fold);

        /* Where the marker drops for each tile — showMarker() offsets it by
           MARK_GAP along the seat's fixed axis, toward the centre.
           These cross the cells: a marker's centre lands exactly on a cell's outer
           edge, so half of every circle sits inside one. Two equal lines crossing
           read as a drafting error, so this is a different system and is drawn as
           one — dashed, thinner, and dimmer. The cells are structure; a marker spot
           is a note on top of them. */
        const d = -s * MARK_GAP;
        x.strokeStyle = MARKER;
        x.lineWidth = LW_M;
        x.lineCap = 'round';                   // what turns the dashes into dots
        x.setLineDash([.09 * PX, .17 * PX]);
        x.beginPath();
        for (let i = 0; i < HAND; i++) {
            const o = slotX(i) * cfg.dir;
            const cx = X(f === 'x' ? cfg.x + d : o), cz = Z(f === 'x' ? o : cfg.z + d);
            const r = MARK_R * PX + LW_M / 2;       // inner edge of the dots meets the marker
            x.moveTo(cx + r, cz);                  // start on the arc, or subpaths join up
            x.arc(cx, cz, r, 0, Math.PI * 2);
        }
        x.stroke();
        x.setLineDash([]);
        x.lineCap = 'butt';
    }
    return c;
}

/* A canvas stores premultiplied, so wherever alpha is 0 its RGB is gone — the
   field clearRect leaves behind is (0,0,0,0), not brass-at-zero. A mip then
   averages RGB and alpha apart, and every half-covered texel comes back as brass
   mixed toward black: one level down the hairlines are already ~33% too dark, and
   because the level changes as the camera moves, they crawl. That is the artefact,
   not a want of samples.
   Every mark here is the same brass, so hand the GPU a texture whose RGB is that
   brass everywhere and whose alpha alone carries the ink. Averaging alpha is then
   all a mip does, which is exactly right — and a canvas cannot express it, since
   it has no way to hold a colour at zero alpha. */
function printTexture() {
    const c = layoutCanvas(), W = c.width, H = c.height;
    const src = c.getContext('2d').getImageData(0, 0, W, H).data;
    const px = new Uint8Array(W * H * 4);
    const [r, g, b] = INK.split(',').map(Number);
    for (let y = 0; y < H; y++)
        for (let i = 0; i < W * 4; i += 4) {
            const to = y * W * 4 + i, from = (H - 1 - y) * W * 4 + i;   // DataTexture has no flipY
            px[to] = r; px[to + 1] = g; px[to + 2] = b;
            px[to + 3] = src[from + 3];
        }
    const t = new THREE.DataTexture(px, W, H, THREE.RGBAFormat);
    t.encoding = THREE.sRGBEncoding;
    t.magFilter = THREE.LinearFilter;                    // DataTexture defaults to Nearest
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    t.needsUpdate = true;
    return t;
}

/* oxblood leather: a pebbled rail you rest your arms on */
function leatherCanvas() {
    const S = 512, c = cv(S, S), x = c.getContext('2d');
    x.fillStyle = '#4e171a'; x.fillRect(0, 0, S, S);
    for (let i = 0; i < 2600; i++) {
        const r = 2 + Math.random() * 7;
        x.beginPath(); x.arc(Math.random() * S, Math.random() * S, r, 0, 7);
        x.fillStyle = `rgba(${Math.random() < .5 ? '150,70,60' : '26,6,7'},${.05 + Math.random() * .09})`;
        x.fill();
    }
    grain(x, S, S, 16);
    return c;
}

/* the loud carpet every gaming room has, turned right down in the dark */
function carpetCanvas() {
    const S = 256, c = cv(S, S), x = c.getContext('2d');
    x.fillStyle = '#180d0c'; x.fillRect(0, 0, S, S);
    x.strokeStyle = 'rgba(150,60,40,.16)'; x.lineWidth = 2;
    for (let i = 0; i < 4; i++)
        for (let j = 0; j < 4; j++) {
            x.beginPath();
            x.arc(i * 64 + 32, j * 64 + 32, 21, 0, 7);
            x.stroke();
            x.beginPath();
            x.arc(i * 64 + 32, j * 64 + 32, 9, 0, 7);
            x.stroke();
        }
    grain(x, S, S, 14);
    return c;
}

/* A bare PointsMaterial draws a filled square, so at two or three device pixels
   each mote is a hard-edged block that crawls as the camera moves — which is what
   reads as chunky, not the size itself. A soft radial sprite puts the bright core
   in a fraction of the quad, so a mote reads smaller than the space it occupies,
   and the far ones fade off instead of aliasing. */
function dustCanvas() {
    const S = 64, c = cv(S, S), x = c.getContext('2d');
    const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(.3, 'rgba(255,255,255,.26)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, S, S);
    return c;
}

/* walnut: quartersawn, so the figure is a fine straight stripe */
function woodCanvas() {
    const c = cv(8, 256), x = c.getContext('2d');
    x.fillStyle = '#2b1a10'; x.fillRect(0, 0, 8, 256);
    for (let i = 0; i < 90; i++) {
        x.fillStyle = `rgba(${Math.random() < .5 ? '90,58,32' : '14,8,4'},${.1 + Math.random() * .2})`;
        x.fillRect(0, Math.random() * 256, 8, .6 + Math.random() * 2);
    }
    return c;
}

/* The room these surfaces reflect. It is equirectangular: u = atan2(z,x)/2pi + .5,
   so u=.5 is the +x bearing, u=0 is -x, and the top row is straight up.

   Two things in here were lopsided, and the brass name plaques paid for it. They
   are metalness 1 — no diffuse at all — and they sit at |x| 27 while the lamp's
   cone only reaches 23, so the reflected room is the whole of what they are. A
   horizontal mirror shows you the FAR side, so West's plaque reflects the +x sky
   and East's reflects -x. Draw the pendant as a blob at u=.5 and you have hung it
   over East: West catches it, East reflects the dark half, and one plaque goes
   unreadable.

   The pendant is straight overhead. It has no bearing at all — it belongs across
   the whole sky, not at one of them. And the wall lamps are hung, not thrown: a
   room's lamps do not move, and rolling them re-lit the table on every reload. */
function envCanvas() {
    const W = 512, H = 256, c = cv(W, H), x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#3a2a17'); g.addColorStop(.16, '#2a1d10');
    g.addColorStop(.46, '#0a0705'); g.addColorStop(.72, '#120a06'); g.addColorStop(1, '#050302');
    x.fillStyle = g; x.fillRect(0, 0, W, H);

    const hot = x.createLinearGradient(0, 0, 0, 90);       // .432 keeps the ceiling's old total energy
    hot.addColorStop(0, 'rgba(255,240,208,.432)'); hot.addColorStop(1, 'rgba(255,240,208,0)');
    x.fillStyle = hot; x.fillRect(0, 0, W, 90);

    const LAMPS = 8;                                       // 8 divides the four seats evenly
    for (let i = 0; i < LAMPS; i++) {
        const px = (i + .5) / LAMPS * W;                   // the .5 keeps them off the seam at u=0
        const s = x.createRadialGradient(px, 118, 1, px, 118, 26);
        s.addColorStop(0, 'rgba(255,196,120,.5)'); s.addColorStop(1, 'rgba(255,196,120,0)');
        x.fillStyle = s; x.fillRect(px - 30, 88, 60, 60);
    }
    return c;
}

/* ── tiles: one cut from tusk, one from ebony ──
   Ivory is marked by Schreger lines — two families of arcs crossing at a shallow
   angle, spaced about half a millimetre. They are the assay for real tusk, and
   nothing else looks like them. Under them run fine longitudinal striations and
   the tusk's own soft banding. Ivory takes a waxy polish, never a glassy one, and
   light gets a little way into it before it comes back.
   Ebony here is Gaboon: so dense and close-grained it is very nearly featureless,
   near jet black, its whole character in a polish that goes to a mirror. What
   figure there is runs with the grain, with the odd open pore. */
function tileFaces(value, color) {
    const W = 320, H = 480, dark = color === 'black';
    const face = cv(W, H), f = face.getContext('2d');
    const bump = cv(W, H), b = bump.getContext('2d');
    const rr = (a, b2) => a + Math.random() * (b2 - a);
    f.lineCap = 'round';

    /* Ebony's figure, the tusk's banding and its striation are all one gesture: a
       line running the length of the grain, wandering as it goes. Only the count,
       the weight, the wander and the ink differ. `mid`/`end` are how far it strays
       at the control points and where it lands; `over` lets a stroke start off the
       edge, which is how the banding runs off the piece. */
    const streaks = (n, ink, { a, w, mid, end, over = 0 }) => {
        for (let i = 0; i < n; i++) {
            const x0 = rr(-over, W + over);
            f.strokeStyle = `rgba(${ink()},${rr(...a)})`;
            f.lineWidth = rr(...w);
            f.beginPath(); f.moveTo(x0, -10);
            f.bezierCurveTo(x0 + rr(-mid, mid), H / 3, x0 + rr(-mid, mid), H * 2 / 3, x0 + rr(-end, end), H + 10);
            f.stroke();
        }
    };
    const either = (p, q) => () => Math.random() < .5 ? p : q;

    if (dark) {
        f.fillStyle = '#0c0a08'; f.fillRect(0, 0, W, H);
        streaks(240, either('76,62,48', '0,0,0'), { a: [.04, .11], w: [.5, 2.1], mid: 5, end: 4 });
        for (let i = 0; i < 80; i++) {                     // open pores, drawn out along the grain
            f.fillStyle = `rgba(0,0,0,${rr(.3, .7)})`;
            f.beginPath(); f.ellipse(rr(0, W), rr(0, H), rr(.5, 1.3), rr(1.4, 4.4), 0, 0, 7); f.fill();
        }
    } else {
        f.fillStyle = '#f1e5cd'; f.fillRect(0, 0, W, H);
        streaks(7,   () => '198,170,116',                  { a: [.05, .1], w: [10, 34], mid: 14, end: 10, over: 20 });
        streaks(420, either('176,150,102', '255,252,240'), { a: [.03, .1], w: [.4, 1.1], mid: 3, end: 2 });
        /* Schreger: ~30° either side of horizontal, so the two families cross at
           about 60°, ruled every 8px — which on a 2.1-unit tile is the half
           millimetre the real thing measures. */
        f.lineWidth = .8;
        for (const dir of [1, -1]) {
            f.strokeStyle = 'rgba(146,114,62,.05)';
            for (let k = -H; k < H * 2; k += 8) {
                f.beginPath();
                f.moveTo(-10, k);
                f.quadraticCurveTo(W / 2, k + dir * W * .3, W + 10, k + dir * W * .58);
                f.stroke();
            }
        }
        const age = f.createRadialGradient(W / 2, H / 2, W * .2, W / 2, H / 2, W * .78);
        age.addColorStop(0, 'rgba(190,158,98,0)');         // handled edges yellow first
        age.addColorStop(1, 'rgba(190,158,98,.22)');
        f.fillStyle = age; f.fillRect(0, 0, W, H);
    }

    /* A bumpMap is read through screen-space derivatives, so what it encodes is
       the SLOPE of the height field, not the height. A step has no slope: dFdx of
       one is whatever the 2x2 quad happens to straddle, so it flips from quad to
       quad and crawls — and a clearcoat turns every bit of that into a highlight.
       Supersampling makes it worse, not better: a finer grid selects a lower mip,
       which sharpens the very steps that are the problem.
       So the height field is built out of ramps. A chamfer is a slope anyway. */
    b.fillStyle = '#808080'; b.fillRect(0, 0, W, H);
    const cham = 15;
    for (let k = 0; k < cham; k++) {                       // the arris falls away to the face
        const v = 40 + 88 * k / cham | 0;
        b.strokeStyle = `rgb(${v},${v},${v})`;
        b.lineWidth = 1;
        b.strokeRect(k + .5, k + .5, W - k * 2 - 1, H - k * 2 - 1);
    }

    /* value === null is a back: same stock, same chamfer, nothing cut into it.
       A back's whole job is to say one thing — black or white — and that is the
       information this game runs on. Anything else on it can only get in the way.
       Real ivory and ebony pieces are blank behind for the same reason; the device
       on a card back is there because cards are thin enough to read through, and
       a tile is not. */
    /* The mark is cut in and filled, the way these pieces are actually made:
       ebony takes an ivory inlay, ivory takes ink.
       The joker's bar is drawn, not typeset. Bodoni is a didone — fat verticals,
       hairline horizontals — so the digits read on their stems while a dash, which
       is nothing but a horizontal, comes out a 5px thread here and a half-pixel
       once the tile is on screen. Cut it as a bar instead, measured off the
       numerals it sits beside: a digit's stem for its weight, and a width that
       lands between the two extremes on the table — past a single numeral, well
       short of a pair like 10 or 11. */
    if (value !== null) {
        const glyph = String(value);
        const FONT = 220, DIGIT = FONT * .44;              // one numeral's ink width
        const BAR_W = DIGIT * 1.4, BAR_H = FONT * .145;    // a pair of digits runs ~.94em
        const setFont = ctx => { ctx.font = `600 ${FONT}px 'Bodoni Moda', serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; };
        const mark = (ctx, dy) => value === -1
            ? ctx.fillRect(W / 2 - BAR_W / 2, H / 2 + dy - BAR_H / 2, BAR_W, BAR_H)
            : ctx.fillText(glyph, W / 2, H / 2 + dy);
        setFont(f); setFont(b);
        /* The face is 83 CSS px on screen, so this 320px map is minified 3.8x and one
           screen pixel costs 3.8 map px. At 5 the lip was 1.3 of them — alive, but
           sitting on the floor, so the mip chain took most of its contrast and what
           survived moved with the level. At 10 it is 2.6, clear of the floor and
           stable. It is also the truer number: 10px of a 320px face across a 21mm
           tile is a .66mm cut, which is about what an inlaid numeral needs to hold
           its filling. The lip was too shallow to be a real engraving OR a resolvable
           one. */
        const LIP = 10;
        f.fillStyle = dark ? 'rgba(255,246,224,.13)' : 'rgba(255,255,255,.9)';
        mark(f, LIP);                                          // the cut's lower wall, catching the lamp
        f.fillStyle = dark ? '#e9dcc0' : '#191512';
        mark(f, 0);
        b.filter = 'blur(6px)';                                // an engraving has shoulders,
        b.fillStyle = '#2a2a2a'; mark(b, 0);                   // and a shoulder is a slope
        b.filter = 'none';
    }

    grain(f, W, H, dark ? 7 : 13);
    return { face, bump };
}
