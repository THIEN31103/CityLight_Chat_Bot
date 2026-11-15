// Console HTTP server: static page + JSON API + chat answers streamed as server-sent events over a POST response.
// Loopback by default; a LAN address needs JARVIS_CONSOLE_TOKEN (config.ts). Every state-changing request needs the
// session's CSRF value in x-jarvis-csrf and, when the browser sends one, an Origin equal to the Host.
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoleKey, User } from '@citylight/shared';
import { ROLE_LABELS } from '@citylight/shared';
import { ApiProblem } from '../api/client';
import type { AuditLog } from '../audit/log';
import { looksLikeSmallTalk, runTurn } from '../brain/agent';
import type { LlmProvider } from '../brain/llm';
import { systemPrompt } from '../brain/system-prompt';
import type { Config } from '../config';
import { sanitizeText } from '../sanitize/llm';
import { bootstrapAdmin, canEditSettings, canGrant, canViewChatsOf, getAccess, listAccess, rememberUser, rights, setAccess, type Actor, type Flag } from '../store/access';
import { addTokenUsage, tokensToday, type Db } from '../store/db';
import { addMessage, createConversation, deleteOwn, getConversation, getMessages, listAll, listOwn, tokenReport } from '../store/history';
import { SettingsError, effectiveTokenCap, getSettings, updateSettings } from '../store/settings';
import { READ_TOOLS, SPARE_TOOLS } from '../tools/read';
import type { ToolDef } from '../tools/registry';
import { SidecarVoice, type SttProvider, type TtsAudio, type TtsProvider } from '../voice/client';
import { toSpeech } from '../voice/speech-text';
import { ConsoleSession, RateLimiter, SessionStore } from './session';
import { FILLER, Speaker } from './speaker';
import { isControlCapabilityQuestion } from '../brain/router';
import { classifyReply } from '../guard/confirm-words';
import { parseOrder } from '../guard/orders';
import { sendAndFollow, type PendingAction, type Via } from '../guard/pending';
import { CommandRate, controlUnavailable, type GuardState } from '../guard/policy';
import { outcomeText, propose, STATUS_VI } from '../guard/propose';

const STATIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../console');
const STATIC: Record<string, string> = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/voice.js': 'voice.js', '/mic-worklet.js': 'mic-worklet.js',
};
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const MAX_BODY = 64 * 1024;
/** 30 s of 16 kHz 16-bit mono */
const MAX_AUDIO = 30 * 16_000 * 2;
const MAX_TEXT = 1000;
/** street search and the area list: run when the router sees them plainly asked for ("các tủ trên đường X", "những khu vực nào") */
const ROUTER_TOOLS = SPARE_TOOLS.filter((d) => d.name === 'find_cabinets' || d.name === 'list_areas');
export const ADMIN_NOTICE = 'Quản trị viên có thể xem nội dung chat';

const TOOL_LABELS: Record<string, string> = {
  get_system_overview: 'tổng quan hệ thống', find_cabinets: 'tìm tủ', get_cabinet: 'tình trạng tủ', get_cabinet_history: 'lịch sử tủ',
  list_alarms: 'cảnh báo', explain_alarm_code: 'mã cảnh báo', list_areas: 'khu vực', get_area_cabinets: 'tủ theo khu vực',
  get_schedule: 'lịch bật / tắt', list_incidents: 'sự cố', get_command_status: 'trạng thái lệnh',
};

export interface ConsoleDeps {
  cfg: Config;
  db: Db;
  llm: LlmProvider;
  audit: AuditLog;
  tools?: ToolDef[];
  /** tests: a fake CityLight fetch */
  fetch?: typeof fetch;
  /** tests: how often a sent command is polled (default 2 s) */
  commandPollMs?: number;
  /** speech engines; default: the local sidecar (voice/sidecar.py) when voice is enabled, none otherwise */
  voice?: (SttProvider & TtsProvider) | null;
}

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > max) throw new HttpError(413, 'too_large', 'Câu nói quá dài (tối đa 30 giây)');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'too_large', 'Nội dung quá lớn');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'bad_json', 'JSON không hợp lệ');
  }
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'",
  // the console asks for the microphone itself; nothing else on this origin may
  'permissions-policy': 'microphone=(self), camera=(), geolocation=()',
};

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createConsoleServer(deps: ConsoleDeps): { server: Server; sessions: SessionStore } {
  const { cfg, db, llm, audit } = deps;
  const tools = deps.tools ?? READ_TOOLS;
  const voice = deps.voice !== undefined ? deps.voice : cfg.voice.enabled ? new SidecarVoice({ url: cfg.voice.url, voice: cfg.tts.voice }) : null;
  const sessions = new SessionStore(() => new ConsoleSession(cfg.apiBase, cfg.apiTimeoutMs, deps.fetch));
  const limiter = new RateLimiter();
  const settings = () => getSettings(db, cfg);

  const actorOf = (u: User): Actor => ({ id: u.id, role: u.role, access: getAccess(db, u.id) });

  function sessionView(s: ConsoleSession | null) {
    const st = settings();
    if (!s?.user) return { signedIn: false, pending2fa: !!s?.pending2fa, notice: ADMIN_NOTICE, csrf: s?.csrf ?? null };
    const a = actorOf(s.user);
    const r = rights(a);
    return {
      signedIn: true,
      csrf: s.csrf,
      notice: ADMIN_NOTICE,
      user: { id: s.user.id, fullName: s.user.fullName, role: s.user.role, roleLabel: ROLE_LABELS[s.user.role], scopeAll: s.user.scopeAll },
      rights: { ...r, canEditSettings: canEditSettings(a) },
      conversationId: s.conversationId,
      brain: `${llm.name}/${llm.model}`,
      voice: !!voice,
      limits: { perUserPerMin: st.perUserPerMin, tokenCap: effectiveTokenCap(st, cfg), tokensToday: tokensToday(db) },
      pending: (() => {
        const p = s.pending.active();
        return p ? pendingView(p) : null;
      })(),
    };
  }

  /** After CityLight accepted the password (and 2FA): Jarvis's own gate (G4). */
  async function finishLogin(s: ConsoleSession, user: User) {
    s.pending2fa = false;
    if (user.totpRequired && !user.totpEnabled) {
      await s.api.logout().catch(() => undefined);
      throw new HttpError(403, 'totp_setup_required', 'Tài khoản cần bật xác thực 2 lớp trên web CityLight trước khi dùng Jarvis');
    }
    // a new or reset account has a temporary password: the API refuses everything until it is changed on the web
    if (user.passwordChangeRequired) {
      await s.api.logout().catch(() => undefined);
      throw new HttpError(403, 'password_change_required', 'Tài khoản đang dùng mật khẩu tạm: đăng nhập web CityLight để đổi mật khẩu trước khi dùng Jarvis');
    }
    rememberUser(db, user);
    if (bootstrapAdmin(db, user)) audit.write({ kind: 'bootstrap_admin', userId: user.id, role: user.role });
    if (!rights(actorOf(user)).canUse) {
      audit.write({ kind: 'access_denied', userId: user.id, role: user.role });
      await s.api.logout().catch(() => undefined);
      throw new HttpError(403, 'jarvis_not_granted', 'Tài khoản chưa được cấp quyền dùng Jarvis. Liên hệ quản trị viên.');
    }
    s.user = user;
    s.newConversation();
    audit.write({ kind: 'login', userId: user.id, role: user.role });
  }

  function requireUser(s: ConsoleSession | null): { s: ConsoleSession; user: User; actor: Actor } {
    if (!s?.user) throw new HttpError(401, 'signed_out', 'Chưa đăng nhập');
    const actor = actorOf(s.user);
    if (!rights(actor).canUse) throw new HttpError(403, 'jarvis_not_granted', 'Quyền dùng Jarvis của tài khoản đã bị thu hồi');
    return { s, user: s.user, actor };
  }

  // ---------------------------------------------------------------- chat

  /** Checks that apply before any work (busy, per-minute limit, daily token cap). */
  function admit(s: ConsoleSession, user: User, countsAsQuestion = true) {
    if (s.busy) throw new HttpError(409, 'busy', 'Jarvis đang trả lời câu trước');
    const st = settings();
    if (countsAsQuestion && !limiter.allow(user.id, st.perUserPerMin)) throw new HttpError(429, 'rate_limited', `Tối đa ${st.perUserPerMin} câu / phút, đợi một chút`);
    const cap = effectiveTokenCap(st, cfg);
    if (cap > 0 && tokensToday(db) >= cap) {
      audit.write({ kind: 'token_cap_hit', userId: user.id, cap });
      throw new HttpError(429, 'token_cap', 'Đã hết hạn mức hôm nay');
    }
  }

  /** Opens the event stream of one turn; the abort fires when the browser goes away. */
  function openStream(res: ServerResponse, s: ConsoleSession) {
    const ac = new AbortController();
    s.busy = ac;
    res.on('close', () => {
      if (!res.writableFinished) ac.abort();
    });
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', ...SECURITY_HEADERS });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    return { ac, send };
  }

  async function chat(req: IncomingMessage, res: ServerResponse, s: ConsoleSession) {
    const { user } = requireUser(s);
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(422, 'empty', 'Câu hỏi trống');
    if (text.length > MAX_TEXT) throw new HttpError(422, 'too_long', `Tối đa ${MAX_TEXT} ký tự`);
    // "xác nhận", "hủy lệnh", an order: answered in code without the model, so not counted as a question (the commands
    // themselves have their own limit, 6 a minute); a "xác nhận" used to be refused after 10 questions (2026-11-15)
    admit(s, user, !handledInCode(s, text));
    const { ac, send } = openStream(res, s);
    try {
      if (!(await control(s, user, text, send, ac, null))) await answer(s, user, text, send, ac, null);
    } catch (e) {
      send('error', { code: 'failed', message: (e as Error).message });
    } finally {
      s.busy = null;
      res.end();
    }
  }

  /** Voice turn (milestone 3): PCM 16 kHz mono in -> transcript -> the same answer, spoken sentence by sentence. */
  async function voiceTurn(req: IncomingMessage, res: ServerResponse, s: ConsoleSession) {
    const { user } = requireUser(s);
    if (!voice) throw new HttpError(503, 'voice_off', 'Chức năng giọng nói đang tắt (STT_PROVIDER / TTS_PROVIDER = none)');
    const pcm = await readRaw(req, MAX_AUDIO);
    if (pcm.length < 3200) throw new HttpError(422, 'too_short', 'Câu nói quá ngắn');
    admit(s, user);
    const { ac, send } = openStream(res, s);
    try {
      send('status', { state: 'transcribing' });
      const stt = await voice.transcribe(pcm, ac.signal);
      const text = sanitizeText(stt.text).trim();
      send('transcript', { text, sttMs: stt.ms, audioMs: stt.audioMs });
      if (!text || text.length < 2) {
        send('done', { text: '', heard: false, sttMs: stt.ms });
        return;
      }
      const extra = { sttMs: stt.ms, audioMs: stt.audioMs };
      // orders and yes / no to a waiting action are handled in code; their fixed sentences are spoken at once
      if (await control(s, user, text, send, ac, speakerFor(send, ac, false), extra)) return;
      const speaker = speakerFor(send, ac, !looksLikeSmallTalk(text))!;
      await answer(s, user, text, send, ac, speaker, extra);
    } catch (e) {
      send('error', { code: 'failed', message: (e as Error).message });
    } finally {
      s.busy = null;
      res.end();
    }
  }

  /** a speaker that streams audio events to this turn; null when voice is off */
  function speakerFor(send: (e: string, d: unknown) => void, ac: AbortController, needsData: boolean): Speaker | null {
    if (!voice) return null;
    return new Speaker(voice, needsData, (c) => send('audio', { seq: c.seq, text: c.text, filler: c.filler, mime: c.mime, data: Buffer.from(c.audio).toString('base64'), ms: c.ms }), ac.signal, needsData ? fillerAudio : undefined);
  }

  let filler: Promise<TtsAudio | null> | null = null;
  /** "Để tôi kiểm tra." synthesized once and reused */
  const fillerAudio = () => {
    filler ??= voice ? voice.synth(toSpeech(FILLER)).catch(() => {
      filler = null;
      return null;
    }) : Promise.resolve(null);
    return filler;
  };

  /** One turn of the agent, shared by text and voice; history, tokens and audit are written here. */
  async function answer(
    s: ConsoleSession, user: User, text: string, send: (e: string, d: unknown) => void, ac: AbortController, speaker: Speaker | null,
    extra: Record<string, unknown> = {},
  ) {
    if (!s.conversationId) s.conversationId = createConversation(db, user, text);
    const conversationId = s.conversationId;
    addMessage(db, conversationId, { role: 'user', content: text });
    audit.write({ kind: 'user_text', userId: user.id, role: user.role, conversationId, text, voice: !!speaker });
    send('status', { state: 'thinking', conversationId });
    const t0 = performance.now();
    let firstText: number | null = null;
    ac.signal.addEventListener('abort', () => speaker?.stop());
    {
      const result = await runTurn({
        llm, tools, routerTools: deps.tools ? undefined : ROUTER_TOOLS, maxTokens: cfg.llm.maxTokens, signal: ac.signal,
        ctx: { reads: s.reads, user, focus: s.ctx.focus, userText: text },
        system: systemPrompt(user, s.ctx.focus, new Date(), { voice: !!speaker }),
        messages: s.ctx.messagesFor(text, cfg.contextMessages),
        onEvent: (ev) => {
          if (ev.type === 'reset') {
            speaker?.reset();
            send('reset', {});
          } else if (ev.type === 'text') {
            firstText ??= performance.now() - t0;
            const clean = sanitizeText(ev.text);
            speaker?.text(clean);
            send('text', { text: clean });
          } else if (ev.type === 'tool_start') {
            speaker?.tool();
            send('status', { state: 'tool', tool: ev.name, label: TOOL_LABELS[ev.name] ?? ev.name });
          } else if (ev.type === 'tool_end') send('status', { state: 'thinking' });
        },
      });
      if (speaker && result.stopReason !== 'aborted' && result.stopReason !== 'error') {
        // an answer that is only the fallback sentence has no streamed text: speak it too
        if (!result.text.trim() && result.stopReason === 'too_many_tools') speaker.text('Tôi chưa tìm ra câu trả lời, bạn hỏi cụ thể hơn giúp tôi.');
        send('status', { state: 'speaking' });
        await speaker.end();
      }
      addTokenUsage(db, user.id, result.usage.inputTokens, result.usage.outputTokens);
      for (const m of result.produced) {
        if (m.role === 'tool') addMessage(db, conversationId, { role: 'tool', content: m.content, toolCalls: { name: m.name } });
        else if (m.role === 'assistant' && m.toolCalls?.length) addMessage(db, conversationId, { role: 'assistant', content: m.content, toolCalls: m.toolCalls.map((c) => ({ name: c.name, input: c.input })) });
      }
      const reply = result.text.trim() || (result.stopReason === 'too_many_tools' ? 'Tôi chưa tìm ra câu trả lời, bạn hỏi cụ thể hơn giúp tôi.' : '');
      addMessage(db, conversationId, { role: 'assistant', content: reply, tokensIn: result.usage.inputTokens, tokensOut: result.usage.outputTokens });
      for (const c of result.toolCalls) audit.write({ kind: 'tool_call', userId: user.id, conversationId, tool: c.name, input: c.input, ok: c.ok, ms: c.ms });
      audit.write({ kind: 'assistant_text', userId: user.id, conversationId, text: reply, stop: result.stopReason, usage: result.usage, nudged: result.nudged });
      if (result.stopReason !== 'aborted') s.ctx.addTurn(text, reply);
      if (result.stopReason === 'error') send('error', { code: 'brain_error', message: `Bộ não AI lỗi: ${result.error}` });
      else send('done', {
        conversationId, stop: result.stopReason, text: sanitizeText(reply), usage: result.usage, tools: result.toolCalls.map((c) => c.name), nudged: result.nudged,
        ms: Math.round(performance.now() - t0), firstTextMs: firstText === null ? null : Math.round(firstText),
        firstAudioMs: speaker?.firstAudioMs ?? null, ttsErrors: speaker?.errors.length ? speaker.errors.slice(0, 2) : undefined, ...extra,
      });
    }
  }

  // ---------------------------------------------------------------- actions (milestone 4)

  const commandRate = new CommandRate();
  const guardState = (): GuardState => ({ envEnabled: cfg.actionsEnabled, settingsEnabled: settings().actionsEnabled, allowlist: cfg.cabinetAllowlist });
  const pendingView = (p: PendingAction) => ({ id: p.id, summary: p.summary, tier: p.tier, expiresAt: new Date(p.expiresAt).toISOString(), note: p.note ?? null });
  type Send = (e: string, d: unknown) => void;

  /**
   * Handles in code, without the model: a yes / no to the waiting action, "can you control the lights", and orders to
   * a cabinet. Returns false when the text is none of these (the agent answers it).
   */
  async function control(s: ConsoleSession, user: User, text: string, send: Send, ac: AbortController, speaker: Speaker | null, extra: Record<string, unknown> = {}): Promise<boolean> {
    s.lastInteraction = Date.now();
    // tests script the fake model with a [[fake:{...}]] prefix whose JSON may hold words like "bật"
    if (llm.name === 'fake' && text.startsWith('[[fake:')) return false;
    const via: Via = speaker ? 'voice' : 'text';
    const gone = s.pending.expired();
    const p = s.pending.active();
    const reply = classifyReply(text);
    if (p && reply) {
      if (reply === 'unclear') return fixedTurn(s, user, text, `Bạn muốn xác nhận hay hủy lệnh: ${p.summary}?`, send, speaker, extra);
      if (reply === 'cancel') {
        s.pending.cancel(p.id);
        audit.write({ kind: 'pending_cancelled', userId: user.id, pendingId: p.id, via });
        send('pending_closed', { id: p.id, state: 'cancelled' });
        return fixedTurn(s, user, text, `Đã hủy lệnh: ${p.summary}.`, send, speaker, extra);
      }
      if (!commandRate.allow(user.id)) return fixedTurn(s, user, text, 'Jarvis đã gửi 6 lệnh trong một phút qua, bạn đợi một chút rồi xác nhận lại.', send, speaker, extra);
      const t = s.pending.take(p.id, via);
      if (!t.ok) {
        audit.write({ kind: 'pending_refused', userId: user.id, pendingId: p.id, via, reason: t.reason });
        return fixedTurn(s, user, text, t.reason, send, speaker, extra);
      }
      await execute(s, user, text, t.pending, via, send, ac, speaker, extra);
      return true;
    }
    // a short reply that is neither yes nor no while an action waits (speech recognition got it wrong): ask again,
    // never pass it to the model, which answered "Hồi." with a question about the system
    if (p && !reply && text.trim().split(/\s+/).length <= 2 && !parseOrder(text, s.ctx.focus))
      return fixedTurn(s, user, text, `Tôi chưa nghe rõ. Bạn muốn xác nhận hay hủy lệnh: ${p.summary}?`, send, speaker, extra);
    if (reply && (reply === 'confirm' || reply === 'cancel') && text.trim().split(/\s+/).length <= 3) {
      if (gone) send('pending_closed', { id: gone.id, state: 'expired' });
      return fixedTurn(s, user, text, gone ? `Lệnh "${gone.summary}" đã hết hạn 60 giây, bạn ra lệnh lại nếu vẫn cần.` : 'Không có lệnh nào đang chờ xác nhận.', send, speaker, extra);
    }
    if (isControlCapabilityQuestion(text)) {
      const off = controlUnavailable(guardState(), user.role);
      return fixedTurn(s, user, text, off
        ? `Chưa. ${off} Muốn bật hay tắt đèn, bạn thao tác trên web CityLight giúp tôi nhé.`
        : 'Có. Tôi bật, tắt, trả về lịch, bật xung hoặc gửi lệnh chẩn đoán cho từng tủ được phép, và chỉ gửi sau khi bạn xác nhận. Lệnh tắt phải bấm nút trên màn hình.', send, speaker, extra);
    }
    const order = parseOrder(text, s.ctx.focus);
    if (!order) return false;
    send('status', { state: 'tool', label: 'chuẩn bị lệnh' });
    const prop = await propose(order, { reads: s.reads, user, focus: s.ctx.focus, userText: text, signal: ac.signal }, guardState(), user.role, Date.now() - s.lastInteraction);
    if (prop.kind === 'refused') {
      audit.write({ kind: 'action_refused', userId: user.id, text, reason: prop.say });
      return fixedTurn(s, user, text, prop.say, send, speaker, extra);
    }
    const { pending, replaced } = s.pending.create(prop.draft);
    if (replaced) send('pending_closed', { id: replaced.id, state: 'replaced' });
    audit.write({ kind: 'pending_created', userId: user.id, role: user.role, pendingId: pending.id, cabinet: pending.cabinet.code, command: pending.command, tier: pending.tier, replaced: replaced?.id });
    send('pending', pendingView(pending));
    return fixedTurn(s, user, text, `${replaced ? 'Lệnh trước đó đã được thay bằng lệnh này. ' : ''}${prop.say}`, send, speaker, extra);
  }

  /** true when control() will answer this text without the model */
  function handledInCode(s: ConsoleSession, text: string): boolean {
    if (llm.name === 'fake' && text.startsWith('[[fake:')) return false;
    if (classifyReply(text) && text.trim().split(/\s+/).length <= 4) return true;
    if (s.pending.active() && text.trim().split(/\s+/).length <= 2) return true;
    return isControlCapabilityQuestion(text) || !!parseOrder(text, s.ctx.focus);
  }

  /** A turn whose answer is a fixed sentence: same history, audit and events as a model turn, no tokens. */
  async function fixedTurn(
    s: ConsoleSession, user: User, text: string, reply: string, send: Send, speaker: Speaker | null, extra: Record<string, unknown> = {}, spoken = reply,
  ): Promise<true> {
    const t0 = performance.now();
    if (!s.conversationId) s.conversationId = createConversation(db, user, text);
    const conversationId = s.conversationId;
    addMessage(db, conversationId, { role: 'user', content: text });
    audit.write({ kind: 'user_text', userId: user.id, role: user.role, conversationId, text, voice: !!speaker });
    send('text', { text: reply });
    if (speaker) {
      speaker.text(spoken);
      send('status', { state: 'speaking' });
      await speaker.end();
    }
    addMessage(db, conversationId, { role: 'assistant', content: reply });
    audit.write({ kind: 'assistant_text', userId: user.id, conversationId, text: reply, stop: 'fixed' });
    s.ctx.addTurn(text, reply);
    send('done', {
      conversationId, stop: 'end_turn', text: reply, usage: { inputTokens: 0, outputTokens: 0 }, tools: [], ms: Math.round(performance.now() - t0),
      firstAudioMs: speaker?.firstAudioMs ?? null, ttsErrors: speaker?.errors.length ? speaker.errors.slice(0, 2) : undefined, ...extra,
    });
    return true;
  }

  /** Sends the confirmed action and follows it; the result is said only from the command's real status. */
  async function execute(s: ConsoleSession, user: User, text: string, p: PendingAction, via: Via, send: Send, ac: AbortController, speaker: Speaker | null, extra: Record<string, unknown> = {}) {
    audit.write({ kind: 'pending_confirmed', userId: user.id, role: user.role, pendingId: p.id, cabinet: p.cabinet.code, command: p.command, via });
    send('pending_closed', { id: p.id, state: 'confirmed' });
    const first = `Đang gửi lệnh: ${p.summary}.`;
    send('text', { text: `${first}\n` });
    speaker?.text(first);
    send('status', { state: 'command', label: 'Đang gửi lệnh…' });
    const outcome = await sendAndFollow(s.api, p, { signal: ac.signal, pollMs: deps.commandPollMs, onStatus: (st) => send('status', { state: 'command', label: STATUS_VI[st] ?? st }) });
    if (outcome.status !== 'not_sent') commandRate.record(user.id);
    audit.write({ kind: 'command_result', userId: user.id, pendingId: p.id, commandId: outcome.commandId, status: outcome.status, error: outcome.error, apiError: outcome.code });
    let result: string;
    if (ac.signal.aborted) result = 'Lệnh đã gửi nhưng bạn đã dừng theo dõi; xem kết quả trên web CityLight.';
    else {
      const after = outcome.status === 'confirmed' ? ((await s.reads.cabinet(p.cabinet.id).catch(() => null))?.state as Record<string, unknown> | undefined) : undefined;
      result = outcomeText(p, outcome, after);
    }
    send('reset', {});
    // the first sentence was already heard: only the result is spoken now
    await fixedTurn(s, user, text, `${first}\n${result}`, send, speaker, { ...extra, command: { status: outcome.status, id: outcome.commandId } }, result);
  }

  // ---------------------------------------------------------------- admin

  async function adminUsers(s: ConsoleSession) {
    const { actor } = requireUser(s);
    if (!rights(actor).canGrant) throw new HttpError(403, 'forbidden', 'Bạn không có quyền cấp quyền dùng Jarvis');
    const people = await s.reads.users();
    const grants = new Map(listAccess(db).map((a) => [a.userId, a]));
    const flags: Flag[] = ['canUse', 'canGrant', 'canViewChats'];
    return people
      .filter((p) => p.active !== false)
      .map((p) => {
        const a = grants.get(p.id);
        const effective = p.role === 'admin' ? { canUse: true, canGrant: true, canViewChats: true } : { canUse: !!a?.canUse, canGrant: !!a?.canGrant, canViewChats: !!a?.canViewChats };
        return {
          id: p.id, fullName: p.fullName, email: p.email, role: p.role, roleLabel: ROLE_LABELS[p.role], self: p.id === actor.id, access: effective,
          editable: Object.fromEntries(flags.map((f) => [f, p.role !== 'admin' && canGrant(actor, { id: p.id, role: p.role }, f)])),
        };
      });
  }

  async function adminSetAccess(s: ConsoleSession, targetId: string, body: Record<string, unknown>) {
    const { actor, user } = requireUser(s);
    const people = await s.reads.users();
    const target = people.find((p) => p.id === targetId);
    if (!target) throw new HttpError(404, 'not_found', 'Không tìm thấy tài khoản');
    const change: Partial<Record<Flag, boolean>> = {};
    for (const f of ['canUse', 'canGrant', 'canViewChats'] as Flag[]) {
      if (typeof body[f] !== 'boolean') continue;
      if (!canGrant(actor, { id: target.id, role: target.role }, f)) throw new HttpError(403, 'forbidden', `Bạn không được đổi quyền này cho ${ROLE_LABELS[target.role]}`);
      change[f] = body[f] as boolean;
    }
    if (!Object.keys(change).length) throw new HttpError(422, 'nothing', 'Không có thay đổi');
    const before = getAccess(db, target.id);
    const after = setAccess(db, { id: target.id, email: target.email, role: target.role }, change, user.id);
    audit.write({ kind: 'access_change', userId: user.id, role: user.role, target: target.id, targetRole: target.role, change, before: before && { canUse: before.canUse, canGrant: before.canGrant, canViewChats: before.canViewChats } });
    return { canUse: after.canUse, canGrant: after.canGrant, canViewChats: after.canViewChats };
  }

  function visibleConversations(actor: Actor, q: URLSearchParams) {
    const rows = listAll(db, { userId: q.get('userId') || undefined, from: q.get('from') || undefined, to: q.get('to') || undefined });
    return rows.filter((c) => c.userId !== actor.id && canViewChatsOf(actor, { id: c.userId, role: c.userRole }));
  }

  function openConversation(s: ConsoleSession, id: string) {
    const { actor, user } = requireUser(s);
    const c = getConversation(db, id);
    if (!c || !canViewChatsOf(actor, { id: c.userId, role: c.userRole })) throw new HttpError(404, 'not_found', 'Không tìm thấy cuộc chat');
    if (c.userId !== user.id) audit.write({ kind: 'view_chat', userId: user.id, role: user.role, owner: c.userId, ownerRole: c.userRole, conversationId: id });
    return { conversation: c, messages: getMessages(db, id).filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool') };
  }

  // ---------------------------------------------------------------- routing

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://console');
    const method = req.method ?? 'GET';
    const jar = cookies(req);

    if (cfg.console.token) {
      const given = (req.headers['x-jarvis-token'] as string | undefined) ?? jar.jv_tok ?? url.searchParams.get('token') ?? '';
      if (!sameToken(given, cfg.console.token)) return sendJson(res, 401, { code: 'console_token', message: 'Cần token truy cập console' });
      if (url.searchParams.get('token')) {
        res.writeHead(302, { location: '/', 'set-cookie': `jv_tok=${encodeURIComponent(cfg.console.token)}; Path=/; HttpOnly; SameSite=Strict` });
        return res.end();
      }
    }

    if (method === 'GET' && STATIC[url.pathname]) {
      const file = STATIC[url.pathname]!;
      const body = readFileSync(path.join(STATIC_DIR, file));
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
      return res.end(body);
    }
    if (method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { status: 'ok', llm: { provider: llm.name, model: llm.model }, api: cfg.apiBase });
    if (!url.pathname.startsWith('/api/')) return sendJson(res, 404, { code: 'not_found', message: 'Không có trang này' });

    let s = sessions.get(jar.jv_sid);
    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpError(403, 'origin', 'Sai nguồn gốc yêu cầu');
      if (!s || req.headers['x-jarvis-csrf'] !== s.csrf) throw new HttpError(403, 'csrf', 'Phiên console không hợp lệ, hãy tải lại trang');
    }

    // GET /api/session also creates the console session (and its CSRF value)
    if (method === 'GET' && url.pathname === '/api/session') {
      if (!s) {
        s = sessions.create();
        return sendJson(res, 200, sessionView(s), { 'set-cookie': `jv_sid=${s.id}; Path=/; HttpOnly; SameSite=Strict` });
      }
      return sendJson(res, 200, sessionView(s));
    }
    if (!s) throw new HttpError(401, 'no_session', 'Phiên console đã hết, hãy tải lại trang');

    const key = `${method} ${url.pathname}`;
    const idOf = (prefix: string) => decodeURIComponent(url.pathname.slice(prefix.length));

    if (key === 'POST /api/login') {
      const b = await readJson(req);
      const email = typeof b.email === 'string' ? b.email.trim() : '';
      const password = typeof b.password === 'string' ? b.password : '';
      if (!email || !password) throw new HttpError(422, 'missing', 'Nhập email và mật khẩu');
      s.user = null;
      const r = await s.api.login(email, password);
      if (r.kind === 'challenge') {
        s.pending2fa = true;
        return sendJson(res, 200, { requires2fa: true });
      }
      await finishLogin(s, r.user);
      return sendJson(res, 200, sessionView(s));
    }
    if (key === 'POST /api/2fa') {
      const b = await readJson(req);
      const code = typeof b.code === 'string' ? b.code.replace(/\s+/g, '') : '';
      if (!s.pending2fa) throw new HttpError(409, 'no_challenge', 'Hãy đăng nhập lại');
      const user = /^\d{6}$/.test(code) ? await s.api.verify2fa({ code }) : await s.api.verify2fa({ recoveryCode: code });
      await finishLogin(s, user);
      return sendJson(res, 200, sessionView(s));
    }
    if (key === 'POST /api/logout') {
      if (s.user) audit.write({ kind: 'logout', userId: s.user.id });
      sessions.drop(s);
      return sendJson(res, 200, { signedIn: false }, { 'set-cookie': 'jv_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    }
    if (key === 'POST /api/chat') return chat(req, res, s);
    if (key === 'POST /api/voice') return voiceTurn(req, res, s);
    if (key === 'GET /api/voice/status') {
      requireUser(s);
      const h = voice && 'health' in voice ? await (voice as SidecarVoice).health() : null;
      return sendJson(res, 200, { enabled: !!voice, ready: !!h || (!!voice && !(voice instanceof SidecarVoice)), engine: h });
    }
    // the buttons of the confirmation card: confirming streams the command's progress like a turn
    if (method === 'POST' && /^\/api\/pending\/[\w-]+\/confirm$/.test(url.pathname)) {
      const { user } = requireUser(s);
      const id = url.pathname.split('/')[3]!;
      const b = await readJson(req);
      if (s.busy) throw new HttpError(409, 'busy', 'Jarvis đang trả lời câu trước');
      const { ac, send } = openStream(res, s);
      const speaker = b.voice === true ? speakerFor(send, ac, false) : null;
      try {
        s.lastInteraction = Date.now();
        const asked = '(bấm nút Xác nhận)';
        if (!commandRate.allow(user.id)) await fixedTurn(s, user, asked, 'Jarvis đã gửi 6 lệnh trong một phút qua, bạn đợi một chút rồi xác nhận lại.', send, speaker);
        else {
          const t = s.pending.take(id, 'button');
          if (!t.ok) {
            send('pending_closed', { id, state: 'gone' });
            await fixedTurn(s, user, asked, t.reason, send, speaker);
          } else await execute(s, user, asked, t.pending, 'button', send, ac, speaker);
        }
      } catch (e) {
        send('error', { code: 'failed', message: (e as Error).message });
      } finally {
        s.busy = null;
        res.end();
      }
      return;
    }
    if (method === 'POST' && /^\/api\/pending\/[\w-]+\/cancel$/.test(url.pathname)) {
      const { user } = requireUser(s);
      const p = s.pending.cancel(url.pathname.split('/')[3]!);
      if (p) {
        audit.write({ kind: 'pending_cancelled', userId: user.id, pendingId: p.id, via: 'button' });
        if (s.conversationId) {
          addMessage(db, s.conversationId, { role: 'user', content: '(bấm nút Hủy)' });
          addMessage(db, s.conversationId, { role: 'assistant', content: `Đã hủy lệnh: ${p.summary}.` });
        }
      }
      return sendJson(res, 200, { cancelled: !!p, text: p ? `Đã hủy lệnh: ${p.summary}.` : 'Không có lệnh nào đang chờ.' });
    }
    if (key === 'POST /api/chat/stop') {
      s.busy?.abort();
      return sendJson(res, 200, { stopped: true });
    }
    if (key === 'POST /api/chat/new') {
      requireUser(s);
      s.newConversation();
      return sendJson(res, 200, { conversationId: null });
    }
    if (key === 'GET /api/conversations') {
      const { user } = requireUser(s);
      return sendJson(res, 200, listOwn(db, user.id));
    }
    if (method === 'GET' && url.pathname.startsWith('/api/conversations/')) return sendJson(res, 200, openConversation(s, idOf('/api/conversations/')));
    if (method === 'DELETE' && url.pathname.startsWith('/api/conversations/')) {
      const { user } = requireUser(s);
      const id = idOf('/api/conversations/');
      if (!deleteOwn(db, user.id, id)) throw new HttpError(404, 'not_found', 'Không tìm thấy cuộc chat của bạn');
      if (s.conversationId === id) s.newConversation();
      audit.write({ kind: 'delete_chat', userId: user.id, conversationId: id });
      return sendJson(res, 200, { deleted: true });
    }

    if (key === 'GET /api/admin/users') return sendJson(res, 200, await adminUsers(s));
    if (method === 'PUT' && url.pathname.startsWith('/api/admin/access/')) return sendJson(res, 200, await adminSetAccess(s, idOf('/api/admin/access/'), await readJson(req)));
    if (key === 'GET /api/admin/settings') {
      const { actor } = requireUser(s);
      const st = settings();
      return sendJson(res, 200, { settings: st, editable: canEditSettings(actor), hardCap: cfg.dailyTokenCapMax, effectiveCap: effectiveTokenCap(st, cfg), tokensToday: tokensToday(db), envActionsEnabled: cfg.actionsEnabled });
    }
    if (key === 'PUT /api/admin/settings') {
      const { actor, user } = requireUser(s);
      if (!canEditSettings(actor)) throw new HttpError(403, 'forbidden', 'Bạn không được sửa cấu hình Jarvis');
      const b = await readJson(req);
      const patch: Record<string, unknown> = {};
      for (const k of ['actionsEnabled', 'perUserPerMin', 'dailyTokenCap', 'historyDays']) if (k in b) patch[k] = b[k];
      try {
        const { before, after } = updateSettings(db, cfg, patch, user.id);
        audit.write({ kind: 'settings_change', userId: user.id, role: user.role, before, after });
        return sendJson(res, 200, { settings: after, effectiveCap: effectiveTokenCap(after, cfg) });
      } catch (e) {
        if (e instanceof SettingsError) throw new HttpError(422, 'invalid_settings', e.message);
        throw e;
      }
    }
    if (key === 'GET /api/admin/history') {
      const { actor } = requireUser(s);
      if (!rights(actor).canViewChats) throw new HttpError(403, 'forbidden', 'Bạn chỉ xem được cuộc chat của mình');
      return sendJson(res, 200, visibleConversations(actor, url.searchParams));
    }
    if (key === 'GET /api/admin/tokens') {
      const { actor } = requireUser(s);
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days')) || 7));
      const rows = tokenReport(db, days).filter((r) => r.userId === actor.id || canViewChatsOf(actor, { id: r.userId, role: (r.role ?? 'viewer') as RoleKey }));
      return sendJson(res, 200, rows);
    }
    throw new HttpError(404, 'not_found', 'Không có API này');
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) return sendJson(res, e.status, { code: e.code, message: e.message });
      if (e instanceof ApiProblem) return sendJson(res, e.status >= 500 ? 502 : e.status, { code: e.code, message: e.detail });
      console.error('[jarvis] console error', (e as Error).message);
      sendJson(res, 500, { code: 'internal', message: 'Lỗi console Jarvis' });
    });
  });
  return { server, sessions };
}
