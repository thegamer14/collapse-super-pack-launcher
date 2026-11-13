'use strict';

const { app, BrowserWindow, Menu, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { launchExecutable, launchWithDisplay } = require('./game-process');
const { CloudClient } = require('./cloud');
const discord = require('./discord');
const gameSaves = require('./game-saves');
const gamePatches = require('./game-patches');
const { GAME_CODES, CODE_GUIDES } = require('./game-codes');

const ROOT = path.resolve(__dirname, '..');          // CollapseLauncher/, or app/ inside a build

/* Built as a single exe, the launcher sits in the folder that holds the games,
   so that folder (not the source tree) is what the tiles are relative to. The
   portable build unpacks itself to a temp folder; PORTABLE_EXECUTABLE_DIR is
   the folder the player actually double-clicked. */
const GAMES_DIR = app.isPackaged
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : path.resolve(ROOT, '..');

/* Preferences live in the source tree while developing, and under the user's
   app data once packaged (the exe may sit somewhere read-only). */
const DATA_DIR = app.isPackaged ? app.getPath('userData') : path.join(ROOT, 'data');
const LIBRARY_FILE = path.join(DATA_DIR, 'library.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

/** Launcher-wide preferences, saved next to the library. */
const DEFAULT_SETTINGS = {
  tileSize: 'medium',     // small | medium | large
  showYears: true,        // the year sash on each box
  animations: true,       // tile pop-in and hover lift
  confirmRemove: true,    // ask before removing a game from the launcher
  discordEnabled: false,  // Discord Rich Presence is opt-in
  discordClientId: '',    // Discord application ID
  cloudUrl: 'https://site-21d01c0b2ef446f7b99c1c01574e93d1.freebuff.page', // REST endpoint for saves and leaderboards
  cloudName: '',          // name shown on the shared leaderboard
};

/** The games that ship in this collection, in the order the launcher shows them. */
const DEFAULT_GAMES = [
  { id: 'puzzle-gallery',  title: 'Super Collapse! Puzzle Gallery',   year: '2007', art: 'puzzle-gallery',   path: 'SuperCollapsePuzzleGallery/CollapsePuzzle.exe' },
  { id: 'puzzle-gallery-2', title: 'Super Collapse! Puzzle Gallery 2', year: '2007', art: 'puzzle-gallery-2', path: 'supercollapsepuzzlegallery2/CollapsePuzzle2.exe' },
  { id: 'puzzle-gallery-3', title: 'Super Collapse! Puzzle Gallery 3', year: '2008', art: 'puzzle-gallery-3', path: 'SuperCollapsePuzzleGallery3/CollapsePuzzle3.exe' },
  { id: 'super-collapse-3', title: 'Super Collapse! 3',                year: '2006', art: 'sc3',              path: 'SuperCollapse3/SuperCollapseIII.exe' },
  // both of these were sold inside trial launchers; see README "Trial wrappers"
  // the 2003 Reflexive Arcade copy in "Super Collapse" is ASProtect-packed and
  // cannot unpack on current Windows; the 2002 GameHouse build runs as-is
  { id: 'super-collapse',  title: 'Super Collapse!',                  year: '2001', art: 'sc1',              path: 'Super Collapse!/Collapse.exe' },
  { id: 'collapse-crunch', title: 'Collapse! Crunch',                 year: '2004', art: 'crunch',           path: 'Collapse! Crunch/unpacked/Collapse3.exe' },
  { id: 'collapse',        title: 'Collapse!',                        year: '2009', art: 'collapse',         path: 'collapse!/collapse.exe' },
  { id: 'puzzle-gallery-4', title: 'Super Collapse! Puzzle Gallery 4', year: '2008', art: 'puzzle-gallery-4', path: 'supercollapsepuzzlegallery4/CollapsePuzzle4.exe' },
  { id: 'puzzle-gallery-5', title: 'Super Collapse! Puzzle Gallery 5', year: '2009', art: 'puzzle-gallery-5', path: 'supercollapsepuzzlegallery5/PuzzleGallery5.exe' },
  { id: 'super-collapse-2', title: 'Super Collapse! II Platinum',     year: '2005', art: 'sc2',              path: 'supercollapseiiplatinum/SC2Platinum.exe' },
  { id: 'spongebob-collapse', title: 'SpongeBob SquarePants Collapse!', year: '2003', art: 'spongebob',      path: 'Super-SpongeBob-SquarePants-Collapse_Win_EN_Full-Rip/SBCollapse.exe' },
];

/* Release years shown on the game tiles. These follow the series table, not
   the build date or the copyright year printed inside an individual copy. */
const RELEASE_YEARS = {
  'puzzle-gallery-2': '2007',
  'puzzle-gallery-3': '2008',
  'puzzle-gallery-4': '2008',
  'super-collapse': '2001',
  'super-collapse-2': '2005',
  'spongebob-collapse': '2003',
  'collapse-crunch': '2004',
  collapse: '2009',
};

/* What each engine actually draws at, and whether it re-renders when its window
   is resized. Everything here comes from measuring the shipping games: the
   GameHouse titles paint a fixed surface, Collapse! (2010) scales with its
   window. */
const NATIVE_SIZES = {
  'puzzle-gallery': { width: 800, height: 600, scalable: false },
  'puzzle-gallery-2': { width: 800, height: 600, scalable: false },
  'puzzle-gallery-3': { width: 800, height: 600, scalable: false },
  'puzzle-gallery-4': { width: 800, height: 600, scalable: false },
  'puzzle-gallery-5': { width: 800, height: 600, scalable: false },
  'super-collapse-3': { width: 800, height: 600, scalable: false },
  'collapse-crunch': { width: 800, height: 600, scalable: false },
  'super-collapse-2': { width: 640, height: 480, scalable: false },
  'spongebob-collapse': { width: 640, height: 480, scalable: false },
  'super-collapse': { width: 800, height: 600, scalable: false },
  collapse: { width: 1024, height: 768, scalable: true },
};

let win = null;
const presenceWatchers = new Map();

/**
 * Discord should go back to "Browsing" when the game leaves, not stay on the
 * last title forever. tasklist is enough here: every game is a normal Windows
 * process, including the ones BitBit wraps.
 */
function watchGamePresence(game) {
  const exe = path.basename(game.path || '');
  if (!exe.toLowerCase().endsWith('.exe')) return;
  const old = presenceWatchers.get(game.id);
  if (old) clearInterval(old);
  const started = Date.now();
  const timer = setInterval(() => {
    execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], { windowsHide: true }, (error, stdout) => {
      const running = !error && String(stdout).toLowerCase().includes(exe.toLowerCase());
      if (running && Date.now() - started < 6 * 60 * 60 * 1000) return;
      clearInterval(timer);
      presenceWatchers.delete(game.id);
      discord.clearGame();
    });
  }, 5000);
  presenceWatchers.set(game.id, timer);
}

function noteGameStarted(game) {
  discord.setGame(game);
  watchGamePresence(game);
}

/**
 * First run of a built launcher: start from the library and preferences that
 * were saved while developing, so the per-game display settings carry over
 * instead of being replaced by the defaults.
 */
function seedData() {
  if (!app.isPackaged) return;
  const bundled = path.join(ROOT, 'data');
  for (const name of ['library.json', 'settings.json']) {
    const target = path.join(DATA_DIR, name);
    const source = path.join(bundled, name);
    if (fs.existsSync(target) || !fs.existsSync(source)) continue;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.copyFileSync(source, target);
  }
}

function readLibrary() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LIBRARY_FILE, 'utf8'));
    if (Array.isArray(parsed.games)) {
      // Older libraries predate the display settings on Collapse! 2010. Give
      // that one game the settings it needed to leave its tiny window: scaled,
      // stretched to 1080p. A player's explicit choice is never overwritten.
      const collapse = parsed.games.find((game) => game.id === 'collapse');
      if (collapse && !collapse.settings) {
        collapse.settings = {
          args: '', cwd: null, admin: false,
          display: 'scaled', scaling: 'fill', filter: 'smooth', musicFix: true, widescreenFix: true,
          windowWidth: 1920, windowHeight: 1080,
        };
        writeLibrary(parsed);
      }
      // Existing libraries keep their old labels until they are touched. Fix
      // the known series dates here so current installs update automatically.
      let yearsChanged = false;
      for (const game of parsed.games) {
        const year = RELEASE_YEARS[game.id];
        if (year && game.year !== year) {
          game.year = year;
          yearsChanged = true;
        }
      }
      if (yearsChanged) writeLibrary(parsed);
      return parsed;
    }
  } catch {
    /* first run or unreadable file: start from the defaults */
  }
  const library = {
    games: DEFAULT_GAMES.map((g) => ({ ...g, path: g.path ? path.join(GAMES_DIR, g.path) : null })),
  };
  writeLibrary(library);
  return library;
}

function writeLibrary(library) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LIBRARY_FILE, JSON.stringify(library, null, 2));
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    const merged = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof parsed[key] === typeof DEFAULT_SETTINGS[key]) merged[key] = parsed[key];
    }
    if (!['small', 'medium', 'large'].includes(merged.tileSize)) merged.tileSize = 'medium';
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

const cloud = new CloudClient({ dataDir: DATA_DIR, getSettings: readSettings });

function configureDiscord(settings) {
  discord.configure(settings || readSettings()).catch((error) => {
    console.error('Discord Rich Presence setup failed:', error.message);
  });
}

function findGame(id) {
  return decorate(readLibrary()).games.find((game) => game.id === id);
}

/** Adds an `exists` flag, which drives the orange Locate button. */
function decorate(library) {
  return {
    games: library.games.map((game) => ({
      ...game,
      exists: Boolean(game.path) && fs.existsSync(game.path),
      native: NATIVE_SIZES[game.id] || null,
      codes: GAME_CODES[game.id] || [],
      codeGuide: CODE_GUIDES[game.id] || null,
    })),
  };
}

const captureIndexArg = process.argv.indexOf('--capture');
const captureMode = captureIndexArg > 0 && Boolean(process.argv[captureIndexArg + 1]);

function createWindow() {
  win = new BrowserWindow({
    width: Math.min(1180, screen.getPrimaryDisplay().workAreaSize.width - 40),
    height: Math.min(740, screen.getPrimaryDisplay().workAreaSize.height - 40),
    minWidth: 940,
    minHeight: 640,
    useContentSize: true,
    backgroundColor: '#123c26',
    title: 'Super Collapse Super Pack',
    icon: path.join(ROOT, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    show: !captureMode,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // rendering offscreen lets --capture work without a visible desktop
      offscreen: captureMode,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (captureMode) {
    const target = path.resolve(process.argv[captureIndexArg + 1]);
    win.webContents.once('did-finish-load', async () => {
      // let the layout settle (and any window auto-fit finish) before grabbing pixels
      await new Promise((r) => setTimeout(r, 2500));
      let png = Buffer.alloc(0);
      for (let attempt = 0; attempt < 10 && png.length === 0; attempt++) {
        png = (await win.webContents.capturePage()).toPNG();
        if (png.length === 0) await new Promise((r) => setTimeout(r, 400));
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, png);
      console.log('SHOT', target, png.length, 'bytes');
      app.exit(0);
    });
  }

  if (process.argv.includes('--smoke')) {
    win.webContents.once('did-finish-load', () => {
      console.log('SMOKE: window loaded');
      setTimeout(() => {
        console.log('SMOKE OK');
        app.exit(0);
      }, 1200);
    });
    win.webContents.on('console-message', (_e, _level, message) => console.log('renderer:', message));
  }
}

Menu.setApplicationMenu(null);

app.whenReady().then(() => {
  seedData();
  createWindow();
  configureDiscord(readSettings());
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  for (const timer of presenceWatchers.values()) clearInterval(timer);
  presenceWatchers.clear();
  discord.clearGame();
});

ipcMain.handle('library:get', () => decorate(readLibrary()));

ipcMain.handle('settings:get', () => readSettings());

ipcMain.handle('settings:save', (_event, patch) => {
  const settings = { ...readSettings(), ...(patch || {}) };
  if (!['small', 'medium', 'large'].includes(settings.tileSize)) settings.tileSize = 'medium';
  writeSettings(settings);
  configureDiscord(settings);
  return settings;
});

/** Per-game launch settings: arguments, working folder and elevation. */
ipcMain.handle('game:update', (_event, { id, settings }) => {
  const library = readLibrary();
  const game = library.games.find((g) => g.id === id);
  if (!game) return decorate(library);
  const patch = settings || {};
  const width = Number(patch.windowWidth);
  const height = Number(patch.windowHeight);
  // 'fullscreen' was the old mode-switching path; it maps onto the scaler
  const display = patch.display === 'scaled' || patch.display === 'fullscreen'
    ? 'scaled'
    : patch.display === 'borderless' ? 'borderless' : 'window';
  game.settings = {
    args: typeof patch.args === 'string' ? patch.args.slice(0, 400) : '',
    cwd: patch.cwd ? String(patch.cwd) : null,
    admin: Boolean(patch.admin),
    display,
    scaling: patch.scaling === 'fill' ? 'fill' : 'fit',
    filter: patch.filter === 'nearest' ? 'nearest' : 'smooth',
    musicFix: patch.musicFix !== false,
    widescreenFix: patch.widescreenFix !== false,
    windowWidth: Number.isFinite(width) && width >= 640 ? Math.round(width) : null,
    windowHeight: Number.isFinite(height) && height >= 480 ? Math.round(height) : null,
  };
  writeLibrary(library);
  return decorate(library);
});

ipcMain.handle('game:launch', async (_event, id) => {
  const library = decorate(readLibrary());
  const game = library.games.find((g) => g.id === id);
  if (!game) return { ok: false, error: 'That game is no longer in the library.' };

  const settings = game.settings || {};
  // fixed-size engines need the wrapper; the 2010 Collapse! re-renders itself
  const needsWrapper = !game.native || !game.native.scalable;
  const chosen = settings.display === 'scaled' || settings.display === 'window' ||
    settings.display === 'fullscreen' || settings.display === 'borderless';
  // fixed-size engines default to the wrapper; everything else stays windowed
  const display = chosen ? settings.display : (needsWrapper ? 'scaled' : 'window');
  const scaled = display === 'scaled' || display === 'fullscreen';
  let warning = null;

  // Collapse! (2009/2010) starts the menu stream and never switches to the
  // continuous track. The resource patch is backed up and reversible.
  if (game.id === 'collapse') {
    const music = gamePatches.setMusicFix(game.path, settings.musicFix !== false);
    if (!music.ok) warning = music.error;
    const widescreen = gamePatches.setWidescreenFix(game.path, settings.widescreenFix !== false);
    if (!widescreen.ok && !warning) warning = widescreen.error;
  }

  // Scaled is the whole point of BitBit, so it has to work for scalable games
  // too: previously Collapse! 2010 was sent straight to launchExecutable and
  // kept its little window (and the black bars) no matter what was selected.
  // A requested window size also needs the display helper to apply it.
  const wantsDisplay = scaled || display === 'borderless' || Boolean(settings.windowWidth && settings.windowHeight);
  if (wantsDisplay && !settings.admin) {
    const result = launchWithDisplay(game.path, { ...settings, display, native: game.native });
    if (result.ok) noteGameStarted(game);
    return warning ? { ...result, warning } : result;
  }
  const result = launchExecutable(game.path, settings);
  if (result.ok) noteGameStarted(game);
  return warning ? { ...result, warning } : result;
});

ipcMain.handle('game:unlock', async (_event, id) => {
  const game = findGame(id);
  if (!game) return { ok: false, error: 'That game is not in the library.' };
  return gameSaves.unlockGame(game, DATA_DIR);
});

ipcMain.handle('game:save-info', async (_event, id) => gameSaves.saveInfo(findGame(id)));

ipcMain.handle('cloud:health', async () => cloud.health());

ipcMain.handle('cloud:leaderboard', async (_event, { gameId, mode }) => cloud.leaderboard(gameId, mode));

ipcMain.handle('cloud:submit-score', async (_event, payload) => cloud.submitScore(payload || {}));

ipcMain.handle('cloud:backup-save', async (_event, id) => {
  const game = findGame(id);
  if (!game) return { ok: false, error: 'That game is not in the library.' };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'collapse-cloud-'));
  try {
    const save = await gameSaves.collectSave(game, DATA_DIR, temp);
    const result = await cloud.backupSave({ gameId: game.id, label: save.label, files: save.files });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
});

ipcMain.handle('cloud:restore-save', async (_event, id) => {
  const game = findGame(id);
  if (!game) return { ok: false, error: 'That game is not in the library.' };
  try {
    const payload = await cloud.restoreSave(game.id);
    return await gameSaves.restoreSave(game, DATA_DIR, payload);
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('discord:status', () => discord.status());
ipcMain.handle('discord:reconnect', () => {
  configureDiscord(readSettings());
  return { ok: true };
});

ipcMain.handle('game:reveal', (_event, id) => {
  const library = readLibrary();
  const game = library.games.find((g) => g.id === id);
  if (!game || !game.path || !fs.existsSync(game.path)) return { ok: false };
  shell.showItemInFolder(game.path);
  return { ok: true };
});

ipcMain.handle('game:remove', (_event, id) => {
  const library = readLibrary();
  library.games = library.games.filter((g) => g.id !== id);
  writeLibrary(library);
  return decorate(library);
});

/** Opens a file picker and returns the chosen executable (or null). */
ipcMain.handle('game:pick', async (_event, options) => {
  const result = await dialog.showOpenDialog(win, {
    title: (options && options.title) || 'Select a game executable',
    defaultPath: (options && options.defaultPath) || app.getPath('downloads'),
    properties: ['openFile'],
    filters: [{ name: 'Game executable', extensions: ['exe', 'bat', 'cmd'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

/** Folder picker, used by the per-game working-folder setting. */
ipcMain.handle('folder:pick', async (_event, options) => {
  const result = await dialog.showOpenDialog(win, {
    title: (options && options.title) || 'Select a folder',
    defaultPath: (options && options.defaultPath) || app.getPath('downloads'),
    properties: ['openDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

/** Registers a picked executable as a game (or relinks an existing one). */
ipcMain.handle('game:register', (_event, { path: exePath, id }) => {
  const library = readLibrary();
  if (!exePath) return decorate(library);

  if (id) {
    const game = library.games.find((g) => g.id === id);
    if (game) game.path = exePath;
  } else {
    const base = path.basename(exePath, path.extname(exePath));
    const title = base
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'game';
    let unique = slug;
    let n = 2;
    while (library.games.some((g) => g.id === unique)) unique = `${slug}-${n++}`;
    library.games.push({ id: unique, title, year: '', art: 'default', path: exePath, added: true });
  }

  writeLibrary(library);
  return decorate(library);
});

ipcMain.handle('game:rename', (_event, { id, title }) => {
  const library = readLibrary();
  const game = library.games.find((g) => g.id === id);
  if (game && title && title.trim()) game.title = title.trim().slice(0, 60);
  writeLibrary(library);
  return decorate(library);
});

ipcMain.handle('window:fit', (_event, width, height) => {
  if (!win) return null;
  const { workAreaSize } = screen.getPrimaryDisplay();
  const w = captureMode ? Math.round(width) : Math.min(Math.round(width), workAreaSize.width - 40);
  const h = captureMode ? Math.round(height) : Math.min(Math.round(height), workAreaSize.height - 80);
  win.setContentSize(w, h);
  return { width: w, height: h };
});
