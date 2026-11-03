/**
 * twilioOps.js — Twilio REST calls made outside TAC's own flows.
 *
 *  - Conversation Orchestrator: re-attach a conversation's status callbacks after a
 *    chat handoff, so the Serverless /webhooks/co-events feeds the Flex panel.
 *  - Conversation Memory: profile lookup (cached) and memory snapshots for Pia's
 *    voice opening line and the save_customer_note tool.
 *
 * All functions log what they do, and none of them throw into the demo flow:
 * failures are logged and a safe empty value is returned.
 */

import { settings } from './config.js';
import { getLogger, timed } from './logger.js';

const log = getLogger('twilio');

/** REST client authenticated with the API key (not the auth token). */
const basicAuth = 'Basic ' + Buffer.from(`${settings.apiKey}:${settings.apiSecret}`).toString('base64');


// --------------------------------------------------------------------------- Conversation Orchestrator

/**
 * Point ONE Orchestrator conversation's status callbacks at the Serverless /webhooks/co-events Function.
 *
 * TAC's handoff tool clears per-conversation callbacks so TAC stops answering.
 * We re-attach them to the Serverless /webhooks/co-events (not TAC's /webhook) so the Flex panel keeps
 * receiving COMMUNICATION_CREATED events (live transcript) for the human part.
 */
export async function attachStatusCallback(conversationId, url) {
  const payload = { configuration: { statusCallbacks: [{ url, method: 'POST' }] } };
  try {
    const res = await fetch(`https://conversations.twilio.com/v2/Conversations/${conversationId}`, {
      method: 'PATCH',
      headers: { Authorization: basicAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    log.info({ conversationId, url }, 'Re-attached conversation status callback for live assist');
    return true;
  } catch (err) {
    log.warn({ conversationId, err: err.message }, 'attachStatusCallback failed');
    return false;
  }
}

// --------------------------------------------------------------------------- Conversation Memory

/**
 * Short-lived cache of "email:x" / "phone:y" -> profile id (60 s). Short on purpose:
 * the brain view's "Reset demo" deletes and re-creates Mia's profile, so a long-lived
 * cache would keep pointing at the deleted one.
 * @type {Map<string, {id: string, at: number}>}
 */
const profileCache = new Map();
const PROFILE_CACHE_MS = 60 * 1000;

/**
 * Find a Memory profile id by email or phone. Cached, because the opening line,
 * the brain view and the Flex panel all ask for the same customer repeatedly.
 */
export async function lookupProfileId(tac, { email, phone } = {}) {
  const memory = tac.getMemoryClient();
  if (!memory) {
    log.warn('Memory client not available (is the Orchestrator configuration linked to a memory store?)');
    return null;
  }
  const [idType, value] = email ? ['email', email] : ['phone', phone];
  if (!value) return null;
  const key = `${idType}:${value}`;
  const cached = profileCache.get(key);
  if (cached && Date.now() - cached.at < PROFILE_CACHE_MS) return cached.id;
  try {
    const result = await timed(log, 'Memory profile lookup', () => memory.lookupProfile(idType, value), { idType });
    const profileId = result.profiles?.[0] || null;
    if (profileId) {
      profileCache.set(key, { id: profileId, at: Date.now() });
      log.info({ idType, profileId }, 'Memory profile found');
    } else {
      log.warn({ idType, value }, 'No Memory profile for this identifier (run `provision seed`?)');
    }
    return profileId;
  } catch (err) {
    log.warn({ key, err: err.message }, 'Memory profile lookup failed');
    return null;
  }
}

export function forgetProfileCache() {
  profileCache.clear();
  log.info('Profile cache cleared');
}

/**
 * Traits + observations + summaries for a profile, oldest first.
 * @param {string|null} profileId
 * @param {string} [query] optional semantic query for the Recall API
 */
export async function memorySnapshot(tac, profileId, query) {
  const snap = { profileId, traits: {}, observations: [], summaries: [] };
  const memory = tac.getMemoryClient();
  if (!memory || !profileId) return snap;

  try {
    const profile = await timed(log, 'Get profile', () => memory.getProfile(profileId), { profileId });
    snap.traits = profile.traits || {};
  } catch (err) {
    log.warn({ profileId, err: err.message }, 'getProfile failed');
  }

  try {
    const recall = await timed(
      log,
      'Memory recall',
      () => memory.retrieveMemories(profileId, { ...(query ? { query } : {}), observationsLimit: 50, summariesLimit: 10 }),
      { profileId, query }
    );
    const byTime = (a, b) => String(a.occurredAt || a.createdAt || '').localeCompare(String(b.occurredAt || b.createdAt || ''));
    snap.observations = (recall.observations || [])
      .map((o) => ({ content: o.content, source: o.source, createdAt: o.createdAt, occurredAt: o.occurredAt }))
      .sort(byTime);
    snap.summaries = (recall.summaries || [])
      .map((s) => ({ content: s.content, conversationId: s.conversationIds?.[0], createdAt: s.createdAt }))
      .sort(byTime);
  } catch (err) {
    log.warn({ profileId, err: err.message }, 'retrieveMemories failed');
  }

  log.info(
    { profileId, traitGroups: Object.keys(snap.traits).length, observations: snap.observations.length, summaries: snap.summaries.length },
    'Memory snapshot'
  );
  return snap;
}
