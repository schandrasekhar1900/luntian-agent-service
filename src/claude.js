/**
 * claude.js — minimal client for Anthropic's Messages API (Claude), via fetch.
 *
 * Why no SDK: the Messages API is a single, stable HTTPS endpoint, and calling it
 * directly keeps dependencies small and every request easy to log.
 *
 *   POST https://api.anthropic.com/v1/messages
 *   headers: x-api-key, anthropic-version: 2023-06-01
 *   body:    { model, max_tokens, system, messages, tools? }
 *   reply:   { content: [ {type:"text", text} | {type:"tool_use", id, name, input} ], stop_reason, usage }
 *
 * Env: ANTHROPIC_API_KEY, ANTHROPIC_MODEL (default claude-haiku-5-5, chosen for voice latency).
 */

import { settings } from './config.js';
import { getLogger } from './logger.js';

const log = getLogger('claude');
const URL = 'https://api.anthropic.com/v1/messages';

/**
 * One Messages API call.
 * @param {{system?: string, messages: Array<object>, tools?: Array<object>, maxTokens?: number, timeoutMs?: number, purpose?: string}} p
 * @returns {Promise<{content: Array<any>, stop_reason: string, usage: object}>}
 */
export async function messages(opts) {
  // Rate limits (429) and overload (529) are retried automatically: wait as long as Anthropic
  // suggests (retry-after), at most twice, so a busy minute shows as a slower reply, not an error.
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await messagesOnce(opts);
    } catch (err) {
      if (!err.retryable || attempt > 2) throw err;
      const waitMs = Math.min(Math.max(err.retryAfterMs || 2000 * attempt, 1000), 8000);
      log.warn({ purpose: opts.purpose, attempt, waitMs, status: err.status }, 'Claude busy (rate limit/overload); retrying');
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

async function messagesOnce({ system, messages: msgs, tools, maxTokens = 1024, timeoutMs = 20000, purpose = 'turn' }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();
  const body = { model: settings.anthropicModel, max_tokens: maxTokens, messages: msgs };
  if (system) body.system = system;
  if (tools?.length) body.tools = tools;
  log.debug({ purpose, model: settings.anthropicModel, messages: msgs.length, tools: tools?.length || 0 }, '→ Claude');
  try {
    const res = await fetch(URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': settings.anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = json?.error?.message || JSON.stringify(json).slice(0, 300);
      const e = new Error(`Claude HTTP ${res.status} (${json?.error?.type || 'error'}): ${msg}`);
      e.status = res.status;
      e.retryable = res.status === 429 || res.status === 529;
      const ra = Number(res.headers?.get?.('retry-after'));
      if (ra > 0) e.retryAfterMs = ra * 1000;
      throw e;
    }
    log.debug({ purpose, ms: Date.now() - t0, stop: json.stop_reason, usage: json.usage }, '← Claude');
    return json;
  } catch (err) {
    // Node's fetch hides network-level causes (DNS, TLS, proxy) in err.cause; surface them.
    const cause = err.cause ? ` (${err.cause.code || err.cause.name || 'cause'}: ${err.cause.message || err.cause})` : '';
    const reason = err.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : `${err.message}${err.status ? '' : cause}`;
    log.warn({ purpose, ms: Date.now() - t0, err: reason }, 'Claude call failed');
    const e = new Error(reason);
    e.status = err.status;
    e.retryable = err.retryable;
    e.retryAfterMs = err.retryAfterMs;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Convenience: single prompt in, plain text out. */
export async function text(prompt, { maxTokens = 300, timeoutMs = 8000, purpose = 'text' } = {}) {
  const resp = await messages({ messages: [{ role: 'user', content: prompt }], maxTokens, timeoutMs, purpose });
  return (resp.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/^"|"$/g, '');
}
