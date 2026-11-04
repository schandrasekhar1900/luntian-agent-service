/**
 * agent.js — "Pia", Luntian Bank's AI agent. One brain for chat and voice.
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

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KnowledgeClient,
  MemoryPromptBuilder,
  createKnowledgeSearchToolAsync,
  createStudioHandoffTool,
} from 'twilio-agent-connect';
import { audienceCoEventsUrl, coEventsUrl, firstName, settings } from './config.js';
import * as claude from './claude.js';
import { getLogger } from './logger.js';
import { audience, bus, registry, takeOpener } from './events.js';
import * as ops from './twilioOps.js';

const log = getLogger('agent');
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
/**
 * Bundled copy of the eight Luntian policy articles (same text as Enterprise Knowledge).
 * Used ONLY as a fallback when the Twilio Knowledge search errors or finds nothing, so Pia
 * can always answer policy questions on stage.
 */
const POLICY_PARAGRAPHS = (() => {
  const dir = path.join(DATA, 'knowledge');
  const out = [];
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      const lines = text.split('\n');
      const title = (lines[0] || f).replace(/^#\s*/, '');
      const body = lines.slice(1).join('\n'); // drop only the heading line; the text may start right below it
      for (const para of body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)) {
        out.push({ title, file: f, text: para });
      }
    }
  } catch (err) {
    /* no bundled articles: fallback simply returns nothing */
  }
  return out;
})();

/** Simple keyword search over the bundled articles: top 3 paragraphs, each with its article title. */
function localPolicySearch(query, top = 3) {
  const words = String(query).toLowerCase().match(/[a-z]{4,}/g) || [];
  return POLICY_PARAGRAPHS.map((p) => {
    const hay = `${p.title} ${p.text}`.toLowerCase();
    const score = words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0);
    return { content: `${p.title}: ${p.text}`.slice(0, 900), score: words.length ? score / words.length : 0, knowledgeId: `bundled:${p.file}` };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, top);
}

const CUSTOMERS = JSON.parse(readFileSync(path.join(DATA, 'customers.json'), 'utf8'));
const KNOWLEDGE_TOOL_NAME = 'search_luntian_policies';

/** Core-banking record for the demo customer (falls back to the first record, e.g. for Gmail aliases). */
function customerRecord() {
  return CUSTOMERS[settings.customerEmail] || Object.values(CUSTOMERS)[0];
}

/** Audience attendees' generated scenarios, by conversation (set at the start of each turn). */
const audienceRecords = new Map();
/** Record for THIS conversation: the attendee's scenario, else Mia's. */
function recordFor(conversationId) {
  return (conversationId && audienceRecords.get(conversationId)) || customerRecord();
}

/** Extra instructions for audience chats (strangers on their phones, on a projector). */
const AUDIENCE_RULES = `AUDIENCE DEMO: this customer is a guest at a live event, chatting on their phone while the room
may watch. Keep every reply to 2-3 short sentences. Stay on Luntian Bank loans; politely decline anything
unrelated, offensive or personal, without lecturing. Use only this customer's own loan data from your tools.`;

// --------------------------------------------------------------------------- prompts

const PERSONA = `You are Pia, the AI assistant of Luntian Bank, a Philippine bank.
You help personal-banking customers with their loans.

How you work:
- The customer is already authenticated (logged-in web chat, or calling from their registered mobile).
- CUSTOMER CONTEXT below comes from Conversation Memory: profile traits, observations and summaries
  from earlier conversations on any channel. Use it. Continue where things were left; never re-ask
  something already known. When observations conflict, the most recent one wins (people change their minds).
- Use get_customer_accounts for balances and amortizations, calculate_relief_options for any figures,
  and search_luntian_policies for policy, rates, fees, eligibility and disclosures. Never invent numbers or policy.
- Figures your tools returned earlier in this conversation are verified: reuse them confidently and never
  retract or apologise for them.
- FIGURES RULE: before you state ANY peso amount, monthly payment, saving, interest cost, rate or term for an
  option, you MUST have called calculate_relief_options (and get_customer_accounts for current balances) in this
  conversation and quote ONLY the numbers those tools returned. If you have not run them yet, run them first.
  Never estimate, round from memory or "approximately" calculate in your head.
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

/** Keep only blocks Claude accepts back in history: non-empty text, tool_use, tool_result. */
function cleanContent(content) {
  if (typeof content === 'string') return content.trim() ? content : null;
  if (!Array.isArray(content)) return null;
  const kept = content
    .filter((b) => (b.type === 'text' && String(b.text || '').trim()) || b.type === 'tool_use' || b.type === 'tool_result')
    .map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} } : { type: 'tool_result', tool_use_id: b.tool_use_id, content: String(b.content ?? '') }));
  return kept.length ? kept : null;
}

/**
 * Plain-text version of a conversation for the recovery call: tool calls become short
 * text notes, roles strictly alternate, first message is from the user.
 */
function plainTranscript(msgs) {
  const out = [];
  for (const m of msgs) {
    let text = '';
    if (typeof m.content === 'string') text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_use' ? `[called ${b.name}]` : b.type === 'tool_result' ? `[${b.name || 'tool'} result: ${String(b.content).slice(0, 1500)}]` : '')).filter(Boolean).join('\n');
    }
    if (!text.trim()) continue;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += `\n${text}`;
    else out.push({ role: m.role, content: text });
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: '(The customer opened the chat.)' });
  if (out.length && out[out.length - 1].role !== 'user') out.push({ role: 'user', content: '(continue)' });
  return out;
}

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
export function calculateRelief({ option, new_term_months, annual_rate, holiday_months } = {}, record = customerRecord()) {
  const loans = Object.fromEntries(record.loans.map((l) => [l.type, l]));
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

export class Pia {
  /** @param {import('twilio-agent-connect').TAC} tac */
  constructor(tac) {
    this.tac = tac;
    /** Conversations where Pia has already run the calculator or account lookup (figures guard) */
    this.dataToolUsed = new Set();
    /** Audience conversations currently handed to Flex (for the concurrent-handoff cap) */
    this.audienceHandoffs = new Set();
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
    log.info({ model: settings.anthropicModel, knowledgeBase: settings.knowledgeBaseId || null }, 'Pia initialised');
  }

  /** Conversation closed: free its handoff slot and per-conversation data. */
  release(conversationId) {
    this.audienceHandoffs.delete(conversationId);
    this.dataToolUsed.delete(conversationId);
    audienceRecords.delete(conversationId);
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
        log.warn({ err: err.message }, 'Knowledge tool unavailable; Pia will answer without policy search');
      }
    }
    return this.knowledgeTool;
  }

  // ------------------------------------------------------------------ tools

  /** TAC's Studio handoff tool for this session (null if not configured). */
  handoffTool(session, audienceKey = null) {
    if (!settings.studioFlowSid) return null;
    const rec = recordFor(session.conversationId);
    const attributes = audienceKey
      ? { department: 'loans_care', brand: 'Luntian Bank', customerName: rec.name, demo: 'audience', attendeeKey: audienceKey }
      : { department: 'loans_care', brand: 'Luntian Bank', customerName: settings.customerName };
    try {
      return createStudioHandoffTool(this.tac, session, {
        attributes,
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
    if ((knowledgeTool && name === knowledgeTool.name) || name === KNOWLEDGE_TOOL_NAME) {
      const query = args.query || Object.values(args)[0] || '';
      bus.emit('knowledge_search', { query }, conversationId, channel);
      let chunks = [];
      if (knowledgeTool) {
        try {
          chunks = (await knowledgeTool.implementation({ query })) || [];
        } catch (err) {
          tlog.warn({ query, err: err.message }, 'Enterprise Knowledge search failed; using bundled policy articles');
        }
      }
      if (!chunks.length) {
        chunks = localPolicySearch(query);
        tlog.info({ query, hits: chunks.length }, 'Policy answer from bundled articles (fallback)');
      }
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
      const { seedObservations, hint, ...rec } = recordFor(conversationId); // tools never see demo-only fields
      result = rec;
    } else if (name === 'calculate_relief_options') {
      result = calculateRelief(args, recordFor(conversationId));
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
      const audKey = audience.keyForConversation(conversationId);
      if (audKey && result?.status === 'handoff_initiated') {
        this.audienceHandoffs.add(conversationId);
        audience.updateLive(audKey, { status: 'with_officer', handoffReason: reason }, { conversationId, status: 'HANDED_OFF', handoffReason: reason });
        tlog.info({ audKey, active: this.audienceHandoffs.size }, 'Audience handoff to Flex');
      }
      if (channel === 'CHAT' && result?.status === 'handoff_initiated') {
        // TAC cleared this conversation's callbacks; re-attach to OUR endpoint for the Flex panel.
        // (For voice the Serverless /voice/agent-transcription does it, called from Studio.)
        // Audience chats: send post-handoff events to the AUDIENCE service (their live view), not Mia's
        const audKeyForEvents = audience.keyForConversation(conversationId);
        const eventsUrl = audKeyForEvents && settings.audienceFunctionsDomain ? audienceCoEventsUrl(audKeyForEvents) : coEventsUrl;
        tlog.info({ eventsUrl: eventsUrl.replace(/key=[^&]+/, 'key=…') }, 'Re-attaching conversation events after handoff');
        void ops.attachStatusCallback(conversationId, eventsUrl);
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

  systemPrompt(channel, session, memory, extra = []) {
    const now = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'full', timeStyle: 'short' });
    const base = [PERSONA, CHANNEL_STYLE[channel] || CHANNEL_STYLE.CHAT, ...extra, `Now: ${now} (Manila)`].join('\n\n');
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

    // Audience attendee? (recognised by Memory profile; their events, loans and bubble are separate)
    const audKey = await audience.keyForProfile(session.profileId);
    let audScenario = null;
    if (audKey) {
      audience.mark(conversationId, audKey);
      const scenario = await audience.scenario(audKey);
      audScenario = scenario;
      if (scenario) audienceRecords.set(conversationId, scenario);
      const handedOff = this.audienceHandoffs.has(conversationId);
      audience.updateLive(
        audKey,
        { channel, conversationId, chatSid, lastMessage: String(message).slice(0, 140), ...(handedOff ? {} : { status: 'with_pia' }) },
        { conversationId, channel, status: handedOff ? 'HANDED_OFF' : 'ACTIVE' }
      );
      tlog.info({ audKey, vehicle: scenario?.loans?.[0]?.vehicle }, 'Audience turn');
    }

    registry.upsert(conversationId, { channel, profileId: session.profileId, callSid: session.callSid, chatSid });

    // First turn of this conversation: fold in Pia's memory-informed opening line.
    let history = this.history.get(conversationId);
    if (!history) {
      history = [];
      this.history.set(conversationId, history);
      // Voice opening lines are generated here (kept in memory); chat ones by the
      // Serverless /chat/greet Function (parked in Sync map "openers").
      const localKey = [chatSid, session.callSid].find((k) => k && this.pendingOpeners.has(k));
      const opener = localKey ? this.pendingOpeners.get(localKey) : audKey ? await audience.takeOpener(chatSid) : await takeOpener(chatSid);
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
    // Audience: at most AUDIENCE_HANDOFF_CAP chats handed to Flex at once; beyond that Pia keeps helping
    const capReached = !!audKey && !this.audienceHandoffs.has(conversationId) && this.audienceHandoffs.size >= settings.audienceHandoffCap;
    const handoffTool = capReached ? null : this.handoffTool(session, audKey);
    const extra = audKey ? [AUDIENCE_RULES] : [];
    // The attendee's real accounts, stated as authoritative. Memory can contain wrong figures
    // (e.g. from an earlier test answered with another customer's data), so they must lose.
    if (audScenario) {
      const peso = (n) => `₱${Math.round(n).toLocaleString('en-PH')}`;
      const [car, home] = audScenario.loans;
      extra.push(
        `THIS CUSTOMER'S ACCOUNTS (authoritative, from core banking; always use these):\n` +
          `- Name: ${audScenario.name}\n` +
          `- Auto loan: ${car.vehicle}, ${peso(car.monthlyAmortization)}/month, balance ${peso(car.outstandingBalance)}, ${car.interestRatePa}% p.a., ${car.remainingTermMonths} months left\n` +
          `- Home loan: ${home.property}, ${peso(home.monthlyAmortization)}/month, balance ${peso(home.outstandingBalance)}, ${home.interestRatePa}% p.a., ${home.remainingTermMonths} months left\n` +
          `If memory or earlier messages mention any other name, vehicle, property or figures, they are wrong: ignore them and never repeat them.`
      );
    }
    if (capReached) {
      extra.push('ALL LOANS CARE OFFICERS ARE BUSY: if the customer asks for a person, say an officer will message them shortly, and keep helping in the meantime. Do not promise a time.');
      tlog.info({ active: this.audienceHandoffs.size }, 'Audience handoff cap reached: handoff tool withheld');
    }
    // Claude tool format: { name, description, input_schema }. TAC tools provide toAnthropicFormat().
    const tools = CUSTOM_TOOLS.map(toClaudeTool);
    if (knowledgeTool) tools.push(knowledgeTool.toAnthropicFormat());
    else
      tools.push({
        name: KNOWLEDGE_TOOL_NAME,
        description: "Search Luntian Bank's loan policies: refinancing, payment holidays, fees and waivers, credit reporting, pre-termination, required documents, disclosures. The input MUST be a question.",
        input_schema: { type: 'object', properties: { query: { type: 'string', description: 'The question to search for' } }, required: ['query'] },
      });
    if (handoffTool) tools.push(handoffTool.toAnthropicFormat());

    const system = this.systemPrompt(channel, session, memory, extra);
    tlog.debug({ system }, 'System prompt');
    // Claude's Messages API wants the first message from the user. On turn one the
    // history starts with Pia's opening line, so we prefix a short context note.
    const messages = history[0]?.role === 'assistant'
      ? [{ role: 'user', content: `(The customer opened the ${channel === 'VOICE' ? 'call' : 'chat'}.)` }, ...history]
      : [...history];
    const turnStart = messages.length; // everything after this index is this turn's tool traffic

    let reply = '';
    let toolCalls = 0;
    // Claude often writes its answer in the SAME turn as a tool call ("Got it — here's…" +
    // save_customer_note) and then ends with an empty turn after the tool result.
    // Keep that interim text so the customer always gets the real answer.
    const interimText = [];
    let figuresRetried = false;
    try {
      // Tool-use loop: at most 6 model round trips per customer turn.
      for (let round = 1; round <= 6; round += 1) {
        const t0 = Date.now();
        const resp = await claude.messages({ system, messages, tools, maxTokens: channel === 'VOICE' ? 400 : 800, purpose: `turn ${round}` });
        const toolUses = (resp.content || []).filter((b) => b.type === 'tool_use');
        const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        tlog.info(
          { round, ms: Date.now() - t0, stop: resp.stop_reason, toolUses: toolUses.map((t) => t.name), textChars: text.length },
          'LLM round'
        );
        if (resp.stop_reason === 'max_tokens') tlog.warn({ round }, 'Claude hit max_tokens; reply may be cut short');

        if (resp.stop_reason !== 'tool_use' || !toolUses.length) {
          // Guard: a reply quoting peso figures before any calculator/accounts call in this conversation
          // is discarded once, and Claude is told to run the tools and answer again.
          const quotesFigures = /₱\s?\d|PHP\s?\d|\b\d{1,3}(,\d{3})+\b/.test(text);
          if (quotesFigures && !this.dataToolUsed.has(conversationId) && !figuresRetried && round < 6) {
            figuresRetried = true;
            tlog.warn({ round }, 'Reply quoted figures without running the calculator; asking Claude to calculate first');
            messages.push({ role: 'assistant', content: text });
            messages.push({
              role: 'user',
              content: '(Internal check, not from the customer: you quoted figures without running your tools. Call get_customer_accounts and calculate_relief_options now, then answer again using only the numbers they return. Do not mention this check.)',
            });
            continue;
          }
          reply = text;
          break;
        }
        if (text) interimText.push(text);
        // Echo Claude's full turn (text + tool_use blocks), then answer every tool_use in one user turn.
        messages.push({ role: 'assistant', content: resp.content });
        const results = [];
        for (const call of toolUses) {
          toolCalls += 1;
          if (call.name === 'calculate_relief_options' || call.name === 'get_customer_accounts') this.dataToolUsed.add(conversationId);
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

      // Final turn had no text: use what Claude said alongside its tool calls
      if (!reply && interimText.length) {
        reply = interimText.join(' ');
        tlog.info({ chars: reply.length }, 'Final turn was empty; using the text Claude wrote alongside its tool calls');
      }
      // Still nothing: ask once more, explicitly, for the customer-facing reply (no tools)
      if (!reply) {
        tlog.warn('No reply text after the tool loop; asking Claude once more for the customer-facing reply');
        const nudge = [
          ...messages,
          ...(messages[messages.length - 1]?.role === 'user' ? [] : [{ role: 'user', content: '(continue)' }]),
        ];
        // The last message is a tool_result turn (role user); add the instruction to it as plain text.
        const last = nudge[nudge.length - 1];
        const instruction = { type: 'text', text: 'Now reply to the customer in your normal style. Do not call tools.' };
        nudge[nudge.length - 1] = { role: 'user', content: Array.isArray(last.content) ? [...last.content, instruction] : `${last.content}\n\n${instruction.text}` };
        const resp = await claude.messages({ system, messages: nudge, maxTokens: channel === 'VOICE' ? 300 : 600, purpose: 'final reply' });
        reply = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        tlog.info({ chars: reply.length, stop: resp.stop_reason }, 'Final reply after nudge');
      }
    } catch (err) {
      tlog.error({ err: err.message }, 'LLM turn failed; retrying once with a plain-text transcript');
      bus.emit('error', { message: err.message }, conversationId, channel);
      try {
        const resp = await claude.messages({ system, messages: plainTranscript(messages), maxTokens: channel === 'VOICE' ? 300 : 700, purpose: 'recovery' });
        reply = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
        tlog.info({ chars: reply.length }, 'Recovered with plain-text transcript');
        // Replace this conversation's history with the plain form so later turns don't hit the same error
        const plain = plainTranscript(history);
        history.length = 0;
        history.push(...plain);
        if (history.length && history[history.length - 1].content === '(continue)') history.pop();
      } catch (err2) {
        tlog.error({ err: err2.message }, 'Recovery call failed too');
        reply = 'Pasensya na, I hit a snag on my side. Could you say that again?';
      }
    }

    reply ||= 'Sige, one moment po.';
    // Keep this turn's tool calls and results in the history (minus the internal figures check),
    // so on later turns Pia can see that her figures came from the calculator.
    const turnMsgs = messages.slice(turnStart);
    for (let i = 0; i < turnMsgs.length; i += 1) {
      const m = turnMsgs[i];
      const next = turnMsgs[i + 1];
      const isCheck = (x) => x && x.role === 'user' && typeof x.content === 'string' && x.content.startsWith('(Internal check');
      if (isCheck(m)) continue;
      if (m.role === 'assistant' && typeof m.content === 'string' && isCheck(next)) continue;
      const content = cleanContent(m.content);
      if (!content) continue;
      if (history.length && history[history.length - 1].role === m.role) continue; // keep roles alternating
      history.push({ role: m.role, content });
    }
    if (history.length && history[history.length - 1].role === 'assistant') history.push({ role: 'user', content: '(continue)' });
    history.push({ role: 'assistant', content: reply });
    bus.emit('agent_message', { text: reply }, conversationId, channel);
    tlog.info({ reply, toolCalls, ms: Date.now() - started }, 'Pia replied');
    return reply;
  }

  // ------------------------------------------------------------------ informed opening line

  /**
   * Build the first thing Pia says, from Conversation Memory (the "informed start").
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
          ? `Hi ${name}, this is Pia from Luntian Bank. How can I help you today?`
          : `Hi ${name}! I'm Pia, your Luntian assistant. Kumusta? How can I help you today?`;
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
        `You are Pia, Luntian Bank's AI assistant. ${name} is a returning customer who has just opened a ` +
        `${channel === 'VOICE' ? 'phone call' : 'web chat'}.\n` +
        `What we know (oldest first; later entries supersede earlier ones):\n${memoryText}\n\n` +
        "Write Pia's opening message. Greet by first name, reflect the CURRENT state of their plans in one specific " +
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
