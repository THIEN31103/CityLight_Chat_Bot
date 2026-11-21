import { describe, expect, it } from 'vitest';
import type { User } from '@citylight/shared';
import { DATA_FAIL_ANSWER, NO_DATA_ANSWER, TOOL_NOT_OFFERED, TOOL_NUDGE, looksLikeSmallTalk, runTurn, type AgentEvent } from '../src/brain/agent';
import { SWITCH_ANSWER } from '../src/brain/router';
import { FakeLlm } from '../src/brain/providers/fake';
import type { ToolContext, ToolDef } from '../src/tools/registry';
import { z } from 'zod';

const user = { id: 'u', email: 'u@a.vn', fullName: 'U', role: 'operator', scopeAll: true, scopeAreaIds: [], lang: 'vi' } as unknown as User;
const ctx = { reads: {} as never, user, focus: {} } as ToolContext;
const echo: ToolDef = {
  name: 'get_system_overview', kind: 'read', description: 'd', schema: { type: 'object', properties: {} }, input: z.object({}).passthrough(),
  run: async () => ({ cabinets: { total: 10 } }),
};

describe('small talk vs data questions', () => {
  it.each(['Xin chào Jarvis', 'chào bạn', 'Cảm ơn nhé', 'ok', 'Bạn là ai?', '', 'bạn giới thiệu về bạn đi', 'bạn có thể làm gì', 'hôm nay trời đẹp nhỉ'])(
    '"%s" is small talk',
    (t) => expect(looksLikeSmallTalk(t)).toBe(true),
  );
  it.each([
    'Hệ thống thế nào rồi?', 'Tủ DM0010 bị gì', 'chào, tủ số 3 có sáng không và lịch thế nào vậy bạn', 'Mã E201 là gì', 'phường nào đang có lỗi',
    'TL01.0009 sao rồi', 'có sự cố nào quá hạn không', 'quận 3 có bao nhiêu đèn đang sáng',
  ])('"%s" needs data', (t) => expect(looksLikeSmallTalk(t)).toBe(false));
});

describe('runTurn', () => {
  it('a data question answered without a tool is asked again once, and the draft is dropped', async () => {
    const llm = new FakeLlm();
    const events: AgentEvent[] = [];
    const r = await runTurn({
      llm, tools: [echo], ctx, system: 's', messages: [{ role: 'user', content: 'Hệ thống thế nào rồi?' }], maxTokens: 100, onEvent: (e) => events.push(e), useRouter: false,
    });
    expect(r.nudged).toBe(true);
    // the drafts are never shown (2026-11-20): only the fixed sentence reaches the screen, nothing to take back
    expect(events.some((e) => e.type === 'reset')).toBe(false);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual([NO_DATA_ANSWER]);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: TOOL_NUDGE });
    expect(r.produced.filter((m) => m.role === 'assistant')).toHaveLength(1);
    // the fake still calls no tool after the nudge: the fixed honest sentence, not the model's second guess
    expect(r.text).toBe(NO_DATA_ANSWER);
    expect(events.filter((e) => e.type === 'reset')).toHaveLength(0);
  });

  it('a question about Jarvis itself is answered at once, never nudged', async () => {
    const llm = new FakeLlm();
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', messages: [{ role: 'user', content: 'bạn giới thiệu về bạn đi' }], maxTokens: 100 });
    expect(r).toMatchObject({ nudged: false, text: 'ok' });
    expect(llm.requests).toHaveLength(1);
  });

  it('small talk is answered at once', async () => {
    const llm = new FakeLlm();
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', messages: [{ role: 'user', content: 'xin chào' }], maxTokens: 100 });
    expect(r).toMatchObject({ nudged: false, text: 'ok', stopReason: 'end_turn' });
    expect(llm.requests).toHaveLength(1);
  });

  it('a turn that used a tool is not nudged; the tool result goes back to the model', async () => {
    const llm = new FakeLlm();
    const r = await runTurn({
      llm, tools: [echo], ctx, system: 's', maxTokens: 100, useRouter: false,
      messages: [{ role: 'user', content: '[[fake:{"tools":[{"name":"get_system_overview","input":{}}],"text":"Có 10 tủ."}]] hệ thống?' }],
    });
    expect(r).toMatchObject({ nudged: false, text: 'Có 10 tủ.', toolCalls: [{ name: 'get_system_overview', ok: true }] });
    expect(llm.requests[1]!.messages.find((m) => m.role === 'tool')!.content).toContain('"total":10');
  });

  it('the router fetches first: the model gets the data in its very first call', async () => {
    const llm = new FakeLlm();
    const events: AgentEvent[] = [];
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, messages: [{ role: 'user', content: 'Tình hình hệ thống sao rồi?' }], onEvent: (e) => events.push(e) });
    expect(r.toolCalls.map((c) => c.name)).toEqual(['get_system_overview']);
    expect(r.nudged).toBe(false);
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.messages.find((m) => m.role === 'tool')!.content).toContain('"total":10');
    expect(events[0]).toMatchObject({ type: 'tool_start', name: 'get_system_overview' });
  });

  it('the router may run a tool the model is not offered (street search)', async () => {
    const find: ToolDef = { ...echo, name: 'find_cabinets', input: z.object({ query: z.string() }), run: async (_c, i) => ({ found: [(i as { query: string }).query] }) };
    const llm = new FakeLlm();
    const r = await runTurn({ llm, tools: [echo], routerTools: [find], ctx, system: 's', maxTokens: 100, messages: [{ role: 'user', content: 'các tủ trên đường Lý Thường Kiệt' }] });
    expect(r.toolCalls.map((c) => c.name)).toEqual(['find_cabinets']);
    // the street search itself is never offered to the model; after the router fetched, no tool list at all (token use)
    expect(llm.requests[0]!.tools).toEqual([]);
    expect(llm.requests[0]!.messages.find((m) => m.role === 'tool')!.content).toContain('Lý Thường Kiệt');
  });

  it('an order to switch lights gets the fixed "cannot yet" sentence, no model call', async () => {
    const llm = new FakeLlm();
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, messages: [{ role: 'user', content: 'Bật đèn tủ TL01.0009 lên giúp tôi' }] });
    expect(r.text).toBe(SWITCH_ANSWER);
    expect(llm.requests).toHaveLength(0);
  });

  it('an unknown tool name is reported to the model, not thrown', async () => {
    const llm = new FakeLlm();
    const r = await runTurn({
      llm, tools: [echo], ctx, system: 's', maxTokens: 100,
      messages: [{ role: 'user', content: '[[fake:{"tools":[{"name":"switch_off_everything","input":{}}],"text":"Không làm được."}]] tắt hết' }],
    });
    expect(r.toolCalls).toEqual([{ name: 'switch_off_everything', input: {}, ok: false, ms: 0 }]);
    expect(llm.requests[1]!.messages.find((m) => m.role === 'tool')!.content).toContain('unknown_tool');
  });
});

describe('a bare "không biết" although a tool answered', () => {
  it('is dropped and the model is asked once to answer from the data', async () => {
    const replies = ['Tôi không biết.', 'Hệ thống có 12 khu vực.'];
    const llm = {
      name: 'scripted', model: 'm', requests: [] as unknown[],
      async *stream(r: unknown) {
        (this.requests as unknown[]).push(r);
        yield { type: 'text' as const, text: replies.shift()! };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      },
    };
    const events: AgentEvent[] = [];
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, onEvent: (e) => events.push(e), messages: [{ role: 'user', content: 'Tình hình hệ thống sao rồi?' }] });
    expect(r.text).toBe('Hệ thống có 12 khu vực.');
    expect(llm.requests).toHaveLength(2);
    // "Tôi không biết." never reached the screen: only the answer from the data
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Hệ thống có 12 khu vực.');
    expect(events.some((e) => e.type === 'reset')).toBe(false);
  });
});

describe('what reaches the screen (user report 2026-11-20: an answer appeared, then another one replaced it)', () => {
  const scripted = (rounds: { text: string; tool?: string }[]) => ({
    name: 'scripted', model: 'm', requests: [] as unknown[],
    async *stream(r: unknown) {
      (this.requests as unknown[]).push(r);
      const next = rounds.shift()!;
      for (const piece of next.text.match(/.{1,5}/gs) ?? []) yield { type: 'text' as const, text: piece };
      if (next.tool) yield { type: 'tool_use' as const, call: { id: 'c1', name: next.tool, input: {} } };
      yield { type: 'done' as const, stopReason: (next.tool ? 'tool_use' : 'end_turn') as 'tool_use' | 'end_turn' };
    },
  });
  const shownText = (events: AgentEvent[]) => events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');

  it('a long answer after the data streams in pieces, and what streams is exactly the answer', async () => {
    const long = 'Hệ thống có 510 tủ, trong đó 19 tủ đang trực tuyến và 491 tủ mất kết nối.';
    const llm = scripted([{ text: long }]);
    const events: AgentEvent[] = [];
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, onEvent: (e) => events.push(e), messages: [{ role: 'user', content: 'Tình hình hệ thống sao rồi?' }] });
    expect(r.text).toBe(long);
    expect(shownText(events)).toBe(long);
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1);
    expect(events.some((e) => e.type === 'reset')).toBe(false);
  });

  it('a draft written before a second tool call is not shown; only the last round is', async () => {
    const llm = scripted([{ text: 'Có 491 tủ mất kết nối.', tool: 'get_system_overview' }, { text: 'Có 491 tủ đang mất kết nối.' }]);
    const events: AgentEvent[] = [];
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, onEvent: (e) => events.push(e), messages: [{ role: 'user', content: 'Tình hình hệ thống sao rồi?' }] });
    expect(r.text).toBe('Có 491 tủ đang mất kết nối.');
    expect(shownText(events)).toBe('Có 491 tủ đang mất kết nối.');
  });

  it('small talk streams at once', async () => {
    const llm = scripted([{ text: 'Chào bạn! Tôi là Jarvis.' }]);
    const events: AgentEvent[] = [];
    await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, onEvent: (e) => events.push(e), messages: [{ role: 'user', content: 'xin chào' }] });
    expect(events.filter((e) => e.type === 'text').length).toBeGreaterThan(1);
  });
});

describe('token use', () => {
  it('when the router already fetched the data, the first answer is asked without the tool list', async () => {
    const llm = new FakeLlm();
    await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, messages: [{ role: 'user', content: 'Tình hình hệ thống sao rồi?' }] });
    expect(llm.requests[0]!.tools).toEqual([]);
  });
  it('without a router match the tools are offered as before', async () => {
    const llm = new FakeLlm();
    await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, useRouter: false, messages: [{ role: 'user', content: 'Tình hình hệ thống sao rồi?' }] });
    expect(llm.requests[0]!.tools?.map((t) => t.name)).toEqual(['get_system_overview']);
  });
});

describe('a tool call the provider refused because no tool was offered (user report 2026-11-20)', () => {
  it('the round is asked again with the tools, and the answer comes from that', async () => {
    const requests: { tools: unknown[] }[] = [];
    const llm = {
      name: 'scripted', model: 'm',
      async *stream(r: { tools: unknown[] }) {
        requests.push(r);
        if (requests.length === 1) {
          yield { type: 'error' as const, message: 'groq trả lỗi 400: Tool choice is none, but model called a tool' };
          return;
        }
        yield { type: 'text' as const, text: 'Hệ thống có 10 tủ, đây là câu trả lời sau khi được đưa công cụ.' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      },
    };
    const events: AgentEvent[] = [];
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, onEvent: (e) => events.push(e), messages: [{ role: 'user', content: 'Tình hình hệ thống sao rồi?' }] });
    expect(r.stopReason).toBe('end_turn');
    expect(r.text).toMatch(/^Hệ thống có 10 tủ/);
    expect(requests[0]!.tools).toEqual([]);
    expect(requests[1]!.tools).toHaveLength(1);
    expect(events.some((e) => e.type === 'reset')).toBe(false);
  });
  it('any other error is still reported', () => {
    expect(TOOL_NOT_OFFERED.test('groq báo đã dùng hết giới hạn miễn phí lúc này')).toBe(false);
  });
});

describe('a bare "không biết" twice although a tool answered (2026-11-20)', () => {
  it('ends in the fixed honest sentence, never "Không biết." alone, and nothing else reached the screen', async () => {
    const llm = {
      name: 'scripted', model: 'm', requests: [] as unknown[],
      async *stream(r: unknown) {
        (this.requests as unknown[]).push(r);
        yield { type: 'text' as const, text: 'Không biết.' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      },
    };
    const events: AgentEvent[] = [];
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, onEvent: (e) => events.push(e), messages: [{ role: 'user', content: 'Tình hình hệ thống sao rồi?' }] });
    expect(llm.requests).toHaveLength(2);
    expect(r.text).toBe(DATA_FAIL_ANSWER);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual([DATA_FAIL_ANSWER]);
  });
  it('"bạn có thể liệt kê các tủ như nào" is answered in code', async () => {
    const llm = new FakeLlm();
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, messages: [{ role: 'user', content: 'bạn có thể liệt kê các tủ như nào' }] });
    expect(r.text).toMatch(/^Tôi liệt kê được các tủ theo trạng thái/);
    expect(llm.requests).toHaveLength(0);
  });
});

describe('a tool call refused for its arguments (2026-11-21: "limit: maximum 30, got 39")', () => {
  it('is reported to the model once and the answer comes from the next try', async () => {
    const requests: { messages: { role: string; content: string }[] }[] = [];
    const llm = {
      name: 'scripted', model: 'm',
      async *stream(r: { messages: { role: string; content: string }[] }) {
        requests.push(r);
        if (requests.length === 1) {
          yield { type: 'error' as const, message: 'Tool call validation failed: parameters for tool get_area_cabinets did not match schema' };
          return;
        }
        yield { type: 'text' as const, text: 'Có 39 tủ mất kết nối ở Thủ Đức, ví dụ TL01.0001, TL01.0002.' };
        yield { type: 'done' as const, stopReason: 'end_turn' as const };
      },
    };
    const r = await runTurn({ llm, tools: [echo], ctx, system: 's', maxTokens: 100, useRouter: false, messages: [{ role: 'user', content: 'liệt kê 39 tủ mất kết nối' }] });
    expect(r.stopReason).toBe('end_turn');
    // no red error: the refusal went back to the model once (every request shares the one message list)
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(requests.at(-1)!.messages.filter((m) => /Your tool call was refused/.test(m.content))).toHaveLength(1);
  });
});
