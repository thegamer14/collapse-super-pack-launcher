'use strict';

/* The renderer also runs without Electron (plain browser preview), in which
   case it shows the bundled games with a stubbed backend. */
const LAUNCHER_DEFAULT_SETTINGS = {
  tileSize: 'medium',
  showYears: true,
  animations: true,
  confirmRemove: true,
  discordEnabled: true,
  discordClientId: '1570871731571134615',
  cloudUrl: '',
  cloudName: '',
};

const DEMO_CODES = {
  collapse: [
    { code: 'eindhoven', reward: 'Clown outfit', source: 'collapse.exe' },
    { code: 'paris', reward: 'Pirate outfit', source: 'collapse.exe' },
  ],
};

const DEMO_CODE_GUIDE = {
  collapse: {
    where: 'In Collapse!, open the Redeem Codes screen and enter the code.',
    search: 'Game-file search: these two promo-code strings are stored beside the Redeem Codes UI in collapse.exe. No other promo-code entries were found in the installed games; the other Pirate and Clown matches are puzzle or avatar names.',
  },
};

const DEMO_GAMES = [
  ['puzzle-gallery', 'Super Collapse! Puzzle Gallery', '2007'],
  ['puzzle-gallery-2', 'Super Collapse! Puzzle Gallery 2', '2007'],
  ['puzzle-gallery-3', 'Super Collapse! Puzzle Gallery 3', '2008'],
  ['super-collapse-3', 'Super Collapse! 3', '2006'],
  ['sc1', 'Super Collapse!', '2001'],
  ['crunch', 'Collapse! Crunch', '2004'],
  ['collapse', 'Collapse!', '2009'],
  ['puzzle-gallery-4', 'Super Collapse! Puzzle Gallery 4', '2008'],
  ['puzzle-gallery-5', 'Super Collapse! Puzzle Gallery 5', '2009'],
  ['super-collapse-2', 'Super Collapse! II Platinum', '2005'],
  ['spongebob', 'SpongeBob SquarePants Collapse!', '2003'],
].map(([art, title, year]) => ({
  id: art,
  art,
  title,
  year,
  exists: true,
  codes: DEMO_CODES[art] || [],
  codeGuide: DEMO_CODE_GUIDE[art] || null,
}));

const backend = window.launcher || {
  getLibrary: async () => ({ games: DEMO_GAMES }),
  launch: async () => ({ ok: false, error: 'Launching works in the desktop app.' }),
  reveal: async () => ({ ok: false }),
  remove: async (id) => {
    const i = DEMO_GAMES.findIndex((g) => g.id === id);
    if (i >= 0) DEMO_GAMES.splice(i, 1);
    return { games: DEMO_GAMES };
  },
  register: async () => ({ games: DEMO_GAMES }),
  rename: async ({ id, title }) => {
    const game = DEMO_GAMES.find((g) => g.id === id);
    if (game) game.title = title;
    return { games: DEMO_GAMES };
  },
  pick: async () => null,
  pickFolder: async () => null,
  updateGame: async ({ id, settings: patch }) => {
    const game = DEMO_GAMES.find((g) => g.id === id);
    if (game) game.settings = patch;
    return { games: DEMO_GAMES };
  },
  getSettings: async () => ({ ...LAUNCHER_DEFAULT_SETTINGS }),
  saveSettings: async (patch) => ({ ...LAUNCHER_DEFAULT_SETTINGS, ...patch }),
  getVersion: async () => '1.0.0-dev',
  getLogPath: async () => '',
  readLog: async () => '',
  openLog: async () => ({ ok: false, error: 'Launch logs work in the desktop app.' }),
  checkLauncherUpdate: async () => ({ ok: false, error: 'GitHub updates work in the desktop app.' }),
  installLauncherUpdate: async () => ({ ok: false, error: 'GitHub updates work in the desktop app.' }),
  openLauncherRelease: async () => ({ ok: false }),
  fitWindow: async () => null,
  unlock: async () => ({ ok: false, error: 'Unlocking works in the desktop app.' }),
  saveInfo: async () => ({ supported: false, files: [] }),
  cloudHealth: async () => ({ ok: false, error: 'Cloud features work in the desktop app.' }),
  leaderboard: async () => ({ scores: [] }),
  submitScore: async () => ({ ok: false }),
  backupSave: async () => ({ ok: false, error: 'Cloud features work in the desktop app.' }),
  restoreSave: async () => ({ ok: false, error: 'Cloud features work in the desktop app.' }),
  discordStatus: async () => ({ enabled: false, connected: false }),
  reconnectDiscord: async () => ({ ok: false }),
};

const STAGE_H = 740;
const TILE_W = 257;
const SIDE = 30;
const GAP = 30;

const rowTop = document.getElementById('row-top');
const rowBottom = document.getElementById('row-bottom');
const countEl = document.getElementById('count');
const toastEl = document.getElementById('toast');
const menuEl = document.getElementById('menu');
const stage = document.getElementById('stage');

const TILTS = [-3, 2.4, -2, 3.2, 3, -2.4, 2, -3.2];

let games = [];
let menuGameId = null;
let settings = { ...LAUNCHER_DEFAULT_SETTINGS };

const GEAR_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94a7.1 7.1 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.88 2h-3.76a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.61.22L2.71 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.1 7.1 0 0 0 0 1.88L2.83 14.16a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.33.61.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.04.24.24.42.5.42h3.76c.26 0 .46-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.18.11.47.02.61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"/></svg>';

/* ------------------------------------------------------------- helpers */
function fitStage() {
  const w = stage.offsetWidth || 1180;
  const scale = Math.min(window.innerWidth / w, window.innerHeight / STAGE_H);
  stage.style.transform = `scale(${scale})`;
}

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function artFor(game) {
  return `../../assets/boxes/${game.art || 'default'}.png`;
}

/* --------------------------------------------------------------- tiles */

/*
  The chip on each cover says how that game will be presented, so the display
  and resolution settings are visible in the launcher rather than hidden behind
  the gear: 'BitBit 1920 × 1080' when it is upscaled, 'Window' when it is not.
*/
function displayChip(game) {
  const s = game.settings || {};
  const needsWrapper = !game.native || !game.native.scalable;
  const display = s.display === 'scaled' || s.display === 'window' || s.display === 'borderless'
    ? s.display
    : (needsWrapper ? 'scaled' : 'window');

  const chip = document.createElement('span');
  if (display === 'window') {
    chip.className = 'mode window';
    chip.textContent = 'Window';
    chip.title = 'Plays in its own window';
    return chip;
  }

  if (display === 'borderless') {
    chip.className = 'mode';
    chip.textContent = 'Borderless';
    chip.title = 'Fills the screen without the BitBit capture layer';
    return chip;
  }

  const size = s.windowWidth && s.windowHeight
    ? `${s.windowWidth} × ${s.windowHeight}`
    : 'Screen';
  const shape = s.scaling === 'fill' ? 'Fill 16:9' : 'Fit 4:3';
  chip.className = 'mode';
  chip.textContent = size;
  chip.title = `BitBit — upscaled to ${size}, ${shape}, at your monitor's refresh rate`;
  return chip;
}

function buildTile(game, index) {
  const tile = document.createElement('article');
  tile.className = 'tile';
  tile.dataset.id = game.id;
  tile.tabIndex = 0;
  tile.style.setProperty('--rot', `${TILTS[index % TILTS.length]}deg`);
  tile.style.setProperty('--delay', `${40 * index}ms`);
  tile.title = game.title;

  const face = document.createElement('div');
  face.className = 'face';

  const img = document.createElement('img');
  img.src = artFor(game);
  img.alt = '';
  img.draggable = false;
  img.addEventListener('error', () => {
    if (!img.dataset.fallback) {
      img.dataset.fallback = '1';
      img.src = '../../assets/boxes/default.png';
    }
  });
  face.append(img);

  if (!game.art || game.art === 'default') {
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = game.title;
    face.append(name);
  }

  if (game.year && settings.showYears) {
    const sash = document.createElement('span');
    sash.className = 'sash';
    sash.textContent = game.year;
    face.append(sash);
  }

  face.append(displayChip(game));

  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'play' + (game.exists ? '' : ' missing');
  const label = document.createElement('img');
  label.className = 'label';
  label.src = game.exists ? '../../assets/label-play.png' : '../../assets/label-locate.png';
  label.alt = game.exists ? 'Play' : 'Locate';
  label.draggable = false;
  play.append(label);
  play.addEventListener('click', (event) => {
    event.stopPropagation();
    if (game.exists) startGame(game);
    else relocate(game);
  });

  const gear = document.createElement('button');
  gear.type = 'button';
  gear.className = 'gear tile-gear';
  gear.title = `${game.title} settings`;
  gear.setAttribute('aria-label', `${game.title} settings`);
  gear.innerHTML = GEAR_SVG;
  gear.addEventListener('click', (event) => {
    event.stopPropagation();
    openGameSettings(game);
  });

  const codeEntries = Array.isArray(game.codes) ? game.codes : [];
  const playRow = document.createElement('div');
  playRow.className = 'play-row';
  if (codeEntries.length) {
    const codes = document.createElement('button');
    codes.type = 'button';
    codes.className = 'codes-btn';
    codes.textContent = 'CODES';
    codes.title = `View codes for ${game.title}`;
    codes.setAttribute('aria-label', `View codes for ${game.title}`);
    codes.addEventListener('click', (event) => {
      event.stopPropagation();
      openCodes(game);
    });
    playRow.append(codes);
  }
  playRow.append(play, gear);
  tile.append(face, playRow);

  tile.addEventListener('keydown', (event) => {
    if (event.target !== tile) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (game.exists) startGame(game);
      else relocate(game);
    }
  });

  tile.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openMenu(game.id, event.clientX, event.clientY);
  });

  return tile;
}

function render() {
  // two rows of games with the title band between them; a short last row stays centred
  const columns = Math.max(4, Math.ceil(games.length / 2));
  const scale = { small: 0.86, medium: 1, large: 1.1 }[settings.tileSize] || 1;
  const tileW = Math.round((columns <= 4 ? TILE_W : columns === 5 ? 245 : 230) * scale);
  stage.style.setProperty('--tile-w', `${tileW}px`);

  const split = Math.ceil(games.length / 2);
  const top = games.slice(0, split);
  const bottom = games.slice(split);
  rowTop.replaceChildren(...top.map(buildTile));
  rowBottom.replaceChildren(...bottom.map((game, i) => buildTile(game, i + top.length)));

  const widest = Math.max(top.length, bottom.length, 4);
  const stageW = SIDE * 2 + widest * tileW + (widest - 1) * GAP;
  stage.style.setProperty('--stage-w', `${stageW}px`);
  backend.fitWindow(stageW, STAGE_H).catch(() => {});

  const missing = games.filter((g) => !g.exists).length;
  countEl.textContent = missing
    ? `${games.length} games · ${missing} needs locating`
    : `${games.length} games ready to play`;
}

async function refresh(library) {
  games = library.games;
  render();
}

/* ------------------------------------------------------------ actions */
async function startGame(game) {
  try {
    const result = await backend.launch(game.id);
    if (!result || result.ok === false) {
      const message = result && result.error ? result.error : 'Could not start that game.';
      toast(`${message} See Launcher settings → Launch log.`);
      return;
    }
    toast(result.warning ? `Launching ${game.title}… ${result.warning}` : `Launching ${game.title}…`);
  } catch (error) {
    toast(`${error.message || 'Could not start that game.'} See Launcher settings → Launch log.`);
  }
}

async function relocate(game) {
  const picked = await backend.pick({ title: `Locate ${game.title}` });
  if (!picked) return;
  const library = await backend.register({ id: game.id, path: picked });
  await refresh(library);
  toast(`${game.title} relinked.`);
}

async function addGame() {
  const picked = await backend.pick({
    title: 'Add a Collapse game',
    defaultPath: undefined,
  });
  if (!picked) return;
  const library = await backend.register({ path: picked });
  await refresh(library);
  toast('Game added.');
}

/* --------------------------------------------------------------- menu */
function openMenu(id, x, y) {
  menuGameId = id;
  const game = games.find((g) => g.id === id);
  if (!game) return;
  menuEl.hidden = false;
  const rect = menuEl.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menuEl.style.left = `${Math.max(8, left)}px`;
  menuEl.style.top = `${Math.max(8, top)}px`;
  menuEl.querySelector('[data-action="relocate"]').textContent =
    game.exists ? 'Relink executable…' : 'Locate executable…';
}

function closeMenu() {
  menuEl.hidden = true;
  menuGameId = null;
}

menuEl.addEventListener('click', async (event) => {
  const action = event.target.closest('button')?.dataset.action;
  const game = games.find((g) => g.id === menuGameId);
  closeMenu();
  if (!action || !game) return;

  if (action === 'launch') {
    if (game.exists) startGame(game);
    else relocate(game);
  } else if (action === 'relocate') {
    relocate(game);
  } else if (action === 'reveal') {
    const ok = await backend.reveal(game.id);
    if (!ok || ok.ok === false) toast('That file is not where the launcher expects it.');
  } else if (action === 'rename') {
    const title = await askName(game.title);
    if (title) {
      const library = await backend.rename({ id: game.id, title });
      await refresh(library);
    }
  } else if (action === 'settings') {
    openGameSettings(game);
  } else if (action === 'remove') {
    if (settings.confirmRemove) {
      const ok = await askConfirm(
        `Remove ${game.title} from the launcher?`,
        'The game files stay where they are — only the tile is taken out.'
      );
      if (!ok) return;
    }
    const library = await backend.remove(game.id);
    await refresh(library);
    toast('Removed from the launcher (the game files are untouched).');
  }
});

document.addEventListener('pointerdown', (event) => {
  if (!menuEl.hidden && !menuEl.contains(event.target)) closeMenu();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeMenu();
    closePrompt();
  }
});

/* --------------------------------------------------------- rename box */
function askName(current) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'prompt';
    wrap.innerHTML = `
      <form>
        <label>Game name
          <input type="text" maxlength="60" value="">
        </label>
        <div class="row">
          <button type="button" class="cancel">Cancel</button>
          <button type="submit" class="ok">Save</button>
        </div>
      </form>`;
    const input = wrap.querySelector('input');
    input.value = current;
    document.body.append(wrap);
    input.focus();
    input.select();

    const done = (value) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') done(null);
    };
    document.addEventListener('keydown', onKey);
    wrap.querySelector('.cancel').addEventListener('click', () => done(null));
    wrap.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      done(input.value.trim() || null);
    });
  });
}

function closePrompt() {
  document.querySelectorAll('.prompt').forEach((el) => el.remove());
}

function askConfirm(message, detail, okLabel = 'Remove') {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'prompt';
    wrap.innerHTML = `
      <form>
        <p class="msg"></p>
        <p class="detail"></p>
        <div class="row">
          <button type="button" class="cancel">Cancel</button>
          <button type="button" class="ok"></button>
        </div>
      </form>`;
    wrap.querySelector('.msg').textContent = message;
    wrap.querySelector('.detail').textContent = detail || '';
    wrap.querySelector('.ok').textContent = okLabel;
    document.body.append(wrap);

    const done = (value) => {
      wrap.remove();
      resolve(value);
    };
    wrap.querySelector('.cancel').addEventListener('click', () => done(false));
    wrap.querySelector('.ok').addEventListener('click', () => done(true));
    wrap.querySelector('.ok').focus();
  });
}

/* ------------------------------------------------------------ settings */
function saveSettings(patch) {
  settings = { ...settings, ...patch };
  return backend.saveSettings(patch).catch((error) => {
    console.error(error);
    toast('Could not save the launcher settings.');
  });
}

function applyLauncherSettings() {
  document.body.classList.toggle('no-motion', !settings.animations);
  if (games.length) render();
}

function showSheet(title, subtitle, onClose) {
  const overlay = document.createElement('div');
  overlay.className = 'sheet';
  const panel = document.createElement('div');
  panel.className = 'sheet-panel';

  const heading = document.createElement('h2');
  heading.textContent = title;
  panel.append(heading);

  if (subtitle) {
    const sub = document.createElement('p');
    sub.className = 'sub';
    sub.textContent = subtitle;
    panel.append(sub);
  }

  overlay.append(panel);
  document.body.append(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    if (onClose) onClose();
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close();
  });

  return { panel, close };
}

async function copyText(value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall back to the selection method below */
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

function openCodes(game) {
  const entries = Array.isArray(game.codes) ? game.codes : [];
  const guide = game.codeGuide || {};
  const { panel, close } = showSheet(
    `${game.title} codes`,
    guide.where || 'Enter these codes in the game. The launcher only shows them; it does not edit your save.'
  );

  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'code-note';
    empty.textContent = 'No promo codes were found for this game.';
    panel.append(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'code-list';
    entries.forEach((entry) => {
      const card = document.createElement('div');
      card.className = 'code-card';

      const main = document.createElement('div');
      main.className = 'code-main';
      const reward = document.createElement('strong');
      reward.className = 'code-reward';
      reward.textContent = entry.reward || 'Reward';
      const value = document.createElement('span');
      value.className = 'code-value';
      value.textContent = entry.code || '';
      main.append(reward, value);
      if (entry.source) {
        const source = document.createElement('small');
        source.className = 'code-source';
        source.textContent = `Found in ${entry.source}`;
        main.append(source);
      }

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'btn primary copy-code';
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        const copied = await copyText(entry.code || '');
        copy.textContent = copied ? 'Copied' : 'Select';
        toast(copied ? `${entry.reward || 'Code'} copied.` : 'Select the code text and copy it.');
        setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
      });

      card.append(main, copy);
      list.append(card);
    });
    panel.append(list);
  }

  if (guide.search) {
    const search = document.createElement('p');
    search.className = 'code-note code-search';
    search.textContent = guide.search;
    panel.append(search);
  }

  const footer = document.createElement('footer');
  const grow = document.createElement('span');
  grow.className = 'grow';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn';
  done.textContent = 'Done';
  done.addEventListener('click', close);
  footer.append(grow, done);
  panel.append(footer);
  done.focus();
}

function settingsRow(parent, title, hint, control) {
  const row = document.createElement('div');
  row.className = 'sheet-row';
  const text = document.createElement('div');
  text.className = 'text';
  const strong = document.createElement('strong');
  strong.textContent = title;
  text.append(strong);
  if (hint) {
    const small = document.createElement('small');
    small.textContent = hint;
    text.append(small);
  }
  row.append(text, control);
  parent.append(row);
  return row;
}

function toggleControl(options) {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'switch';
  input.checked = Boolean(options.value);
  input.addEventListener('change', () => options.onChange(input.checked));
  return input;
}

function openLauncherSettings() {
  const { panel, close } = showSheet(
    'Launcher settings',
    'These apply to the launcher itself. Each game has its own gear beside its Play button.'
  );

  const sizes = document.createElement('div');
  sizes.className = 'segments';
  const sizeButtons = {};
  for (const [value, label] of [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.classList.toggle('on', settings.tileSize === value);
    button.addEventListener('click', () => {
      for (const [key, el] of Object.entries(sizeButtons)) el.classList.toggle('on', key === value);
      saveSettings({ tileSize: value });
      if (games.length) render();
    });
    sizeButtons[value] = button;
    sizes.append(button);
  }
  settingsRow(panel, 'Box size', 'How large the game covers are drawn in the grid.', sizes);

  settingsRow(
    panel,
    'Release years',
    'Show the year sash on the corner of each game box.',
    toggleControl({
      value: settings.showYears,
      onChange: (value) => {
        saveSettings({ showYears: value });
        if (games.length) render();
      },
    })
  );

  settingsRow(
    panel,
    'Animations',
    'Pop-in when the launcher opens, and the lift on hover.',
    toggleControl({
      value: settings.animations,
      onChange: (value) => {
        saveSettings({ animations: value });
        applyLauncherSettings();
      },
    })
  );

  settingsRow(
    panel,
    'Ask before removing',
    'Confirm when a game is taken out of the launcher.',
    toggleControl({
      value: settings.confirmRemove,
      onChange: (value) => saveSettings({ confirmRemove: value }),
    })
  );

  /* ---------------------------------------------------- launcher updates */
  const updatesSection = document.createElement('p');
  updatesSection.className = 'sub section-title';
  updatesSection.textContent = 'Launcher updates';
  panel.append(updatesSection);

  const updateField = document.createElement('div');
  updateField.className = 'field';
  const updateLabel = document.createElement('label');
  updateLabel.textContent = 'GitHub releases';
  const updateHint = document.createElement('small');
  updateHint.textContent = 'Checks for a newer portable launcher and installs it from GitHub.';
  updateLabel.append(updateHint);

  const updateRow = document.createElement('div');
  updateRow.className = 'button-row';
  const updateButton = document.createElement('button');
  updateButton.type = 'button';
  updateButton.className = 'btn primary';
  updateButton.textContent = 'Check for updates';
  const releaseButton = document.createElement('button');
  releaseButton.type = 'button';
  releaseButton.className = 'btn quiet';
  releaseButton.textContent = 'Release page';
  updateRow.append(updateButton, releaseButton);
  updateField.append(updateLabel, updateRow);
  panel.append(updateField);

  backend.getVersion().then((version) => {
    if (version) updateHint.textContent = `Current version ${version}. Checks for a newer portable launcher and installs it from GitHub.`;
  }).catch(() => {});

  releaseButton.addEventListener('click', () => {
    backend.openLauncherRelease().catch(() => toast('Could not open the GitHub releases page.'));
  });

  /* ------------------------------------------------------- launch log */
  const diagnosticsSection = document.createElement('p');
  diagnosticsSection.className = 'sub section-title';
  diagnosticsSection.textContent = 'Launch diagnostics';
  panel.append(diagnosticsSection);

  const logField = document.createElement('div');
  logField.className = 'field';
  const logLabel = document.createElement('label');
  logLabel.textContent = 'Launch log';
  const logHint = document.createElement('small');
  logHint.textContent = 'Records startup, game paths, launch commands, helper errors and process exits.';
  logLabel.append(logHint);

  const logRow = document.createElement('div');
  logRow.className = 'button-row';
  const openLogButton = document.createElement('button');
  openLogButton.type = 'button';
  openLogButton.className = 'btn primary';
  openLogButton.textContent = 'Open log';
  const copyLogButton = document.createElement('button');
  copyLogButton.type = 'button';
  copyLogButton.className = 'btn quiet';
  copyLogButton.textContent = 'Copy log';
  logRow.append(openLogButton, copyLogButton);
  logField.append(logLabel, logRow);
  panel.append(logField);

  backend.getLogPath().then((file) => {
    if (file) logHint.textContent = `Records startup, game paths, launch commands, helper errors and process exits. File: ${file}`;
  }).catch(() => {});

  openLogButton.addEventListener('click', async () => {
    try {
      const result = await backend.openLog();
      if (!result || result.ok === false) toast((result && result.error) || 'Could not open the launch log.');
    } catch (error) {
      toast(error.message || 'Could not open the launch log.');
    }
  });

  copyLogButton.addEventListener('click', async () => {
    copyLogButton.disabled = true;
    try {
      const text = await backend.readLog();
      if (!text) {
        toast('The launch log is empty.');
        return;
      }
      const copied = await copyText(text);
      toast(copied ? 'Launch log copied.' : 'Could not copy the launch log.');
    } catch (error) {
      toast(error.message || 'Could not read the launch log.');
    } finally {
      copyLogButton.disabled = false;
    }
  });

  updateButton.addEventListener('click', async () => {
    updateButton.disabled = true;
    releaseButton.disabled = true;
    updateButton.textContent = 'Checking…';
    try {
      const result = await backend.checkLauncherUpdate();
      if (!result || result.ok === false) {
        toast((result && result.error) || 'Could not check GitHub for updates.');
        return;
      }
      if (!result.available) {
        toast(`Launcher is up to date (v${result.currentVersion}).`);
        return;
      }
      const accepted = await askConfirm(
        `Update the launcher to v${result.latestVersion}?`,
        'The portable launcher will download the new GitHub release, close, install it and reopen. Your game library and settings stay untouched.',
        'Update now'
      );
      if (!accepted) return;
      updateButton.textContent = 'Downloading…';
      const install = await backend.installLauncherUpdate();
      if (!install || install.ok === false) {
        toast((install && install.error) || 'Could not install the launcher update.');
        return;
      }
      if (install.upToDate) toast(`Launcher is already up to date (v${install.currentVersion}).`);
      else toast('Update downloaded. The launcher will restart to finish installing.');
    } catch (error) {
      toast(error.message || 'Could not update the launcher.');
    } finally {
      updateButton.disabled = false;
      releaseButton.disabled = false;
      updateButton.textContent = 'Check for updates';
    }
  });

  /* ---------------------------------------------------- Discord presence */
  const discordSection = document.createElement('p');
  discordSection.className = 'sub section-title';
  discordSection.textContent = 'Discord Rich Presence';
  panel.append(discordSection);

  settingsRow(
    panel,
    'Show what I am playing',
    'Publishes the running game in your Discord profile while it is open.',
    toggleControl({
      value: settings.discordEnabled,
      onChange: async (value) => {
        await saveSettings({ discordEnabled: value });
        await updateDiscordStatus();
        setTimeout(updateDiscordStatus, 1200);
      },
    })
  );

  const discordStatus = document.createElement('p');
  discordStatus.className = 'sub discord-status';
  discordStatus.textContent = 'Checking the Discord connection…';
  panel.append(discordStatus);

  async function updateDiscordStatus() {
    try {
      const status = await backend.discordStatus();
      if (!settings.discordEnabled) {
        discordStatus.textContent = 'Rich Presence is turned off.';
      } else if (status.starting) {
        discordStatus.textContent = 'Connecting to Discord…';
      } else if (status.connected) {
        discordStatus.textContent = status.game
          ? `Connected to Discord — showing ${status.game}.`
          : 'Connected to Discord — showing the launcher.';
      } else {
        discordStatus.textContent = 'Discord is not running, so nothing is being shared.';
      }
    } catch {
      discordStatus.textContent = 'Could not read the Discord connection.';
    }
  }
  updateDiscordStatus();

  const discordIdField = document.createElement('div');
  discordIdField.className = 'field';
  const discordIdLabel = document.createElement('label');
  discordIdLabel.textContent = 'Discord application ID';
  const discordIdHint = document.createElement('small');
  discordIdHint.textContent = 'The pack uses its own Discord application by default. Only change this if you are using a different Discord application; this is not a bot token.';
  discordIdLabel.append(discordIdHint);
  const discordIdInput = document.createElement('input');
  discordIdInput.type = 'text';
  discordIdInput.placeholder = '1570871731571134615';
  discordIdInput.value = settings.discordClientId || '';
  discordIdInput.addEventListener('change', async () => {
    await saveSettings({ discordClientId: discordIdInput.value.trim() });
    toast('Discord settings saved. Reconnecting…');
    await backend.reconnectDiscord().catch(() => {});
    setTimeout(updateDiscordStatus, 600);
  });
  discordIdField.append(discordIdLabel, discordIdInput);
  panel.append(discordIdField);

  /* ---------------------------------------------------------- cloud sync */
  const cloudSection = document.createElement('p');
  cloudSection.className = 'sub section-title';
  cloudSection.textContent = 'Cloud saves & leaderboards';
  panel.append(cloudSection);

  const cloudField = document.createElement('div');
  cloudField.className = 'field';
  const cloudLabel = document.createElement('label');
  cloudLabel.textContent = 'Cloud server URL';
  const cloudHint = document.createElement('small');
  cloudHint.textContent = 'The address of the Collapse cloud worker (see cloud/ in the project). Leave empty to keep everything local.';
  cloudLabel.append(cloudHint);
  const cloudInput = document.createElement('input');
  cloudInput.type = 'text';
  cloudInput.placeholder = 'https://your-worker.example.workers.dev';
  cloudInput.value = settings.cloudUrl || '';
  cloudInput.addEventListener('change', () => saveSettings({ cloudUrl: cloudInput.value.trim() }));
  const cloudLine = document.createElement('div');
  cloudLine.className = 'with-button';
  const testCloud = document.createElement('button');
  testCloud.type = 'button';
  testCloud.className = 'btn';
  testCloud.textContent = 'Test';
  testCloud.addEventListener('click', async () => {
    testCloud.disabled = true;
    try {
      await saveSettings({ cloudUrl: cloudInput.value.trim() });
      await backend.cloudHealth();
      toast('Cloud server is reachable.');
    } catch (error) {
      toast(error.message || 'Could not reach the cloud server.');
    } finally {
      testCloud.disabled = false;
    }
  });
  cloudLine.append(cloudInput, testCloud);
  cloudField.append(cloudLabel, cloudLine);
  panel.append(cloudField);

  const nameField = document.createElement('div');
  nameField.className = 'field';
  const nameLabel = document.createElement('label');
  nameLabel.textContent = 'Leaderboard name';
  const nameHint = document.createElement('small');
  nameHint.textContent = 'Shown next to your scores. A private player key is generated on this PC and never shown.';
  nameLabel.append(nameHint);
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.placeholder = 'Player';
  nameInput.value = settings.cloudName || '';
  nameInput.addEventListener('change', () => saveSettings({ cloudName: nameInput.value.trim() }));
  nameField.append(nameLabel, nameInput);
  panel.append(nameField);

  const footer = document.createElement('footer');
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn quiet';
  reset.textContent = 'Reset';
  const grow = document.createElement('span');
  grow.className = 'grow';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn primary';
  done.textContent = 'Done';

  reset.addEventListener('click', async () => {
    await saveSettings({ ...LAUNCHER_DEFAULT_SETTINGS });
    applyLauncherSettings();
    close();
    openLauncherSettings();
  });
  done.addEventListener('click', close);

  footer.append(reset, grow, done);
  panel.append(footer);
  done.focus();
}

function openGameSettings(game) {
  const { panel, close } = showSheet(
    `${game.title} settings`,
    'These apply only to this game, and are used the next time it is launched.'
  );

  const current = game.settings || {};

  const pathBox = document.createElement('div');
  pathBox.className = 'pathbox';
  pathBox.textContent = game.path || 'No executable linked yet — use Locate to point at one.';

  const program = document.createElement('div');
  program.className = 'field';
  const programLabel = document.createElement('label');
  programLabel.textContent = 'Program';
  program.append(programLabel, pathBox);
  panel.append(program);

  const argsField = document.createElement('div');
  argsField.className = 'field';
  const argsLabel = document.createElement('label');
  argsLabel.textContent = 'Launch arguments';
  const argsHint = document.createElement('small');
  argsHint.textContent = 'Passed to the game on launch, e.g. -windowed';
  argsLabel.append(argsHint);
  const argsInput = document.createElement('input');
  argsInput.type = 'text';
  argsInput.placeholder = 'none';
  argsInput.value = current.args || '';
  argsField.append(argsLabel, argsInput);
  panel.append(argsField);

  const cwdField = document.createElement('div');
  cwdField.className = 'field';
  const cwdLabel = document.createElement('label');
  cwdLabel.textContent = 'Working folder';
  const cwdHint = document.createElement('small');
  cwdHint.textContent = 'Leave empty to start the game from its own folder.';
  cwdLabel.append(cwdHint);
  const cwdLine = document.createElement('div');
  cwdLine.className = 'with-button';
  const cwdInput = document.createElement('input');
  cwdInput.type = 'text';
  cwdInput.placeholder = 'same folder as the game';
  cwdInput.value = current.cwd || '';
  const browse = document.createElement('button');
  browse.type = 'button';
  browse.className = 'btn';
  browse.textContent = 'Browse…';
  browse.addEventListener('click', async () => {
    const folder = await backend.pickFolder({ title: `Working folder for ${game.title}` });
    if (folder) cwdInput.value = folder;
  });
  cwdLine.append(cwdInput, browse);
  cwdField.append(cwdLabel, cwdLine);
  panel.append(cwdField);

  /* ---- display: our wrapper presents fixed-size engines at any resolution ---- */
  let chosenDisplay = current.display === 'borderless'
    ? 'borderless'
    : current.display === 'fullscreen' || current.display === 'scaled' ? 'scaled' : 'window';
  let chosenSize = current.windowWidth && current.windowHeight
    ? `${current.windowWidth}x${current.windowHeight}`
    : '';
  let chosenScaling = current.scaling === 'fill' ? 'fill' : 'fit';
  let chosenFilter = current.filter === 'nearest' ? 'nearest' : 'smooth';
  const native = game.native;

  const displayField = document.createElement('div');
  displayField.className = 'field';
  const displayLabel = document.createElement('label');
  displayLabel.textContent = 'Display';
  const displayHint = document.createElement('small');
  displayHint.textContent = native && !native.scalable
    ? `This game draws at ${native.width} × ${native.height} and cannot render larger. Scaled runs it through BitBit, our upscaler: it re-presents the game at the resolution below, at your monitor's refresh rate, with the real cursor.`
    : 'Scaled runs the game through BitBit at the resolution below. Window leaves the game in its own window.';
  displayLabel.append(displayHint);

  const modes = document.createElement('div');
  modes.className = 'segments';
  const modeButtons = {};
  const displayChoices = native && native.scalable
    ? [['scaled', 'Scaled'], ['borderless', 'Borderless'], ['window', 'Window']]
    : [['scaled', 'Scaled'], ['window', 'Window']];
  for (const [value, label] of displayChoices) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.classList.toggle('on', chosenDisplay === value);
    button.addEventListener('click', () => {
      chosenDisplay = value;
      for (const [key, el] of Object.entries(modeButtons)) el.classList.toggle('on', key === value);
    });
    modeButtons[value] = button;
    modes.append(button);
  }
  displayField.append(displayLabel, modes);
  panel.append(displayField);

  /* the resolution changer: Screen follows the monitor, the rest are fixed */
  const resolutionField = document.createElement('div');
  resolutionField.className = 'field';
  const resolutionLabel = document.createElement('label');
  resolutionLabel.textContent = 'Resolution';
  const resolutionHint = document.createElement('small');
  resolutionHint.textContent = 'The size the game is presented at. Screen uses the monitor’s current size.';
  resolutionLabel.append(resolutionHint);

  const resolutions = document.createElement('div');
  resolutions.className = 'segments wrap';
  const sizeButtons = {};
  for (const [value, label] of [
    ['', 'Screen'],
    ['1920x1080', '1920 × 1080'],
    ['1600x900', '1600 × 900'],
    ['1366x768', '1366 × 768'],
    ['1280x720', '1280 × 720'],
    ['1024x768', '1024 × 768'],
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.classList.toggle('on', chosenSize === value);
    button.addEventListener('click', () => {
      chosenSize = value;
      for (const [key, el] of Object.entries(sizeButtons)) el.classList.toggle('on', key === value);
    });
    sizeButtons[value] = button;
    resolutions.append(button);
  }
  resolutionField.append(resolutionLabel, resolutions);
  panel.append(resolutionField);

  /* widescreen: fill stretches to 16:9, fit keeps the game's own shape */
  const scalingField = document.createElement('div');
  scalingField.className = 'field';
  const scalingLabel = document.createElement('label');
  scalingLabel.textContent = 'Shape';
  const scalingHint = document.createElement('small');
  scalingHint.textContent = 'Fit keeps the game’s 4:3 picture with bars at the sides. Fill stretches it to widescreen.';
  scalingLabel.append(scalingHint);

  const scalingModes = document.createElement('div');
  scalingModes.className = 'segments';
  const scalingButtons = {};
  for (const [value, label] of [['fit', 'Fit 4:3'], ['fill', 'Fill 16:9']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.classList.toggle('on', chosenScaling === value);
    button.addEventListener('click', () => {
      chosenScaling = value;
      for (const [key, el] of Object.entries(scalingButtons)) el.classList.toggle('on', key === value);
    });
    scalingButtons[value] = button;
    scalingModes.append(button);
  }
  scalingField.append(scalingLabel, scalingModes);
  panel.append(scalingField);

  /* nearest-neighbour is the fast path for players who see BitBit's smoothing
     as input lag on integrated GPUs */
  const filterField = document.createElement('div');
  filterField.className = 'field';
  const filterLabel = document.createElement('label');
  filterLabel.textContent = 'Scaling quality';
  const filterHint = document.createElement('small');
  filterHint.textContent = 'Smooth uses HALFTONE. Sharp uses nearest-neighbour and is lighter on slower GPUs.';
  filterLabel.append(filterHint);
  const filterModes = document.createElement('div');
  filterModes.className = 'segments';
  const filterButtons = {};
  for (const [value, label] of [['smooth', 'Smooth'], ['nearest', 'Sharp (fast)']]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.classList.toggle('on', chosenFilter === value);
    button.addEventListener('click', () => {
      chosenFilter = value;
      for (const [key, el] of Object.entries(filterButtons)) el.classList.toggle('on', key === value);
    });
    filterButtons[value] = button;
    filterModes.append(button);
  }
  filterField.append(filterLabel, filterModes);
  panel.append(filterField);

  let musicFix = current.musicFix !== false;
  let musicToggle = null;
  let widescreenFix = current.widescreenFix !== false;
  let widescreenToggle = null;
  if (game.id === 'collapse') {
    musicToggle = toggleControl({ value: musicFix, onChange: (value) => { musicFix = value; } });
    settingsRow(
      panel,
      'Continuous mode music fix',
      'Repoints the game’s MUSIC_GAME stream to the Continuous track. The original resources.xml is backed up beside it.',
      musicToggle
    );
    widescreenToggle = toggleControl({ value: widescreenFix, onChange: (value) => { widescreenFix = value; } });
    settingsRow(
      panel,
      'Widescreen content fix',
      'Turns on the engine’s widescreen viewport so the 4:3 canvas no longer gets side bars. The original application.xml is backed up beside it.',
      widescreenToggle
    );
  }

  /* progress and cloud tools */
  const toolsField = document.createElement('div');
  toolsField.className = 'field';
  const toolsLabel = document.createElement('label');
  toolsLabel.textContent = 'Progress & cloud';
  const toolsHint = document.createElement('small');
  toolsHint.textContent = 'Unlock-all uses a timestamped backup. Cloud tools need the server URL in Launcher settings.';
  toolsLabel.append(toolsHint);
  const toolsRow = document.createElement('div');
  toolsRow.className = 'button-row';

  if (game.id === 'super-collapse-3' || game.id === 'collapse') {
    const unlock = document.createElement('button');
    unlock.type = 'button';
    unlock.className = 'btn';
    unlock.textContent = game.id === 'collapse' ? 'Back up & unlock info' : 'Unlock all progress';
    unlock.addEventListener('click', () => runUnlock(game, close));
    toolsRow.append(unlock);
  }

  const backup = document.createElement('button');
  backup.type = 'button';
  backup.className = 'btn';
  backup.textContent = 'Back up save';
  backup.addEventListener('click', async () => {
    backup.disabled = true;
    try {
      const result = await backend.backupSave(game.id);
      if (!result || result.ok === false) throw new Error((result && result.error) || 'Backup failed.');
      toast('Save backed up to the cloud.');
    } catch (error) {
      toast(error.message || 'Could not back up that save.');
    } finally {
      backup.disabled = false;
    }
  });

  const restore = document.createElement('button');
  restore.type = 'button';
  restore.className = 'btn quiet';
  restore.textContent = 'Restore save';
  restore.addEventListener('click', async () => {
    const ok = await askConfirm(
      `Restore the cloud save for ${game.title}?`,
      'A safety copy of the current local save is kept beside the launcher data. The game must be closed.',
      'Restore'
    );
    if (!ok) return;
    restore.disabled = true;
    try {
      const result = await backend.restoreSave(game.id);
      if (!result || result.ok === false) throw new Error((result && result.error) || 'Restore failed.');
      toast(result.message || 'Cloud save restored.');
    } catch (error) {
      toast(error.message || 'Could not restore that save.');
    } finally {
      restore.disabled = false;
    }
  });

  const board = document.createElement('button');
  board.type = 'button';
  board.className = 'btn';
  board.textContent = 'Leaderboard';
  board.addEventListener('click', () => openLeaderboard(game));

  toolsRow.append(backup, restore, board);
  toolsField.append(toolsLabel, toolsRow);
  panel.append(toolsField);

  const adminInput = toggleControl({ value: current.admin, onChange: () => {} });
  settingsRow(
    panel,
    'Run as administrator',
    'Raises a UAC prompt each launch. Some of these games need it to write their save files.',
    adminInput
  );

  const footer = document.createElement('footer');
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'btn quiet';
  reset.textContent = 'Reset';
  const grow = document.createElement('span');
  grow.className = 'grow';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'btn primary';
  save.textContent = 'Save';

  reset.addEventListener('click', () => {
    argsInput.value = '';
    cwdInput.value = '';
    adminInput.checked = false;
    chosenDisplay = 'scaled';
    chosenSize = '';
    chosenScaling = 'fit';
    chosenFilter = 'smooth';
    musicFix = true;
    widescreenFix = true;
    if (musicToggle) musicToggle.checked = true;
    if (widescreenToggle) widescreenToggle.checked = true;
    for (const [key, el] of Object.entries(modeButtons)) el.classList.toggle('on', key === 'scaled');
    for (const [key, el] of Object.entries(sizeButtons)) el.classList.toggle('on', key === '');
    for (const [key, el] of Object.entries(scalingButtons)) el.classList.toggle('on', key === 'fit');
    for (const [key, el] of Object.entries(filterButtons)) el.classList.toggle('on', key === 'smooth');
  });
  cancel.addEventListener('click', close);
  save.addEventListener('click', async () => {
    try {
      const library = await backend.updateGame({
        id: game.id,
        settings: {
          args: argsInput.value.trim(),
          cwd: cwdInput.value.trim() || null,
          admin: adminInput.checked,
          display: chosenDisplay,
          scaling: chosenScaling,
          filter: chosenFilter,
          musicFix,
          widescreenFix,
          windowWidth: chosenSize ? Number(chosenSize.split('x')[0]) : null,
          windowHeight: chosenSize ? Number(chosenSize.split('x')[1]) : null,
        },
      });
      await refresh(library);
      close();
      toast(`${game.title} settings saved.`);
    } catch (error) {
      console.error(error);
      toast('Could not save those settings.');
    }
  });

  footer.append(reset, grow, cancel, save);
  panel.append(footer);
  argsInput.focus();
}

/* ---------------------------------------------------- progress & cloud */
async function runUnlock(game, close) {
  const ok = await askConfirm(
    `Unlock all progress for ${game.title}?`,
    'The launcher writes a timestamped backup first. For Super Collapse! 3 this sets every Quick Play mode to its maximum level. For Collapse! (2009/2010) the save is encrypted; the launcher only makes a backup and tells you how to use the in-game debug menu.',
    'Unlock'
  );
  if (!ok) return;
  try {
    const result = await backend.unlock(game.id);
    if (result && result.ok) {
      toast(result.message || 'Progress unlocked.');
      if (close) close();
    } else {
      toast((result && result.error) || 'Could not unlock that game.');
    }
  } catch (error) {
    toast(error.message || 'Could not unlock that game.');
  }
}

function openLeaderboard(game) {
  let timer = null;
  const { panel, close } = showSheet(
    `${game.title} leaderboard`,
    'Shared scores from the Collapse cloud. Scores are submitted manually because the original save files are encrypted. The list refreshes every 15 seconds.',
    () => clearInterval(timer)
  );
  const list = document.createElement('div');
  list.className = 'score-list';
  list.textContent = 'Loading…';
  panel.append(list);

  const footer = document.createElement('footer');
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.className = 'btn quiet';
  refresh.textContent = 'Refresh';
  const grow = document.createElement('span');
  grow.className = 'grow';
  const submit = document.createElement('button');
  submit.type = 'button';
  submit.className = 'btn primary';
  submit.textContent = 'Submit score';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'btn';
  done.textContent = 'Done';
  done.addEventListener('click', close);
  footer.append(refresh, grow, submit, done);
  panel.append(footer);

  async function load() {
    list.textContent = 'Loading…';
    try {
      const result = await backend.leaderboard({ gameId: game.id });
      const scores = (result && result.scores) || [];
      list.replaceChildren();
      if (!scores.length) {
        const empty = document.createElement('p');
        empty.className = 'score-empty';
        empty.textContent = 'No scores yet — be the first on the board.';
        list.append(empty);
        return;
      }
      scores.forEach((entry, index) => {
        const row = document.createElement('div');
        row.className = 'score-row';
        const rank = document.createElement('b');
        rank.textContent = `${index + 1}.`;
        const who = document.createElement('span');
        who.className = 'who';
        who.textContent = `${entry.player_name || 'Player'} · ${entry.mode || 'Classic'}`;
        const value = document.createElement('strong');
        value.textContent = Number(entry.score || 0).toLocaleString();
        row.append(rank, who, value);
        list.append(row);
      });
    } catch (error) {
      list.textContent = error.message || 'Could not load the leaderboard.';
    }
  }

  refresh.addEventListener('click', load);
  submit.addEventListener('click', async () => {
    const entry = await askScore(game);
    if (!entry) return;
    try {
      const result = await backend.submitScore({ ...entry, gameId: game.id, gameTitle: game.title });
      if (!result || result.ok === false) throw new Error((result && result.error) || 'Score was not accepted.');
      toast('Score submitted.');
      await load();
    } catch (error) {
      toast(error.message || 'Could not submit that score.');
    }
  });

  load();
  timer = setInterval(load, 15000);
}

function askScore(game) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'prompt';
    wrap.innerHTML = `
      <form>
        <p class="msg"></p>
        <label>Mode<input type="text" maxlength="40" value="Classic"></label>
        <label>Score<input type="number" min="0" step="1" value="0"></label>
        <div class="row">
          <button type="button" class="cancel">Cancel</button>
          <button type="submit" class="ok">Submit</button>
        </div>
      </form>`;
    wrap.querySelector('.msg').textContent = `${game.title} — enter the score you just finished with.`;
    document.body.append(wrap);
    const mode = wrap.querySelector('input[type="text"]');
    const score = wrap.querySelector('input[type="number"]');
    mode.focus();
    mode.select();
    const done = (value) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') done(null);
    };
    document.addEventListener('keydown', onKey);
    wrap.querySelector('.cancel').addEventListener('click', () => done(null));
    wrap.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      done({ mode: mode.value.trim() || 'Classic', score: Number(score.value) });
    });
  });
}

/* ---------------------------------------------------------------- wire */
document.getElementById('add-game').addEventListener('click', addGame);
document.getElementById('launcher-settings').addEventListener('click', openLauncherSettings);
window.addEventListener('resize', fitStage);

async function boot() {
  try {
    const saved = await backend.getSettings();
    if (saved) settings = { ...LAUNCHER_DEFAULT_SETTINGS, ...saved };
  } catch (error) {
    console.error(error);
  }
  applyLauncherSettings();

  try {
    await refresh(await backend.getLibrary());
  } catch (error) {
    console.error(error);
    toast('Could not read the game library.');
  }
}

fitStage();
boot();
