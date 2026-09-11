'use strict';

/**
 * logger.cjs — Minimal logger for comms-graph
 * Mirrors voice-service logger interface (info/warn/error/debug)
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LEVELS[process.env.LOG_LEVEL || 'info'] || 1;

function _fmt(level, msg, meta) {
  const ts = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `[${ts}] [${level.toUpperCase()}] [comms-graph] ${msg}${metaStr}`;
}

module.exports = {
  debug(msg, meta) { if (CURRENT_LEVEL <= 0) console.log(_fmt('debug', msg, meta)); },
  info(msg, meta)  { if (CURRENT_LEVEL <= 1) console.log(_fmt('info', msg, meta)); },
  warn(msg, meta)  { if (CURRENT_LEVEL <= 2) console.warn(_fmt('warn', msg, meta)); },
  error(msg, meta) { if (CURRENT_LEVEL <= 3) console.error(_fmt('error', msg, meta)); },
};
