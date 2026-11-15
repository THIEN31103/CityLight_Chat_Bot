import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { collect, type LlmMessage, type LlmRequest } from '../src/brain/llm';
import { FakeLlm, parseFakeScript } from '../src/brain/providers/fake';
import { OllamaLlm } from '../src/brain/providers/ollama';

const req = (messages: LlmMessage[], extra: Partial<LlmRequest> = {}): LlmRequest => ({ system: 'sys', messages, tools: [], maxTokens: 256, ...extra });

describe('fake provider (spec 5.6)', () => {
  it('answers "ok" without a script', async () => {
    const r = await collect(new FakeLlm().stream(req([{ role: 'user', content: 'xin chào' }])));
    expect(r).toMatchObject({ text: 'ok', stopReason: 'end_turn', error: null });
  });

  it('asks for the scripted tools first, then streams the text in chunks with the scripted usage', async () => {
    const llm = new FakeLlm();
    const content = '[[fake:{"tools":[{"name":"get_cabinet","input":{"cabinet":"DM0010"}}],"text":"Tủ DM0010 mất PLC.","chunks":3,"usage":{"inputTokens":120,"outputTokens":9}}]] tủ 10 bị gì';
    const first = await collect(llm.stream(req([{ role: 'user', content }])));
    expect(first.stopReason).toBe('tool_use');
    expect(first.toolCalls).toEqual([{ id: expect.any(String), name: 'get_cabinet', input: { cabinet: 'DM0010' } }]);

    const pieces: string[] = [];
    for await (const ev of llm.stream(req([
      { role: 'user', content },
      { role: 'assistant', content: '', toolCalls: first.toolCalls },
      { role: 'tool', toolCallId: first.toolCalls[0]!.id, name: 'get_cabinet', content: '{"online":true}' },
    ]))) if (ev.type === 'text') pieces.push(ev.text);
    expect(pieces).toHaveLength(3);
    expect(pieces.join('')).toBe('Tủ DM0010 mất PLC.');
    expect(llm.requests).toHaveLength(2);
  });

  it('a broken script is plain text', () => {
    expect(parseFakeScript('[[fake:{not json}]] hi')).toBeNull();
    expect(parseFakeScript('hỏi [[fake:{}]]')).toBeNull();
  });

  it('stops when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await collect(new FakeLlm().stream(req([{ role: 'user', content: '[[fake:{"text":"abcdef","chunks":3}]]' }], { signal: ac.signal })));
    expect(r.stopReason).toBe('aborted');
    expect(r.text).toBe('');
  });
});

/** Serves canned NDJSON lines the way Ollama's /api/chat streams them, and keeps the request body. */
async function fakeOllama(lines: object[], status = 200) {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (r, res) => {
    let s = '';
    for await (const c of r) s += c;
    bodies.push(JSON.parse(s) as Record<string, unknown>);
    // no keep-alive: a pooled socket to a port a closed fake server used made later tests fail under parallel load
    res.writeHead(status, { 'content-type': 'application/x-ndjson', connection: 'close' });
    for (const l of lines) res.write(`${JSON.stringify(l)}\n`);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, bodies, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('ollama provider (wire format only; a real model is measured by scripts/bench-llm.ts)', () => {
  it('streams text and reports token counts from the last line', async () => {
    const o = await fakeOllama([
      { message: { role: 'assistant', content: 'Hệ thống ' }, done: false },
      { message: { role: 'assistant', content: 'ổn định.' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 310, eval_count: 7 },
    ]);
    const llm = new OllamaLlm({ baseUrl: o.url, model: 'qwen3:4b', numCtx: 4096, think: false });
    const r = await collect(llm.stream(req([{ role: 'user', content: 'tình hình?' }], {
      tools: [{ name: 'get_system_overview', description: 'tổng quan', inputSchema: { type: 'object', properties: {} } }],
    })));
    expect(r).toMatchObject({ text: 'Hệ thống ổn định.', usage: { inputTokens: 310, outputTokens: 7 }, stopReason: 'end_turn', error: null });
    const sent = o.bodies[0]!;
    expect(sent).toMatchObject({ model: 'qwen3:4b', stream: true, think: false, options: { num_predict: 256, num_ctx: 4096 } });
    expect((sent.messages as { role: string }[])[0]).toEqual({ role: 'system', content: 'sys' });
    expect((sent.tools as { function: { name: string } }[])[0]!.function.name).toBe('get_system_overview');
    await o.close();
  });

  it('turns tool_calls into tool_use events with ids, and sends tool results back with their name', async () => {
    const o = await fakeOllama([
      { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'find_cabinets', arguments: { query: 'demo 10' } } }] }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 12 },
    ]);
    const llm = new OllamaLlm({ baseUrl: o.url, model: 'm' });
    const r = await collect(llm.stream(req([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'x1', name: 'get_cabinet', input: { cabinet: 'DM0001' } }] },
      { role: 'tool', toolCallId: 'x1', name: 'get_cabinet', content: '{}' },
    ])));
    expect(r.stopReason).toBe('tool_use');
    expect(r.toolCalls).toEqual([{ id: expect.stringMatching(/^call_/), name: 'find_cabinets', input: { query: 'demo 10' } }]);
    const msgs = o.bodies[0]!.messages as Record<string, unknown>[];
    expect(msgs[2]).toEqual({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_cabinet', arguments: { cabinet: 'DM0001' } } }] });
    expect(msgs[3]).toEqual({ role: 'tool', content: '{}', tool_name: 'get_cabinet' });
    expect(o.bodies[0]).not.toHaveProperty('think');
    await o.close();
  });

  it('an HTTP error or an unreachable Ollama is an error event, not an exception', async () => {
    const o = await fakeOllama([{ error: 'model "x" not found' }], 404);
    const r = await collect(new OllamaLlm({ baseUrl: o.url, model: 'x' }).stream(req([{ role: 'user', content: 'a' }])));
    expect(r.error).toMatch(/404/);
    await o.close();
    const down = await collect(new OllamaLlm({ baseUrl: 'http://127.0.0.1:1', model: 'x' }).stream(req([{ role: 'user', content: 'a' }])));
    expect(down.error).toMatch(/Không kết nối được Ollama/);
  });

  it('a stream that ends without done is reported', async () => {
    const o = await fakeOllama([{ message: { content: 'nửa câu' }, done: false }]);
    const r = await collect(new OllamaLlm({ baseUrl: o.url, model: 'm' }).stream(req([{ role: 'user', content: 'a' }])));
    expect(r.text).toBe('nửa câu');
    expect(r.error).toMatch(/giữa chừng/);
    await o.close();
  });
});
