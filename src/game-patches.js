'use strict';

const fs = require('fs');
const path = require('path');

/* Collapse! (2009/2010) maps MUSIC_GAME to its menu track. The continuous
   scene has the right stream in resources.xml, but the game starts MUSIC_GAME
   and never hands over to it on this build, so Continuous plays the menu loop.
   Repointing only MUSIC_GAME fixes that without touching the menu tracks. The
   original file is kept beside it and is restored when the option is turned off. */

const COLLAPSE_MUSIC = 'sound/SC4_ContinuousCollapse.ogg';

function collapseResources(gamePath) {
  return path.join(path.dirname(gamePath), 'properties', 'resources.xml');
}

function ensureBackup(xmlPath) {
  const backup = `${xmlPath}.launcher-original`;
  if (!fs.existsSync(backup)) fs.copyFileSync(xmlPath, backup);
  return backup;
}

function setMusicFix(gamePath, enabled) {
  try {
    const xmlPath = collapseResources(gamePath);
    if (!fs.existsSync(xmlPath)) return { ok: false, error: 'Collapse! resources.xml was not found.' };
    const backup = ensureBackup(xmlPath);
    const source = enabled ? fs.readFileSync(xmlPath, 'utf8') : fs.readFileSync(backup, 'utf8');
    const line = /(<Stream\s+file=")[^"]+("(?:\s+[^>]*)?\sid="MUSIC_GAME")/;
    if (!line.test(source)) return { ok: false, error: 'The MUSIC_GAME stream was not found in resources.xml.' };

    const next = source.replace(line, `$1${enabled ? COLLAPSE_MUSIC : 'sound/SC4_Menu_Music.ogg'}$2`);
    if (next !== fs.readFileSync(xmlPath, 'utf8')) fs.writeFileSync(xmlPath, next);
    return { ok: true, patched: enabled, backup };
  } catch (error) {
    return { ok: false, error: `Could not update Collapse! music resources: ${error.message}` };
  }
}

module.exports = { setMusicFix, collapseResources, COLLAPSE_MUSIC };
