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

import { ChatChannel, TAC, TACConfig, TACServer, VoiceChannel, WhatsAppChannel } from 'twilio-agent-connect';
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
/**
 * Pia's spoken voice (ConversationRelay text-to-speech). Set on Render, no code change needed:
 *   PIA_TTS_PROVIDER  ElevenLabs | Google | Amazon        (default: ConversationRelay's, ElevenLabs)
 *   PIA_VOICE         the voice ID, e.g. an ElevenLabs ID from the ConversationRelay voice picker,
 *                     or a Google ID such as fil-PH-Wavenet-A
 *   PIA_TTS_LANGUAGE  e.g. en-US (default) or fil-PH
 * Unset values are left out, so ConversationRelay's defaults apply.
 */
const voiceSettings = Object.fromEntries(
  [
    ['ttsProvider', process.env.PIA_TTS_PROVIDER],
    ['voice', process.env.PIA_VOICE],
    ['ttsLanguage', process.env.PIA_TTS_LANGUAGE],
  ].filter(([, v]) => v && String(v).trim()).map(([k, v]) => [k, String(v).trim()])
);
log.info({ voice: Object.keys(voiceSettings).length ? voiceSettings : 'ConversationRelay default' }, 'Pia voice settings');

const voiceChannel = new VoiceChannel(tac, {
  memoryMode: 'once',
  defaultTwimlOptions: { welcomeGreeting: 'Hi, this is Pia from Luntian Bank. How can I help you today?', interruptible: 'speech', ...voiceSettings },
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
  // Audience attendee calling from their chat page (browser softphone, identity aud_<key>):
  // greet from THEIR profile and remember the call so every turn is theirs.
  const audMatch = String(req.from || '').match(/^client:aud_([a-z0-9_]+)$/);
  if (audMatch) {
    const attendeeKey = audMatch[1].replace(/_/g, '-');
    try {
      const live = await withTimeout(audience.live(attendeeKey), 2000, 'attendee lookup');
      if (!live?.profileId) throw new Error('attendee has no profile yet');
      // Hand the live chat (if any) to the call: greeting and every call turn continue from it
      const chatContext = live.channel === 'CHAT' || live.chatSid ? lia.recentTranscript(live.conversationId) : '';
      lia.callAudience.set(req.callSid, { key: attendeeKey, profileId: live.profileId, chatContext });
      if (chatContext) vlog.info({ attendeeKey, chars: chatContext.length }, 'Audience browser call: continuing from the live chat');
      audience.updateLive(attendeeKey, { channel: 'VOICE', status: 'with_pia', callSid: req.callSid });
      audience.publish(attendeeKey, 'call_started', { from: 'browser' }, 'VOICE', req.callSid);
      const line = await withTimeout(lia.openingLine('VOICE', live.profileId, req.callSid, chatContext), 7000, 'opening line');
      vlog.info({ attendeeKey, profileId: live.profileId, line }, 'Audience browser call: greeting set');
      return { welcomeGreeting: line };
    } catch (err) {
      vlog.warn({ attendeeKey, err: err.message }, 'Audience browser call: greeting fell back to the default');
      return {};
    }
  }
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

/**
 * WhatsApp (audience segment): Agent Connect's built-in WhatsApp channel, enabled only when
 * TWILIO_WHATSAPP_NUMBER is set (e.g. whatsapp:+14155238886 for the Twilio Sandbox). Inbound
 * messages reach Pia through the Orchestrator configuration's WHATSAPP capture rule; replies
 * go out from that number. Customers are recognised by their phone number (Memory profile).
 */
const messagingChannels = [chatChannel];
if ((process.env.TWILIO_WHATSAPP_NUMBER || '').trim()) {
  messagingChannels.push(new WhatsAppChannel(tac, { memoryMode: 'always' }));
  log.info({ number: process.env.TWILIO_WHATSAPP_NUMBER }, 'WhatsApp channel enabled');
} else {
  log.info('WhatsApp channel off (TWILIO_WHATSAPP_NUMBER not set)');
}

const server = new TACServer(tac, { port: settings.port, voiceChannel, messagingChannels, fastify: { logger: false } });
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

/**
 * POST /audience/call?key=WEBHOOK_KEY {attendeeKey, phone, profileId}
 * Called by the audience Serverless /audience/call-me after it added the attendee's mobile
 * number to their Memory profile. Answers at once (202), then in the background:
 *   1. waits until Memory resolves that number to the attendee's profile (same profile as chat),
 *   2. writes Pia's memory-informed spoken greeting,
 *   3. places the outbound call from the hotline via Agent Connect (ConversationRelay).
 * When the call connects, Orchestrator links it to the profile, so the audience Pia recognises
 * the attendee exactly as for chat (scenario, live view, bubble).
 */
app.post('/audience/call', async (request, reply) => {
  if ((request.query?.key || '') !== settings.webhookKey) return reply.code(403).send({ error: 'bad key' });
  const { attendeeKey, phone, profileId } = request.body || {};
  if (!attendeeKey || !/^\+\d{8,15}$/.test(String(phone || '')) || !profileId) return reply.code(400).send({ error: 'attendeeKey, phone (E.164) and profileId required' });
  const clog = log.child({ attendeeKey });
  clog.info({ phone: `${String(phone).slice(0, 4)}…${String(phone).slice(-3)}` }, 'Audience call requested');
  audience.updateLive(attendeeKey, { channel: 'VOICE', status: 'calling' });
  audience.publish(attendeeKey, 'call_started', { note: 'Pia is calling the attendee' }, 'VOICE');
  reply.code(202).send({ ok: true });

  (async () => {
    try {
      // 1. Wait (max ~10 s) until the number resolves to the attendee's existing profile
      const memory = tac.getMemoryClient();
      let resolved = null;
      for (let i = 0; i < 10 && memory; i += 1) {
        try {
          const r = await memory.lookupProfile('phone', phone);
          resolved = r.profiles?.[0] || null;
          if (resolved === profileId) break;
        } catch (e) { /* not yet */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
      clog.info({ resolved, expected: profileId, match: resolved === profileId }, 'Phone number resolution before calling');
      // 2. Greeting from memory (same as inbound calls)
      const line = await lia.openingLine('VOICE', profileId, `out-${attendeeKey}`);
      // 3. Call
      const result = await voiceChannel.initiateOutboundConversation({ to: phone, twimlOptions: { welcomeGreeting: line } });
      lia.pendingOpeners.set(result.callSid, line); // first turn picks the greeting up by CallSid
      clog.info({ callSid: result.callSid }, 'Outbound call placed');
      audience.updateLive(attendeeKey, { channel: 'VOICE', status: 'with_pia', callSid: result.callSid });
    } catch (err) {
      clog.error({ err: err.message }, 'Outbound call failed');
      audience.updateLive(attendeeKey, { status: 'call_failed' });
      audience.publish(attendeeKey, 'error', { message: `Call failed: ${err.message}` }, 'VOICE');
    }
  })();
});

app.get('/health', async () => ({ ok: true, memoryStore: tac.getMemoryStoreId() || null, at: new Date().toISOString() }));

await server.start();
log.info(`Orchestrator status callback -> ${baseUrl}/webhook`);
log.info(`AI hotline Voice webhook     -> ${baseUrl}/twiml`);
log.info(`Health                       -> ${baseUrl}/health`);
log.info(`Listening on port ${settings.port}`);
