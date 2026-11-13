'use strict';

const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 128 * 1024;

let logFile = null;
let childOutputFd = null;

function configure(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'launcher.log');
    try {
      if (fs.statSync(logFile).size > MAX_LOG_BYTES) {
        const previous = `${logFile}.1`;
        try { fs.rmSync(previous, { force: true }); } catch { /* best effort */ }
        fs.renameSync(logFile, previous);
      }
    } catch {
      /* no log yet, or a previous file could not be rotated */
    }
    if (childOutputFd !== null) {
      try { fs.closeSync(childOutputFd); } catch { /* already closed */ }
      childOutputFd = null;
    }
  } catch (error) {
    logFile = null;
    console.error('Could not create the launcher log:', error.message);
  }
  return logFile;
}

function describe(value) {
  if (value === undefined) return '';
  if (value instanceof Error) {
    return JSON.stringify({
      message: value.message,
      code: value.code,
      errno: value.errno,
      syscall: value.syscall,
      path: value.path,
      stack: value.stack,
    });
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level, message, detail) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}${detail === undefined ? '' : ` ${describe(detail)}`}`;
  try {
    if (logFile) fs.appendFileSync(logFile, `${line}\n`, 'utf8');
  } catch {
    /* A full disk or locked log must never break a game launch. */
  }
  const output = level === 'ERROR' ? console.error : console.log;
  output(line);
}

function log(message, detail) {
  write('INFO', message, detail);
}

function warn(message, detail) {
  write('WARN', message, detail);
}

function error(message, detail) {
  write('ERROR', message, detail);
}

function file() {
  return logFile;
}

function ensure() {
  if (!logFile) return null;
  try {
    fs.appendFileSync(logFile, '', 'utf8');
    return logFile;
  } catch {
    return null;
  }
}

function readTail(maxBytes = TAIL_BYTES) {
  if (!logFile) return '';
  try {
    const stat = fs.statSync(logFile);
    const start = Math.max(0, stat.size - maxBytes);
    const handle = fs.openSync(logFile, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(handle, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return '';
  }
}

/**
 * Child stdout/stderr go into the same file as the launcher's text log. A
 * single append descriptor is opened once and inherited by each child, so
 * helper tools such as BitBit and PowerShell can report their own failures
 * even after this process stops watching them.
 */
function outputHandle() {
  if (!logFile) return 'ignore';
  try {
    if (childOutputFd === null) childOutputFd = fs.openSync(logFile, 'a');
    return childOutputFd;
  } catch {
    return 'ignore';
  }
}

module.exports = {
  configure,
  log,
  warn,
  error,
  file,
  ensure,
  readTail,
  outputHandle,
  MAX_LOG_BYTES,
};
