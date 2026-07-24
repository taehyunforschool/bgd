/* Inference engine and the AI's decision rules. Reads state, writes none.
   Loaded as a classic script, so every top-level name here shares the one
   global scope with the other files — the split changes no semantics. */

/* ── inference engine ───────────────────────────────────────── */
/* knownKeys(x) = cards seat x can see. knownKeys(null) = public knowledge. */
const knownKeys = observer => new Set(allTiles
    .filter(t => t.userData.owner && (t.userData.isRevealed || t.userData.owner === observer))
    .map(t => keyOf(t.userData)));

/* Enumerate every arrangement of `owner`'s hand consistent with the ordering
   rule, its revealed tiles and `known`; return the count plus a per-slot
   value→count map — an exact posterior over each hidden tile.
   A slot's candidates therefore depend on its neighbours, not just its bounds:
   two slots that both look like {5,6} resolve to 5 then 6.
   Measured worst case on a fresh deal: ~6k arrangements, ~2ms. */
function analyse(owner, known) {
    const hand = hands[owner];
    const pool = { black: [], white: [] };
    for (const color of ['black', 'white'])
        for (let value = -1; value <= 11; value++)
            if (!known.has(keyOf({ color, value }))) pool[color].push(value);

    const counts = hand.map(() => new Map());
    const used = new Set(), pick = [];
    let total = 0;

    (function dfs(i, lo) {
        if (i === hand.length) {
            total++;
            pick.forEach((v, s) => v !== null && counts[s].set(v, (counts[s].get(v) || 0) + 1));
            return;
        }
        const u = hand[i].userData;
        if (u.isRevealed) {                            // also enforces the upper bound
            if (u.value === -1) { pick[i] = null; dfs(i + 1, lo); }
            else if (rank(u) > lo) { pick[i] = null; dfs(i + 1, rank(u)); }
            return;
        }
        for (const value of pool[u.color]) {
            const card = { color: u.color, value }, k = keyOf(card);
            if (used.has(k)) continue;
            const joker = value === -1, r = rank(card);
            if (!joker && r <= lo) continue;           // must out-rank the tile on its left
            used.add(k); pick[i] = value;
            dfs(i + 1, joker ? lo : r);                // a joker carries no bound
            used.delete(k);
        }
        pick[i] = null;
    })(0, RANK_LO);

    return { total, counts };
}

/* Read the whole table at once, propagating certainties: a slot with exactly one
   feasible value is provably that card, so no other hand can hold it. Iterate to
   fixpoint — this is what turns a 50/50 into a solved tile. */
function readTable(observer) {
    const base = knownKeys(observer), locked = new Map(), reports = {};
    const seats = others(observer);
    for (let pass = 0; pass < 3; pass++) {
        seats.forEach(p => {
            const known = new Set(base);
            locked.forEach((o, k) => o !== p && known.add(k));   // proven elsewhere ⇒ not here
            reports[p] = analyse(p, known);
        });
        let progress = false;
        seats.forEach(p => {
            const { total, counts } = reports[p];
            if (!total) return;
            hands[p].forEach((t, i) => {
                if (t.userData.isRevealed || counts[i].size !== 1) return;
                const k = keyOf({ color: t.userData.color, value: counts[i].keys().next().value });
                if (!locked.has(k)) { locked.set(k, p); progress = true; }
            });
        });
        if (!progress) break;
    }
    return reports;
}


/* Best guess on the table = highest posterior, nudged toward a kill: finishing a
   player removes a guesser, so a slightly worse shot at their last tile is worth it. */
function bestGuess(who) {
    const reports = readTable(who);
    let out = null;
    PLAYERS.forEach(p => {
        const r = reports[p];
        if (!r || !r.total) return;
        const bonus = hidden(p).length === 1 ? .15 : 0;
        hands[p].forEach((t, i) => {
            if (t.userData.isRevealed) return;
            r.counts[i].forEach((n, value) => {
                const prob = n / r.total, score = prob + bonus;
                if (!out || score > out.score) out = { tile: t, value, prob, score };
            });
        });
    });
    return out;
}

/* Forced to expose a tile: leak as little as possible. Score each option by how
   many arrangements of this hand still survive in public view afterwards — more
   surviving ambiguity means the table learns less. Falls out naturally that end
   tiles beat interior ones, and that dumping a joker early is expensive. */
function safestReveal(who) {
    const pub = knownKeys(null);
    let best = null, most = -1;
    for (const t of hidden(who)) {
        t.userData.isRevealed = true;
        const { total } = analyse(who, new Set(pub).add(keyOf(t.userData)));
        t.userData.isRevealed = false;
        if (total > most) { most = total; best = t; }
    }
    return best;
}

/* Press on only when the next shot beats the cost of a miss (one of your own
   tiles). Fewer tiles in hand ⇒ a miss hurts more ⇒ demand a better shot.
   One opponent tile left means a hit wins outright, so take long odds. */
const pressBar = who => {
    const n = hidden(who).length;
    return opponentTiles(who).length === 1 ? .34 : n <= 2 ? .8 : n <= 4 ? .6 : .45;
};
