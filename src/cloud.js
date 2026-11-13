'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* The cloud endpoint is deliberately a plain REST worker so it can be hosted
   anywhere, including the worker in cloud/worker.js. It is not required for the
   launcher to work: every method reports a useful error until a URL is set. */

function trimUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function cleanId(value, max = 80) {
  return String(value || '').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, max);
}

class CloudClient {
  constructor({ dataDir, getSettings }) {
    this.dataDir = dataDir;
    this.getSettings = getSettings;
    this.identityFile = path.join(dataDir, 'cloud', 'identity.json');
  }

  identity() {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.identityFile, 'utf8'));
    } catch {
      /* first use */
    }
    if (!saved || !saved.playerId || !saved.token) {
      saved = {
        playerId: crypto.randomUUID(),
        token: crypto.randomBytes(24).toString('hex'),
      };
      fs.mkdirSync(path.dirname(this.identityFile), { recursive: true });
      fs.writeFileSync(this.identityFile, JSON.stringify(saved, null, 2));
    }
    return saved;
  }

  settings() {
    return this.getSettings() || {};
  }

  baseUrl() {
    const value = trimUrl(this.settings().cloudUrl);
    if (!value) throw new Error('Set a cloud URL in Launcher settings first.');
    if (!/^https?:\/\//i.test(value)) throw new Error('The cloud URL must start with http:// or https://.');
    return value;
  }

  displayName() {
    return String(this.settings().cloudName || '').trim().slice(0, 40) || 'Player';
  }

  async request(route, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Number(options.timeout) || 12000);
    const id = this.identity();
    try {
      const response = await fetch(this.baseUrl() + route, {
        method: options.method || 'GET',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Player-Id': id.playerId,
          'X-Player-Token': id.token,
          ...(options.headers || {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { error: text.slice(0, 200) };
      }
      if (!response.ok) {
        throw new Error((data && (data.error || data.message)) || `Cloud request failed (${response.status}).`);
      }
      return data;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('The cloud request timed out.');
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async health() {
    return this.request('/api/health', { timeout: 6000 });
  }

  async leaderboard(gameId, mode = '') {
    const query = new URLSearchParams({ gameId: cleanId(gameId), limit: '50' });
    if (mode) query.set('mode', cleanId(mode, 40));
    return this.request(`/api/leaderboard?${query.toString()}`);
  }

  async submitScore({ gameId, gameTitle, mode, score }) {
    const numeric = Number(score);
    if (!Number.isFinite(numeric) || numeric < 0) throw new Error('Enter a score of 0 or more.');
    return this.request('/api/score', {
      method: 'POST',
      body: {
        gameId: cleanId(gameId),
        gameTitle: String(gameTitle || gameId).slice(0, 80),
        mode: String(mode || 'Classic').slice(0, 40),
        score: Math.round(numeric),
        playerName: this.displayName(),
      },
    });
  }

  async backupSave({ gameId, label, files }) {
    if (!Array.isArray(files) || files.length === 0) throw new Error('There are no save files to back up yet.');
    const body = {
      gameId: cleanId(gameId),
      label: String(label || gameId).slice(0, 80),
      files: files.map((file) => ({
        name: String(file.name).slice(0, 160),
        data: Buffer.from(file.data).toString('base64'),
      })),
    };
    if (JSON.stringify(body).length > 5 * 1024 * 1024) throw new Error('That save is too large for the cloud (5 MB limit).');
    return this.request('/api/save', { method: 'PUT', body, timeout: 25000 });
  }

  async restoreSave(gameId) {
    const query = new URLSearchParams({ gameId: cleanId(gameId) });
    return this.request(`/api/save?${query.toString()}`, { timeout: 25000 });
  }
}

module.exports = { CloudClient };
