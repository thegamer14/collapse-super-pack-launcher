'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { app, shell } = require('electron');
const logger = require('./logger');

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

function powershellPath() {
  return path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Quotes a value as a PowerShell single-quoted string. */
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function logPath() {
  try {
    return logger.file() || path.join(app.getPath('userData'), 'launcher.log');
  } catch {
    return '';
  }
}

async function fileSha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
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
    const asset = releaseAsset(release);
    const currentVersion = cleanVersion(app.getVersion());
    const latestVersion = cleanVersion(release.tag_name || release.name);
    const result = {
      ok: true,
      currentVersion,
      latestVersion,
      available: compareVersions(latestVersion, currentVersion) > 0,
      releaseUrl: release.html_url || RELEASES_PAGE,
      assetName: asset ? asset.name : null,
      publishedAt: release.published_at || release.created_at || null,
      notes: String(release.body || '').slice(0, 4000),
    };
    logger.log('update check', {
      currentVersion,
      latestVersion,
      available: result.available,
      assetName: result.assetName,
    });
    return result;
  } catch (error) {
    logger.error('update check failed', error);
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
  logger.log('update download starting', {
    asset: asset.name || null,
    size: asset.size || null,
    destination,
  });
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
  if (typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')) {
    const expected = asset.digest.slice('sha256:'.length).toLowerCase();
    const actual = await fileSha256(destination);
    if (actual !== expected) {
      throw new Error('The downloaded launcher failed its SHA-256 check.');
    }
    logger.log('update download verified', { bytes: stat.size, sha256: actual });
  } else {
    logger.log('update download complete', { bytes: stat.size });
  }
}

/**
 * The helper has to outlive this Electron process, because it replaces the
 * portable exe only after this process exits. A normal detached child can still
 * be tied to Electron's Windows job and disappear with it. Creating the helper
 * through WMI puts it under the WMI provider instead, outside that job tree.
 */
function startUpdateHelper(scriptPath) {
  const helperCommand = `"${powershellPath()}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${scriptPath}"`;
  const startCommand = [
    "$ErrorActionPreference = 'Stop'",
    '$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:COLLAPSE_UPDATE_COMMAND }',
    'if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create failed with $($result.ReturnValue)." }',
    'Write-Output $result.ProcessId',
  ].join('; ');

  logger.log('starting update helper through WMI', { scriptPath });
  return new Promise((resolve, reject) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', startCommand],
      {
        env: { ...process.env, COLLAPSE_UPDATE_COMMAND: helperCommand },
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || '').trim() || error.message;
          reject(new Error(`Could not start the update helper: ${detail}`));
          return;
        }
        const output = String(stdout || '').trim();
        const lastLine = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || '';
        const pid = Number.parseInt(lastLine, 10);
        if (!Number.isFinite(pid)) {
          reject(new Error(`Could not start the update helper: unexpected output "${output}".`));
          return;
        }
        logger.log('update helper is running outside the launcher', { pid, scriptPath });
        resolve(pid);
      }
    );
  });
}

function updaterScript({ appPid, source, target, backup, log }) {
  return `$AppPid = ${Number(appPid)}
$Source = ${psQuote(source)}
$Target = ${psQuote(target)}
$Backup = ${psQuote(backup)}
$Log = ${psQuote(log)}
$ErrorActionPreference = 'Stop'

function Write-UpdateLog([string]$Message) {
  try {
    Add-Content -LiteralPath $Log -Value ("[{0}] [updater] {1}" -f (Get-Date).ToString('o'), $Message)
  } catch {}
}

Write-UpdateLog "helper started (PID $PID); waiting for launcher $AppPid"
try {
  Wait-Process -Id $AppPid -Timeout 45 -ErrorAction SilentlyContinue
  Write-UpdateLog 'launcher exited; waiting for the target file to unlock'
  Start-Sleep -Milliseconds 500
  # The portable wrapper keeps its own exe open briefly after Electron exits.
  # Wait until that file is no longer locked before swapping it.
  $deadline = (Get-Date).AddSeconds(30)
  $unlocked = $false
  while ((Get-Date) -lt $deadline) {
    try {
      $handle = [System.IO.File]::Open($Target, 'Open', 'ReadWrite', 'None')
      $handle.Close()
      $unlocked = $true
      break
    } catch {
      Start-Sleep -Milliseconds 300
    }
  }
  if (-not $unlocked) { throw "Timed out waiting for $Target to be released." }
  if (Test-Path -LiteralPath $Target) {
    Copy-Item -LiteralPath $Target -Destination $Backup -Force
    Write-UpdateLog "backup written to $Backup"
  }
  Copy-Item -LiteralPath $Source -Destination $Target -Force
  Write-UpdateLog "update copied to $Target"
  Start-Process -FilePath $Target -WorkingDirectory (Split-Path -Parent $Target)
  Write-UpdateLog 'relaunched the launcher'
  Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue
} catch {
  Write-UpdateLog ("FAILED: " + $_.Exception.Message + " | " + $_.ScriptStackTrace)
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

  logger.log('update install requested', {
    currentVersion: check.currentVersion,
    latestVersion: check.latestVersion,
    target,
    backup,
  });

  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'collapse-super-pack-update-'));
  const downloadPath = path.join(folder, asset.name || 'Collapse Super Pack.exe');
  const scriptPath = path.join(folder, 'install-update.ps1');
  try {
    await download(asset, downloadPath);
    const script = updaterScript({
      appPid: process.pid,
      source: downloadPath,
      target,
      backup,
      log: logPath(),
    });
    // PowerShell 5.1 reads UTF-8 script files correctly when they start with a
    // BOM, which matters when a game or user profile path contains non-ASCII.
    fs.writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');
    const helperPid = await startUpdateHelper(scriptPath);
    logger.log('update helper handed off', { helperPid, target, downloadPath, scriptPath });
    return {
      ok: true,
      started: true,
      helperPid,
      latestVersion: check.latestVersion,
      target,
      backup,
    };
  } catch (error) {
    logger.error('update install failed', error);
    // Keep the temp folder on failure so the downloaded executable, helper
    // script and launcher log can be inspected. It is safe to remove later.
    return { ok: false, error: `Could not start the update: ${error.message}` };
  }
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
