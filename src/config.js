/**
 * config.js — every setting the agent service needs, read once from agent-service/.env.
 *
 * Twilio Agent Connect (TAC) reads its own variables (TWILIO_ACCOUNT_SID,
 * TWILIO_CONVERSATION_CONFIGURATION_ID, TWILIO_STUDIO_HANDOFF_FLOW_SID, ...)
 * through TACConfig.fromEnv(). This file holds the extra demo settings and
 * validates the ones without which nothing works, so a missing value fails
 * loudly at startup instead of halfway through a rehearsal.
 */

import 'dotenv/config';
import { getLogger } from './logger.js';

const log = getLogger('config');

/** Read a required variable or exit with a clear message. */
function required(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    log.error(`Missing required environment variable ${name} (see agent-service/.env.example)`);
    process.exit(1);
  }
  return value;
}

/** Read an optional variable, logging when it is absent so gaps are visible. */
function optional(name, fallback = '') {
  const value = (process.env[name] || '').trim();
  if (!value) log.warn({ name, fallback }, `Optional variable ${name} not set; using fallback`);
  return value || fallback;
}

export const settings = Object.freeze({
  accountSid: required('TWILIO_ACCOUNT_SID'),
  authToken: required('TWILIO_AUTH_TOKEN'),
  apiKey: required('TWILIO_API_KEY'),
  apiSecret: required('TWILIO_API_SECRET'),

  /** Twilio number the AI voice agent answers on (Voice webhook -> /twiml). */
  agentNumber: required('TWILIO_PHONE_NUMBER'),
  /** Public host name (ngrok static domain), no scheme. */
  publicDomain: required('TWILIO_VOICE_PUBLIC_DOMAIN'),
  /** Conversations (classic) service Flex uses; bridged into Orchestrator. */
  conversationsServiceSid: required('TWILIO_CONVERSATIONS_SERVICE_SID'),
  conversationConfigurationId: required('TWILIO_CONVERSATION_CONFIGURATION_ID'),

  /** Shared live-event bus: Twilio Sync service (same as the Serverless service). */
  syncServiceSid: required('SYNC_SERVICE_SID'),
  /** Serverless domain (no scheme) hosting /webhooks/co-events, and its shared secret. */
  functionsDomain: required('FUNCTIONS_DOMAIN'),
  webhookKey: required('WEBHOOK_KEY'),

  studioFlowSid: optional('TWILIO_STUDIO_HANDOFF_FLOW_SID'),
  knowledgeBaseId: optional('TWILIO_KNOWLEDGE_BASE_ID'),

  /** Claude via the Anthropic Messages API. Haiku keeps voice replies fast; Sonnet is richer. */
  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  anthropicModel: optional('ANTHROPIC_MODEL', 'claude-haiku-5-5'),

  customerName: optional('DEMO_CUSTOMER_NAME', 'Mia Santos'),
  /** The customer's email doubles as her chat identity (TAC resolves the Memory profile by email). */
  customerEmail: required('DEMO_CUSTOMER_EMAIL').toLowerCase(),
  /** Verified caller ID presented when the web page dials the AI agent. */
  customerPhone: required('DEMO_CUSTOMER_PHONE'),
  chatAgentIdentity: optional('CHAT_AGENT_IDENTITY', 'lia'),

  port: Number(optional('PORT', '8000')),
});

/** https://<domain> of this agent service. */
export const baseUrl = `https://${settings.publicDomain}`;
/** Serverless webhook that receives a conversation's events after handoff (Flex live assist). */
export const coEventsUrl = `https://${settings.functionsDomain}/webhooks/co-events?key=${encodeURIComponent(settings.webhookKey)}`;
export const firstName = settings.customerName.split(/\s+/)[0];

/** Addresses that identify the customer in Orchestrator communications. */
export const customerAddresses = new Set([settings.customerEmail, settings.customerPhone]);
/** Addresses that identify Lia (AI) in Orchestrator communications. */
export const aiAddresses = new Set([settings.chatAgentIdentity, settings.agentNumber]);

if (settings.chatAgentIdentity === settings.customerEmail) {
  log.error('CHAT_AGENT_IDENTITY must differ from DEMO_CUSTOMER_EMAIL or TAC will ignore the customer');
  process.exit(1);
}

log.info(
  {
    publicDomain: settings.publicDomain,
    agentNumber: settings.agentNumber,
    customer: settings.customerEmail,
    customerPhone: settings.customerPhone,
    model: settings.anthropicModel,
    knowledgeBase: settings.knowledgeBaseId || '(none)',
    studioFlow: settings.studioFlowSid || '(none: handoff disabled)',
    syncService: settings.syncServiceSid,
    functionsDomain: settings.functionsDomain,
  },
  'Configuration loaded'
);
