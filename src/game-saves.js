'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const SC3_KEY = 'HKCU\\Software\\GameHouse\\SuperCollapseIII';
const SC4_KEY = 'HKCU\\Software\\GameHouse\\Games\\SuperCollapse4';
const SC4_SAVE = 'C:\\ProgramData\\GameHouse\\Games\\SuperCollapse4';

/* Super Collapse! 3 does not derive its Game Parlor locks from the
   *_maxLevel registry values. Its dialog has one locked-overlay branch per
   Quick Play mode and jumps over the unlocked branch when the profile has not
   earned that mode. These are the exact comparisons and jumps in the shipping
   executable. NOPing the jump leaves the dialog on the already-built unlocked
   path, which reveals the mode card and START button. */
const SC3_UNLOCK_PATCHES = [
  { name: 'Classic',    pattern: '663968288bce0f853b010000', jumpOffset: 6, jumpLength: 6 },
  { name: 'Relapse',    pattern: '6639692a8bce0f853b010000', jumpOffset: 6, jumpLength: 6 },
  { name: 'Strategy',   pattern: '6639692c8bce0f853b010000', jumpOffset: 6, jumpLength: 6 },
  { name: 'Puzzle',     pattern: '6639692e8bce756a',         jumpOffset: 6, jumpLength: 2 },
  { name: 'Slider',     pattern: '663969208bce0f853b010000', jumpOffset: 6, jumpLength: 6 },
  { name: 'Continuous', pattern: '663969248bce756a',         jumpOffset: 6, jumpLength: 2 },
  { name: 'Countdown',  pattern: '663969268bce756a',         jumpOffset: 6, jumpLength: 2 },
];

function hexBuffer(hex) {
  return Buffer.from(hex, 'hex');
}

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, error: error ? String(stderr || error.message).trim() : '', stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupDir(dataDir, prefix) {
  const dir = path.join(dataDir, 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `${prefix}-${timestamp()}`);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function copyFileSafe(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(source, dest);
}

function walkFiles(root, current = root, out = []) {
  if (!fs.existsSync(current)) return out;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) walkFiles(root, full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function sc3Profiles() {
  const script =
    "$base = 'HKCU:\\Software\\GameHouse\\SuperCollapseIII'; " +
    "if (Test-Path $base) { Get-ChildItem $base -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.PSChildName -ne 'userdata' } | Select-Object -ExpandProperty PSChildName }";
  const result = await run('powershell.exe', ['-NoProfile', '-Command', script]);
  return result.ok ? result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

async function exportRegistry(key, file) {
  return run('reg.exe', ['export', key, file, '/y']);
}

async function unlockSc3(game, dataDir) {
  if (!game || !game.path || !fs.existsSync(game.path)) {
    return { ok: false, error: 'The Super Collapse! 3 executable was not found.' };
  }

  const original = `${game.path}.launcher-original`;
  try {
    if (!fs.existsSync(original)) fs.copyFileSync(game.path, original);
  } catch (error) {
    return { ok: false, error: `Could not back up Super Collapse! 3 before patching it: ${error.message}` };
  }

  let patched = 0;
  let alreadyPatched = 0;
  try {
    const buffer = fs.readFileSync(game.path);
    const next = Buffer.from(buffer);
    const found = [];
    for (const patch of SC3_UNLOCK_PATCHES) {
      const pattern = hexBuffer(patch.pattern);
      const at = next.indexOf(pattern);
      if (at >= 0) {
        found.push({ ...patch, at });
        continue;
      }
      // A previous unlock already NOPed this jump. Recognise it so the action
      // is idempotent instead of reporting an unsupported executable.
      const prefix = pattern.subarray(0, patch.jumpOffset);
      const prefixAt = next.indexOf(prefix);
      const jumpAt = prefixAt >= 0 ? prefixAt + patch.jumpOffset : -1;
      const jump = jumpAt >= 0 ? next.subarray(jumpAt, jumpAt + patch.jumpLength) : null;
      if (jump && jump.length === patch.jumpLength && jump.every((byte) => byte === 0x90)) {
        alreadyPatched++;
        continue;
      }
      return { ok: false, error: `This Super Collapse! 3 build does not match the unlock patch (${patch.name}).` };
    }

    for (const patch of found) {
      const jumpAt = patch.at + patch.jumpOffset;
      next.fill(0x90, jumpAt, jumpAt + patch.jumpLength);
      patched++;
    }
    if (patched) fs.writeFileSync(game.path, next);
  } catch (error) {
    return { ok: false, error: `Could not patch Super Collapse! 3. Close the game and try again. (${error.message})` };
  }

  const profiles = await sc3Profiles();
  let registryBackup = null;
  if (profiles.length) {
    const folder = backupDir(dataDir, 'super-collapse-3-registry');
    registryBackup = path.join(folder, 'SuperCollapseIII.reg');
    const exported = await exportRegistry(SC3_KEY, registryBackup);
    if (!exported.ok) registryBackup = null;
  }

  return {
    ok: true,
    message: alreadyPatched && !patched
      ? 'Every Quick Play mode is already unlocked.'
      : 'Unlocked every Quick Play mode. Restart the game if it is open.',
    backup: original,
    registryBackup,
    profiles,
    patched,
  };
}

async function backupCollapse(dataDir) {
  const folder = backupDir(dataDir, 'collapse-2010-save');
  let copied = 0;
  if (fs.existsSync(SC4_SAVE)) {
    for (const file of walkFiles(SC4_SAVE)) {
      const relative = path.relative(SC4_SAVE, file);
      copyFileSafe(file, path.join(folder, 'save', relative));
      copied++;
    }
  }
  const registry = await exportRegistry(SC4_KEY, path.join(folder, 'SuperCollapse4.reg'));
  return { folder, copied, registry: registry.ok, backup: folder };
}

async function unlockGame(game, dataDir) {
  if (!game) return { ok: false, error: 'That game is not in the library.' };
  if (game.id === 'super-collapse-3') return unlockSc3(game, dataDir);
  if (game.id === 'collapse') {
    const backup = await backupCollapse(dataDir);
    return {
      ok: false,
      backedUp: true,
      backup: backup.folder,
      error:
        'Collapse! (2009/2010) keeps its progress in an encrypted players.plrs file. ' +
        'The launcher backed up the save but will not overwrite that encrypted file. ' +
        'The game has a debug menu on its main screen; progress can be unlocked there without corrupting the save.',
    };
  }
  return { ok: false, error: 'Unlock-all is only available for Super Collapse! 3 and Collapse! (2009/2010).' };
}

async function collectSave(game, dataDir, tempDir) {
  if (!game) return { files: [], label: '' };
  if (game.id === 'super-collapse-3') {
    const file = path.join(tempDir, 'SuperCollapseIII.reg');
    const exported = await exportRegistry(SC3_KEY, file);
    if (!exported.ok) throw new Error(`Could not export the Super Collapse! 3 registry: ${exported.error}`);
    return { label: 'Super Collapse! 3 registry profile', files: [{ name: 'SuperCollapseIII.reg', data: fs.readFileSync(file) }] };
  }
  if (game.id === 'collapse') {
    const files = [];
    if (fs.existsSync(SC4_SAVE)) {
      for (const file of walkFiles(SC4_SAVE)) {
        const relative = path.relative(SC4_SAVE, file).split(path.sep).join('/');
        files.push({ name: `save/${relative}`, data: fs.readFileSync(file) });
      }
    }
    const registryFile = path.join(tempDir, 'SuperCollapse4.reg');
    if ((await exportRegistry(SC4_KEY, registryFile)).ok) {
      files.push({ name: 'SuperCollapse4.reg', data: fs.readFileSync(registryFile) });
    }
    return { label: 'Collapse! (2009/2010) save files', files };
  }
  return { files: [], label: game.title || game.id };
}

async function restoreSave(game, dataDir, payload) {
  if (!game) return { ok: false, error: 'That game is not in the library.' };
  const files = payload && Array.isArray(payload.files) ? payload.files : [];
  if (!files.length) return { ok: false, error: 'The cloud backup is empty.' };

  const safety = await backupDir(dataDir, `${game.id}-before-restore`);
  if (game.id === 'collapse' && fs.existsSync(SC4_SAVE)) {
    for (const file of walkFiles(SC4_SAVE)) {
      copyFileSafe(file, path.join(safety, 'save', path.relative(SC4_SAVE, file)));
    }
  }
  if (game.id === 'super-collapse-3') await exportRegistry(SC3_KEY, path.join(safety, 'SuperCollapseIII.reg'));

  for (const entry of files) {
    const name = String(entry.name || '');
    const data = Buffer.from(String(entry.data || ''), 'base64');
    if (!data.length) continue;
    if (name.toLowerCase().endsWith('.reg')) {
      const temp = path.join(os.tmpdir(), `collapse-restore-${Date.now()}.reg`);
      fs.writeFileSync(temp, data);
      const imported = await run('reg.exe', ['import', temp]);
      try { fs.unlinkSync(temp); } catch {}
      if (!imported.ok) return { ok: false, error: `Could not restore the registry: ${imported.error}`, safety: safety };
    } else if (game.id === 'collapse') {
      const relative = name.replace(/^save\//, '');
      const target = path.join(SC4_SAVE, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }
  return { ok: true, safety: safety, message: 'Cloud save restored. A safety copy of the old save was kept.' };
}

async function saveInfo(game) {
  if (!game) return { supported: false };
  if (game.id === 'super-collapse-3') {
    return { supported: true, label: 'Super Collapse! 3 registry profile', files: (await sc3Profiles()).map((p) => `${p} (registry)`) };
  }
  if (game.id === 'collapse') {
    return { supported: true, label: 'Collapse! save folder', files: fs.existsSync(SC4_SAVE) ? walkFiles(SC4_SAVE).map((f) => path.relative(SC4_SAVE, f)) : [] };
  }
  return { supported: false, label: game.title || game.id, files: [] };
}

module.exports = {
  unlockGame,
  collectSave,
  restoreSave,
  saveInfo,
  backupCollapse,
  SC3_KEY,
  SC4_KEY,
  SC4_SAVE,
};
