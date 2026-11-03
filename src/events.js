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

async function appendToList(listName, data) {
  try {
    await sync.syncLists(listName).syncListItems.create({ data, itemTtl: LIST_TTL });
  } catch (err) {
    if (err.status !== 404) throw err;
    log.debug({ listName }, 'Sync list missing; creating it');
    try {
      await sync.syncLists.create({ uniqueName: listName, ttl: LIST_TTL });
    } catch (e) {
      if (e.status !== 409) throw e;
    }
    await sync.syncLists(listName).syncListItems.create({ data, itemTtl: LIST_TTL });
  }
}

async function mapSet(mapName, key, data) {
  const items = () => sync.syncMaps(mapName).syncMapItems;
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
        await sync.syncMaps.create({ uniqueName: mapName });
      } catch (e2) {
        if (e2.status !== 409) throw e2;
      }
      await items().create({ key, data });
    }
  }
}

async function mapGet(mapName, key) {
  try {
    return (await sync.syncMaps(mapName).syncMapItems(key).fetch()).data;
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

log.info({ service: settings.syncServiceSid }, 'Sync event bus ready');
