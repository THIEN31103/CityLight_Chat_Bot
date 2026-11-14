import { describe, expect, it } from 'vitest';
import type { User } from '@citylight/shared';
import { NO_DATA_ANSWER, TOOL_NUDGE, looksLikeSmallTalk, runTurn, type AgentEvent } from '../src/brain/agent';
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
    expect(events.some((e) => e.type === 'reset')).toBe(true);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages.at(-1)).toEqual({ role: 'user', content: TOOL_NUDGE });
    expect(r.produced.filter((m) => m.role === 'assistant')).toHaveLength(1);
    // the fake still calls no tool after the nudge: the fixed honest sentence, not the model's second guess
    expect(r.text).toBe(NO_DATA_ANSWER);
    expect(events.filter((e) => e.type === 'reset')).toHaveLength(2);
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
    expect(llm.requests[0]!.tools?.map((t) => t.name)).toEqual(['get_system_overview']);
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
