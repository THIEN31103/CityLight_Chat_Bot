// Jarvis console (text chat, voice mode, admin). Plain ES module, no build step.
// All requests go to the Jarvis process on this host; the CityLight session never reaches the browser.
import { Player, VoiceInput } from './voice.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let session = null;
let busy = false;
/** a confirmed command is being sent and followed: talking over Jarvis then only stops its voice (2026-11-21) */
let following = false;
let currentCancel = null;

// ------------------------------------------------------------------ api

async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && session?.csrf) headers['x-jarvis-csrf'] = session.csrf;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  // no answer from Jarvis itself (no JSON message): on Codespaces a sleeping codespace answers 404 / 502 (test 2026-11-25,
  // the login page only said "Lỗi 404")
  const away = !data.message && (res.status === 404 || res.status >= 502);
  const said = data.message || (away ? 'Không kết nối được Jarvis: máy chạy Jarvis có thể đang ngủ hoặc khởi động lại. Mở lại codespace (github.com/codespaces), chờ 1–2 phút rồi tải lại trang.' : `Lỗi ${res.status}`);
  if (!res.ok) throw Object.assign(new Error(said), { code: data.code, status: res.status });
  return data;
}

/** POST that answers with server-sent events; calls onEvent(name, data) for each. An ArrayBuffer body is sent raw. */
async function stream(path, body, onEvent, signal) {
  const raw = body instanceof ArrayBuffer;
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json', 'x-jarvis-csrf': session.csrf },
    body: raw ? body : JSON.stringify(body),
    signal,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.message || `Lỗi ${res.status}`), { code: data.code, status: res.status });
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      // a comment block (the server's first 2 KB, sent to get through proxies) is not an event
      if (!data && event === 'message') continue;
      try {
        onEvent(event, data ? JSON.parse(data) : null);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

// ------------------------------------------------------------------ helpers

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}

const fmtTime = (iso) => new Date(iso).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
const fmtNum = (n) => Number(n).toLocaleString('vi-VN');

function setStatus(text, isBusy) {
  const s = $('#status');
  s.textContent = text;
  s.className = `status ${isBusy ? 'busy' : 'idle'}`;
}

// ------------------------------------------------------------------ session / login

async function refresh() {
  session = await api('GET', '/api/session');
  render();
}

function render() {
  for (const t of $$('.notice-text')) t.textContent = session?.notice ?? '';
  if (!session?.signedIn) {
    $('#app').hidden = true;
    $('#login').hidden = false;
    $('#step-password').hidden = !!session?.pending2fa;
    $('#step-2fa').hidden = !session?.pending2fa;
    $('#login-btn').textContent = session?.pending2fa ? 'Xác nhận' : 'Đăng nhập';
    (session?.pending2fa ? $('#code') : $('#email')).focus();
    return;
  }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#who-name').textContent = session.user.fullName;
  $('#who-role').textContent = session.user.roleLabel;
  $('#brain').textContent = session.brain;
  $('#admin-tab').hidden = !(session.rights.canGrant || session.rights.canViewChats || session.rights.canEditSettings);
  $('#voice-btn').hidden = !session.voice;
  const l = session.limits;
  $('#limits').textContent = `Tối đa ${l.perUserPerMin} câu / phút · token hôm nay ${fmtNum(l.tokensToday)}${l.tokenCap ? ` / ${fmtNum(l.tokenCap)}` : ''}`;
  startNotices();
  // after a reload (F5) the chat in progress is shown again, not an empty screen
  showCurrent();
  $('#input').focus();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-error').textContent = '';
  $('#login-btn').disabled = true;
  try {
    if (!session?.csrf) await refresh();
    if (session.pending2fa) {
      session = await api('POST', '/api/2fa', { code: $('#code').value.trim() });
    } else {
      const r = await api('POST', '/api/login', { email: $('#email').value.trim(), password: $('#password').value });
      if (r.requires2fa) {
        session.pending2fa = true;
        $('#password').value = '';
      } else session = r;
    }
    $('#code').value = '';
    render();
  } catch (err) {
    $('#login-error').textContent = err.message;
    if (['challenge_expired', 'no_challenge', 'account_locked', 'jarvis_not_granted', 'totp_setup_required'].includes(err.code)) {
      session.pending2fa = false;
      render();
    }
  } finally {
    $('#login-btn').disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  if (voiceIn.on) $('#voice-btn').click();
  player.stop();
  await api('POST', '/api/logout').catch(() => undefined);
  $('#messages').querySelectorAll('.msg').forEach((m) => m.remove());
  await refresh();
});

// ------------------------------------------------------------------ chat

const input = $('#input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});
for (const b of $$('.suggest')) b.addEventListener('click', () => ask(b.textContent));
$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  ask(input.value);
});
$('#stop').addEventListener('click', () => {
  currentCancel?.abort();
  stopVoice();
  api('POST', '/api/chat/stop').catch(() => undefined);
});
async function newChat() {
  if (busy) return;
  await api('POST', '/api/chat/new');
  session.conversationId = null;
  showLive();
  clearMessages();
  loadConversations();
  input.focus();
}
$('#new-chat').addEventListener('click', newChat);
// spec 7 briefing (2026-11-23): one click for the shift report
$('#start-shift').addEventListener('click', () => ask('Bản tin đầu ca'));

/**
 * Jarvis speaks up (spec 7): every 20 s the console asks what to say, and reads it aloud. Critical ones (P0) come back after
 * 2 minutes while nobody answers (the server decides). In voice mode they are read aloud too. Not while an answer
 * streams or is read, while the user talks, or while an old chat is open: they wait for the next look.
 */
let noticeTimer = null;
let looking = false;
const canLook = () => !looking && session?.signedIn && !busy && !viewingId && !player.playing && !$('#voice-btn').classList.contains('hot');
async function lookNotices() {
  if (!canLook()) return;
  looking = true;
  try {
    // every notice is read aloud, microphone on or not (user request 2026-11-25: a voice says more than a beep); the
    // beep stays only for a critical one that came without audio (voice engine off or failed)
    const r = await api('GET', session.voice ? '/api/notices?voice=1' : '/api/notices').catch(() => null);
    if (!r) return;
    showMute(r.mutedUntil);
    for (const n of r.notices ?? []) {
      const b = addBubble('assistant', n.text);
      b.classList.add('notice', n.level === 'P0' ? 'p0' : 'p1');
      if (n.data) player.enqueue(n.data, n.mime);
      else if (n.level === 'P0') beep();
    }
  } finally {
    looking = false;
  }
}
/**
 * The server's live events (GET /api/live): an alarm started or ended, look now instead of at the next 20 s look.
 * Busy (an answer, the user talking): try again a little later. The 20 s looks stay as the fallback.
 */
let liveSrc = null;
// many events at once (64 cabinets dropping together) make ONE look: a nudge while one waits is dropped (2026-11-25)
let nudgeTimer = null;
function nudge() {
  if (nudgeTimer) return;
  const run = (tries) => {
    if (canLook()) {
      nudgeTimer = null;
      lookNotices();
    } else nudgeTimer = tries < 10 ? setTimeout(() => run(tries + 1), 3000) : null;
  };
  // a short wait gathers the events of one burst
  nudgeTimer = setTimeout(() => run(0), 500);
}
function startLive() {
  if (liveSrc || !window.EventSource) return;
  const src = new EventSource('/api/live');
  liveSrc = src;
  src.addEventListener('look', () => nudge());
  src.onerror = () => {
    // signed out or the server restarted: the browser gives up on a refused stream, so start again later
    if (src.readyState !== EventSource.CLOSED) return;
    if (liveSrc === src) liveSrc = null;
    setTimeout(() => session?.signedIn && startLive(), 30_000);
  };
}
function startNotices() {
  startLive();
  if (noticeTimer) return;
  lookNotices();
  noticeTimer = setInterval(lookNotices, 20_000);
}

/** the bell button shows "im lặng" and until when (said or clicked) */
let mutedUntil = null;
function showMute(until) {
  mutedUntil = until ? new Date(until) : null;
  const b = $('#mute-btn');
  const on = !!mutedUntil && mutedUntil > new Date();
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('on', on);
  b.textContent = on ? `🔔 Hết im lặng (tới ${mutedUntil.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })})` : '🔕 Im lặng 15 phút';
}
$('#mute-btn').addEventListener('click', async () => {
  const on = !(mutedUntil && mutedUntil > new Date());
  const r = await api('POST', '/api/notices/mute', { on }).catch(() => null);
  if (r) showMute(r.mutedUntil);
});

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.25);
    o.onended = () => ctx.close();
  } catch {
    // no sound allowed yet: the message is still there
  }
}

// phone: the chat list opens as a drawer; picking a chat, starting one or tapping outside closes it
function setDrawer(open) {
  $('.sidebar').classList.toggle('open', open);
  $('#history-btn').setAttribute('aria-expanded', String(open));
}
$('#history-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  setDrawer(!$('.sidebar').classList.contains('open'));
});
document.addEventListener('click', (e) => {
  const side = $('.sidebar');
  if (!side.classList.contains('open')) return;
  if (!side.contains(e.target) || e.target.closest('button.open, #new-chat')) setDrawer(false);
});
$('#new-chat-top').addEventListener('click', newChat);
$('#back-live').addEventListener('click', showCurrent);

/**
 * Back from reading an old chat to the one in progress: its messages are shown again (the screen used to stay empty,
 * end-to-end check of 2026-11-14).
 */
async function showCurrent() {
  showLive();
  clearMessages();
  const id = session.conversationId;
  if (id) {
    try {
      const { messages } = await api('GET', `/api/conversations/${id}`);
      if (viewingId === null && session.conversationId === id) {
        for (const m of messages) if ((m.role === 'user' || m.role === 'assistant') && m.content.trim()) addBubble(m.role, m.content);
      }
    } catch {
      /* deleted meanwhile: an empty screen is right */
    }
  }
  // an action still waiting (after F5 or coming back from an old chat) keeps its card
  if (viewingId === null && session.pending && Date.parse(session.pending.expiresAt) > Date.now()) showPendingCard(session.pending);
  loadConversations();
}

function clearMessages() {
  for (const c of pendingCards.values()) clearInterval(c.timer);
  pendingCards.clear();
  $('#messages').querySelectorAll('.msg').forEach((m) => m.remove());
  $('#empty').hidden = false;
}

function addBubble(role, text) {
  $('#empty').hidden = true;
  const b = el('div', { class: `msg ${role}` }, text);
  $('#messages').append(b);
  b.scrollIntoView({ block: 'end' });
  return b;
}

/**
 * Buttons under the answer for the numbered cabinets it read (2026-11-23): a click sends "số N", as if said. They go
 * away after one click or once the next question is asked.
 */
function showChoices(bubble, items) {
  document.querySelectorAll('.choices').forEach((x) => x.remove());
  const row = el('div', { class: 'choices', role: 'group', 'aria-label': 'Chọn tủ' });
  for (const it of items) {
    const b = el('button', { type: 'button', class: 'ghost' }, it.label);
    b.addEventListener('click', () => {
      if (busy) return;
      row.remove();
      ask(`số ${it.n}`);
    });
    row.append(b);
  }
  bubble.after(row);
  // the buttons sit under the answer: bring them into view (test 2026-11-24: they were hidden below the fold)
  row.scrollIntoView({ block: 'end' });
}

/**
 * The server asked for the 2FA code again (403 reauth_required, 2026-11-23): a box under the answer; the code goes to
 * /api/reauth and from there to the server, never into the chat.
 */
function showReauth(bubble) {
  document.querySelectorAll('.reauth').forEach((x) => x.remove());
  const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: 'Mã 6 số', 'aria-label': 'Mã xác thực 2 lớp' });
  const go = el('button', { type: 'button', class: 'primary' }, 'Xác thực lại');
  const msg = el('span', { class: 'pc-note' }, '');
  const box = el('div', { class: 'reauth', role: 'group', 'aria-label': 'Xác thực lại 2 lớp' }, code, go, msg);
  go.addEventListener('click', async () => {
    const v = code.value.trim();
    if (!/^\d{6}$/.test(v)) {
      msg.textContent = 'Mã gồm 6 chữ số.';
      return;
    }
    go.disabled = true;
    code.value = '';
    const r = await api('POST', '/api/reauth', { code: v }).catch((e) => ({ ok: false, text: e.message }));
    msg.textContent = r.text ?? '';
    if (r.ok) setTimeout(() => box.remove(), 4000);
    else go.disabled = false;
  });
  bubble.after(box);
  code.focus();
}

function showLive() {
  viewingId = null;
  $('#viewing').hidden = true;
  $('#composer').hidden = false;
  updateChatTools();
}

function ask(raw) {
  const text = raw.trim();
  if (!text || busy) return;
  document.querySelectorAll('.choices').forEach((x) => x.remove());
  input.value = '';
  input.style.height = 'auto';
  return turn({ text });
}

const STATUS_TEXT = { thinking: 'Đang nghĩ…', transcribing: 'Đang nghe lại câu nói…', speaking: 'Đang nói…' };

/** One question, typed ({ text }) or spoken ({ pcm }): streams the answer, plays its audio in voice mode. */
async function turn({ text, pcm, confirmId, otp }) {
  showLive();
  // a click on "Xác nhận" streams the command like a turn; in voice mode its result is spoken too
  const spoken = !!pcm || (!!confirmId && voiceIn.on);
  const userBubble = addBubble('user', confirmId ? '✔ Xác nhận (bấm nút)' : text ?? '🎙 …');
  const bubble = addBubble('assistant', '');
  const body = el('span', { class: 'caret' });
  bubble.append(body);
  busy = true;
  $('#send').disabled = true;
  $('#stop').hidden = false;
  setStatus(pcm ? STATUS_TEXT.transcribing : confirmId ? 'Đang gửi lệnh…' : STATUS_TEXT.thinking, true);
  currentCancel = new AbortController();
  let got = '';
  // Voice turns show the answer in step with the voice (2026-11-14: the text used to be on screen seconds before it
  // was said): each piece appears when its audio starts, the filler is only heard, and the full text replaces the
  // pieces once the last one has played (or at once when no audio came, e.g. the voice sidecar failed).
  let shown = '';
  // a turn that created a confirmation card keeps the CARD in view: scrolling to the answer text used to push the
  // card below the screen, so it looked like it came late (user report, 2026-11-15)
  let card = null;
  // the number buttons sit under the answer and come before its text: keep THEM in view (test 2026-11-24)
  const keepInView = () => {
    const next = bubble.nextElementSibling;
    (card ?? (next?.classList.contains('choices') ? next : bubble)).scrollIntoView({ block: 'end' });
  };
  const reveal = (t) => {
    shown = shown ? `${shown} ${t}` : t;
    body.textContent = shown;
    keepInView();
  };
  revealRest?.();
  try {
    const [path, payload] = confirmId ? [`/api/pending/${encodeURIComponent(confirmId)}/confirm`, { voice: voiceIn.on, ...(otp ? { otp } : {}) }] : pcm ? ['/api/voice', pcm] : ['/api/chat', { text }];
    await stream(path, payload, (event, data) => {
      if (event === 'transcript') {
        userBubble.textContent = data.text ? `🎙 ${data.text}` : '🎙 (không nghe rõ)';
      } else if (event === 'reset') {
        // Jarvis answered without looking anything up and is asked to check first: drop that draft
        got = '';
        if (!spoken) body.textContent = '';
        if (!confirmId) setStatus('Đang tra cứu dữ liệu…', true);
      } else if (event === 'reauth') {
        showReauth(bubble);
      } else if (event === 'choices') {
        showChoices(bubble, data.items);
      } else if (event === 'pending') {
        card = showPendingCard(data);
      } else if (event === 'pending_closed') {
        closePendingCard(data.id, data.state);
      } else if (event === 'text') {
        got += data.text;
        if (spoken) return;
        body.textContent = got;
        keepInView();
      } else if (event === 'audio') {
        player.enqueue(data.data, data.mime, data.filler ? undefined : () => reveal(data.text));
        setStatus(STATUS_TEXT.speaking, true);
      } else if (event === 'status') {
        following = data.state === 'command';
        if (data.state === 'command') setStatus(data.label, true);
        else if (data.state !== 'speaking' || player.playing) setStatus(data.state === 'tool' ? `Đang tra cứu: ${data.label}…` : STATUS_TEXT[data.state] ?? 'Đang nghĩ…', true);
      } else if (event === 'done') {
        following = false;
        if (data.heard === false) {
          bubble.remove();
          return;
        }
        if ('mutedUntil' in data) showMute(data.mutedUntil);
        const full = data.text || got || '(không có câu trả lời)';
        const finish = () => {
          revealRest = null;
          body.classList.remove('caret');
          body.textContent = full;
        };
        if (spoken && player.playing) revealRest = finish;
        else finish();
        session.conversationId = data.conversationId;
        const meta = el('div', { class: 'meta' },
          ...(data.tools || []).map((t) => el('span', { class: 'pill' }, `đã tra: ${t}`)),
          data.sttMs != null ? el('span', { class: 'pill' }, `nghe ${(data.sttMs / 1000).toFixed(1)} s`) : null,
          data.firstAudioMs != null ? el('span', { class: 'pill' }, `tiếng đầu ${(data.firstAudioMs / 1000).toFixed(1)} s`) : null,
          el('span', { class: 'pill' }, `${(data.ms / 1000).toFixed(1)} s`),
          el('span', { class: 'pill' }, `${fmtNum(data.usage.inputTokens + data.usage.outputTokens)} token`),
          data.ttsErrors ? el('span', { class: 'pill fail', title: data.ttsErrors.join('\n') }, 'lỗi đọc') : null);
        bubble.append(meta);
        keepInView();
      } else if (event === 'error') {
        body.classList.remove('caret');
        bubble.className = 'msg error';
        body.textContent = data.message;
      }
    }, currentCancel.signal);
  } catch (err) {
    body.classList.remove('caret');
    if (err.name === 'AbortError') body.textContent = got ? `${got} …(đã dừng)` : '(đã dừng)';
    else {
      bubble.className = 'msg error';
      body.textContent = err.message;
    }
  } finally {
    if (!revealRest) body.classList.remove('caret');
    busy = false;
    currentCancel = null;
    $('#send').disabled = false;
    $('#stop').hidden = true;
    if (!player.playing) setStatus(voiceIn.on ? 'Đang nghe…' : 'Sẵn sàng', false);
    loadConversations();
    refreshLimits();
    if (!voiceIn.on) input.focus();
  }
}

// ------------------------------------------------------------------ confirmation card (milestone 4)

const pendingCards = new Map();
const CLOSED = { confirmed: 'Đã gửi lệnh', cancelled: 'Đã hủy', expired: 'Đã hết hạn', replaced: 'Đã thay bằng lệnh mới', gone: 'Không còn hiệu lực' };

/**
 * The action waiting for a yes: its fixed summary, how to confirm it (T1: say / type / click, T2: click only), a 60 s
 * countdown, and the two buttons. The server decides everything again on click; the card only shows.
 */
function showPendingCard(p) {
  if (pendingCards.has(p.id)) return pendingCards.get(p.id).card;
  session.pending = p;
  for (const id of [...pendingCards.keys()]) closePendingCard(id, 'replaced');
  const left = el('span', { class: 'countdown' });
  const ok = el('button', { class: 'primary', type: 'button' }, 'Xác nhận');
  const no = el('button', { class: 'ghost', type: 'button' }, 'Hủy');
  // a batch (T3, 2026-11-23): the OTP is typed here and goes with the click straight to the server, never into the chat
  const otp = p.tier === 'T3'
    ? el('input', { class: 'pc-otp', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: 'Mã OTP 6 số', 'aria-label': 'Mã OTP 6 số' })
    : null;
  const how = p.tier === 'T3'
    ? 'Lệnh nhiều tủ: nhập mã OTP trong ứng dụng xác thực (nếu tài khoản bật 2 lớp) rồi bấm Xác nhận. Nói hay gõ "xác nhận" không gửi được.'
    : p.tier === 'T2' ? 'Lệnh tắt: nói hoặc gõ đúng chữ "xác nhận", hoặc bấm nút.' : 'Nói hoặc gõ "xác nhận" / "hủy lệnh", hoặc bấm nút.';
  const card = el('div', { class: `msg pending-card ${p.tier === 'T1' ? 't1' : 't2'}`, role: 'group', 'aria-label': 'Lệnh chờ xác nhận' },
    el('div', { class: 'pc-head' }, el('strong', {}, '⚠ Lệnh chờ xác nhận'), left),
    el('div', { class: 'pc-summary' }, p.summary),
    p.warning ? el('div', { class: 'pc-warn', role: 'note' }, p.warning) : null,
    p.note ? el('div', { class: 'pc-note' }, p.note) : null,
    el('div', { class: 'pc-how' }, how),
    el('div', { class: 'pc-actions' }, otp, ok, no));
  $('#empty').hidden = true;
  $('#messages').append(card);
  card.scrollIntoView({ block: 'end' });
  const until = Date.parse(p.expiresAt);
  const tick = () => {
    const s = Math.max(0, Math.round((until - Date.now()) / 1000));
    left.textContent = `còn ${s} giây`;
    if (s <= 0) closePendingCard(p.id, 'expired');
  };
  tick();
  const timer = setInterval(tick, 1000);
  pendingCards.set(p.id, { card, timer, ok, no });
  card.scrollIntoView({ block: 'end' });
  ok.addEventListener('click', () => {
    if (busy) return;
    const code = otp ? otp.value.trim() : '';
    if (otp && code && !/^\d{6}$/.test(code)) {
      otp.setCustomValidity('Mã OTP gồm 6 chữ số');
      otp.reportValidity();
      return;
    }
    ok.disabled = no.disabled = true;
    if (otp) otp.value = '';
    turn({ confirmId: p.id, otp: code || undefined });
  });
  otp?.addEventListener('input', () => otp.setCustomValidity(''));
  no.addEventListener('click', async () => {
    if (busy) return;
    ok.disabled = no.disabled = true;
    const r = await api('POST', `/api/pending/${encodeURIComponent(p.id)}/cancel`).catch((e) => ({ text: e.message }));
    closePendingCard(p.id, r.cancelled ? 'cancelled' : 'gone');
    addBubble('user', '✖ Hủy (bấm nút)');
    addBubble('assistant', r.text);
    loadConversations();
  });
  return card;
}

function closePendingCard(id, state) {
  const c = pendingCards.get(id);
  if (!c) return;
  clearInterval(c.timer);
  pendingCards.delete(id);
  c.ok.disabled = c.no.disabled = true;
  c.card.classList.add('closed');
  c.card.querySelector('.countdown').textContent = CLOSED[state] ?? state;
  if (session?.pending?.id === id) session.pending = null;
}

// ------------------------------------------------------------------ voice mode (milestone 3)

/** set while a finished voice answer is still being read out: shows its full text (when it ends or is cut off) */
let revealRest = null;

const player = new Player(() => {
  revealRest?.();
  if (!busy) setStatus(voiceIn.on ? 'Đang nghe…' : 'Sẵn sàng', false);
});

/** stop the voice and show the whole answer it was reading */
function stopVoice() {
  player.stop();
  revealRest?.();
}

/** the user started talking while Jarvis thinks or talks: Jarvis stops at once (barge-in) */
function bargeIn() {
  if (!busy && !player.playing) return;
  stopVoice();
  // the command is already sent: keep following it, or its real result is lost (it was "quá giờ" 4 s after sending)
  if (busy && !following) {
    currentCancel?.abort();
    api('POST', '/api/chat/stop').catch(() => undefined);
  }
}

const voiceIn = new VoiceInput({
  isPlaying: () => player.playing,
  onSpeechStart: () => {
    bargeIn();
    setStatus('Đang nghe bạn nói…', true);
    $('#voice-btn').classList.add('hot');
  },
  onUtterance: async (pcm) => {
    $('#voice-btn').classList.remove('hot');
    // a turn that was just interrupted needs a moment to release the session
    for (let i = 0; busy && i < 20; i++) await new Promise((r) => setTimeout(r, 100));
    if (!busy) turn({ pcm });
  },
});

$('#voice-btn').addEventListener('click', async () => {
  const b = $('#voice-btn');
  if (voiceIn.on) {
    await voiceIn.stop();
    stopVoice();
    b.classList.remove('on', 'hot');
    b.setAttribute('aria-pressed', 'false');
    b.textContent = '🎙 Giọng nói: tắt';
    setStatus('Sẵn sàng', false);
    return;
  }
  try {
    const st = await api('GET', '/api/voice/status');
    if (!st.enabled) throw new Error('Chức năng giọng nói đang tắt trên máy chủ Jarvis');
    if (!st.ready) throw new Error('Bộ giọng nói (voice sidecar) chưa chạy: xem README phần Giọng nói');
    await voiceIn.start();
    b.classList.add('on');
    b.setAttribute('aria-pressed', 'true');
    b.textContent = '🎙 Giọng nói: bật';
    setStatus('Đang nghe…', false);
  } catch (err) {
    setStatus(err.name === 'NotAllowedError' ? 'Trình duyệt chưa cho dùng micro' : err.message, false);
  }
});

async function refreshLimits() {
  try {
    const s = await api('GET', '/api/session');
    if (s.signedIn) {
      session.limits = s.limits;
      const l = s.limits;
      $('#limits').textContent = `Tối đa ${l.perUserPerMin} câu / phút · token hôm nay ${fmtNum(l.tokensToday)}${l.tokenCap ? ` / ${fmtNum(l.tokenCap)}` : ''}`;
    }
  } catch {
    /* not important */
  }
}

/** own conversations as last loaded (titles for the toolbar) */
let conversations = [];
/** an older conversation opened read-only; null = the live one */
let viewingId = null;

/** Title and delete button above the messages: the conversation on screen, live or opened from the list. */
function updateChatTools() {
  const id = viewingId ?? session?.conversationId ?? null;
  const c = conversations.find((x) => x.id === id);
  $('#chat-title').textContent = id ? (c?.title || 'Cuộc chat') + (viewingId ? ' (xem lại)' : '') : 'Cuộc chat mới';
  $('#delete-chat').hidden = !id;
  $('#rename-chat').hidden = !id || !c;
  $('#delete-all').hidden = !conversations.length;
}

async function loadConversations() {
  try {
    const list = await api('GET', '/api/conversations');
    conversations = list;
    const ul = $('#conversations');
    ul.replaceChildren(
      ...list.map((c) =>
        el('li', { class: c.id === (viewingId ?? session.conversationId) ? 'active' : '' },
          el('button', { class: 'open', title: c.title || '', onclick: () => openOwn(c.id) },
            el('span', { class: 'title' }, c.title || '(chưa có tiêu đề)'),
            el('span', { class: 'meta' }, `${fmtTime(c.updatedAt)} · ${c.messages} tin`)),
          el('button', { class: 'ren', title: 'Đổi tên đoạn chat này', 'aria-label': `Đổi tên đoạn chat ${c.title || ''}`, onclick: () => renameOwn(c.id) }, '✎'),
          el('button', { class: 'del', title: 'Xóa đoạn chat này', 'aria-label': `Xóa đoạn chat ${c.title || ''}`, onclick: () => removeOwn(c.id) }, '🗑'))),
    );
    if (!list.length) ul.append(el('li', { class: 'hint' }, 'Chưa có cuộc chat nào.'));
  } catch {
    /* signed out */
  }
  updateChatTools();
}

async function openOwn(id) {
  if (busy) return;
  if (id === session.conversationId) {
    if (viewingId) showCurrent();
    return;
  }
  const { messages } = await api('GET', `/api/conversations/${id}`);
  clearMessages();
  for (const m of messages) if ((m.role === 'user' || m.role === 'assistant') && m.content.trim()) addBubble(m.role, m.content);
  viewingId = id;
  $('#viewing').hidden = false;
  $('#composer').hidden = true;
  loadConversations();
}

/** Deletes one of the user's own conversations (asks first); clears the screen when it was the one shown. */
async function removeOwn(id) {
  if (busy) return;
  const c = conversations.find((x) => x.id === id);
  if (!confirm(`Xóa hẳn đoạn chat "${c?.title || 'này'}"? Không khôi phục được.`)) return;
  try {
    await api('DELETE', `/api/conversations/${id}`);
  } catch (err) {
    setStatus(err.message, false);
    return;
  }
  const shown = id === (viewingId ?? session.conversationId);
  if (id === session.conversationId) session.conversationId = null;
  if (shown) {
    viewingId = null;
    clearMessages();
    showLive();
  }
  setStatus('Đã xóa đoạn chat', false);
  loadConversations();
}

/** Renames one of the user's own conversations (the browser asks for the new name). */
async function renameOwn(id) {
  if (busy) return;
  const c = conversations.find((x) => x.id === id);
  const name = prompt('Tên mới cho đoạn chat (tối đa 80 ký tự):', c?.title || '');
  if (name === null) return;
  const title = name.replace(/\s+/g, ' ').trim();
  if (!title || title === c?.title) return;
  try {
    await api('PATCH', `/api/conversations/${id}`, { title: title.slice(0, 80) });
  } catch (err) {
    setStatus(err.message, false);
    return;
  }
  setStatus('Đã đổi tên đoạn chat', false);
  loadConversations();
}

/** Deletes every conversation of the user (asks first) and starts a new one. */
async function removeAll() {
  if (busy || !conversations.length) return;
  if (!confirm(`Xóa hẳn tất cả ${conversations.length} đoạn chat của bạn? Không khôi phục được.`)) return;
  try {
    await api('DELETE', '/api/conversations');
  } catch (err) {
    setStatus(err.message, false);
    return;
  }
  session.conversationId = null;
  viewingId = null;
  clearMessages();
  showLive();
  setStatus('Đã xóa tất cả đoạn chat', false);
  loadConversations();
}

$('#delete-all').addEventListener('click', removeAll);
$('#rename-chat').addEventListener('click', () => {
  const id = viewingId ?? session.conversationId;
  if (id) renameOwn(id);
});

$('#delete-chat').addEventListener('click', () => {
  const id = viewingId ?? session.conversationId;
  if (id) removeOwn(id);
});

// ------------------------------------------------------------------ views

for (const t of $$('.tab')) {
  t.addEventListener('click', () => {
    for (const x of $$('.tab')) x.classList.toggle('active', x === t);
    $('#view-chat').hidden = t.dataset.view !== 'chat';
    $('#view-admin').hidden = t.dataset.view !== 'admin';
    if (t.dataset.view === 'admin') openPane($$('.subtab.active')[0]?.dataset.pane ?? 'access');
  });
}
for (const t of $$('.subtab')) t.addEventListener('click', () => openPane(t.dataset.pane));

function openPane(name) {
  for (const x of $$('.subtab')) x.classList.toggle('active', x.dataset.pane === name);
  for (const p of $$('.pane')) p.hidden = p.id !== `pane-${name}`;
  ({ access: loadAccess, settings: loadSettings, history: loadHistory, tokens: loadTokens })[name]?.();
}

// ------------------------------------------------------------------ admin: access

async function loadAccess() {
  const tbody = $('#access-table tbody');
  const msg = $('#access-msg');
  msg.textContent = '';
  if (!session.rights.canGrant) {
    tbody.replaceChildren();
    msg.textContent = 'Bạn không có quyền cấp quyền dùng Jarvis.';
    return;
  }
  try {
    const users = await api('GET', '/api/admin/users');
    tbody.replaceChildren(
      ...users.map((u) => {
        const box = (flag) => {
          const cb = el('input', { type: 'checkbox', class: 'toggle', 'aria-label': `${flag} ${u.fullName}` });
          cb.checked = u.access[flag];
          cb.disabled = !u.editable[flag];
          cb.addEventListener('change', async () => {
            try {
              const r = await api('PUT', `/api/admin/access/${u.id}`, { [flag]: cb.checked });
              u.access = r;
              msg.textContent = `Đã lưu quyền cho ${u.fullName}.`;
            } catch (err) {
              cb.checked = !cb.checked;
              msg.textContent = err.message;
            }
          });
          return el('td', {}, cb);
        };
        return el('tr', {},
          el('td', {}, u.fullName, u.self ? ' (bạn)' : '', el('span', { class: 'sub' }, u.email)),
          el('td', {}, u.roleLabel), box('canUse'), box('canGrant'), box('canViewChats'));
      }),
    );
  } catch (err) {
    msg.textContent = err.message;
  }
}

// ------------------------------------------------------------------ admin: settings

async function loadSettings() {
  const f = $('#settings-form');
  $('#settings-msg').textContent = '';
  const r = await api('GET', '/api/admin/settings');
  f.perUserPerMin.value = r.settings.perUserPerMin;
  f.dailyTokenCap.value = r.settings.dailyTokenCap;
  f.historyDays.value = r.settings.historyDays;
  f.actionsEnabled.checked = r.settings.actionsEnabled;
  f.actionsEnabled.disabled = !r.envActionsEnabled || !r.editable;
  for (const i of f.querySelectorAll('input, button')) if (i !== f.actionsEnabled) i.disabled = !r.editable;
  $('#settings-info').textContent =
    `Trần cứng của máy chủ: ${r.hardCap ? fmtNum(r.hardCap) : 'không có'} · đang áp dụng: ${r.effectiveCap ? fmtNum(r.effectiveCap) : 'không giới hạn'} · đã dùng hôm nay: ${fmtNum(r.tokensToday)}` +
    (r.editable ? '' : ' · Bạn chỉ được xem.') + (r.envActionsEnabled ? '' : ' · Điều khiển bị tắt trong .env.');
}

$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  try {
    await api('PUT', '/api/admin/settings', {
      perUserPerMin: Number(f.perUserPerMin.value),
      dailyTokenCap: Number(f.dailyTokenCap.value),
      historyDays: Number(f.historyDays.value),
      actionsEnabled: f.actionsEnabled.checked,
    });
    await loadSettings();
    $('#settings-msg').textContent = 'Đã lưu.';
    refreshLimits();
  } catch (err) {
    $('#settings-msg').textContent = err.message;
  }
});

// ------------------------------------------------------------------ admin: history + tokens

async function loadHistory() {
  const ul = $('#history-list');
  const view = $('#history-view');
  if (!session.rights.canViewChats) {
    ul.replaceChildren(el('li', { class: 'hint' }, 'Bạn chỉ xem được cuộc chat của mình (ở tab Trò chuyện).'));
    return;
  }
  try {
    const list = await api('GET', '/api/admin/history');
    ul.replaceChildren(
      ...list.map((c) =>
        el('li', {},
          el('button', { class: 'open', onclick: () => openOther(c.id) },
            el('span', { class: 'title' }, `${c.fullName ?? c.userId} · ${c.title || ''}`),
            el('span', { class: 'meta' }, `${fmtTime(c.updatedAt)} · ${c.messages} tin`)))),
    );
    if (!list.length) ul.append(el('li', { class: 'hint' }, 'Chưa có cuộc chat nào của người khác.'));
  } catch (err) {
    view.replaceChildren(el('p', { class: 'error' }, err.message));
  }
}

async function openOther(id) {
  const view = $('#history-view');
  try {
    const { conversation, messages } = await api('GET', `/api/conversations/${id}`);
    view.replaceChildren(
      el('p', { class: 'hint' }, `${conversation.fullName ?? conversation.userId} · ${fmtTime(conversation.startedAt)} · lần xem này đã được ghi nhật ký`),
      ...messages.map((m) => el('div', { class: `msg ${m.role}` }, m.role === 'tool' ? `[${m.toolCalls?.name ?? 'tool'}] ${m.content}` : m.content)),
    );
  } catch (err) {
    view.replaceChildren(el('p', { class: 'error' }, err.message));
  }
}

async function loadTokens() {
  const rows = await api('GET', '/api/admin/tokens?days=14');
  $('#tokens-table tbody').replaceChildren(
    ...rows.map((r) =>
      el('tr', {},
        el('td', {}, r.day), el('td', {}, r.fullName ?? r.userId, el('span', { class: 'sub' }, r.role ?? '')),
        el('td', { class: 'num' }, fmtNum(r.tokensIn)), el('td', { class: 'num' }, fmtNum(r.tokensOut)), el('td', { class: 'num' }, fmtNum(r.tokensIn + r.tokensOut)))),
  );
  if (!rows.length) $('#tokens-table tbody').append(el('tr', {}, el('td', { colspan: 5, class: 'hint' }, 'Chưa có số liệu.')));
}

refresh().catch((e) => {
  document.body.textContent = `Không mở được console Jarvis: ${e.message}`;
});
