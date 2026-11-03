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
export async function messages({ system, messages: msgs, tools, maxTokens = 1024, timeoutMs = 20000, purpose = 'turn' }) {
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
      throw new Error(`Claude HTTP ${res.status} (${json?.error?.type || 'error'}): ${msg}`);
    }
    log.debug({ purpose, ms: Date.now() - t0, stop: json.stop_reason, usage: json.usage }, '← Claude');
    return json;
  } catch (err) {
    // Node's fetch hides network-level causes (DNS, TLS, proxy) in err.cause; surface them.
    const cause = err.cause ? ` (${err.cause.code || err.cause.name || 'cause'}: ${err.cause.message || err.cause})` : '';
    const reason = err.name === 'AbortError' ? `timeout after ${timeoutMs} ms` : `${err.message}${cause}`;
    log.warn({ purpose, ms: Date.now() - t0, err: reason }, 'Claude call failed');
    throw new Error(reason);
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
