export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Player-Id, X-Player-Token',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/api/health') {
      return json({ ok: true, service: 'collapse-cloud', time: new Date().toISOString() }, cors);
    }
    if (!url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, cors, 404);

    try {
      await schema(env);
      const route = url.pathname;
      if (route === '/api/leaderboard' && request.method === 'GET') return await leaderboard(url, env, cors);
      if (route === '/api/score' && request.method === 'POST') return await score(request, env, cors);
      if (route === '/api/save' && request.method === 'GET') return await getSave(request, url, env, cors);
      if (route === '/api/save' && request.method === 'PUT') return await putSave(request, env, cors);
      return json({ error: 'Not found' }, cors, 404);
    } catch (error) {
      return json({ error: error.message || 'Cloud request failed.' }, cors, 400);
    }
  },
};

let schemaReady = false;

async function schema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new Error('The cloud database is not attached.');
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS players (
      player_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      game_title TEXT NOT NULL,
      mode TEXT NOT NULL,
      player_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      score INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS scores_player_game_mode
      ON scores(game_id, mode, player_id)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS saves (
      game_id TEXT NOT NULL,
      player_id TEXT NOT NULL,
      label TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (game_id, player_id)
    )`),
  ]);
  schemaReady = true;
}

function json(value, cors, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function id(value, max = 80) {
  return String(value || '').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, max);
}

function player(request) {
  const playerId = id(request.headers.get('X-Player-Id'), 80);
  const token = String(request.headers.get('X-Player-Token') || '').slice(0, 200);
  if (!playerId || token.length < 16) throw new Error('A player identity is required.');
  return { playerId, token };
}

async function playerHash(playerId, token) {
  const bytes = new TextEncoder().encode(`${playerId}:${token}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPlayer(request, env) {
  const { playerId, token } = player(request);
  const hash = await playerHash(playerId, token);
  const existing = await env.DB.prepare('SELECT token_hash FROM players WHERE player_id = ?').bind(playerId).first();
  if (existing) {
    if (existing.token_hash !== hash) throw new Error('That player key is not valid.');
    return playerId;
  }
  await env.DB.prepare('INSERT INTO players (player_id, token_hash, created_at) VALUES (?, ?, ?)')
    .bind(playerId, hash, new Date().toISOString()).run();
  return playerId;
}

async function leaderboard(url, env, cors) {
  const gameId = id(url.searchParams.get('gameId'));
  if (!gameId) throw new Error('gameId is required.');
  const mode = id(url.searchParams.get('mode'), 40);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const statement = mode
    ? env.DB.prepare('SELECT game_id, game_title, mode, player_name, score, updated_at FROM scores WHERE game_id = ? AND mode = ? ORDER BY score DESC, updated_at ASC LIMIT ?').bind(gameId, mode, limit)
    : env.DB.prepare('SELECT game_id, game_title, mode, player_name, score, updated_at FROM scores WHERE game_id = ? ORDER BY score DESC, updated_at ASC LIMIT ?').bind(gameId, limit);
  const { results } = await statement.all();
  return json({ scores: results || [] }, cors);
}

async function score(request, env, cors) {
  const playerId = await verifyPlayer(request, env);
  const body = await request.json();
  const gameId = id(body.gameId);
  const mode = id(body.mode, 40) || 'Classic';
  const numeric = Math.round(Number(body.score));
  if (!gameId) throw new Error('gameId is required.');
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1000000000) throw new Error('score is not valid.');
  const name = String(body.playerName || 'Player').replace(/[^\w .'-]/g, '').trim().slice(0, 40) || 'Player';
  const title = String(body.gameTitle || gameId).slice(0, 80);
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO scores (game_id, game_title, mode, player_id, player_name, score, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id, mode, player_id) DO UPDATE SET
      player_name = excluded.player_name, score = excluded.score, updated_at = excluded.updated_at
    WHERE excluded.score >= scores.score`)
    .bind(gameId, title, mode, playerId, name, numeric, now).run();
  return json({ ok: true }, cors);
}

async function getSave(request, url, env, cors) {
  const playerId = await verifyPlayer(request, env);
  const gameId = id(url.searchParams.get('gameId'));
  if (!gameId) throw new Error('gameId is required.');
  const row = await env.DB.prepare('SELECT label, payload, updated_at FROM saves WHERE game_id = ? AND player_id = ?')
    .bind(gameId, playerId).first();
  if (!row) return json({ error: 'No cloud save exists for this game yet.' }, cors, 404);
  return json({ gameId, label: row.label, files: JSON.parse(row.payload), updatedAt: row.updated_at }, cors);
}

async function putSave(request, env, cors) {
  const playerId = await verifyPlayer(request, env);
  const body = await request.json();
  const gameId = id(body.gameId);
  if (!gameId) throw new Error('gameId is required.');
  const files = Array.isArray(body.files) ? body.files : [];
  if (!files.length) throw new Error('There are no files to save.');
  if (files.length > 40) throw new Error('Too many files in this save.');
  for (const file of files) {
    if (!file || !file.name || typeof file.data !== 'string') throw new Error('A save file is malformed.');
    if (file.data.length > 4 * 1024 * 1024) throw new Error('That save file is too large.');
  }
  const payload = JSON.stringify(files);
  if (payload.length > 5 * 1024 * 1024) throw new Error('That save is larger than the 5 MB limit.');
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT INTO saves (game_id, player_id, label, payload, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(game_id, player_id) DO UPDATE SET
      label = excluded.label, payload = excluded.payload, updated_at = excluded.updated_at`)
    .bind(gameId, playerId, String(body.label || gameId).slice(0, 80), payload, now).run();
  return json({ ok: true, updatedAt: now }, cors);
}
