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
  caveDataLength: 0xf2,
  // Continuous starts its board before the level-load music switch. Play the
  // puzzle board drop-in sample at the top of both Continuous music blocks.
  // The sample is declared in the always-loaded scenegamebase section.
  dropInSoundSectionVa: 0x7495a0,
  dropInSoundSectionLength: 0x0d,
  dropInSoundSectionLengthVa: 0x44b8ba,
  dropInSoundSectionNameVa: 0x44b8c3,
  dropInSoundFunctionVa: 0x44b880,
  doubleSectionNameVa: 0x7575b0,
  singleHelperOffset: 0xbb,
  doubleHelperOffset: 0xc8,
  soundHelperOffset: 0xdc,
  executedSectionFlag: 0x20000000,
  // The game's music switch. Unlike a direct Sound::play call this stops the
  // previous track and registers the new one with the scene/music manager, so
  // leaving the game returns to Quick Play's menu track instead of bleeding
  // the Continuous loop into the menu.
  musicManagerVa: 0x59eca0,
  // Relative call instructions inside the copied Double Continuous block.
  // The call at 0x7f is replaced by the music-manager switch below.
  callOffsets: [0x0c, 0x28, 0x54, 0x5f, 0x8e, 0x9e, 0xaa],
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
      (buffer[cave] === 0x68 || buffer[cave] === 0xe8);
  } catch {
    return false;
  }
}

/* Version two uses the music-manager switch. Version one used a direct
   Sound::play tail and must be rebuilt so existing installs get the stop fix. */
function isCurrentMusicPatch(buffer) {
  try {
    const rdataHeader = findSectionHeader(buffer, '.rdata');
    if (rdataHeader < 0) return false;
    const rdata = sectionDetails(buffer, rdataHeader);
    const cave = rdata.rawOffset + PATCH.caveOffsetWithinRdata;
    return buffer[cave] === 0x68 &&
      buffer[cave + 1] === 0x74 &&
      buffer[cave + 2] === 0x75 &&
      buffer[cave + 3] === 0x75 &&
      buffer[cave + 0x6c] === 0x90 &&
      buffer[cave + 0x6d] === 0x90 &&
      buffer[cave + 0x73] === 0x68 &&
      buffer[cave + 0x82] === 0x90 &&
      buffer[cave + 0x83] === 0x90 &&
      buffer[cave + PATCH.singleHelperOffset] === 0xe8 &&
      buffer[cave + PATCH.doubleHelperOffset] === 0x68 &&
      buffer[cave + PATCH.soundHelperOffset] === 0x9c &&
      buffer[cave + PATCH.soundHelperOffset + 0x15] === 0xc3;
  } catch {
    return false;
  }
}

function writeCall(buffer, offset, targetVa, nextVa) {
  buffer[offset] = 0xe8;
  buffer.writeInt32LE(targetVa - nextVa, offset + 1);
}

/* Two tiny call gates at the top of each Continuous music block. They push the
   section name the original block's first instruction used to push, call the
   board drop-in sample, then jump to the instruction after that push with the
   section still on the stack. The block does not read eax, ecx or edx before
   defining them; eax is the only caller register the gate changes. */
function writeSfxHelpers(cave, caveVa) {
  const single = PATCH.singleHelperOffset;
  const double = PATCH.doubleHelperOffset;
  const common = PATCH.soundHelperOffset;
  const commonVa = caveVa + common;

  // The copied single-Continuous block keeps its original leading push and
  // calls this gate from its former exit jump. The gate only has to discard
  // the call's return address and continue at the normal block end.
  writeCall(cave, single, commonVa, caveVa + single + 5);
  cave[single + 5] = 0x83; // add esp,4
  cave[single + 6] = 0xc4;
  cave[single + 7] = 0x04;
  cave[single + 8] = 0xe9; // jmp PATCH.blockEndVa
  cave.writeInt32LE(PATCH.blockEndVa - (caveVa + single + 13), single + 9);

  // The original double-Continuous block is patched in place, so its gate has
  // to push the section name that the replaced first instruction used to push,
  // then return to the instruction after it.
  cave[double] = 0x68;
  cave.writeUInt32LE(PATCH.doubleSectionNameVa, double + 1);
  writeCall(cave, double + 5, commonVa, caveVa + double + 10);
  cave[double + 10] = 0x58; // pop eax (section name)
  cave[double + 11] = 0x83; // add esp,4 (drop the return address)
  cave[double + 12] = 0xc4;
  cave[double + 13] = 0x04;
  cave[double + 14] = 0x50; // push eax
  cave[double + 15] = 0xe9; // jmp PATCH.blockVa+5
  cave.writeInt32LE(PATCH.blockVa + 5 - (caveVa + double + 20), double + 16);

  let offset = common;
  cave[offset++] = 0x9c; // pushfd
  cave[offset++] = 0x60; // pushad
  cave[offset++] = 0x6a; // push 0
  cave[offset++] = 0x00;
  cave[offset++] = 0x8d; // lea ecx,[esp-0x24d]
  cave[offset++] = 0x8c;
  cave[offset++] = 0x24;
  cave.writeInt32LE(-0x24d, offset);
  offset += 4;
  const callOffset = offset;
  writeCall(cave, callOffset, PATCH.dropInSoundFunctionVa, caveVa + callOffset + 5);
  offset += 5;
  cave[offset++] = 0x83; // add esp,4
  cave[offset++] = 0xc4;
  cave[offset++] = 0x04;
  cave[offset++] = 0x61; // popad
  cave[offset++] = 0x9d; // popfd
  cave[offset++] = 0xc3; // ret
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
  const dropInLengthOffset = text.rawOffset + (PATCH.dropInSoundSectionLengthVa - (PATCH.imageBase + text.va));
  const dropInNameOffset = text.rawOffset + (PATCH.dropInSoundSectionNameVa - (PATCH.imageBase + text.va));

  if (blockOffset < 0 || jumpEntryOffset + 4 > original.length || caveOffset + PATCH.caveMaxLength > original.length) {
    throw new Error('The Collapse! executable layout does not match the supported build.');
  }
  if (original[blockOffset] !== 0x68 || original.readUInt32LE(blockOffset + 1) !== 0x7575b0) {
    throw new Error('The Double Continuous music block was not found where expected.');
  }
  if (original.readUInt32LE(jumpEntryOffset) !== 0x4971bd) {
    throw new Error('The Continuous switch entry was not found where expected.');
  }
  if (original[dropInLengthOffset] !== 0x0f || original.readUInt32LE(dropInNameOffset) !== 0x7453b0) {
    throw new Error('The board drop-in sound code was not found where expected.');
  }

  const patched = Buffer.from(original);
  const block = Buffer.from(original.subarray(blockOffset, blockOffset + (PATCH.blockEndVa - PATCH.blockVa)));
  if (block.length !== 0xb6) throw new Error('The copied music block has an unexpected size.');

  // The copied block must use the single-Continuous section; the original
  // block keeps the double-Continuous section and is patched in place below.
  block.writeUInt32LE(PATCH.singleSectionNameVa, 1);
  const delta = PATCH.caveVa - PATCH.blockVa;
  for (const callOffset of PATCH.callOffsets) {
    if (block[callOffset] !== 0xe8) throw new Error('A music-block call has moved.');
    const oldRelative = block.readInt32LE(callOffset + 1);
    block.writeInt32LE(oldRelative - delta, callOffset + 1);
  }

  // Both the copied single-Continuous block and the original double-Continuous
  // block must switch music through the manager. The direct Sound::play call
  // left the previous menu stream running and was never stopped on scene exit.
  patchContinuousMusicSwitch(block, 0, PATCH.caveVa);
  patchContinuousMusicSwitch(patched, blockOffset, PATCH.blockVa);

  // The board drop-in resource is only declared for scenegamepuzzle. The
  // always-loaded base section gets it too, and the puzzle drop-in routine is
  // pointed at that section. The helpers below call the routine from both
  // Continuous music blocks without needing a real GameBoard object.
  patched[dropInLengthOffset] = PATCH.dropInSoundSectionLength;
  patched.writeUInt32LE(PATCH.dropInSoundSectionVa, dropInNameOffset);

  const cave = Buffer.alloc(PATCH.soundHelperOffset + 0x16);
  block.copy(cave, 0);
  writeSfxHelpers(cave, PATCH.caveVa);

  // The copied block's old exit jump is now a call to the single-Continuous
  // sound gate; it jumps to the normal block end when it is done.
  writeCall(cave, block.length, PATCH.caveVa + PATCH.singleHelperOffset, PATCH.caveVa + PATCH.singleHelperOffset);
  if (cave.length > PATCH.caveMaxLength) throw new Error('The Continuous music patch is too large.');

  for (let i = 0; i < cave.length; i += 1) {
    if (patched[caveOffset + i] !== 0) throw new Error('The Collapse! code cave is not empty.');
  }

  // Only the original double-Continuous block's first instruction is replaced;
  // the gate restores the section-name push before continuing. Keeping the
  // copied block's opening push intact also lets older launchers recognize the
  // patch (they inspect those first bytes).
  writeCall(patched, blockOffset, PATCH.caveVa + PATCH.doubleHelperOffset, PATCH.blockVa + 5);

  cave.copy(patched, caveOffset);
  patched.writeUInt32LE(PATCH.caveVa, jumpEntryOffset);
  patched.writeUInt32LE(PATCH.patchedRdataVirtualSize, rdataHeader + 8);
  patched.writeUInt32LE((rdata.characteristics | PATCH.executedSectionFlag) >>> 0, rdataHeader + 36);
  return patched;
}

/* Replaces the copied block's direct Sound::play tail with the game's music
   manager. The manager stops the previous stream, starts the requested one,
   and keeps the current-track pointer the scene destructors stop on exit. */
function patchContinuousMusicSwitch(buffer, start, blockVa) {
  // Remove fld1; the manager takes the stream's own configured volume.
  if (buffer[start + 0x6c] !== 0xd9 || buffer[start + 0x6d] !== 0xe8) {
    throw new Error('The Continuous music volume load has moved.');
  }
  buffer[start + 0x6c] = 0x90;
  buffer[start + 0x6d] = 0x90;

  // push 0x132 / push 0 / push edi / mov ecx,eax / call manager. The manager
  // is __thiscall with three stack arguments (ret 0xc), so the old extra
  // push esi was a fourth argument and corrupted the call. The final argument
  // byte lands on the old pop esi, which must also disappear with the push.
  const call = Buffer.from([
    0x68, 0x32, 0x01, 0x00, 0x00, 0x6a, 0x00, 0x57,
    0x8b, 0xc8, 0xe8, 0x00, 0x00, 0x00, 0x00,
  ]);
  const callVa = blockVa + 0x82;
  call.writeInt32LE(PATCH.musicManagerVa - callVa, 11);
  for (let i = 0; i < call.length; i += 1) buffer[start + 0x73 + i] = call[i];
  // The 15-byte sequence is three bytes shorter than the old 18-byte
  // push esi/.../pop esi form. Drop the remaining old displacement bytes and
  // pop esi before the block's mov eax,esi.
  buffer[start + 0x82] = 0x90;
  buffer[start + 0x83] = 0x90;
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

  if (patched) {
    if (isCurrentMusicPatch(current)) return { ok: true, patched: true, backup: backupExists ? backup : null };
    // Upgrade an older launcher patch instead of rejecting the executable.
    if (!backupExists) return { ok: false, error: 'The original Collapse! executable backup is missing.' };
    const original = fs.readFileSync(backup);
    fs.writeFileSync(exePath, buildPatchedExecutable(original));
    return { ok: true, patched: true, backup, upgraded: true };
  }
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

/* Continuous uses scenegamebase, which is loaded for every game scene, while
   the board drop-in sample was only declared in scenegamepuzzle. Add the same
   resource to the base section so the Continuous helper can play it. */
function ensureContinuousDropInSound(xmlPath) {
  const current = fs.readFileSync(xmlPath, 'utf8');
  const opening = /(<Section\s+auto="true"\s+name="scenegamebase">\r?\n)/;
  const section = current.match(/<Section\s+auto="true"\s+name="scenegamebase">[\s\S]*?<\/Section>/);
  if (!opening.test(current) || !section) {
    return { ok: false, error: 'The scenegamebase section was not found in resources.xml.' };
  }
  if (section[0].includes('id="SOUND_PUZZLE_DROP_IN"')) return { ok: true, added: false };

  const line = '\t\t\t<Sound file="sound/SC4_Puzzle_Board_DropIn.ogg" id="SOUND_PUZZLE_DROP_IN" volume="1.0" />\r\n';
  const next = current.replace(opening, `$1${line}`);
  fs.writeFileSync(xmlPath, next);
  return { ok: true, added: true };
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
    if (enabled) {
      const soundResult = ensureContinuousDropInSound(xmlPath);
      if (!soundResult.ok) return soundResult;
    }

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
