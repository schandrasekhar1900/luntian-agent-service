/**
 * server.js — Pia agent service (Node.js + Twilio Agent Connect).
 *
 * Why this isn't a Twilio Function: ConversationRelay streams the AI voice call over
 * a WebSocket, and TAC keeps per-conversation state between webhooks. Functions
 * can't hold WebSockets and are stateless, so this small service runs as one
 * long-lived Node process (behind an ngrok static domain, or any WebSocket-capable host).
 * Everything else (web pages, tokens, TwiML, Flex APIs, CI webhooks) is on Serverless.
 *
 * Routes (all registered by TAC's TACServer on Fastify):
 *   POST /webhook                     Conversation Orchestrator events (chat turns, lifecycle)
 *   POST /twiml                       AI hotline's Voice webhook -> <Connect><ConversationRelay>
 *   WS   /ws                          ConversationRelay stream (speech <-> text)
 *   POST /conversation-relay-callback ConversationRelay end (TAC routes handoffs to Studio)
 *   GET  /health                      liveness check (added below)
 *
 * Act 3 call paths both arrive at /twiml with From = Mia's mobile:
 *   - inbound: Mia dials the hotline from her mobile
 *   - browser: TwiML App -> Serverless /voice/client-dial -> dials the hotline with her caller ID
 *
 * Run: npm start (after npm install and filling .env).
 */

import { ChatChannel, TAC, TACConfig, TACServer, VoiceChannel } from 'twilio-agent-connect';
import { Pia } from './agent.js';
import { baseUrl, settings } from './config.js';
import { audience, bus, registry } from './events.js';
import { getLogger } from './logger.js';
import * as ops from './twilioOps.js';

const log = getLogger('server');
process.on('unhandledRejection', (err) => log.error({ err: err?.message, stack: err?.stack }, 'Unhandled promise rejection'));
process.on('uncaughtException', (err) => log.fatal({ err: err.message, stack: err.stack }, 'Uncaught exception'));

// ============================================================================ TAC

log.info({ configurationId: settings.conversationConfigurationId }, 'Starting Twilio Agent Connect');
const tac = await TAC.create({ config: TACConfig.fromEnv() });
log.info({ orchestrator: tac.isOrchestratorEnabled(), memoryStore: tac.getMemoryStoreId() || null }, 'TAC ready');
if (!tac.getMemoryStoreId()) log.warn('No memory store linked to the Orchestrator configuration: Pia will have no memory');

const lia = new Pia(tac);

/**
 * Chat: customers use the Conversations JS SDK with their EMAIL as identity, which
 * TAC uses to find the Memory profile. memoryMode "always" = recall on every turn,
 * using the customer's message as the semantic query.
 */
const chatChannel = new ChatChannel(tac, { agentAddress: settings.chatAgentIdentity, memoryMode: 'always' });

/**
 * Voice: ConversationRelay. memoryMode "once" = one recall per call (lower latency).
 * The greeting is replaced per call by onInboundCallTwiml below.
 */
const voiceChannel = new VoiceChannel(tac, {
  memoryMode: 'once',
  defaultTwimlOptions: { welcomeGreeting: 'Hi, this is Pia from Luntian Bank. How can I help you today?', interruptible: 'speech' },
});

/** Every customer turn on any channel. TAC sends the returned text on the right channel. */
tac.onMessageReady(async (params) => lia.respond(params));

/** Orchestrator reported the conversation CLOSED (Memory extraction runs now). */
tac.onConversationEnded(({ session }) => {
  const channel = String(session.channel || '').toUpperCase();
  log.info({ conversationId: session.conversationId, channel }, 'Conversation ended: Memory extraction runs on close');
  registry.upsert(session.conversationId, { status: 'CLOSED' });
  bus.emit('conversation_status', { status: 'CLOSED', note: 'Memory extraction runs on close' }, session.conversationId, channel);
  const audKey = audience.keyForConversation(session.conversationId);
  if (audKey) audience.updateLive(audKey, { status: 'ended' }, { conversationId: session.conversationId, status: 'CLOSED' });
  lia.release(session.conversationId);
  lia.forget(session.conversationId);
});

/**
 * Inbound call (from Mia's mobile, or the browser button dialling out as her):
 * build the greeting from Conversation Memory BEFORE she says a word.
 */
voiceChannel.onInboundCallTwiml(async (req) => {
  const vlog = log.child({ callSid: req.callSid });
  vlog.info({ from: req.from, to: req.to }, 'Inbound call to the AI hotline: building memory-informed greeting');
  bus.emit('call_started', { from: req.from, callSid: req.callSid }, null, 'VOICE', req.callSid);
  try {
    const profileId = await withTimeout(ops.lookupProfileId(tac, { phone: req.from }), 3000, 'profile lookup');
    if (!profileId) vlog.warn({ from: req.from }, 'Caller is not linked to a Memory profile (is DEMO_CUSTOMER_PHONE the number calling?)');
    const line = await withTimeout(lia.openingLine('VOICE', profileId, req.callSid || req.from), 7000, 'opening line');
    vlog.info({ profileId, line }, 'Voice greeting set');
    return { welcomeGreeting: line };
  } catch (err) {
    vlog.warn({ err: err.message }, 'Voice greeting fell back to the default');
    return {};
  }
});

/** Reject after `ms` so a slow API never hits Twilio's 15 s TwiML timeout. */
function withTimeout(promise, ms, label) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms))]);
}

// ============================================================================ HTTP

const server = new TACServer(tac, { port: settings.port, voiceChannel, messagingChannels: [chatChannel], fastify: { logger: false } });
const app = server.fastify;

/** Log every request/response through our logger (TAC's own Fastify logger is off). */
app.addHook('onRequest', async (request) => {
  request.startedAt = Date.now();
  log.debug({ method: request.method, url: request.url }, '→ request');
});
app.addHook('onResponse', async (request, reply) => {
  const level = reply.statusCode >= 400 ? 'warn' : 'debug';
  log[level]({ method: request.method, url: request.url, status: reply.statusCode, ms: Date.now() - (request.startedAt || Date.now()) }, '← response');
});

/**
 * Tee Orchestrator lifecycle events that reach TAC's /webhook into Sync, so the
 * /brain page shows ACTIVE / INACTIVE / CLOSED and profile resolution. Runs after
 * the response, and only when TAC accepted the request (valid Twilio signature).
 */
app.addHook('onResponse', async (request, reply) => {
  if (request.method !== 'POST' || request.url.split('?')[0] !== '/webhook' || !request.body) return;
  if (reply.statusCode >= 300) return; // rejected by TAC (e.g. bad signature): ignore
  const { eventType, data = {} } = request.body;
  log.debug({ eventType, body: request.body }, 'Orchestrator webhook payload');
  const conversationId = data.conversationId || (eventType === 'CONVERSATION_UPDATED' ? data.id : null);
  if (eventType === 'CONVERSATION_UPDATED' && conversationId && data.status) {
    log.info({ conversationId, status: data.status }, 'Orchestrator: conversation status changed');
    registry.upsert(conversationId, { status: data.status });
    bus.emit('conversation_status', { status: data.status }, conversationId);
    const audKey = audience.keyForConversation(conversationId);
    if (audKey) audience.updateLive(audKey, data.status === 'CLOSED' ? { status: 'ended' } : {}, { conversationId, status: data.status });
  } else if (eventType === 'PARTICIPANT_ADDED' && conversationId && data.profileId) {
    log.info({ conversationId, profileId: data.profileId, type: data.type }, 'Orchestrator: participant linked to Memory profile');
    // Audience attendee? Mark it first so this and later events go to their own live view.
    const audKey = await audience.keyForProfile(data.profileId);
    if (audKey) {
      audience.mark(conversationId, audKey);
      audience.updateLive(audKey, { conversationId }, { conversationId, channel: data.addresses?.[0]?.channel || 'CHAT', status: 'ACTIVE' });
    }
    registry.upsert(conversationId, { profileId: data.profileId });
    bus.emit('profile_resolved', { profileId: data.profileId, participantType: data.type }, conversationId);
  }
});

app.get('/health', async () => ({ ok: true, memoryStore: tac.getMemoryStoreId() || null, at: new Date().toISOString() }));

await server.start();
log.info(`Orchestrator status callback -> ${baseUrl}/webhook`);
log.info(`AI hotline Voice webhook     -> ${baseUrl}/twiml`);
log.info(`Health                       -> ${baseUrl}/health`);
log.info(`Listening on port ${settings.port}`);
