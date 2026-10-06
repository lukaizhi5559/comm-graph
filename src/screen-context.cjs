'use strict';

/**
 * screen-context.cjs — read-only screen awareness shared by the capability
 * gate (server.cjs) and the planning lane (nodes/planning.cjs).
 *
 *   needsAmbientCtx(text)  — same predicate ResolveReferencesV2 uses to
 *                            decide a prompt needs screen context
 *   screenContext()        — parallel memory.getRecentOcr +
 *                            memory.getActiveAppContext, bounded + fail-open
 *   memoryCall(action,…)   — thin POST wrapper over user-memory :3001
 *
 * Enrichment is additive only: callers append what this returns; nothing here
 * can block or override routing.
 */

const { REFERENTIAL_RE, ACTION_VERB_RE, SCREEN_OBSERVATION_RE, AMBIENT_ARTIFACT_RE } =
  require('../../shared/text-patterns.cjs');

const MEMORY_PORT = parseInt(process.env.USER_MEMORY_PORT || '3001', 10);
const MEM_API_KEY = process.env.MCP_USER_MEMORY_API_KEY || process.env.MCP_MEMORY_API_KEY || process.env.MCP_API_KEY || '';

function needsAmbientCtx(text) {
  const t = text || '';
  return (REFERENTIAL_RE.test(t) && AMBIENT_ARTIFACT_RE.test(t) && ACTION_VERB_RE.test(t))
      || SCREEN_OBSERVATION_RE.test(t);
}

async function memoryCall(action, payload = {}, timeoutMs = 1500) {
  const res = await fetch(`http://127.0.0.1:${MEMORY_PORT}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(MEM_API_KEY ? { Authorization: `Bearer ${MEM_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      version: 'mcp.v1', service: 'user-memory', action,
      payload, requestId: `cg_screen_${Date.now()}`,
      context: { userId: 'local_user' },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const d = await res.json();
  return d?.data || d;
}

async function screenContext() {
  const [ocr, app] = await Promise.all([
    memoryCall('memory.getRecentOcr', { maxAgeSeconds: 300 }).catch(() => null),
    memoryCall('memory.getActiveAppContext', {}).catch(() => null),
  ]);
  const capture = ocr?.capture || null;
  const a = app?.app || {};
  const url = a.url || capture?.url || null;
  let host = null;
  try { host = url ? new URL(url).hostname.replace(/^www\./, '') : null; } catch (_) {}
  const appName = a.appName || capture?.appName || null;
  const title = a.windowTitle || capture?.windowTitle || null;
  const ocrText = (capture?.text || '').replace(/\s+/g, ' ').slice(0, 300);
  if (!appName && !host && !ocrText) return null;
  return { appName, host, title, url, ocrText };
}

module.exports = { needsAmbientCtx, screenContext, memoryCall };
