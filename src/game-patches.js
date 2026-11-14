'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* Collapse! (2009/2010) has a scene named scenegamecontinuous whose music is
   SC4_ContinuousCollapse.ogg, but its music switch has no case for single
   Continuous. It therefore leaves the previous music playing, which is the
   menu loop in Quick Play. The game binary is patched so that case reuses the
   existing double-Continuous setup with the single-Continuous scene name.

   The original executable is kept beside it as a .launcher-original backup and
   is restored when the option is turned off. resources.xml is also restored to
   its menu track, because the old launcher's MUSIC_GAME workaround is no longer
   needed and would otherwise change music outside Continuous. */

const COLLAPSE_MUSIC = 'sound/SC4_ContinuousCollapse.ogg';
const COLLAPSE_MENU = 'sound/SC4_Menu_Music.ogg';
const ORIGINAL_EXE_SHA256 = 'e8334fa2cdcc28cdb11d6df9673bfc72d8765f9da016035b56fcf72784c89077';

// Addresses and byte lengths for the shipping Collapse! executable.
const PATCH = {
  imageBase: 0x400000,
  blockVa: 0x497102,
  blockEndVa: 0x4971b8,
  jumpEntryVa: 0x4971f4,
  singleSectionNameVa: 0x757574,
  caveVa: 0x7b4300,
  caveOffsetWithinRdata: 0x9c300,
  patchedRdataVirtualSize: 0x9c400,
  caveMaxLength: 0x100,
  caveDataLength: 0xbb,
  executedSectionFlag: 0x20000000,
  // Relative call instructions inside the copied Double Continuous block.
  callOffsets: [0x0c, 0x28, 0x54, 0x5f, 0x7f, 0x8e, 0x9e, 0xaa],
};

function collapseResources(gamePath) {
  return path.join(path.dirname(gamePath), 'properties', 'resources.xml');
}

function collapseApplication(gamePath) {
  return path.join(path.dirname(gamePath), 'properties', 'application.xml');
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ensureBackup(xmlPath) {
  const backup = `${xmlPath}.launcher-original`;
  if (!fs.existsSync(backup)) fs.copyFileSync(xmlPath, backup);
  return backup;
}

function findSectionHeader(buffer, wanted) {
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') return -1;
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 24 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) return -1;
  const count = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  let header = peOffset + 24 + optionalSize;
  for (let i = 0; i < count; i += 1) {
    if (header + 40 > buffer.length) return -1;
    const name = buffer.toString('ascii', header, header + 8).replace(/\0.*$/, '');
    if (name === wanted) return header;
    header += 40;
  }
  return -1;
}

function sectionDetails(buffer, header) {
  return {
    va: buffer.readUInt32LE(header + 12),
    rawSize: buffer.readUInt32LE(header + 16),
    rawOffset: buffer.readUInt32LE(header + 20),
    characteristics: buffer.readUInt32LE(header + 36),
  };
}

function isPatchedExecutable(buffer) {
  try {
    const textHeader = findSectionHeader(buffer, '.text');
    const rdataHeader = findSectionHeader(buffer, '.rdata');
    if (textHeader < 0 || rdataHeader < 0) return false;
    const text = sectionDetails(buffer, textHeader);
    const rdata = sectionDetails(buffer, rdataHeader);
    const jumpEntry = text.rawOffset + (PATCH.jumpEntryVa - (PATCH.imageBase + text.va));
    const cave = rdata.rawOffset + PATCH.caveOffsetWithinRdata;
    if (jumpEntry + 4 > buffer.length || cave + 5 > buffer.length) return false;
    return buffer.readUInt32LE(jumpEntry) === PATCH.caveVa &&
      buffer[cave] === 0x68 &&
      buffer[cave + 1] === 0x74 &&
      buffer[cave + 2] === 0x75 &&
      buffer[cave + 3] === 0x75;
  } catch {
    return false;
  }
}

function buildPatchedExecutable(original) {
  if (hashFileBuffer(original) !== ORIGINAL_EXE_SHA256) {
    throw new Error('This is not the Collapse! build the launcher knows how to patch.');
  }

  const textHeader = findSectionHeader(original, '.text');
  const rdataHeader = findSectionHeader(original, '.rdata');
  if (textHeader < 0 || rdataHeader < 0) {
    throw new Error('The Collapse! executable has no .text/.rdata sections to patch.');
  }

  const text = sectionDetails(original, textHeader);
  const rdata = sectionDetails(original, rdataHeader);
  const blockOffset = text.rawOffset + (PATCH.blockVa - (PATCH.imageBase + text.va));
  const jumpEntryOffset = text.rawOffset + (PATCH.jumpEntryVa - (PATCH.imageBase + text.va));
  const caveOffset = rdata.rawOffset + PATCH.caveOffsetWithinRdata;

  if (blockOffset < 0 || jumpEntryOffset + 4 > original.length || caveOffset + PATCH.caveMaxLength > original.length) {
    throw new Error('The Collapse! executable layout does not match the supported build.');
  }
  if (original[blockOffset] !== 0x68 || original.readUInt32LE(blockOffset + 1) !== 0x7575b0) {
    throw new Error('The Double Continuous music block was not found where expected.');
  }
  if (original.readUInt32LE(jumpEntryOffset) !== 0x4971bd) {
    throw new Error('The Continuous switch entry was not found where expected.');
  }

  const patched = Buffer.from(original);
  const block = Buffer.from(original.subarray(blockOffset, blockOffset + (PATCH.blockEndVa - PATCH.blockVa)));
  if (block.length !== 0xb6) throw new Error('The copied music block has an unexpected size.');

  block.writeUInt32LE(PATCH.singleSectionNameVa, 1);
  const delta = PATCH.caveVa - PATCH.blockVa;
  for (const callOffset of PATCH.callOffsets) {
    if (block[callOffset] !== 0xe8) throw new Error('A music-block call has moved.');
    const oldRelative = block.readInt32LE(callOffset + 1);
    block.writeInt32LE(oldRelative - delta, callOffset + 1);
  }

  const jump = Buffer.alloc(5);
  jump[0] = 0xe9;
  jump.writeInt32LE(PATCH.blockEndVa - (PATCH.caveVa + block.length + 5), 1);
  const cave = Buffer.concat([block, jump]);
  if (cave.length > PATCH.caveMaxLength) throw new Error('The Continuous music patch is too large.');

  for (let i = 0; i < cave.length; i += 1) {
    if (patched[caveOffset + i] !== 0) throw new Error('The Collapse! code cave is not empty.');
  }

  cave.copy(patched, caveOffset);
  patched.writeUInt32LE(PATCH.caveVa, jumpEntryOffset);
  patched.writeUInt32LE(PATCH.patchedRdataVirtualSize, rdataHeader + 8);
  patched.writeUInt32LE((rdata.characteristics | PATCH.executedSectionFlag) >>> 0, rdataHeader + 36);
  return patched;
}

function hashFileBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function executableBackup(exePath) {
  return `${exePath}.launcher-original`;
}

/* Applies or removes the executable-side Continuous music fix. The backup is
   only replaced when the current file is the untouched supported build. */
function setExecutableFix(exePath, enabled) {
  if (!fs.existsSync(exePath)) {
    return { ok: false, error: 'Collapse! executable was not found.' };
  }

  const backup = executableBackup(exePath);
  const backupExists = fs.existsSync(backup);
  if (backupExists && hashFile(backup) !== ORIGINAL_EXE_SHA256) {
    return { ok: false, error: 'The Collapse! executable backup is not the expected original build.' };
  }

  const current = fs.readFileSync(exePath);
  const currentHash = hashFileBuffer(current);
  const patched = isPatchedExecutable(current);

  if (!enabled) {
    if (!patched) {
      if (currentHash === ORIGINAL_EXE_SHA256) return { ok: true, patched: false, backup: backupExists ? backup : null };
      return { ok: false, error: 'The Collapse! executable is modified and cannot be restored automatically.' };
    }
    if (!backupExists) return { ok: false, error: 'The original Collapse! executable backup is missing.' };
    fs.copyFileSync(backup, exePath);
    return { ok: true, patched: false, restored: true, backup };
  }

  if (patched) return { ok: true, patched: true, backup: backupExists ? backup : null };
  if (currentHash !== ORIGINAL_EXE_SHA256) {
    return { ok: false, error: 'This Collapse! executable is not the supported original build.' };
  }

  if (!backupExists) fs.copyFileSync(exePath, backup);
  const next = buildPatchedExecutable(current);
  fs.writeFileSync(exePath, next);
  return { ok: true, patched: true, backup };
}

/* The old workaround changed MUSIC_GAME to Continuous. Restore that one entry
   to the menu track; the executable patch now starts the Continuous stream for
   the mode that needs it. Other custom resource edits are left alone. */
function restoreMusicResource(xmlPath) {
  const current = fs.readFileSync(xmlPath, 'utf8');
  const line = /(<Stream\s+file=")[^"]+("(?:\s+[^>]*)?\sid="MUSIC_GAME")/;
  if (!line.test(current)) return { ok: false, error: 'The MUSIC_GAME stream was not found in resources.xml.' };

  const backup = ensureBackup(xmlPath);
  const next = current.replace(line, `$1${COLLAPSE_MENU}$2`);
  if (next !== current) fs.writeFileSync(xmlPath, next);
  return { ok: true, backup };
}

function setMusicFix(gamePath, enabled) {
  try {
    const exePath = path.resolve(gamePath);
    const xmlPath = collapseResources(exePath);
    if (!fs.existsSync(xmlPath)) return { ok: false, error: 'Collapse! resources.xml was not found.' };

    const exeResult = setExecutableFix(exePath, enabled);
    if (!exeResult.ok) return exeResult;
    const resourceResult = restoreMusicResource(xmlPath);
    if (!resourceResult.ok) return resourceResult;

    return {
      ok: true,
      patched: Boolean(enabled),
      backup: exeResult.backup,
      resourcesBackup: resourceResult.backup,
    };
  } catch (error) {
    return { ok: false, error: `Could not update Collapse! music: ${error.message}` };
  }
}

/* Older launcher builds patched Collapse! to start at 1920x1080. Its engine
   still renders a 1024-pixel-wide canvas, so that leaves the game in the left
   strip of the window. Restore the untouched application.xml before launch. */
function restoreCollapseApplication(gamePath) {
  try {
    const xmlPath = collapseApplication(gamePath);
    const backup = `${xmlPath}.launcher-original`;
    if (!fs.existsSync(xmlPath) || !fs.existsSync(backup)) {
      return { ok: true, restored: false };
    }
    const current = fs.readFileSync(xmlPath, 'utf8');
    const original = fs.readFileSync(backup, 'utf8');
    if (current === original) return { ok: true, restored: false, backup };
    fs.writeFileSync(xmlPath, original);
    return { ok: true, restored: true, backup };
  } catch (error) {
    return { ok: false, error: `Could not restore Collapse! application.xml: ${error.message}` };
  }
}

module.exports = {
  setMusicFix,
  restoreCollapseApplication,
  collapseResources,
  collapseApplication,
  COLLAPSE_MUSIC,
};
