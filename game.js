/* Traversal — règles, génération de terrain, IA (recherche alpha-bêta + évaluation apprise).
   Fichier partagé : navigateur (window.Traversal), serveur Node (require) et Web Worker (bot local). */
(function (root, factory) {
  const T = factory();
  if (typeof module === 'object' && module.exports) module.exports = T;
  else root.Traversal = T;
  if (typeof window === 'undefined' && typeof importScripts === 'function') {
    self.onmessage = (e) => {
      const r = T.bestMove(e.data.state, e.data.opts);
      self.postMessage({ id: e.data.id, move: T.encodeMove(r.move), info: { score: r.score, depth: r.depth, nodes: r.nodes } });
    };
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const N = 10, NC = 100, MAX_PLY = 200, WIN = 50;
  const TYPES = {
    E: { name: 'Explorateur', mv: 5, f: 1 },
    A: { name: 'Avant-garde', mv: 4, f: 2 },
    S: { name: 'Sentinelle', mv: 3, f: 3 },
  };
  const LAYOUT = ['S', 'A', 'E', 'E', 'A', 'S']; // colonnes 2 à 7, symétrique
  const PT = [], OWN = [], MV = [], FO = [];
  for (let i = 0; i < 12; i++) {
    const t = LAYOUT[i % 6];
    PT.push(t); OWN.push(i < 6 ? 0 : 1); MV.push(TYPES[t].mv); FO.push(TYPES[t].f);
  }
  const MODES = {
    aleatoire: 'Aléatoire', montagnes: 'Montagnes', vallees: 'Vallées',
    hautes_terres: 'Hautes terres', bois: 'Bois', desert: 'Désert',
  };

  // Voisinages précalculés : orthogonaux, diagonales, bonds de 2
  const inb = (x, y) => x >= 0 && y >= 0 && x < N && y < N;
  const NB = [], DG = [], JP = [];
  for (let c = 0; c < NC; c++) {
    const x = c % N, y = (c / N) | 0, nb = [], dg = [], jp = [];
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (inb(x + dx, y + dy)) nb.push(c + dx + dy * N);
      if (inb(x + 2 * dx, y + 2 * dy)) jp.push(c + 2 * dx + 2 * dy * N);
    }
    for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) if (inb(x + dx, y + dy)) dg.push(c + dx + dy * N);
    NB.push(nb); DG.push(dg); JP.push(jp);
  }

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const stepCost = (h, a, b) => { const d = Math.abs(h[a] - h[b]); return d === 0 ? 1 : d + 1; };

  // ---------- Terrain ----------
  function genTerrain(mode, seed) {
    const R = rng(seed);
    function vnoise(scale) {
      const S = Math.ceil(N / scale) + 2, g = [];
      for (let i = 0; i < S * S; i++) g.push(R());
      return (x, y) => {
        const fx = x / scale, fy = y / scale, ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const a = g[iy * S + ix], b = g[iy * S + ix + 1], c = g[(iy + 1) * S + ix], d = g[(iy + 1) * S + ix + 1];
        return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
      };
    }
    const n1 = vnoise(3), n2 = vnoise(1.7), n3 = vnoise(4.5);
    const h = new Array(NC);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const cx = (x - 4.5) / 4.5, cy = (y - 4.5) / 4.5, r = Math.hypot(cx, cy);
      const a = n1(x, y), b = n2(x, y), c = n3(x, y);
      let v;
      switch (mode) {
        case 'montagnes': v = 7.5 * Math.max(0, 1 - r / 1.15) + 2.5 * a + b - 1.6; break;
        case 'vallees': { const ridge = 1 - Math.abs(2 * c - 1); v = 6.5 * ridge * ridge + 1.2 * b - 0.4; break; }
        case 'hautes_terres': v = 0.3 + 7 * Math.pow(a, 1.3) + 1.6 * (b - 0.5); break;
        case 'bois': v = 0.3 + 2.4 * a + 0.8 * (b - 0.5); break;
        case 'desert': v = 0.9 * a; break;
        default: v = 4.5 * a + 2 * b + 1.5 * c - 2;
      }
      h[y * N + x] = Math.max(0, Math.min(7, Math.round(v)));
    }
    if (mode === 'desert') {
      const k = 1 + Math.floor(R() * 2);
      for (let i = 0; i < k; i++) h[10 + Math.floor(R() * 35)] = 3 + Math.floor(R() * 3);
    }
    // Symétrie centrale : aucun camp n'est avantagé
    for (let i = 0; i < 50; i++) h[NC - 1 - i] = h[i];
    // Contrainte : deux cases voisines diffèrent d'au plus 2 (on relève les creux)
    let changed = true;
    while (changed) {
      changed = false;
      for (let c = 0; c < NC; c++) for (const d of NB[c]) if (h[d] < h[c] - 2) { h[d] = h[c] - 2; changed = true; }
    }
    return h;
  }

  // Coût terrain minimal jusqu'à la rangée d'arrivée, pour chaque camp
  function goalDist(h) {
    return [0, 1].map((side) => {
      const goal = side === 0 ? 0 : N - 1, d = new Int16Array(NC).fill(999), q = [];
      for (let x = 0; x < N; x++) { d[goal * N + x] = 0; q.push(goal * N + x); }
      while (q.length) {
        const u = q.shift();
        for (const v of NB[u]) { const nc = d[u] + stepCost(h, u, v); if (nc < d[v]) { d[v] = nc; q.push(v); } }
      }
      return d;
    });
  }

  // ---------- État ----------
  // Joueur 0 (rouge) : rangée du bas (y=9), sort par le haut (y=0). Joueur 1 (bleu) : l'inverse.
  function newGame(o) {
    o = o || {};
    const mode = MODES[o.mode] ? o.mode : 'aleatoire';
    const seed = o.seed != null ? o.seed >>> 0 : (Math.random() * 4294967296) >>> 0;
    const h = Int8Array.from(o.h || genTerrain(mode, seed));
    const s = {
      mode, seed, h, dist: goalDist(h), pos: new Int8Array(12), board: new Int8Array(NC).fill(-1),
      turn: 0, ply: 0, score: [0, 0], exits: 0, passes: 0, over: false, winner: -1, reason: '', last: null,
    };
    for (let i = 0; i < 6; i++) { s.pos[i] = 9 * N + 2 + i; s.pos[6 + i] = 7 - i; }
    for (let i = 0; i < 12; i++) s.board[s.pos[i]] = i;
    return s;
  }

  function clone(s) {
    return {
      mode: s.mode, seed: s.seed, h: s.h, dist: s.dist, pos: s.pos.slice(), board: s.board.slice(),
      turn: s.turn, ply: s.ply, score: s.score.slice(), exits: s.exits, passes: s.passes,
      over: s.over, winner: s.winner, reason: s.reason, last: s.last,
    };
  }

  // ---------- Combat ----------
  function strength(s, p, target, cost) {
    const def = s.board[target];
    let a = FO[p];
    const ha = s.h[s.pos[p]], hd = s.h[target];
    if (ha > hd) a++; else if (ha < hd) a--;
    if (PT[p] === 'A' && cost === 4) a++; // charge de l'Avant-garde
    let d = FO[def];
    for (const v of NB[target]) {
      const q = s.board[v];
      if (q < 0 || q === p || q === def) continue;
      if (OWN[q] === OWN[p]) a += FO[q]; // alliés de l'attaquant
      else d += 1; // renforts du défenseur
    }
    return [a, d];
  }

  // ---------- Génération des coups ----------
  const D = new Int16Array(NC), AC = new Int16Array(NC), BK = [[], [], [], [], [], []];
  function pieceMoves(s, p, out) {
    const c0 = s.pos[p];
    if (c0 < 0) return out;
    const me = OWN[p], M = MV[p], h = s.h, goal = me === 0 ? 0 : N - 1;
    D.fill(99); AC.fill(99);
    for (const b of BK) b.length = 0;
    D[c0] = 0; BK[0].push(c0);
    let exit = false;
    const atk = [];
    for (let k = 0; k <= M; k++) {
      const B = BK[k];
      for (let i = 0; i < B.length; i++) {
        const u = B[i];
        if (D[u] !== k) continue;
        if (u !== c0) out.push({ p, k: 'm', to: u, c: k });
        if (((u / N) | 0) === goal && k < M) exit = true;
        for (const v of NB[u]) {
          const nc = k + stepCost(h, u, v);
          if (nc > M) continue;
          const q = s.board[v];
          if (q >= 0) {
            if (OWN[q] !== me && nc < AC[v]) { if (AC[v] === 99) atk.push(v); AC[v] = nc; }
            continue;
          }
          if (nc < D[v]) { D[v] = nc; BK[nc].push(v); }
        }
      }
    }
    if (PT[p] === 'E') { // pas en diagonale ou bond de 2, sans coût de hauteur
      for (const list of [DG[c0], JP[c0]]) for (const v of list) {
        const q = s.board[v];
        if (q < 0) { if (D[v] > M) { out.push({ p, k: 'm', to: v, c: 0, sp: 1 }); D[v] = 0; } }
        else if (OWN[q] !== me && AC[v] === 99) { atk.push(v); AC[v] = 0; }
      }
    }
    for (const v of atk) {
      const [a, d] = strength(s, p, v, AC[v]);
      if (a >= d) out.push({ p, k: 'a', to: v, c: AC[v], a, d });
    }
    if (exit) out.push({ p, k: 'x' });
    return out;
  }

  function legalMoves(s) {
    if (s.over) return [];
    const out = [];
    for (let p = s.turn * 6; p < s.turn * 6 + 6; p++) pieceMoves(s, p, out);
    if (!out.length) out.push({ p: -1, k: 'p' });
    return out;
  }

  const encodeMove = (m) => (m ? (m.k === 'a' || m.k === 'm' ? [m.p, m.k, m.to] : [m.p, m.k]) : null);
  function findMove(s, a) {
    if (!Array.isArray(a)) return null;
    const [p, k, to] = a;
    return legalMoves(s).find((m) => m.k === k && (k === 'p' || (m.p === p && (k === 'x' || m.to === to)))) || null;
  }

  // ---------- Application d'un coup ----------
  function finish(s, w, why) { s.over = true; s.winner = w; s.reason = why; }
  function finishScore(s) {
    const [a, b] = s.score;
    finish(s, a > b ? 0 : b > a ? 1 : 2, `Deux pièces arrivées — score ${a} – ${b}`);
  }
  function finishLimit(s, why) {
    const [a, b] = s.score;
    if (a !== b) return finish(s, a > b ? 0 : 1, `${why} — score ${a} – ${b}`);
    const best = [0, 1].map((side) => {
      let r = 99, f = 0;
      for (let p = side * 6; p < side * 6 + 6; p++) {
        const c = s.pos[p];
        if (c < 0) continue;
        const y = (c / N) | 0, rows = side === 0 ? y : N - 1 - y;
        if (rows < r || (rows === r && FO[p] > f)) { r = rows; f = FO[p]; }
      }
      return { r, f };
    });
    const [x, y] = best;
    if (x.r !== y.r) return finish(s, x.r < y.r ? 0 : 1, `${why} — pièce la plus proche de l'arrivée`);
    if (x.f !== y.f) return finish(s, x.f > y.f ? 0 : 1, `${why} — pièce la plus forte`);
    finish(s, 2, `${why} — égalité parfaite`);
  }

  function applyMove(s, m) {
    const last = { p: m.p, k: m.k, from: m.p >= 0 ? s.pos[m.p] : -1, to: m.to == null ? -1 : m.to, cap: -1, side: s.turn };
    if (m.k === 'p') s.passes++;
    else {
      s.passes = 0;
      const p = m.p;
      s.board[s.pos[p]] = -1;
      if (m.k === 'x') {
        s.pos[p] = -2; s.score[OWN[p]] += FO[p]; s.exits++;
        if (s.exits === 1 && PT[p] === 'S') finish(s, OWN[p], 'La Sentinelle a franchi l\'arrivée en premier');
        else if (s.exits >= 2) finishScore(s);
      } else {
        if (m.k === 'a') { const d = s.board[m.to]; s.pos[d] = -1; last.cap = d; }
        s.board[m.to] = p; s.pos[p] = m.to;
      }
    }
    s.last = last; s.ply++; s.turn ^= 1;
    if (!s.over) {
      if (s.passes >= 2) finishLimit(s, 'Blocage');
      else if (s.ply >= MAX_PLY) finishLimit(s, 'Limite de 200 coups');
    }
    return s;
  }

  // ---------- Évaluation (poids appris par le serveur) ----------
  const FEAT = ['Matériel', 'Score', 'Course', 'Meilleure pièce', 'Menace Sentinelle', 'Hauteur', 'Cohésion',
    'Avantage au contact', 'Avance Explorateurs', 'Avance Avant-gardes', 'Avance Sentinelles', 'Trait'];
  const NF = FEAT.length;
  const W0 = [0.55, 1.1, 0.6, 0.9, 1.6, 0.06, 0.05, 0.08, 0.15, 0.3, 0.45, 0.12];

  function features(s, out) {
    out = out || new Float64Array(NF);
    out.fill(0);
    let b0 = 0, b1 = 0, s0 = 0, s1 = 0;
    for (let p = 0; p < 12; p++) {
      const c = s.pos[p];
      if (c < 0) continue;
      const me = OWN[p], sg = me === 0 ? 1 : -1, y = (c / N) | 0;
      const inv = 1 / Math.ceil((s.dist[me][c] + 1) / MV[p]); // 1 / (tours estimés pour sortir)
      out[0] += sg * FO[p];
      out[2] += sg * FO[p] * inv;
      if (me === 0) { if (inv > b0) b0 = inv; if (PT[p] === 'S' && inv > s0) s0 = inv; }
      else { if (inv > b1) b1 = inv; if (PT[p] === 'S' && inv > s1) s1 = inv; }
      out[5] += sg * s.h[c] / 4;
      out[PT[p] === 'E' ? 8 : PT[p] === 'A' ? 9 : 10] += sg * (me === 0 ? N - 1 - y : y) / (N - 1);
      for (const v of NB[c]) {
        const q = s.board[v];
        if (q < 0) continue;
        if (OWN[q] === me) out[6] += sg * 0.5;
        else out[7] += sg * (FO[p] + Math.sign(s.h[c] - s.h[v]) - FO[q]) / 2;
      }
    }
    out[1] = s.score[0] - s.score[1];
    out[3] = b0 - b1;
    if (s.exits === 0) out[4] = s0 - s1;
    out[11] = s.turn === 0 ? 1 : -1;
    return out;
  }

  const FB = new Float64Array(NF);
  function evaluate(s, w) { // point de vue du joueur 0
    if (s.over) return s.winner === 0 ? WIN : s.winner === 1 ? -WIN : 0;
    const f = features(s, FB);
    let e = 0;
    for (let i = 0; i < NF; i++) e += w[i] * f[i];
    return e;
  }

  // ---------- Recherche ----------
  const ZK = [], ZX = [];
  (function () {
    const R = rng(0xC0FFEE);
    for (let i = 0; i < 12 * NC; i++) ZK.push([(R() * 2097152) | 0, (R() * 4294967296) >>> 0]);
    for (let i = 0; i < 12; i++) ZX.push([(R() * 2097152) | 0, (R() * 4294967296) >>> 0]);
  })();
  function hashOf(s) {
    let a = s.turn ? 0x15555 : 0, b = s.turn ? 0x2468ace : 0;
    for (let p = 0; p < 12; p++) {
      const c = s.pos[p], z = c >= 0 ? ZK[p * NC + c] : c === -2 ? ZX[p] : null;
      if (z) { a ^= z[0]; b ^= z[1]; }
    }
    return a * 4294967296 + (b >>> 0);
  }
  function mscore(st, m, tb) {
    if (tb && m.p === tb.p && m.k === tb.k && m.to === tb.to) return 1e6;
    if (m.k === 'x') return 1e5 + FO[m.p];
    if (m.k === 'a') return 1e4 + FO[st.board[m.to]] * 100 - FO[m.p];
    if (m.k === 'p') return 0;
    const me = OWN[m.p];
    return (st.dist[me][st.pos[m.p]] - st.dist[me][m.to]) * 10 / MV[m.p];
  }

  function bestMove(s, o) {
    o = o || {};
    const w = o.weights || W0, deadline = Date.now() + (o.timeMs || 1000), maxD = o.maxDepth || 40, noise = o.noise || 0;
    const root = legalMoves(s);
    if (root.length <= 1) return { move: root[0] || null, score: 0, depth: 0, nodes: 0 };
    const TT = new Map(), STOP = new Error('stop');
    let nodes = 0;
    const sv = (st) => { const e = evaluate(st, w); return st.turn === 0 ? e : -e; };
    const term = (st, ply) => (st.winner === 2 ? 0 : st.winner === st.turn ? WIN - ply * 0.01 : -(WIN - ply * 0.01));
    const tick = () => { if ((++nodes & 511) === 0 && Date.now() > deadline) throw STOP; };
    const order = (st, ms, tb) => { for (const m of ms) m.o = mscore(st, m, tb); ms.sort((x, y) => y.o - x.o); };

    function qs(st, al, be, qd, ply) { // quiescence : captures et arrivées seulement
      tick();
      if (st.over) return term(st, ply);
      const stand = sv(st);
      if (qd <= 0 || stand >= be) return stand;
      if (stand > al) al = stand;
      const ms = legalMoves(st).filter((m) => m.k === 'a' || m.k === 'x');
      order(st, ms, null);
      for (const m of ms) {
        const c = applyMove(clone(st), m);
        const v = -qs(c, -be, -al, qd - 1, ply + 1);
        if (v >= be) return v;
        if (v > al) al = v;
      }
      return al;
    }
    function ab(st, d, al, be, ply) {
      if (st.over) return term(st, ply);
      if (d <= 0) return qs(st, al, be, 4, ply);
      tick();
      const key = hashOf(st), e = TT.get(key);
      if (e && e.d >= d) {
        if (e.f === 0) return e.v;
        if (e.f === 1 && e.v >= be) return e.v;
        if (e.f === 2 && e.v <= al) return e.v;
      }
      const ms = legalMoves(st);
      order(st, ms, e && e.m);
      const a0 = al;
      let best = -Infinity, bm = null;
      for (const m of ms) {
        const v = -ab(applyMove(clone(st), m), d - 1, -be, -al, ply + 1);
        if (v > best) { best = v; bm = m; }
        if (v > al) al = v;
        if (al >= be) break;
      }
      if (TT.size > 300000) TT.clear();
      TT.set(key, { d, v: best, f: best <= a0 ? 2 : best >= be ? 1 : 0, m: bm });
      return best;
    }

    order(s, root, null);
    const list = root.map((m) => ({ m, v: -Infinity }));
    let best = root[0], bestV = 0, depth = 0;
    try {
      for (let d = 1; d <= maxD; d++) {
        let al = -Infinity;
        for (const r of list) {
          r.v = -ab(applyMove(clone(s), r.m), d - 1, -Infinity, -(al - noise), 1);
          if (r.v > al) al = r.v;
        }
        list.sort((a, b) => b.v - a.v);
        depth = d; bestV = list[0].v;
        if (noise > 0) {
          const ok = list.filter((r) => r.v >= bestV - noise);
          best = ok[Math.floor(Math.random() * ok.length)].m;
        } else best = list[0].m;
        if (Math.abs(bestV) > WIN - 5 || Date.now() > deadline) break;
      }
    } catch (err) { if (err !== STOP) throw err; }
    return { move: best, score: bestV, depth, nodes };
  }

  // ---------- Apprentissage (utilisé par le serveur) ----------
  function makeRecord(s, moves, src, names) {
    return {
      v: 1, date: new Date().toISOString(), src, mode: s.mode, seed: s.seed, h: Array.from(s.h),
      moves, winner: s.winner, reason: s.reason, score: s.score.slice(), players: names || [],
    };
  }
  function replay(rec, cb) {
    if (!rec || !Array.isArray(rec.h) || rec.h.length !== NC || !Array.isArray(rec.moves) || rec.moves.length > MAX_PLY + 5) return null;
    const s = newGame({ h: rec.h, mode: rec.mode, seed: rec.seed });
    for (const a of rec.moves) {
      if (cb) cb(s);
      const m = findMove(s, a);
      if (!m) return null;
      applyMove(s, m);
    }
    return s;
  }
  function samplesFromGame(rec, maxN) {
    if (!rec || rec.winner < 0) return [];
    const y = rec.winner === 0 ? 1 : rec.winner === 1 ? 0 : 0.5, xs = [];
    replay(rec, (s) => { if (s.ply >= 2) xs.push(Array.from(features(s))); });
    for (let i = xs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [xs[i], xs[j]] = [xs[j], xs[i]]; }
    return xs.slice(0, maxN || 30).map((x) => ({ x, y }));
  }
  function train(samples, w, epochs, lr, l2) { // régression logistique (« Texel tuning »)
    w = w.slice(); epochs = epochs || 4; lr = lr || 0.005; l2 = l2 || 1e-4;
    for (let ep = 0; ep < epochs; ep++) {
      for (let i = samples.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [samples[i], samples[j]] = [samples[j], samples[i]]; }
      for (const { x, y } of samples) {
        let z = 0;
        for (let k = 0; k < NF; k++) z += w[k] * x[k];
        const g = 1 / (1 + Math.exp(-z)) - y;
        for (let k = 0; k < NF; k++) w[k] -= lr * (g * x[k] + l2 * w[k]);
      }
    }
    return w;
  }

  return {
    N, NC, MAX_PLY, TYPES, PT, OWN, MV, FO, MODES, NB, FEAT, W0,
    genTerrain, newGame, clone, legalMoves, pieceMoves, applyMove, findMove, encodeMove, strength,
    features, evaluate, bestMove, makeRecord, replay, samplesFromGame, train,
  };
});
