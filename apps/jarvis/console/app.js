// Jarvis console (text chat, voice mode, admin). Plain ES module, no build step.
// All requests go to the Jarvis process on this host; the CityLight session never reaches the browser.
import { Player, VoiceInput } from './voice.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

let session = null;
let busy = false;
let currentCancel = null;

// ------------------------------------------------------------------ api

async function api(method, path, body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && session?.csrf) headers['x-jarvis-csrf'] = session.csrf;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `Lỗi ${res.status}`), { code: data.code, status: res.status });
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
        for (const m of messages) if (m.role === 'user' || m.role === 'assistant') addBubble(m.role, m.content);
      }
    } catch {
      /* deleted meanwhile: an empty screen is right */
    }
  }
  loadConversations();
}

function clearMessages() {
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

function showLive() {
  viewingId = null;
  $('#viewing').hidden = true;
  $('#composer').hidden = false;
  updateChatTools();
}

function ask(raw) {
  const text = raw.trim();
  if (!text || busy) return;
  input.value = '';
  input.style.height = 'auto';
  return turn({ text });
}

const STATUS_TEXT = { thinking: 'Đang nghĩ…', transcribing: 'Đang nghe lại câu nói…', speaking: 'Đang nói…' };

/** One question, typed ({ text }) or spoken ({ pcm }): streams the answer, plays its audio in voice mode. */
async function turn({ text, pcm }) {
  showLive();
  const userBubble = addBubble('user', text ?? '🎙 …');
  const bubble = addBubble('assistant', '');
  const body = el('span', { class: 'caret' });
  bubble.append(body);
  busy = true;
  $('#send').disabled = true;
  $('#stop').hidden = false;
  setStatus(pcm ? STATUS_TEXT.transcribing : STATUS_TEXT.thinking, true);
  currentCancel = new AbortController();
  let got = '';
  // Voice turns show the answer in step with the voice (2026-11-14: the text used to be on screen seconds before it
  // was said): each piece appears when its audio starts, the filler is only heard, and the full text replaces the
  // pieces once the last one has played (or at once when no audio came, e.g. the voice sidecar failed).
  let shown = '';
  const reveal = (t) => {
    shown = shown ? `${shown} ${t}` : t;
    body.textContent = shown;
    bubble.scrollIntoView({ block: 'end' });
  };
  revealRest?.();
  try {
    await stream(pcm ? '/api/voice' : '/api/chat', pcm ?? { text }, (event, data) => {
      if (event === 'transcript') {
        userBubble.textContent = data.text ? `🎙 ${data.text}` : '🎙 (không nghe rõ)';
      } else if (event === 'reset') {
        // Jarvis answered without looking anything up and is asked to check first: drop that draft
        got = '';
        if (!pcm) body.textContent = '';
        setStatus('Đang tra cứu dữ liệu…', true);
      } else if (event === 'text') {
        got += data.text;
        if (pcm) return;
        body.textContent = got;
        bubble.scrollIntoView({ block: 'end' });
      } else if (event === 'audio') {
        player.enqueue(data.data, data.mime, data.filler ? undefined : () => reveal(data.text));
        setStatus(STATUS_TEXT.speaking, true);
      } else if (event === 'status') {
        if (data.state !== 'speaking' || player.playing) setStatus(data.state === 'tool' ? `Đang tra cứu: ${data.label}…` : STATUS_TEXT[data.state] ?? 'Đang nghĩ…', true);
      } else if (event === 'done') {
        if (data.heard === false) {
          bubble.remove();
          return;
        }
        const full = data.text || got || '(không có câu trả lời)';
        const finish = () => {
          revealRest = null;
          body.classList.remove('caret');
          body.textContent = full;
        };
        if (pcm && player.playing) revealRest = finish;
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
  if (busy) {
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
  for (const m of messages) if (m.role === 'user' || m.role === 'assistant') addBubble(m.role, m.content);
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
