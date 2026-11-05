/**
 * events.js — the agent service's side of the shared Twilio Sync state.
 *
 * Same objects and shapes as serverless/functions/helpers/sync.private.js:
 *
 *   Sync List "events-all"                every demo event (/brain page)
 *   Sync List "events-<conversationId>"   events for one conversation (Flex panel)
 *   Sync Map  "registry"                  conversation records keyed by conversation id,
 *                                          plus "call-<CallSid>" / "chat-<ChatSid>" index keys
 *   Sync Map  "openers"                   chat opening lines written by /chat/greet
 *
 * Exposes the same API the agent code uses:
 *   bus.emit(type, data, conversationId?, channel?, ref?)   fire-and-forget publish
 *   registry.upsert(conversationId, fields)                  merge + write record and indexes
 *   takeOpener(key)                                          read-and-delete a parked opening line
 *
 * Writes are queued per object so events stay in order, and a Sync failure never
 * breaks a live call or chat (it is logged instead).
 */

import { randomUUID } from 'node:crypto';
import twilio from 'twilio';
import { settings } from './config.js';
import { getLogger } from './logger.js';

const log = getLogger('events');
const client = twilio(settings.apiKey, settings.apiSecret, { accountSid: settings.accountSid });
const sync = client.sync.v1.services(settings.syncServiceSid);

const LIST_TTL = 60 * 60 * 24 * 3; // 3 days
const MAX_ITEM_BYTES = 15000; // Sync item limit is 16 KB

/** Per-object promise chains, so writes to one list/map happen in order. */
const queues = new Map();
function enqueue(key, task) {
  const next = (queues.get(key) || Promise.resolve()).then(task, task);
  queues.set(key, next.catch(() => undefined));
  return next;
}

/** Shrink an event until it fits in one Sync item. */
function fit(event) {
  let json = JSON.stringify(event);
  if (json.length <= MAX_ITEM_BYTES) return event;
  const copy = JSON.parse(json);
  const trim = (obj) => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (typeof v === 'string' && v.length > 600) obj[k] = `${v.slice(0, 600)}…`;
      else if (Array.isArray(v) && v.length > 12) obj[k] = v.slice(-12);
      else if (v && typeof v === 'object') trim(v);
    }
  };
  trim(copy.data);
  json = JSON.stringify(copy);
  log.debug({ type: event.type, bytes: json.length }, 'Event trimmed to fit a Sync item');
  return json.length <= MAX_ITEM_BYTES ? copy : { ...copy, data: { truncated: true, preview: json.slice(0, 2000) } };
}

async function appendToList(listName, data, svc = sync) {
  try {
    await svc.syncLists(listName).syncListItems.create({ data, itemTtl: LIST_TTL });
  } catch (err) {
    if (err.status !== 404) throw err;
    log.debug({ listName }, 'Sync list missing; creating it');
    try {
      await svc.syncLists.create({ uniqueName: listName, ttl: LIST_TTL });
    } catch (e) {
      if (e.status !== 409) throw e;
    }
    await svc.syncLists(listName).syncListItems.create({ data, itemTtl: LIST_TTL });
  }
}

async function mapSet(mapName, key, data, svc = sync) {
  const items = () => svc.syncMaps(mapName).syncMapItems;
  try {
    await items()(key).update({ data });
  } catch (err) {
    if (err.status !== 404) throw err;
    try {
      await items().create({ key, data });
    } catch (e) {
      if (e.status !== 404) throw e;
      log.debug({ mapName }, 'Sync map missing; creating it');
      try {
        await svc.syncMaps.create({ uniqueName: mapName });
      } catch (e2) {
        if (e2.status !== 409) throw e2;
      }
      await items().create({ key, data });
    }
  }
}

async function mapGet(mapName, key, svc = sync) {
  try {
    return (await svc.syncMaps(mapName).syncMapItems(key).fetch()).data;
  } catch (err) {
    if (err.status !== 404) log.warn({ mapName, key, err: err.message }, 'Sync map read failed');
    return null;
  }
}

export const bus = {
  /**
   * Publish a demo event (fire-and-forget). Returns the event immediately.
   * @param {string} type e.g. "memory_recall", "knowledge_results", "handoff"
   */
  emit(type, data = {}, conversationId = null, channel = null, ref = null) {
    const event = fit({ id: randomUUID().slice(0, 12), ts: new Date().toISOString(), type, conversationId, channel, ref, data });
    // Audience conversations go ONLY to that attendee's list in the audience Sync service
    const audKey = conversationId ? audConvs.get(conversationId) : null;
    if (audKey && audSync) {
      const listName = `events-att-${audKey}`;
      enqueue(`aud:${listName}`, () => appendToList(listName, event, audSync)).catch((err) =>
        log.warn({ type, list: listName, err: err.message }, 'Audience event publish failed')
      );
      log.debug({ type, conversationId, audience: audKey }, 'Audience event published');
      return event;
    }
    const targets = ['events-all', ...(conversationId ? [`events-${conversationId}`] : [])];
    for (const name of targets) {
      enqueue(name, () => appendToList(name, event)).catch((err) =>
        log.warn({ type, list: name, err: err.message }, 'Event publish to Sync failed')
      );
    }
    log.debug({ type, conversationId, channel, ref }, 'Event published');
    return event;
  },
};

/** Local cache of registry records (this process is the main writer). */
const records = new Map();

export const registry = {
  /**
   * Merge fields into a conversation record and write it (plus CallSid / chat SID
   * index keys) to Sync map "registry". Fire-and-forget; returns the merged record.
   */
  upsert(conversationId, fields = {}) {
    // Audience conversations are tracked in the audience Sync service, not the main registry
    // (keeps the main demo's brain view and Flex briefing free of audience traffic).
    if (audConvs.has(conversationId)) return { conversationId, ...fields };
    const isNew = !records.has(conversationId);
    const record = records.get(conversationId) || { conversationId, startedAt: new Date().toISOString(), status: 'ACTIVE' };
    const changed = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && record[k] !== v) {
        record[k] = v;
        changed[k] = v;
      }
    }
    record.updatedAt = new Date().toISOString();
    records.set(conversationId, record);
    if (!isNew && !Object.keys(changed).length) return { ...record };

    log[isNew ? 'info' : 'debug']({ conversationId, ...changed }, isNew ? 'Registry: new conversation' : 'Registry: updated');
    const snapshot = { ...record };
    enqueue('registry', async () => {
      await mapSet('registry', conversationId, snapshot);
      if (changed.callSid) await mapSet('registry', `call-${changed.callSid}`, { conversationId });
      if (changed.chatSid) await mapSet('registry', `chat-${changed.chatSid}`, { conversationId });
    }).catch((err) => log.warn({ conversationId, err: err.message }, 'Registry write to Sync failed'));
    return snapshot;
  },
};

/**
 * Read and delete the opening line /chat/greet parked for a classic chat SID.
 * @returns {Promise<string|null>}
 */
export async function takeOpener(key) {
  if (!key) return null;
  const item = await mapGet('openers', key);
  if (!item?.line) return null;
  sync.syncMaps('openers').syncMapItems(key).remove().catch(() => undefined);
  log.info({ key }, 'Picked up chat opening line from Sync');
  return item.line;
}

// =====================================================================================
// Audience segment (separate Sync service). Recognises audience chats by Memory profile:
// /audience/start writes "aud_profiles" (profileId -> attendee key) before the first message.
// =====================================================================================

const audSync = settings.audienceSyncServiceSid ? client.sync.v1.services(settings.audienceSyncServiceSid) : null;
/** conversationId -> attendee key, for every audience conversation this process has seen */
const audConvs = new Map();
/** profileId -> { key|null, at } (negative results cached briefly; Mia's profile is never audience) */
const audProfileCache = new Map();
/** attendee key -> scenario (loans etc.) */
const audScenarioCache = new Map();

export const audience = {
  enabled: !!audSync,

  /** Attendee key for a Memory profile, or null if it is not an audience profile. */
  async keyForProfile(profileId) {
    if (!audSync || !profileId) return null;
    const cached = audProfileCache.get(profileId);
    if (cached && (cached.key || Date.now() - cached.at < 5 * 60 * 1000)) return cached.key;
    const item = await mapGet('aud_profiles', profileId, audSync);
    const key = item?.key || null;
    audProfileCache.set(profileId, { key, at: Date.now() });
    if (key) log.info({ profileId, key }, 'Audience profile recognised');
    return key;
  },

  /** Remember that a conversation belongs to an attendee (routes its events and registry). */
  mark(conversationId, key) {
    if (conversationId && key && !audConvs.has(conversationId)) {
      audConvs.set(conversationId, key);
      log.info({ conversationId, key }, 'Audience conversation');
    }
  },

  keyForConversation(conversationId) {
    return audConvs.get(conversationId) || null;
  },

  async scenario(key) {
    if (audScenarioCache.has(key)) return audScenarioCache.get(key);
    const s = await mapGet('aud_scenarios', key, audSync);
    if (s) audScenarioCache.set(key, s);
    return s;
  },

  /** Read and delete the opening line /audience/greet parked for a chat SID. */
  async takeOpener(chatSid) {
    if (!audSync || !chatSid) return null;
    const item = await mapGet('openers', chatSid, audSync);
    if (!item?.line) return null;
    audSync.syncMaps('openers').syncMapItems(chatSid).remove().catch(() => undefined);
    return item.line;
  },

  /** An attendee's live state (profileId, status…) from the audience Sync map, or null. */
  async live(key) {
    if (!audSync || !key) return null;
    try {
      const item = await audSync.syncMaps('aud_live').syncMapItems(key).fetch();
      return item.data || null;
    } catch (err) {
      return null;
    }
  },

  /** Publish an event straight to an attendee's live view (before a conversation id exists). */
  publish(key, type, data = {}, channel = null, ref = null) {
    if (!audSync || !key) return;
    const event = fit({ id: randomUUID().slice(0, 12), ts: new Date().toISOString(), type, conversationId: null, channel, ref, data });
    const listName = `events-att-${key}`;
    enqueue(`aud:${listName}`, () => appendToList(listName, event, audSync)).catch((err) =>
      log.warn({ type, list: listName, err: err.message }, 'Audience event publish failed')
    );
  },

  /**
   * Merge fields into an attendee's live state ("aud_live", drives the dashboard bubble).
   * Optionally records a conversation in their journey. Serialised per attendee.
   */
  updateLive(key, fields = {}, conversation = null) {
    if (!audSync || !key) return;
    enqueue(`aud-live:${key}`, async () => {
      const cur = (await mapGet('aud_live', key, audSync)) || { key, conversations: [] };
      const next = { ...cur, ...fields, updatedAt: new Date().toISOString() };
      if (conversation) {
        const list = Array.isArray(cur.conversations) ? [...cur.conversations] : [];
        const i = list.findIndex((c) => c.conversationId === conversation.conversationId);
        if (i === -1) list.push({ startedAt: new Date().toISOString(), ...conversation });
        else list[i] = { ...list[i], ...conversation };
        next.conversations = list;
      }
      await mapSet('aud_live', key, next, audSync);
    }).catch((err) => log.warn({ key, err: err.message }, 'Audience live update failed'));
  },
};

log.info({ service: settings.syncServiceSid, audienceService: settings.audienceSyncServiceSid || '(audience off)' }, 'Sync event bus ready');
