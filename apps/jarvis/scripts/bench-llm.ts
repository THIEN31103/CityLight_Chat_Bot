// Measures the configured brain (LLM_PROVIDER / LLM_MODEL) on short Vietnamese operator questions:
// time to first text, total time, tokens. Spec 9 target: first text p50 <= 1.5 s in text mode.
//   npm run bench:llm -w @citylight/jarvis -- [rounds]
// The first round includes loading the model into memory and is reported apart (cold).
import { collect, createLlm, type LlmTool } from '../src/brain/llm';
import { loadConfig } from '../src/config';

const cfg = loadConfig();
const llm = createLlm(cfg.llm, cfg.groq);
const rounds = Math.max(1, Number(process.argv[2] ?? 3));

const SYSTEM =
  'Bạn là Jarvis, trợ lý điều hành hệ thống chiếu sáng CityLight. Xưng "tôi", gọi người dùng là "bạn". ' +
  'Trả lời 1-2 câu, tiếng Việt, chỉ dựa trên dữ liệu từ công cụ; không biết thì nói không biết.';
const TOOLS: LlmTool[] = [
  { name: 'get_system_overview', description: 'Tổng quan: số tủ online / offline / đang sáng, cảnh báo đang mở', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'get_cabinet',
    description: 'Trạng thái một tủ theo mã hoặc tên đọc ra',
    inputSchema: { type: 'object', properties: { cabinet: { type: 'string', description: 'mã tủ (ví dụ DM0010) hoặc tên' } }, required: ['cabinet'], additionalProperties: false },
  },
];
// [question, tool the model should pick, or null when it should just answer]
const CASES: [string, string | null][] = [
  ['Xin chào Jarvis', null],
  ['Hệ thống thế nào rồi?', 'get_system_overview'],
  ['Tủ demo số mười bị gì vậy?', 'get_cabinet'],
  ['Mã lỗi là gì, nói ngắn gọn thôi', null],
];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? NaN;
};

console.log(`brain ${llm.name}/${llm.model} · ${rounds} round(s) × ${CASES.length} questions`);
const first: number[] = [];
const total: number[] = [];
let toolHits = 0;
let toolCases = 0;
for (let r = 0; r <= rounds; r++) {
  for (const [q, want] of CASES) {
    const t0 = performance.now();
    const mark: { first: number | null } = { first: null };
    const timed = (async function* () {
      for await (const ev of llm.stream({ system: SYSTEM, messages: [{ role: 'user', content: q }], tools: TOOLS, maxTokens: cfg.llm.maxTokens })) {
        if (mark.first === null && (ev.type === 'text' || ev.type === 'tool_use')) mark.first = performance.now() - t0;
        yield ev;
      }
    })();
    const res = await collect(timed);
    const tFirst = mark.first;
    const tTotal = performance.now() - t0;
    const picked = res.toolCalls[0]?.name ?? null;
    const label = r === 0 ? 'cold' : `#${r}`;
    if (res.error) {
      console.log(`${label.padEnd(5)} FAIL  ${q}  ${res.error}`);
      continue;
    }
    if (r > 0) {
      if (tFirst !== null) first.push(tFirst);
      total.push(tTotal);
      if (want) {
        toolCases++;
        if (picked === want) toolHits++;
      }
    }
    const what = picked ? `→ ${picked}(${JSON.stringify(res.toolCalls[0]!.input)})` : `"${res.text.trim().slice(0, 60)}"`;
    console.log(`${label.padEnd(5)} first ${String(tFirst?.toFixed(0) ?? '-').padStart(5)} ms  total ${tTotal.toFixed(0).padStart(5)} ms  ${res.usage.inputTokens}+${res.usage.outputTokens} tok  ${q}  ${what}`);
  }
}
if (first.length) {
  console.log(`\nfirst output  p50 ${pct(first, 50).toFixed(0)} ms  p95 ${pct(first, 95).toFixed(0)} ms   (spec 9: p50 <= 1500 ms)`);
  console.log(`whole answer  p50 ${pct(total, 50).toFixed(0)} ms  p95 ${pct(total, 95).toFixed(0)} ms`);
  console.log(`right tool    ${toolHits}/${toolCases}`);
}
