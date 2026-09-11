'use strict';

/**
 * logger.cjs — File + console logger for comms-graph
 *
 * Mirrors the pattern used by other ThinkDrop MCP services:
 * logs to ./logs/comms-graph.log (created on demand) and the console.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'] || 1;

// ── Determine log file path ────────────────────────────────────────────────────
let logFilePath = null;
function _getLogFilePath() {
  if (logFilePath) return logFilePath;

  // Prefer an explicit log path, then the ThinkDrop logs dir if available,
  // otherwise a local logs directory inside comms-graph.
  if (process.env.COMMS_GRAPH_LOG_FILE) {
    logFilePath = process.env.COMMS_GRAPH_LOG_FILE.replace('~', os.homedir());
  } else if (process.env.THINKDROP_PROJECT_ROOT) {
    logFilePath = path.join(process.env.THINKDROP_PROJECT_ROOT, 'logs', 'comms-graph.log');
  } else {
    // Walk upward from __dirname looking for a logs/ folder or the project root
    let dir = path.resolve(__dirname, '..');
    for (let i = 0; i < 4; i++) {
      const logsDir = path.join(dir, 'logs');
      if (fs.existsSync(logsDir) || fs.existsSync(path.join(dir, 'package.json'))) {
        logFilePath = path.join(logsDir, 'comms-graph.log');
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!logFilePath) {
      logFilePath = path.join(__dirname, '..', 'logs', 'comms-graph.log');
    }
  }

  // Ensure directory exists
  const dir = path.dirname(logFilePath);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }

  return logFilePath;
}

function _writeToFile(line) {
  try {
    const file = _getLogFilePath();
    fs.appendFileSync(file, line + '\n', 'utf8');
  } catch (_) {
    // Ignore file logging failures — console is the fallback
  }
}

function _fmt(level, msg, meta) {
  const ts = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `[${ts}] [${level.toUpperCase()}] [comms-graph] ${msg}${metaStr}`;
}

function _log(level, msg, meta) {
  if (CURRENT_LEVEL > LEVELS[level]) return;
  const line = _fmt(level, msg, meta);
  const dest = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  dest(line);
  _writeToFile(line);
}

module.exports = {
  debug(msg, meta) { _log('debug', msg, meta); },
  info(msg, meta)  { _log('info',  msg, meta); },
  warn(msg, meta)  { _log('warn',  msg, meta); },
  error(msg, meta) { _log('error', msg, meta); },
};
