'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const logger = require('./logger');

/**
 * Windows cannot start a file that lives inside app.asar, so the build keeps
 * the helper tools unpacked beside it (see "asarUnpack" in package.json) and
 * this maps the in-archive path onto that copy.
 */
function onDisk(target) {
  const marker = `app.asar${path.sep}`;
  return target.includes(marker) ? target.replace(marker, `app.asar.unpacked${path.sep}`) : target;
}

function errorDetails(error) {
  if (!error) return null;
  return {
    message: error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path,
  };
}

function childStdio() {
  const fd = logger.outputHandle();
  return ['ignore', fd, fd];
}

function attachProcessLogging(child, context) {
  child.on('spawn', () => logger.log('process spawned', { ...context, pid: child.pid }));
  child.on('error', (error) => logger.error('process error', {
    ...context,
    pid: child.pid,
    error: errorDetails(error),
  }));
  child.on('exit', (code, signal) => logger.log('process exited', {
    ...context,
    pid: child.pid,
    code,
    signal,
  }));
  return child;
}

/**
 * Starts a game executable detached from the launcher.
 *
 * All of these titles are old enough that their own trial wrappers are the
 * fragile part, not the games: the launcher therefore points at the game
 * binary itself wherever that is possible (see README, "Trial wrappers").
 */

/** Reads a PE image's section names, cheaply. */
function sectionNames(exePath) {
  let fd;
  try {
    fd = fs.openSync(exePath, 'r');
    const head = Buffer.alloc(4096);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    if (read < 0x40 || head.toString('latin1', 0, 2) !== 'MZ') return [];
    const pe = head.readUInt32LE(0x3c);
    if (pe + 24 > read || head.toString('latin1', pe, pe + 2) !== 'PE') return [];
    const count = head.readUInt16LE(pe + 6);
    const optSize = head.readUInt16LE(pe + 20);
    const names = [];
    for (let i = 0; i < count; i++) {
      const at = pe + 24 + optSize + i * 40;
      if (at + 8 > read) break;
      names.push(head.toString('latin1', at, at + 8).replace(/\0+$/, ''));
    }
    return names;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * ASProtect-packed executables cannot unpack on current Windows: their stub
 * decodes the real game into a buffer and then dies before any of it runs.
 * The 2003 GameHouse trial of Super Collapse! is one of these, and the section
 * table is enough to recognise it (`Collapse.exe` keeps an `.adata` section and
 * blank names for the original ones).
 */
function packerBlocker(exePath) {
  const names = sectionNames(exePath);
  if (!names.some((name) => name === '.adata')) return null;
  logger.warn('executable blocked by ASProtect', { exePath, sections: names });
  return {
    ok: false,
    error:
      'This copy is packed with ASProtect, a 2003 protector that cannot unpack on ' +
      'Windows 11 — the game code never loads. The 2002 GameHouse build in ' +
      '"Super Collapse!/Collapse.exe" runs fine; use Locate to point this tile at it.',
  };
}

/** Splits a command-line string, honouring double and single quotes. */
function parseArgs(text) {
  if (!text || !String(text).trim()) return [];
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(String(text))) !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
  }
  return out;
}

/** Where the game should run from: an override, else the folder holding it. */
function workingDirectory(exePath, options) {
  if (options && options.cwd && fs.existsSync(options.cwd)) return options.cwd;
  return path.dirname(exePath);
}

/**
 * Starts the game as administrator through PowerShell's Start-Process, which
 * raises the usual UAC prompt. Values travel through the environment so no
 * quoting of the path or arguments is needed.
 */
function launchElevated(exePath, args, cwd) {
  const script =
    '$r = Start-Process -FilePath $env:LAUNCH_EXE -WorkingDirectory $env:LAUNCH_CWD' +
    ' -ArgumentList $env:LAUNCH_ARGS -Verb RunAs -PassThru; $r.WaitForExit()';
  logger.log('starting elevated launch', { executable: exePath, cwd, arguments: args });
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    env: {
      ...process.env,
      LAUNCH_EXE: exePath,
      LAUNCH_CWD: cwd,
      LAUNCH_ARGS: args.join(' '),
    },
    detached: true,
    stdio: childStdio(),
    windowsHide: true,
  });
  attachProcessLogging(child, { kind: 'elevated-launch', executable: exePath, cwd });
  child.unref();
  return child;
}

/** Starts the game detached, with the game's folder as the working directory. */
function launchPlain(exePath, options) {
  const args = parseArgs(options && options.args);
  const cwd = workingDirectory(exePath, options);
  const isScript = ['.bat', '.cmd'].includes(path.extname(exePath).toLowerCase());

  if (options && options.admin) return launchElevated(exePath, args, cwd);

  logger.log('starting game', {
    kind: isScript ? 'script-launch' : 'game-launch',
    executable: exePath,
    arguments: args,
    cwd,
    admin: Boolean(options && options.admin),
  });
  const child = isScript
    ? spawn('cmd.exe', ['/c', exePath, ...args], {
        cwd,
        detached: true,
        stdio: childStdio(),
        windowsHide: true,
      })
    : spawn(exePath, args, { cwd, detached: true, stdio: childStdio() });
  attachProcessLogging(child, {
    kind: isScript ? 'script-launch' : 'game-launch',
    executable: exePath,
    cwd,
    arguments: args,
  });
  if (!isScript && options && options.fps !== false) startFpsOverlay(child.pid);
  child.unref();
  return child;
}

/**
 * Starts a game executable detached from the launcher.
 * The working directory matters: these games load assets relative to it.
 */
function launchExecutable(exePath, options = {}) {
  if (!exePath) {
    logger.warn('launch rejected: no executable is set');
    return { ok: false, error: 'No executable is set for this game.' };
  }
  if (!fs.existsSync(exePath)) {
    logger.warn('launch rejected: executable is missing', { exePath });
    return { ok: false, error: 'That file is missing. Use Locate to point the launcher at it.' };
  }

  const blocked = packerBlocker(exePath);
  if (blocked) return blocked;

  try {
    const child = launchPlain(exePath, options);
    return { ok: true, pid: child.pid };
  } catch (error) {
    logger.error('plain launch threw', { exePath, error: errorDetails(error) });
    return { ok: false, error: error.message };
  }
}

/* BitBit is our own little dgVoodoo: it presents a fixed-resolution game at a
   modern resolution, at the monitor's refresh rate, with the real cursor. */
const SCALER = onDisk(path.join(__dirname, '..', 'tools', 'bitbit', 'BitBit.exe'));

function scalerAvailable() {
  return fs.existsSync(SCALER);
}

/** Keeps the FPS readout in a separate, click-through overlay for native modes. */
function startFpsOverlay(pid) {
  if (!pid) return;
  const overlay = onDisk(path.join(__dirname, '..', 'tools', 'fps', 'FpsOverlay.exe'));
  if (!fs.existsSync(overlay)) return;
  try {
    const child = spawn(overlay, ['--pid', String(pid)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    logger.log('FPS overlay started', { gamePid: pid, overlay });
  } catch (error) {
    logger.warn('could not start FPS overlay', { gamePid: pid, error: error.message });
  }
}

/**
 * Starts a game through BitBit at a chosen resolution.
 * `windowWidth`/`windowHeight` is the presentation size (null = whole screen)
 * and `scaling` picks letterboxed ('fit') or stretched widescreen ('fill').
 */
function launchScaled(exePath, options = {}) {
  if (!scalerAvailable()) {
    return { ok: false, error: 'The upscaler (tools/bitbit/BitBit.exe) is missing.' };
  }

  const args = parseArgs(options.args);
  const cwd = workingDirectory(exePath, options);
  const scalerArgs = ['--exe', exePath, '--cwd', cwd];
  if (args.length) scalerArgs.push('--args', args.join(' '));
  if (options.windowWidth && options.windowHeight) {
    scalerArgs.push('--width', String(options.windowWidth), '--height', String(options.windowHeight));
  }
  if (options.scaling === 'fill') scalerArgs.push('--stretch');
  if (options.filter === 'nearest') scalerArgs.push('--nearest');
  if (options.fps !== false) scalerArgs.push('--fps');

  try {
    logger.log('starting BitBit', { scaler: SCALER, executable: exePath, arguments: scalerArgs, cwd });
    const child = spawn(SCALER, scalerArgs, {
      cwd,
      detached: true,
      stdio: childStdio(),
      windowsHide: true,
    });
    attachProcessLogging(child, { kind: 'bitbit', executable: exePath, cwd });
    // BitBit restores the cursor scheme itself; this covers a crash
    child.on('exit', () => {
      try {
        spawn(SCALER, ['--restore-cursors'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } catch { /* nothing to recover */ }
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    logger.error('BitBit launch threw', { exePath, error: errorDetails(error) });
    return { ok: false, error: error.message };
  }
}

/**
 * Starts a game through the display helper. Window mode leaves a normal
 * resizable window; borderless mode strips the frame and fills the requested
 * size (or the screen).
 */
function launchDisplayHelper(exePath, options, mode) {
  const cwd = workingDirectory(exePath, options);
  const psArgs = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', onDisk(path.join(__dirname, '..', 'tools', 'fullscreen-launch.ps1')),
    '-Exe', exePath,
    '-Mode', mode,
    '-WorkingDirectory', cwd,
  ];
  if (options.windowWidth && options.windowHeight) {
    const widthFlag = mode === 'window' ? '-WindowWidth' : '-Width';
    const heightFlag = mode === 'window' ? '-WindowHeight' : '-Height';
    psArgs.push(widthFlag, String(options.windowWidth), heightFlag, String(options.windowHeight));
  }
  const args = parseArgs(options.args);
  if (args.length) psArgs.push('-Arguments', args.join(' '));
  if (options.fps !== false) psArgs.push('-Fps');

  try {
    logger.log('starting display helper', { executable: exePath, arguments: psArgs, mode });
    const child = spawn('powershell.exe', psArgs, {
      cwd,
      // PowerShell 5.1 exits immediately when started detached without a
      // console, before it can run the script. Keep the helper attached; it
      // still lives independently of the launcher window.
      detached: false,
      stdio: childStdio(),
      windowsHide: true,
    });
    attachProcessLogging(child, { kind: 'display-helper', executable: exePath, mode });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (error) {
    logger.error('display helper launch threw', { exePath, error: errorDetails(error) });
    return { ok: false, error: error.message };
  }
}

function launchWindowed(exePath, options = {}) {
  return launchDisplayHelper(exePath, options, 'window');
}

function launchBorderless(exePath, options = {}) {
  return launchDisplayHelper(exePath, options, 'borderless');
}

/**
 * Native fullscreen: switch the desktop to the game's own mode and let the
 * display scale it. This avoids BitBit entirely, which is the reliable path
 * for the GameHouse engines when their cursor handling fights the sliding
 * window.
 */
function launchFullscreen(exePath, options = {}) {
  const native = options.native || {};
  return launchDisplayHelper(exePath, {
    ...options,
    windowWidth: native.width || options.nativeWidth || 800,
    windowHeight: native.height || options.nativeHeight || 600,
  }, 'fullscreen');
}

/** Runs a game the way its per-game settings ask for. */
function launchWithDisplay(exePath, options = {}) {
  if (!exePath) {
    logger.warn('display launch rejected: no executable is set');
    return { ok: false, error: 'No executable is set for this game.' };
  }
  if (!fs.existsSync(exePath)) {
    logger.warn('display launch rejected: executable is missing', { exePath });
    return { ok: false, error: 'That file is missing. Use Locate to point the launcher at it.' };
  }

  const blocked = packerBlocker(exePath);
  if (blocked) return blocked;

  const wantsScaled = options.display === 'scaled' || options.display === 'fullscreen';
  if (wantsScaled) return launchScaled(exePath, options);
  if (options.display === 'native') return launchFullscreen(exePath, options);
  if (options.display === 'borderless') return launchBorderless(exePath, options);
  return launchWindowed(exePath, options);
}

module.exports = { launchExecutable, launchWithDisplay, launchScaled, scalerAvailable };
