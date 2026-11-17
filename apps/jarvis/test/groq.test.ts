// LLM_PROVIDER=groq / STT_PROVIDER=groq (2026-11-17) against a fake OpenAI-compatible server: wire format only,
// no network, no real key. The real service is measured with the local stack (README, "Groq").
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { collect } from '../src/brain/llm';
import { OpenAiCompatLlm } from '../src/brain/providers/openai-compat';
import { loadConfig } from '../src/config';
import { GroqStt, looksMadeUp, pcmToWav } from '../src/voice/groq-stt';

const KEY = 'gsk_test_not_a_real_key';

async function fake(handler: (req: IncomingMessage, body: Buffer) => { status?: number; headers?: Record<string, string>; body: string }) {
  const seen: { path: string; auth?: string; type?: string; body: Buffer }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    seen.push({ path: req.url ?? '', auth: req.headers.authorization, type: req.headers['content-type'], body });
    const r = handler(req, body);
    res.writeHead(r.status ?? 200, { connection: 'close', ...(r.headers ?? {}) });
    res.end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const sse = (chunks: object[]) => `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
const req = (content: string) => ({ system: 's', messages: [{ role: 'user' as const, content }], tools: [{ name: 'get_cabinet', description: 'd', inputSchema: { type: 'object', properties: {} } }], maxTokens: 100 });

describe('groq LLM (OpenAI-compatible chat completions)', () => {
  it('streams text, joins a tool call sent in pieces, reports usage; the key goes only in the Authorization header', async () => {
    const f = await fake(() => ({
      headers: { 'content-type': 'text/event-stream' },
      body: sse([
        { choices: [{ delta: { content: 'Để ' } }] },
        { choices: [{ delta: { content: 'tôi xem.' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'get_', arguments: '{"cab' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'cabinet', arguments: 'inet":"TL01.0009"}' } }] }, finish_reason: 'tool_calls' }] },
        { choices: [], usage: { prompt_tokens: 120, completion_tokens: 15 } },
      ]),
    }));
    const llm = new OpenAiCompatLlm({ name: 'groq', baseUrl: f.url, apiKey: KEY, model: 'openai/gpt-oss-20b', reasoningEffort: 'low' });
    const r = await collect(llm.stream(req('Tủ TL01.0009 thế nào?')));
    expect(r).toMatchObject({ text: 'Để tôi xem.', stopReason: 'tool_use', error: null, usage: { inputTokens: 120, outputTokens: 15 } });
    expect(r.toolCalls).toEqual([{ id: 'call_a', name: 'get_cabinet', input: { cabinet: 'TL01.0009' } }]);
    const sent = JSON.parse(f.seen[0]!.body.toString()) as Record<string, any>;
    expect(f.seen[0]).toMatchObject({ path: '/chat/completions', auth: `Bearer ${KEY}` });
    expect(sent).toMatchObject({ model: 'openai/gpt-oss-20b', stream: true, tool_choice: 'auto', reasoning_effort: 'low', max_tokens: 100 });
    expect(sent.messages[0]).toEqual({ role: 'system', content: 's' });
    expect(sent.tools[0].function.name).toBe('get_cabinet');
    expect(f.seen[0]!.body.toString()).not.toContain(KEY);
    await f.close();
  });

  it('sends tool results back with their call id', async () => {
    const f = await fake(() => ({ body: sse([{ choices: [{ delta: { content: 'Tủ đang sáng.' }, finish_reason: 'stop' }] }]) }));
    const llm = new OpenAiCompatLlm({ name: 'groq', baseUrl: f.url, apiKey: KEY, model: 'm' });
    const r = await collect(llm.stream({
      system: 's', tools: [], maxTokens: 50,
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'get_cabinet', input: { cabinet: 'X' } }] },
        { role: 'tool', toolCallId: 'call_a', name: 'get_cabinet', content: '{"on":true}' },
      ],
    }));
    expect(r).toMatchObject({ text: 'Tủ đang sáng.', stopReason: 'end_turn' });
    const msgs = JSON.parse(f.seen[0]!.body.toString()).messages as Record<string, unknown>[];
    expect(msgs[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'get_cabinet', arguments: '{"cabinet":"X"}' } }] });
    expect(msgs[3]).toEqual({ role: 'tool', tool_call_id: 'call_a', content: '{"on":true}' });
    await f.close();
  });

  it('a used-up free tier (429), a wrong key (401) and a cut stream are error events in Vietnamese, not exceptions', async () => {
    // 30 s is more than Jarvis waits: the turn ends at once with the message
    const limited = await fake(() => ({ status: 429, headers: { 'retry-after': '30' }, body: '{"error":{"message":"Rate limit reached"}}' }));
    expect((await collect(new OpenAiCompatLlm({ name: 'groq', baseUrl: limited.url, apiKey: KEY, model: 'm' }).stream(req('a')))).error).toMatch(/hết giới hạn miễn phí.*30 giây/);
    await limited.close();
    const wrong = await fake(() => ({ status: 401, body: '{"error":{"message":"Invalid API Key"}}' }));
    expect((await collect(new OpenAiCompatLlm({ name: 'groq', baseUrl: wrong.url, apiKey: KEY, model: 'm' }).stream(req('a')))).error).toMatch(/GROQ_API_KEY/);
    await wrong.close();
    const cut = await fake(() => ({ body: 'data: {"choices":[{"delta":{"content":"nửa"}}]}\n\n' }));
    const r = await collect(new OpenAiCompatLlm({ name: 'groq', baseUrl: cut.url, apiKey: KEY, model: 'm' }).stream(req('a')));
    expect(r).toMatchObject({ text: 'nửa', error: expect.stringMatching(/giữa chừng/) });
    await cut.close();
  });
});

describe('groq speech recognition', () => {
  it('sends a 16 kHz WAV in Vietnamese with the operators\' hint, drops made-up segments', async () => {
    const f = await fake(() => ({
      body: JSON.stringify({
        text: 'Tủ đó sao rồi? Hãy subscribe kênh',
        segments: [
          { text: ' Tủ đó sao rồi?', avg_logprob: -0.2, no_speech_prob: 0.01, compression_ratio: 1.1 },
          { text: ' Hãy subscribe kênh', avg_logprob: -0.3, no_speech_prob: 0.1, compression_ratio: 1.2 },
          { text: ' ạ ạ ạ ạ ạ ạ', avg_logprob: -0.4, no_speech_prob: 0.1, compression_ratio: 3.1 },
        ],
      }),
    }));
    const stt = new GroqStt({ baseUrl: f.url, apiKey: KEY, model: 'whisper-large-v3-turbo' });
    const r = await stt.transcribe(new Uint8Array(32_000));
    expect(r).toMatchObject({ text: 'Tủ đó sao rồi?', audioMs: 1000 });
    expect(f.seen[0]).toMatchObject({ path: '/audio/transcriptions', auth: `Bearer ${KEY}` });
    const form = f.seen[0]!.body.toString('latin1');
    for (const part of ['name="model"', 'whisper-large-v3-turbo', 'name="language"', 'name="response_format"', 'verbose_json', 'RIFF', 'WAVE']) expect(form).toContain(part);
    await f.close();
  });

  it('a used-up free tier is a clear message', async () => {
    const f = await fake(() => ({ status: 429, body: '{}' }));
    await expect(new GroqStt({ baseUrl: f.url, apiKey: KEY, model: 'm' }).transcribe(new Uint8Array(3200))).rejects.toThrow(/hết giới hạn nghe giọng/);
    await f.close();
  });

  it('WAV header and made-up filters', () => {
    const wav = pcmToWav(new Uint8Array(3200));
    const v = new DataView(wav.buffer);
    expect([wav.length, v.getUint32(24, true), v.getUint16(22, true), v.getUint16(34, true)]).toEqual([3244, 16000, 1, 16]);
    expect(looksMadeUp({ text: ' Chịp job.', avg_logprob: -1.3 })).toBe(true);
    expect(looksMadeUp({ text: ' Xác nhận.', avg_logprob: -0.2, no_speech_prob: 0.1, compression_ratio: 1 })).toBe(false);
  });
});

describe('config', () => {
  it('groq needs a key; the defaults are gpt-oss-20b and whisper-large-v3-turbo; ollama stays the default', () => {
    expect(() => loadConfig({ LLM_PROVIDER: 'groq' })).toThrow(/GROQ_API_KEY/);
    const c = loadConfig({ LLM_PROVIDER: 'groq', STT_PROVIDER: 'groq', GROQ_API_KEY: KEY });
    expect(c.llm.model).toBe('openai/gpt-oss-20b');
    expect(c.stt.model).toBe('whisper-large-v3-turbo');
    expect(c.groq).toEqual({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: KEY });
    const d = loadConfig({});
    expect([d.llm.provider, d.llm.model, d.stt.model]).toEqual(['ollama', 'qwen3:4b-instruct', 'small']);
  });
});

describe('groq speech recognition: network retry', () => {
  it('a network failure is retried once; a refusal from Groq is not', async () => {
    let calls = 0;
    const flaky = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ text: 'Xác nhận.', segments: [{ text: 'Xác nhận.', avg_logprob: -0.1 }] }), { status: 200 });
    }) as unknown as typeof fetch;
    expect((await new GroqStt({ baseUrl: 'http://x', apiKey: 'k', model: 'm', fetch: flaky }).transcribe(new Uint8Array(3200))).text).toBe('Xác nhận.');
    expect(calls).toBe(2);
    let refused = 0;
    const limited = (async () => {
      refused++;
      return new Response('{}', { status: 429 });
    }) as unknown as typeof fetch;
    await expect(new GroqStt({ baseUrl: 'http://x', apiKey: 'k', model: 'm', fetch: limited }).transcribe(new Uint8Array(3200))).rejects.toThrow(/hết giới hạn/);
    expect(refused).toBe(1);
  });
});

describe('groq free quota: model rotation', () => {
  it('a model out of quota (429) hands the turn to the next one; reasoning settings follow each model', async () => {
    const f = await fake((_r, body) => {
      const m = JSON.parse(body.toString()).model as string;
      return m === 'openai/gpt-oss-20b'
        ? { status: 429, headers: { 'retry-after': '3' }, body: '{"error":{"message":"rate limit"}}' }
        : { body: sse([{ choices: [{ delta: { content: `từ ${m}` }, finish_reason: 'stop' }] }]) };
    });
    const llm = new OpenAiCompatLlm({ name: 'groq', baseUrl: f.url, apiKey: KEY, model: 'openai/gpt-oss-20b', reasoningEffort: 'low', fallbackModels: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'] });
    expect((await collect(llm.stream(req('a')))).text).toBe('từ qwen/qwen3.8-27b');
    const sent = f.seen.map((s) => JSON.parse(s.body.toString()) as Record<string, unknown>);
    expect(sent.map((b) => b.model)).toEqual(['openai/gpt-oss-20b', 'qwen/qwen3.8-27b']);
    expect(sent[0]).toMatchObject({ reasoning_effort: 'low' });
    expect(sent[1]).toMatchObject({ reasoning_format: 'hidden' });
    expect(sent[1]!.reasoning_effort).toBeUndefined();
    await f.close();
  });

  it('all models out of quota: waits what Groq asks once, then says so', async () => {
    const f = await fake(() => ({ status: 429, headers: { 'retry-after': '0' }, body: '{}' }));
    const llm = new OpenAiCompatLlm({ name: 'groq', baseUrl: f.url, apiKey: KEY, model: 'a', fallbackModels: ['b'] });
    expect((await collect(llm.stream(req('a')))).error).toMatch(/hết giới hạn miễn phí/);
    expect(f.seen.length).toBe(4);
    await f.close();
  });
});
