'use strict';

/* Checks that the launcher starts a game the way these old titles expect:
   detached, with the game's own folder as the working directory — plus the
   per-game settings: launch arguments and a working-folder override. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchExecutable } = require('../src/game-process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collapse-launch-'));
const subDir = path.join(dir, 'run-from-here');
fs.mkdirSync(subDir);

const cwdMarker = path.join(dir, 'ran.txt');
const cwdGame = path.join(dir, 'FakeGame.cmd');
fs.writeFileSync(cwdGame, '@echo off\r\ncd > "' + cwdMarker + '"\r\n');

const argsMarker = path.join(dir, 'args.txt');
const argsGame = path.join(dir, 'ArgsGame.cmd');
fs.writeFileSync(argsGame, '@echo off\r\ncd > "' + argsMarker + '"\r\necho %~1 >> "' + argsMarker + '"\r\necho %~2 >> "' + argsMarker + '"\r\n');

let failures = 0;
const check = (name, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${condition || !detail ? '' : ` (${detail})`}`);
  if (!condition) failures++;
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(file, timeout = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (fs.existsSync(file)) return true;
    await delay(100);
  }
  return false;
}

async function main() {
  check('missing path is reported, not thrown', launchExecutable(path.join(dir, 'nope.exe')).ok === false);
  check('empty path is reported', launchExecutable('').ok === false);

  check('existing file launches', launchExecutable(cwdGame).ok === true);
  check('the game actually starts', await waitFor(cwdMarker));

  const cwd = fs.existsSync(cwdMarker) ? fs.readFileSync(cwdMarker, 'utf8').trim() : '';
  check('starts with the game folder as cwd', path.resolve(cwd) === path.resolve(dir), cwd);

  // quoted arguments stay one argument; the rest are split on spaces
  launchExecutable(argsGame, { args: '"one two" three' });
  check('launch arguments reach the game', await waitFor(argsMarker));
  // `echo %~1 >> file` leaves one trailing space in the file; trim each line
  const lines = fs.existsSync(argsMarker)
    ? fs.readFileSync(argsMarker, 'utf8').trim().split(/\r?\n/).map((line) => line.trim())
    : [];
  check('argument order is kept', lines[1] === 'one two' && lines[2] === 'three', JSON.stringify(lines));
  check('default working folder is still the game folder', path.resolve(lines[0] || '') === path.resolve(dir), lines[0]);

  // a working-folder override is honoured
  fs.rmSync(argsMarker, { force: true });
  launchExecutable(argsGame, { args: 'x', cwd: subDir });
  check('override launches', await waitFor(argsMarker));
  const overrideCwd = fs.existsSync(argsMarker) ? fs.readFileSync(argsMarker, 'utf8').trim().split(/\r?\n/)[0] : '';
  check('working folder override is used', path.resolve(overrideCwd) === path.resolve(subDir), overrideCwd);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main();
