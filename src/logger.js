/**
 * logger.js — one pino logger for the whole server.
 *
 * Every module asks for a child logger with its own `module` name, so a log line
 * always tells you which part of the demo produced it, e.g.
 *
 *   [10:02:11.452] INFO (agent): LLM turn complete {"conversationId":"conv_...","toolCalls":2,"ms":1830}
 *
 * Levels used throughout the code:
 *   info  — the story of the demo (chat opened, memory recalled, handoff, ...)
 *   debug — full payloads (webhook bodies, tool arguments/results, prompts)
 *   warn  — something degraded but the demo continues (e.g. Knowledge search failed)
 *   error — something the presenter needs to fix
 *
 * Control with LOG_LEVEL (default "debug") and LOG_PRETTY (default "true").
 */

import pino from 'pino';

const level = process.env.LOG_LEVEL || 'debug';
const pretty = (process.env.LOG_PRETTY || 'true').toLowerCase() !== 'false';

export const rootLogger = pino({
  level,
  base: undefined, // drop pid/hostname noise; the module name is what matters here
  timestamp: pino.stdTimeFunctions.isoTime,
  // Never print secrets even at trace level
  redact: {
    paths: ['*.token', '*.authToken', '*.apiSecret', 'headers.authorization', '*.headers.authorization'],
    censor: '[redacted]',
  },
  transport: pretty
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'module',
          messageFormat: '({module}) {msg}',
          singleLine: true,
        },
      }
    : undefined,
});

/**
 * Get a child logger for one module.
 * @param {string} module short module name shown in every line, e.g. "agent", "voice"
 */
export function getLogger(module) {
  return rootLogger.child({ module });
}

/**
 * Small helper to time an async operation and log its duration.
 * @template T
 * @param {import('pino').Logger} log
 * @param {string} what human description used in the log line
 * @param {() => Promise<T>} fn
 * @param {Record<string, unknown>} [fields] extra structured fields
 * @returns {Promise<T>}
 */
export async function timed(log, what, fn, fields = {}) {
  const started = Date.now();
  log.debug({ ...fields }, `${what}: started`);
  try {
    const result = await fn();
    log.debug({ ...fields, ms: Date.now() - started }, `${what}: done`);
    return result;
  } catch (err) {
    log.warn({ ...fields, ms: Date.now() - started, err: err?.message }, `${what}: failed`);
    throw err;
  }
}
