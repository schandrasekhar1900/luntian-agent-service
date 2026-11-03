/**
 * agent.js — "Lia", Luntian Bank's AI agent. One brain for chat and voice.
 *
 * Flow of one customer turn (called by TAC's onMessageReady):
 *
 *   1. Register the Orchestrator conversation (channel, profile, CallSid / chat SID).
 *   2. Emit what TAC recalled from Conversation Memory (observations, summaries, traits).
 *   3. Build the system prompt = persona + channel style + MemoryPromptBuilder context.
 *   4. Run a Claude tool-use loop (Anthropic Messages API, see claude.js). Tools:
 *        get_customer_accounts      mock core banking (data/customers.json)
 *        calculate_relief_options   refinance / payment-holiday maths
 *        save_customer_note         write an observation to Memory immediately
 *        search_luntian_policies    Enterprise Knowledge (TAC knowledge tool)
 *        handoff                    TAC Studio handoff tool -> Flex
 *   5. Return the reply text; TAC sends it on the right channel.
 *
 * Every step is logged AND published to Twilio Sync (events.js), which is what the
 * under-the-hood page and the Flex panel render.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KnowledgeClient,
  MemoryPromptBuilder,
  createKnowledgeSearchToolAsync,
  createStudioHandoffTool,
} from 'twilio-agent-connect';
import { coEventsUrl, firstName, settings } from './config.js';
import * as claude from './claude.js';
import { getLogger } from './logger.js';
import { bus, registry, takeOpener } from './events.js';
import * as ops from './twilioOps.js';

const log = getLogger('agent');
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const CUSTOMERS = JSON.parse(readFileSync(path.join(DATA, 'customers.json'), 'utf8'));
const KNOWLEDGE_TOOL_NAME = 'search_luntian_policies';

/** Core-banking record for the demo customer (falls back to the first record, e.g. for Gmail aliases). */
function customerRecord() {
  return CUSTOMERS[settings.customerEmail] || Object.values(CUSTOMERS)[0];
}

// --------------------------------------------------------------------------- prompts

const PERSONA = `You are Lia, the AI assistant of Luntian Bank, a Philippine bank.
You help personal-banking customers with their loans.

How you work:
- The customer is already authenticated (logged-in web chat, or calling from their registered mobile).
- CUSTOMER CONTEXT below comes from Conversation Memory: profile traits, observations and summaries
  from earlier conversations on any channel. Use it. Continue where things were left; never re-ask
  something already known. When observations conflict, the most recent one wins (people change their minds).
- Use get_customer_accounts for balances and amortizations, calculate_relief_options for any figures,
  and search_luntian_policies for policy, rates, fees, eligibility and disclosures. Never invent numbers or policy.
- When the customer states something worth remembering for next time (a life event, a preference,
  a decision or change of mind, how they want to be contacted, what they still need to do), call
  save_customer_note with one short third-person sentence, e.g. "Mia now prefers a 3-month home loan
  payment holiday from February instead of refinancing her auto loan."
- You cannot approve fee waivers, exceptions or hardship arrangements, and you cannot submit
  restructuring applications. Explain the policy briefly, tell the customer you will connect them to a
  Loans Care officer who already has the full story, then call the handoff tool with a reason that
  summarises what they want. Also hand off if the customer asks for a person.
- Never ask for card numbers, PINs, OTPs or full account numbers.
- Speak warm, plain English. Mirror light Taglish only if the customer uses it (e.g. "Sige po", "salamat").`;

const CHANNEL_STYLE = {
  CHAT: 'CHANNEL: web chat. Plain text only (no markdown, no bullets, no headings). At most 3 short paragraphs.',
  VOICE:
    'CHANNEL: phone call. Reply in one or two short spoken sentences. No lists, symbols or markdown. ' +
    "Say amounts naturally, e.g. 'about twenty-seven thousand pesos a month'. Ask one question at a time.",
};

/** Tools implemented locally (OpenAI-style schema; converted to Claude's format by toClaudeTool). */
const CUSTOM_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_customer_accounts',
      description: "Get the customer's loan accounts from core banking (balances, amortization, rates, remaining term).",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calculate_relief_options',
      description:
        "Calculate payment-relief figures. option='refinance_auto' re-amortizes the auto loan over new_term_months " +
        "at annual_rate. option='payment_holiday_home' pauses the home loan for holiday_months with interest capitalised.",
      parameters: {
        type: 'object',
        properties: {
          option: { type: 'string', enum: ['refinance_auto', 'payment_holiday_home'] },
          new_term_months: { type: 'integer', description: 'For refinance_auto, e.g. 48' },
          annual_rate: { type: 'number', description: 'For refinance_auto, % p.a., e.g. 7.88' },
          holiday_months: { type: 'integer', description: 'For payment_holiday_home, 1-3' },
        },
        required: ['option'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_customer_note',
      description:
        "Save a durable fact, preference, decision or change of mind to the customer's Conversation Memory right now.",
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: 'One short third-person sentence.' } },
        required: ['note'],
      },
    },
  },
];

/** Convert an OpenAI-style function tool to Claude's tool format. */
function toClaudeTool(tool) {
  return { name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters };
}

// --------------------------------------------------------------------------- loan maths

/** Standard annuity payment. */
function amortization(principal, annualRatePct, months) {
  const r = annualRatePct / 100 / 12;
  return r === 0 ? principal / months : (principal * r) / (1 - (1 + r) ** -months);
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Relief calculator used by the calculate_relief_options tool.
 * Exported so you can sanity-check the story numbers: `node -e "..."`.
 */
export function calculateRelief({ option, new_term_months, annual_rate, holiday_months } = {}) {
  const loans = Object.fromEntries(customerRecord().loans.map((l) => [l.type, l]));
  if (option === 'refinance_auto') {
    const loan = loans.AUTO;
    const term = new_term_months || 48;
    const rate = annual_rate || 7.88;
    const payment = amortization(loan.outstandingBalance, rate, term);
    return {
      option: 'Auto loan refinance',
      currentMonthly: loan.monthlyAmortization,
      newMonthly: round2(payment),
      monthlySaving: round2(loan.monthlyAmortization - payment),
      newTermMonths: term,
      annualRate: rate,
      extraTotalCostOverLife: round2(payment * term - loan.monthlyAmortization * loan.remainingTermMonths),
      processingFee: 5000,
    };
  }
  if (option === 'payment_holiday_home') {
    const loan = loans.HOME;
    const months = Math.max(1, Math.min(holiday_months || 3, 3));
    const r = loan.interestRatePa / 100 / 12;
    const balanceAfter = loan.outstandingBalance * (1 + r) ** months;
    const payment = amortization(balanceAfter, loan.interestRatePa, loan.remainingTermMonths - months);
    return {
      option: 'Home loan payment holiday',
      holidayMonths: months,
      cashFlowFreedDuringHoliday: loan.monthlyAmortization * months,
      interestCapitalised: round2(balanceAfter - loan.outstandingBalance),
      monthlyAfterHoliday: round2(payment),
      increasePerMonthAfter: round2(payment - loan.monthlyAmortization),
      restructuringFee: 5000,
      eligible: loan.monthsInGoodStanding >= 12,
    };
  }
  return { error: `unknown option ${option}` };
}

// --------------------------------------------------------------------------- the agent

export class Lia {
  /** @param {import('twilio-agent-connect').TAC} tac */
  constructor(tac) {
    this.tac = tac;
    /** @type {Map<string, Array<object>>} chat history per Orchestrator conversation */
    this.history = new Map();
    /**
     * Opening lines are generated before TAC knows the Orchestrator conversation id,
     * so they are parked by classic chat SID / CallSid and folded into history on turn one.
     * @type {Map<string, string>}
     */
    this.pendingOpeners = new Map();
    this.knowledgeTool = null;
    this.knowledgeClient = tac.getKnowledgeClient() || new KnowledgeClient(tac.getConfig());
    log.info({ model: settings.anthropicModel, knowledgeBase: settings.knowledgeBaseId || null }, 'Lia initialised');
  }

  forget(conversationId) {
    this.history.delete(conversationId);
    log.debug({ conversationId }, 'Conversation history dropped');
  }

  // ------------------------------------------------------------------ Enterprise Knowledge

  /** Lazily build TAC's knowledge search tool (needs an async KB lookup). */
  async getKnowledgeTool() {
    if (!settings.knowledgeBaseId) return null;
    if (!this.knowledgeTool) {
      try {
        this.knowledgeTool = await createKnowledgeSearchToolAsync(this.knowledgeClient, settings.knowledgeBaseId, {
          name: KNOWLEDGE_TOOL_NAME,
          description:
            "Search Luntian Bank's Enterprise Knowledge base: loan refinancing, payment holidays, fees and waivers, " +
            'credit reporting, required documents and mandatory disclosures. The input MUST be a question.',
          topK: 4,
        });
        log.info({ knowledgeBaseId: settings.knowledgeBaseId }, 'Knowledge search tool ready');
      } catch (err) {
        log.warn({ err: err.message }, 'Knowledge tool unavailable; Lia will answer without policy search');
      }
    }
    return this.knowledgeTool;
  }

  // ------------------------------------------------------------------ tools

  /** TAC's Studio handoff tool for this session (null if not configured). */
  handoffTool(session) {
    if (!settings.studioFlowSid) return null;
    try {
      return createStudioHandoffTool(this.tac, session, {
        attributes: { department: 'loans_care', brand: 'Luntian Bank', customerName: settings.customerName },
        description:
          'Transfer the customer to a human Loans Care officer in Flex. Use for fee waivers, exceptions, hardship ' +
          'approvals, restructuring submissions, complaints, or when the customer asks for a person. ' +
          'The reason must summarise what the customer wants.',
      });
    } catch (err) {
      log.warn({ err: err.message }, 'Handoff tool unavailable');
      return null;
    }
  }

  /** Execute one tool call from the LLM, logging and emitting events around it. */
  async runTool(name, args, session, conversationId, channel, knowledgeTool, handoffTool) {
    const tlog = log.child({ conversationId, channel, tool: name });
    tlog.info({ args }, 'Tool call');

    // Enterprise Knowledge
    if (knowledgeTool && name === knowledgeTool.name) {
      const query = args.query || Object.values(args)[0] || '';
      bus.emit('knowledge_search', { query }, conversationId, channel);
      const chunks = (await knowledgeTool.implementation({ query })) || [];
      tlog.info({ query, hits: chunks.length, topScore: chunks[0]?.score }, 'Knowledge results');
      bus.emit(
        'knowledge_results',
        {
          query,
          chunks: chunks.map((c) => ({ content: String(c.content).slice(0, 600), score: c.score, knowledgeId: c.knowledgeId })),
        },
        conversationId,
        channel
      );
      return chunks;
    }

    bus.emit('tool_call', { name, args }, conversationId, channel);
    let result;

    if (name === 'get_customer_accounts') {
      result = customerRecord();
    } else if (name === 'calculate_relief_options') {
      result = calculateRelief(args);
    } else if (name === 'save_customer_note') {
      // Memory extraction only runs when a conversation closes, so facts the next
      // channel must know immediately are written straight to the Memory API.
      const note = String(args.note || '').trim();
      result = { saved: false };
      const profileId = session.profileId || (await ops.lookupProfileId(this.tac, { email: settings.customerEmail }));
      const memory = this.tac.getMemoryClient();
      if (note && profileId && memory) {
        try {
          await memory.createObservation(profileId, note, 'lia-ai-agent', [conversationId]);
          result = { saved: true };
          tlog.info({ profileId, note }, 'Observation written to Conversation Memory');
          bus.emit('memory_write', { note, profileId }, conversationId, channel);
        } catch (err) {
          tlog.error({ err: err.message }, 'createObservation failed');
          result = { saved: false, error: err.message };
        }
      } else {
        tlog.warn({ hasNote: !!note, profileId }, 'save_customer_note skipped (no profile or empty note)');
      }
    } else if (handoffTool && name === handoffTool.name) {
      const reason = String(args.reason || '');
      tlog.info({ reason }, 'Handing off to Flex via Studio');
      result = await handoffTool.implementation({ reason });
      tlog.info({ result }, 'Handoff tool returned');
      bus.emit('handoff', { reason, result }, conversationId, channel);
      registry.upsert(conversationId, { status: 'HANDED_OFF', handoffReason: reason });
      if (channel === 'CHAT' && result?.status === 'handoff_initiated') {
        // TAC cleared this conversation's callbacks; re-attach to OUR endpoint for the Flex panel.
        // (For voice the Serverless /voice/agent-transcription does it, called from Studio.)
        void ops.attachStatusCallback(conversationId, coEventsUrl);
      }
    } else {
      tlog.warn('Unknown tool requested by the model');
      result = { error: `unknown tool ${name}` };
    }

    tlog.debug({ result }, 'Tool result');
    bus.emit('tool_result', { name, result }, conversationId, channel);
    return result;
  }

  // ------------------------------------------------------------------ one customer turn

  systemPrompt(channel, session, memory) {
    const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'full', timeStyle: 'short' });
    const base = [PERSONA, CHANNEL_STYLE[channel] || CHANNEL_STYLE.CHAT, `Now: ${now} (Manila)`].join('\n\n');
    // MemoryPromptBuilder.compose appends profile traits, observations, summaries
    // and recent communications in TAC's standard format.
    return MemoryPromptBuilder.compose(base, memory, session);
  }

  /**
   * TAC onMessageReady handler body.
   * @param {{conversationId: string, message: string, memory?: any, session: any, channel: string}} p
   * @returns {Promise<string>}
   */
  async respond({ conversationId, message, memory, session, channel: rawChannel }) {
    const started = Date.now();
    const channel = String(rawChannel || session.channel || 'chat').toUpperCase();
    const chatSid = typeof session.metadata?.channelId === 'string' ? session.metadata.channelId : undefined;
    const tlog = log.child({ conversationId, channel });
    tlog.info({ message, profileId: session.profileId, callSid: session.callSid, chatSid }, 'Customer turn received');

    registry.upsert(conversationId, { channel, profileId: session.profileId, callSid: session.callSid, chatSid });

    // First turn of this conversation: fold in Lia's memory-informed opening line.
    let history = this.history.get(conversationId);
    if (!history) {
      history = [];
      this.history.set(conversationId, history);
      // Voice opening lines are generated here (kept in memory); chat ones by the
      // Serverless /chat/greet Function (parked in Sync map "openers").
      const localKey = [chatSid, session.callSid].find((k) => k && this.pendingOpeners.has(k));
      const opener = localKey ? this.pendingOpeners.get(localKey) : await takeOpener(chatSid);
      if (localKey) this.pendingOpeners.delete(localKey);
      if (opener) {
        history.push({ role: 'assistant', content: opener });
        tlog.info({ key: localKey || chatSid }, 'Opening line linked to this conversation');
      }
      bus.emit('conversation_linked', { chatSid, callSid: session.callSid, profileId: session.profileId }, conversationId, channel);
    }

    const observations = (memory?.observations || []).map((o) => o.content);
    const summaries = (memory?.summaries || []).map((s) => s.content);
    tlog.info({ observations: observations.length, summaries: summaries.length }, 'Memory recalled by TAC for this turn');
    tlog.debug({ observations, summaries, traits: session.profile?.traits }, 'Recalled memory detail');
    bus.emit('customer_message', { text: message }, conversationId, channel);
    bus.emit(
      'memory_recall',
      { profileId: session.profileId, traits: session.profile?.traits || {}, observations, summaries },
      conversationId,
      channel
    );

    history.push({ role: 'user', content: message });

    const knowledgeTool = await this.getKnowledgeTool();
    const handoffTool = this.handoffTool(session);
    // Claude tool format: { name, description, input_schema }. TAC tools provide toAnthropicFormat().
    const tools = CUSTOM_TOOLS.map(toClaudeTool);
    if (knowledgeTool) tools.push(knowledgeTool.toAnthropicFormat());
    if (handoffTool) tools.push(handoffTool.toAnthropicFormat());

    const system = this.systemPrompt(channel, session, memory);
    tlog.debug({ system }, 'System prompt');
    // Claude's Messages API wants the first message from the user. On turn one the
    // history starts with Lia's opening line, so we prefix a short context note.
    const messages = history[0]?.role === 'assistant'
      ? [{ role: 'user', content: `(The customer opened the ${channel === 'VOICE' ? 'call' : 'chat'}.)` }, ...history]
      : [...history];

    let reply = '';
    let toolCalls = 0;
    try {
      // Tool-use loop: at most 6 model round trips per customer turn.
      for (let round = 1; round <= 6; round += 1) {
        const t0 = Date.now();
        const resp = await claude.messages({ system, messages, tools, maxTokens: channel === 'VOICE' ? 400 : 800, purpose: `turn ${round}` });
        const toolUses = (resp.content || []).filter((b) => b.type === 'tool_use');
        const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        tlog.debug({ round, ms: Date.now() - t0, stop: resp.stop_reason, toolUses: toolUses.length, usage: resp.usage }, 'LLM round');

        if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
          reply = text;
          break;
        }
        // Echo Claude's full turn (text + tool_use blocks), then answer every tool_use in one user turn.
        messages.push({ role: 'assistant', content: resp.content });
        const results = [];
        for (const call of toolUses) {
          toolCalls += 1;
          let result;
          try {
            result = await this.runTool(call.name, call.input || {}, session, conversationId, channel, knowledgeTool, handoffTool);
          } catch (err) {
            tlog.error({ tool: call.name, err: err.message }, 'Tool execution failed');
            result = { error: err.message };
          }
          results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result).slice(0, 8000) });
        }
        messages.push({ role: 'user', content: results });
      }
    } catch (err) {
      tlog.error({ err: err.message }, 'LLM turn failed');
      bus.emit('error', { message: err.message }, conversationId, channel);
      reply = 'Pasensya na, I hit a snag on my side. Could you say that again?';
    }

    reply ||= 'Sige, one moment po.';
    history.push({ role: 'assistant', content: reply });
    bus.emit('agent_message', { text: reply }, conversationId, channel);
    tlog.info({ reply, toolCalls, ms: Date.now() - started }, 'Lia replied');
    return reply;
  }

  // ------------------------------------------------------------------ informed opening line

  /**
   * Build the first thing Lia says, from Conversation Memory (the "informed start").
   * @param {'CHAT'|'VOICE'} channel
   * @param {string|null} profileId
   * @param {string} key classic chat SID or CallSid, used to link it to the conversation later
   */
  async openingLine(channel, profileId, key) {
    const tlog = log.child({ channel, key });
    const snap = await ops.memorySnapshot(this.tac, profileId, 'loan relief plans, decisions, preferences and next steps');
    const name = snap.traits?.Contact?.firstName || firstName;
    const coldStart = !(snap.observations.length || snap.summaries.length);
    let line;

    if (coldStart) {
      line =
        channel === 'VOICE'
          ? `Hi ${name}, this is Lia from Luntian Bank. How can I help you today?`
          : `Hi ${name}! I'm Lia, your Luntian assistant. Kumusta? How can I help you today?`;
      tlog.info({ profileId }, 'Opening line: cold start (no memory yet)');
    } else {
      const memoryText = [
        ...snap.observations.map((o) => `- [${o.occurredAt || o.createdAt}] ${o.content}`),
        ...snap.summaries.map((s) => `- [summary ${s.createdAt}] ${s.content}`),
      ].join('\n');
      const style =
        channel === 'VOICE'
          ? 'It will be spoken on a phone call: max 35 words, no symbols, amounts in words.'
          : 'It is a web chat message: max 45 words, plain text.';
      const prompt =
        `You are Lia, Luntian Bank's AI assistant. ${name} is a returning customer who has just opened a ` +
        `${channel === 'VOICE' ? 'phone call' : 'web chat'}.\n` +
        `What we know (oldest first; later entries supersede earlier ones):\n${memoryText}\n\n` +
        "Write Lia's opening message. Greet by first name, reflect the CURRENT state of their plans in one specific " +
        'sentence (ignore superseded plans), and ask one question that moves things forward. ' +
        `Never mention memory, notes or records. ${style}`;
      tlog.debug({ prompt }, 'Opening line prompt');
      try {
        const t0 = Date.now();
        line = await claude.text(prompt, { maxTokens: 200, timeoutMs: 8000, purpose: 'opening line' });
        tlog.info({ ms: Date.now() - t0, observations: snap.observations.length, summaries: snap.summaries.length }, 'Opening line generated from memory');
      } catch (err) {
        tlog.warn({ err: err.message }, 'Opening line generation failed; using fallback');
        line = `Welcome back, ${name}! Shall we pick up where we left off?`;
      }
    }

    this.pendingOpeners.set(key, line);
    tlog.info({ line }, 'Opening line ready');
    bus.emit(
      'opening_line',
      { channel, profileId, line, coldStart, traits: snap.traits, observations: snap.observations, summaries: snap.summaries },
      null,
      channel,
      key
    );
    return line;
  }
}
