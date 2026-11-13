'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { app, shell } = require('electron');

const REPO = 'thegamer14/collapse-super-pack-launcher';
const API = `https://api.github.com/repos/${REPO}`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;
const USER_AGENT = 'Collapse-Super-Pack-Launcher';

function cleanVersion(value) {
  return String(value || '').trim().replace(/^v/i, '').split(/[-+]/)[0];
}

function compareVersions(a, b) {
  const left = cleanVersion(a).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const right = cleanVersion(b).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const difference = (left[i] || 0) - (right[i] || 0);
    if (difference) return difference > 0 ? 1 : -1;
  }
  return 0;
}

async function githubRelease() {
  const response = await fetch(`${API}/releases/latest`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
    },
  });
  if (response.status === 404) {
    throw new Error('No GitHub release has been published yet.');
  }
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status} while checking for updates.`);
  }
  return response.json();
}

function releaseAsset(release) {
  const assets = Array.isArray(release && release.assets) ? release.assets : [];
  return assets.find((asset) => /\.exe$/i.test(asset.name || '') && !/\.blockmap$/i.test(asset.name || '')) || null;
}

async function checkForUpdates() {
  try {
    const release = await githubRelease();
    const currentVersion = cleanVersion(app.getVersion());
    const latestVersion = cleanVersion(release.tag_name || release.name);
    return {
      ok: true,
      currentVersion,
      latestVersion,
      available: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: release.html_url || RELEASES_PAGE,
      assetName: releaseAsset(release) ? releaseAsset(release).name : null,
      publishedAt: release.published_at || release.created_at || null,
      notes: String(release.body || '').slice(0, 4000),
    };
  } catch (error) {
    return { ok: false, error: error.message || 'Could not check GitHub for updates.' };
  }
}

function updateTarget() {
  // The portable target unpacks itself before starting Electron. The file the
  // player double-clicked is provided separately from the temporary process
  // executable, so it is the file that must be replaced.
  return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

async function download(asset, destination) {
  const response = await fetch(asset.browser_download_url, {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (!response.ok || !response.body) {
    throw new Error(`GitHub returned HTTP ${response.status} while downloading the update.`);
  }
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
  const stat = fs.statSync(destination);
  const header = Buffer.alloc(2);
  const handle = fs.openSync(destination, 'r');
  try {
    fs.readSync(handle, header, 0, 2, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (stat.size < 1024 * 1024 || header.toString('ascii') !== 'MZ') {
    throw new Error('GitHub returned an invalid launcher executable.');
  }
}

function updaterScript() {
  return `param([int]$AppPid, [string]$Source, [string]$Target, [string]$Backup)
$ErrorActionPreference = 'Stop'
try {
  Wait-Process -Id $AppPid -Timeout 45 -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  if (Test-Path -LiteralPath $Target) {
    Copy-Item -LiteralPath $Target -Destination $Backup -Force
  }
  Copy-Item -LiteralPath $Source -Destination $Target -Force
  Start-Process -FilePath $Target -WorkingDirectory (Split-Path -Parent $Target)
  Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue
} catch {
  try {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show("The launcher update could not be installed." + [Environment]::NewLine + [Environment]::NewLine + $_.Exception.Message, 'Collapse Super Pack update')
  } catch {}
}
`;
}

async function installUpdate() {
  const check = await checkForUpdates();
  if (!check.ok) return check;
  if (!check.available) return { ok: true, upToDate: true, currentVersion: check.currentVersion };
  if (!app.isPackaged) {
    return { ok: false, error: 'Automatic updates are available in the packaged launcher. Use the GitHub release download instead.' };
  }

  const target = updateTarget();
  const backup = `${target}.old`;
  if (!target || !path.isAbsolute(target) || !fs.existsSync(target)) {
    return { ok: false, error: 'Could not find the launcher executable to update.' };
  }
  try {
    fs.accessSync(target, fs.constants.W_OK);
  } catch {
    return { ok: false, error: 'The launcher folder is read-only. Download the new release from GitHub instead.' };
  }

  const release = await githubRelease();
  const asset = releaseAsset(release);
  if (!asset) return { ok: false, error: 'The latest GitHub release does not contain a launcher executable.' };

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'collapse-super-pack-update-'));
  const downloadPath = path.join(folder, asset.name || 'Collapse Super Pack.exe');
  const scriptPath = path.join(folder, 'install-update.ps1');
  try {
    await download(asset, downloadPath);
    fs.writeFileSync(scriptPath, updaterScript(), 'utf8');
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden',
      '-File', scriptPath,
      '-AppPid', String(process.pid),
      '-Source', downloadPath,
      '-Target', target,
      '-Backup', backup,
    ], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  } catch (error) {
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch {}
    return { ok: false, error: `Could not download the update: ${error.message}` };
  }

  return {
    ok: true,
    started: true,
    latestVersion: check.latestVersion,
    target,
    backup,
  };
}

async function openReleasePage(url) {
  await shell.openExternal(url || RELEASES_PAGE);
  return { ok: true };
}

module.exports = {
  REPO,
  RELEASES_PAGE,
  checkForUpdates,
  installUpdate,
  openReleasePage,
  compareVersions,
};