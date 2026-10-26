'use strict';
/* Traversal — serveur : pages, parties en ligne (WebSocket), Elo, bot classé, auto-entraînement en continu.
   Lancement : npm install && npm start  →  http://localhost:3000 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const T = require('./game.js');

const PORT = +process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const F_PLAYERS = path.join(DATA, 'players.json');
const F_GAMES = path.join(DATA, 'games.jsonl');
const F_BRAIN = path.join(DATA, 'brain.json');
const BOT_MS = +process.env.BOT_MS || 1500; // temps de réflexion du bot en partie classée
const DISCONNECT_MS = 60000;

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJSON = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };

if (isMainThread) main();
else if (workerData.role === 'trainer') trainer();
else botWorker();

// =====================================================================
function main() {
  const { WebSocketServer } = require('ws');
  fs.mkdirSync(DATA, { recursive: true });

  const players = readJSON(F_PLAYERS, {});
  const brain = readJSON(F_BRAIN, null) || { version: 1, weights: T.W0, ladder: 0, selfplay: 0, totalGames: 0, history: [] };
  if (!players.bot) players.bot = { id: 'bot', name: 'TraversalBot', elo: 1200, w: 0, l: 0, d: 0, bot: true };
  const tokens = new Map();
  for (const p of Object.values(players)) if (p.token) tokens.set(p.token, p);

  let tP = null, tB = null;
  const savePlayers = () => { clearTimeout(tP); tP = setTimeout(() => writeJSON(F_PLAYERS, players), 400); };
  const saveBrain = () => { clearTimeout(tB); tB = setTimeout(() => writeJSON(F_BRAIN, brain), 1000); };
  const appendGame = (rec) => { fs.appendFile(F_GAMES, JSON.stringify(rec) + '\n', () => {}); brain.totalGames++; saveBrain(); };
  const pub = (p) => ({ id: p.id, name: p.name, elo: p.elo, w: p.w, l: p.l, d: p.d, bot: !!p.bot });
  const cleanName = (n) => String(n || '').replace(/[^\p{L}\p{N} _\-.']/gu, '').trim().slice(0, 20);

  // ---------- Bot : un worker pour jouer, un worker pour s'entraîner ----------
  const botW = new Worker(__filename, { workerData: { role: 'bot' } });
  botW.on('message', ({ id, move }) => {
    const g = games.get(id);
    if (!g || g.s.over || g.pids[g.s.turn] !== 'bot') return;
    const m = T.findMove(g.s, move);
    if (m) play(g, m);
  });
  botW.on('error', (e) => console.error('[bot]', e));

  if (process.env.TRAIN !== '0') {
    const tw = new Worker(__filename, { workerData: { role: 'trainer', data: DATA, brain } });
    tw.on('message', (m) => {
      if (m.t === 'game') { appendGame(m.rec); if (m.rec.src === 'selfplay') brain.selfplay++; }
      else if (m.t === 'brain') {
        Object.assign(brain, { version: m.version, weights: m.weights, ladder: m.ladder });
        brain.history.push(m.hist); brain.history = brain.history.slice(-200);
        saveBrain();
        console.log(`[bot] nouvelle version v${m.version} (score ${(m.hist.score * 100).toFixed(0)} % contre l'ancienne)`);
      } else if (m.t === 'log') console.log('[bot]', m.msg);
    });
    tw.on('error', (e) => console.error('[entraînement]', e));
  }

  // ---------- HTTP ----------
  const STATIC = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/game.js': ['game.js', 'application/javascript'] };
  const json = (res, o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const st = STATIC[url.pathname];
    if (st && req.method === 'GET') {
      fs.readFile(path.join(__dirname, st[0]), (err, buf) => {
        if (err) { res.writeHead(500); return res.end(); }
        res.writeHead(200, { 'Content-Type': st[1] + '; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(buf);
      });
      return;
    }
    if (url.pathname === '/health') return json(res, { ok: true });
    if (url.pathname === '/api/leaderboard') {
      const list = Object.values(players).filter((p) => p.bot || p.w + p.l + p.d > 0).sort((a, b) => b.elo - a.elo).slice(0, 50).map(pub);
      return json(res, { players: list, online: online.size, playing: games.size });
    }
    if (url.pathname === '/api/brain') {
      return json(res, { version: brain.version, weights: brain.weights, ladder: brain.ladder, selfplay: brain.selfplay, totalGames: brain.totalGames, elo: players.bot.elo, features: T.FEAT });
    }
    if (url.pathname === '/api/game' && req.method === 'POST') { // parties locales envoyées pour l'entraînement
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
      req.on('end', () => {
        try {
          const rec = JSON.parse(body), s = T.replay(rec);
          if (!s || !s.over) return json(res, { ok: false }, 400);
          appendGame(T.makeRecord(s, rec.moves, 'local', (rec.players || []).slice(0, 2).map(cleanName)));
          json(res, { ok: true });
        } catch { json(res, { ok: false }, 400); }
      });
      return;
    }
    res.writeHead(404); res.end('404');
  });

  // ---------- Parties en ligne ----------
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 32 * 1024 });
  const online = new Map(); // id joueur -> ws
  const games = new Map(); // id partie -> partie
  const inGame = new Map(); // id joueur -> id partie
  const rooms = new Map(); // code -> { pid, mode }
  let queue = []; // { pid, mode }

  const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
  const broadcast = (g, o) => g.pids.forEach((pid) => send(online.get(pid), o));
  const leaveQueue = (pid) => {
    queue = queue.filter((q) => q.pid !== pid);
    for (const [code, r] of rooms) if (r.pid === pid) rooms.delete(code);
  };
  const shuffle = (a) => (Math.random() < 0.5 ? a : a.reverse());

  function startMsg(g, pid) {
    return {
      t: 'start', id: g.id, you: g.pids.indexOf(pid), mode: g.s.mode, seed: g.s.seed, h: Array.from(g.h0),
      moves: g.moves, rated: g.rated, players: g.pids.map((id) => pub(players[id])),
    };
  }
  function startGame(pids, mode, rated) {
    const s = T.newGame({ mode });
    const g = { id: crypto.randomBytes(5).toString('hex'), pids, rated, s, h0: s.h.slice(), moves: [], dc: {}, done: false };
    games.set(g.id, g);
    for (const pid of pids) if (pid !== 'bot') { leaveQueue(pid); inGame.set(pid, g.id); send(online.get(pid), startMsg(g, pid)); }
    afterMove(g);
  }
  function play(g, m) {
    T.applyMove(g.s, m);
    const enc = T.encodeMove(m);
    g.moves.push(enc);
    broadcast(g, { t: 'move', id: g.id, m: enc, ply: g.s.ply });
    afterMove(g);
  }
  function afterMove(g) {
    if (g.s.over) return finish(g);
    const ms = T.legalMoves(g.s);
    if (ms.length === 1 && ms[0].k === 'p') return setTimeout(() => !g.done && play(g, ms[0]), 400);
    if (g.pids[g.s.turn] === 'bot') {
      const ply = g.s.ply;
      setTimeout(() => { if (!g.done && g.s.ply === ply) botW.postMessage({ id: g.id, state: g.s, opts: { weights: brain.weights, timeMs: BOT_MS } }); }, 250);
    }
  }
  function finish(g, forcedWinner, why) {
    if (g.done) return;
    g.done = true;
    const s = g.s;
    if (forcedWinner !== undefined) { s.over = true; s.winner = forcedWinner; s.reason = why; }
    const ps = g.pids.map((id) => players[id]);
    let elo = null;
    if (g.rated) {
      const ea = 1 / (1 + Math.pow(10, (ps[1].elo - ps[0].elo) / 400));
      const sa = s.winner === 0 ? 1 : s.winner === 1 ? 0 : 0.5;
      const k = (p) => (p.w + p.l + p.d < 20 ? 40 : 24);
      const d0 = Math.round(k(ps[0]) * (sa - ea)), d1 = Math.round(k(ps[1]) * (ea - sa));
      ps[0].elo += d0; ps[1].elo += d1;
      elo = [{ delta: d0, elo: ps[0].elo }, { delta: d1, elo: ps[1].elo }];
    }
    ps.forEach((p, i) => { if (s.winner === 2) p.d++; else if (s.winner === i) p.w++; else p.l++; });
    savePlayers();
    if (g.moves.length >= 4) appendGame(Object.assign(T.makeRecord(s, g.moves, 'online', ps.map((p) => p.name)), { h: Array.from(g.h0), rated: g.rated }));
    broadcast(g, { t: 'end', id: g.id, winner: s.winner, reason: s.reason, score: s.score, elo, players: ps.map(pub) });
    for (const pid of g.pids) { inGame.delete(pid); clearTimeout(g.dc[pid]); }
    games.delete(g.id);
  }

  function handle(ws, m) {
    if (m.t === 'hello') {
      let p = typeof m.token === 'string' && tokens.get(m.token);
      if (!p) {
        const id = crypto.randomBytes(6).toString('hex');
        p = { id, token: crypto.randomBytes(18).toString('hex'), name: cleanName(m.name) || 'Joueur-' + id.slice(0, 4), elo: 1200, w: 0, l: 0, d: 0, created: Date.now() };
        players[id] = p; tokens.set(p.token, p); savePlayers();
      } else if (cleanName(m.name)) { p.name = cleanName(m.name); savePlayers(); }
      const old = online.get(p.id);
      if (old && old !== ws) { old.pid = null; old.close(); }
      ws.pid = p.id; online.set(p.id, ws);
      send(ws, { t: 'welcome', token: p.token, me: pub(p) });
      const g = games.get(inGame.get(p.id));
      if (g) {
        clearTimeout(g.dc[p.id]);
        send(ws, startMsg(g, p.id));
        broadcast(g, { t: 'info', msg: `${p.name} est de retour.` });
      }
      return;
    }
    const p = players[ws.pid];
    if (!p) return;
    const g = games.get(inGame.get(p.id));
    const mode = T.MODES[m.mode] ? m.mode : 'aleatoire';
    switch (m.t) {
      case 'rename': if (cleanName(m.name)) { p.name = cleanName(m.name); savePlayers(); send(ws, { t: 'welcome', token: p.token, me: pub(p) }); } break;
      case 'queue': {
        if (g) return send(ws, { t: 'error', msg: 'Tu es déjà en partie.' });
        leaveQueue(p.id);
        if (m.vs === 'bot') return startGame(shuffle([p.id, 'bot']), mode, true);
        const other = queue.find((q) => q.pid !== p.id && online.has(q.pid));
        if (other) startGame(shuffle([other.pid, p.id]), other.mode, true);
        else { queue.push({ pid: p.id, mode }); send(ws, { t: 'queued' }); }
        break;
      }
      case 'create': {
        if (g) return;
        leaveQueue(p.id);
        let code;
        do code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[crypto.randomInt(24)]).join(''); while (rooms.has(code));
        rooms.set(code, { pid: p.id, mode });
        send(ws, { t: 'room', code });
        break;
      }
      case 'join': {
        const code = String(m.code || '').toUpperCase().trim(), r = rooms.get(code);
        if (!r || r.pid === p.id || !online.has(r.pid)) return send(ws, { t: 'error', msg: 'Salon introuvable.' });
        if (g || inGame.has(r.pid)) return;
        rooms.delete(code);
        startGame(shuffle([r.pid, p.id]), r.mode, false);
        break;
      }
      case 'cancel': leaveQueue(p.id); send(ws, { t: 'cancelled' }); break;
      case 'move': {
        if (!g || g.done) return;
        const seat = g.pids.indexOf(p.id);
        if (g.s.turn !== seat) return send(ws, { t: 'error', msg: 'Ce n\'est pas ton tour.' });
        const mv = T.findMove(g.s, m.m);
        if (!mv) return send(ws, { t: 'error', msg: 'Coup illégal.' });
        play(g, mv);
        break;
      }
      case 'resign': if (g) finish(g, 1 - g.pids.indexOf(p.id), `${p.name} abandonne`); break;
    }
  }

  wss.on('connection', (ws) => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      try { handle(ws, m); } catch (e) { console.error(e); }
    });
    ws.on('close', () => {
      const pid = ws.pid;
      if (!pid || online.get(pid) !== ws) return;
      online.delete(pid);
      leaveQueue(pid);
      const g = games.get(inGame.get(pid));
      if (g) {
        broadcast(g, { t: 'info', msg: `${players[pid].name} s'est déconnecté — 60 s pour revenir.` });
        g.dc[pid] = setTimeout(() => finish(g, 1 - g.pids.indexOf(pid), `${players[pid].name} ne s'est pas reconnecté`), DISCONNECT_MS);
      }
    });
  });
  setInterval(() => wss.clients.forEach((ws) => { if (!ws.alive) return ws.terminate(); ws.alive = false; ws.ping(); }), 30000);

  const flush = () => { try { writeJSON(F_PLAYERS, players); writeJSON(F_BRAIN, brain); } catch {} process.exit(0); };
  process.on('SIGINT', flush); process.on('SIGTERM', flush);
  server.listen(PORT, () => console.log(`Traversal en ligne sur http://localhost:${PORT}  (données : ${DATA})`));
}

// =====================================================================
function botWorker() {
  parentPort.on('message', ({ id, state, opts }) => {
    const r = T.bestMove(state, opts);
    parentPort.postMessage({ id, move: T.encodeMove(r.move) });
  });
}

// Boucle d'auto-amélioration : auto-parties → apprentissage sur TOUTES les parties en base → match de qualification.
function trainer() {
  const F = path.join(workerData.data, 'games.jsonl');
  let champ = workerData.brain.weights.slice(), version = workerData.brain.version, ladder = workerData.brain.ladder || 0;
  const SELF_MS = +process.env.SELF_MS || 150, BATCH = +process.env.BATCH || 24, MATCH = +process.env.MATCH || 20;
  const modes = Object.keys(T.MODES);
  const log = (msg) => parentPort.postMessage({ t: 'log', msg });

  function playGame(wRed, wBlue, ms, noisyPlies) {
    const s = T.newGame({ mode: modes[Math.floor(Math.random() * modes.length)] }), h0 = Array.from(s.h), moves = [];
    while (!s.over) {
      const r = T.bestMove(s, { weights: s.turn === 0 ? wRed : wBlue, timeMs: ms, noise: s.ply < noisyPlies ? 0.35 : 0 });
      moves.push(T.encodeMove(r.move));
      T.applyMove(s, r.move);
    }
    return Object.assign(T.makeRecord(s, moves), { h: h0 });
  }
  function loadRecent(n) {
    let buf;
    try {
      const size = fs.statSync(F).size, len = Math.min(size, 40e6), fd = fs.openSync(F, 'r');
      buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len); fs.closeSync(fd);
    } catch { return []; }
    const lines = buf.toString('utf8').split('\n'), out = [];
    for (let i = lines.length - 1; i >= 1 && out.length < n; i--) { try { if (lines[i]) out.push(JSON.parse(lines[i])); } catch {} }
    return out;
  }
  function improve() {
    const samples = [];
    for (const rec of loadRecent(5000)) {
      const k = rec.src === 'online' || rec.src === 'local' ? 3 : 1; // les parties humaines comptent triple
      for (let i = 0; i < k; i++) samples.push(...T.samplesFromGame(rec, 25));
    }
    if (samples.length < 1000) return;
    const cand = T.train(samples, champ, 4);
    let pts = 0;
    for (let i = 0; i < MATCH; i++) {
      const candRed = i % 2 === 0;
      const rec = playGame(candRed ? cand : champ, candRed ? champ : cand, 80, 6);
      rec.src = 'match'; rec.players = candRed ? ['candidat', 'champion'] : ['champion', 'candidat'];
      parentPort.postMessage({ t: 'game', rec });
      pts += rec.winner === 2 ? 0.5 : (rec.winner === 0) === candRed ? 1 : 0;
    }
    const rate = pts / MATCH, clamp = Math.min(0.97, Math.max(0.03, rate));
    log(`candidat ${(rate * 100).toFixed(0)} % sur ${MATCH} parties (${samples.length} positions apprises)`);
    if (rate >= 0.55) {
      champ = cand; version++; ladder += Math.round(-400 * Math.log10(1 / clamp - 1));
      parentPort.postMessage({ t: 'brain', version, weights: champ, ladder, hist: { version, date: new Date().toISOString(), score: rate, samples: samples.length } });
    }
  }
  (async () => {
    for (let n = 1; ; n++) {
      const rec = playGame(champ, champ, SELF_MS, 10);
      rec.src = 'selfplay'; rec.players = ['Bot v' + version, 'Bot v' + version];
      parentPort.postMessage({ t: 'game', rec });
      if (n % BATCH === 0) improve();
      await new Promise((r) => setTimeout(r, +process.env.SELF_PAUSE || 50));
    }
  })();
}
