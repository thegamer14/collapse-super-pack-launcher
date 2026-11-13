'use strict';

/* Discord Rich Presence is optional: it can be switched off or use a custom
   application ID. The module therefore never throws and only loads
   discord-rpc when presence is enabled. The application's public key is not
   used by local Rich Presence; only the client ID is needed. */

let RPC = null;
let client = null;
let ready = false;
let activeClientId = '';
let currentGame = null;
let starting = false;

function loadRpc() {
  if (RPC) return RPC;
  try {
    RPC = require('discord-rpc');
  } catch (error) {
    console.error('Discord Rich Presence is unavailable:', error.message);
    RPC = null;
  }
  return RPC;
}

const BOX_ART_URL = 'https://raw.githubusercontent.com/thegamer14/collapse-super-pack-launcher/main/assets/boxes/';

function boxArt(game) {
  const art = String((game && game.art) || 'default').toLowerCase();
  return /^[a-z0-9-]+$/.test(art) ? `${BOX_ART_URL}${art}.png` : `${BOX_ART_URL}default.png`;
}

function activityFor(game) {
  return {
    details: game ? String(game.title || 'A Collapse game').slice(0, 128) : 'Browsing the collection',
    state: 'Super Collapse Super Pack',
    largeImageKey: boxArt(game),
    largeImageText: game ? String(game.title || 'Super Collapse Super Pack').slice(0, 128) : 'Super Collapse Super Pack',
    startTimestamp: new Date(),
    instance: false,
  };
}

function publish() {
  if (!client || !ready) return;
  try {
    client.setActivity(activityFor(currentGame)).catch(() => {});
  } catch {
    /* Discord closed between the ready event and this update */
  }
}

function destroy() {
  ready = false;
  activeClientId = '';
  starting = false;
  if (client) {
    try {
      client.destroy();
    } catch {
      /* already gone */
    }
  }
  client = null;
}

/**
 * Starts or stops the RPC client to match the saved settings.
 * Returns a small status object for the settings sheet.
 */
async function configure(settings) {
  const enabled = Boolean(settings && settings.discordEnabled);
  const clientId = String((settings && settings.discordClientId) || '').trim();
  if (!enabled || !clientId) {
    destroy();
    return { enabled: false, connected: false, reason: enabled ? 'Add a Discord application ID.' : 'Disabled.' };
  }

  if (client && ready && activeClientId === clientId) {
    publish();
    return { enabled: true, connected: true };
  }

  destroy();
  const rpc = loadRpc();
  if (!rpc) return { enabled: true, connected: false, reason: 'discord-rpc is not installed.' };

  starting = true;
  activeClientId = clientId;
  client = new rpc.Client({ transport: 'ipc' });

  client.on('ready', () => {
    ready = true;
    starting = false;
    publish();
  });
  client.on('disconnected', () => {
    ready = false;
    starting = false;
  });

  try {
    // login rejects when Discord is not running. That is normal and should not
    // stop the launcher; the next settings save retries it.
    await client.login({ clientId }).catch((error) => {
      ready = false;
      starting = false;
      console.error('Discord RPC login failed:', error.message);
    });
  } catch (error) {
    ready = false;
    starting = false;
    console.error('Discord RPC could not start:', error.message);
  }

  return { enabled: true, connected: ready, starting };
}

function setGame(game) {
  currentGame = game ? { title: game.title } : null;
  if (ready) publish();
}

function clearGame() {
  setGame(null);
}

function status() {
  return {
    enabled: Boolean(activeClientId),
    connected: ready,
    starting,
    game: currentGame ? currentGame.title : null,
  };
}

module.exports = { configure, setGame, clearGame, status };
