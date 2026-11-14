// Voice benchmark (spec 9): the 20 sample sentences of spec 11 are spoken by the TTS voice, then transcribed by the
// STT engine. Reports TTS time, STT time, how close the transcript is, and whether the keyword router still finds
// the right tool from the transcript. A synthetic voice is cleaner than a person in a control room: the real test is
// Bảo's 20 recordings (spec 11); this one catches regressions and measures speed.
//   npm run bench:voice -w @citylight/jarvis
import { route } from '../src/brain/router';
import { loadConfig } from '../src/config';
import { fold, wordsToDigits } from '../src/tools/names';
import { SidecarVoice } from '../src/voice/client';

const cfg = loadConfig();
const voice = new SidecarVoice({ url: cfg.voice.url, voice: cfg.tts.voice, timeoutMs: 60_000 });

// [sentence, tool the router should pick from the transcript (null = none)]
const SAMPLES: [string, string | null][] = [
  ['Jarvis, tình hình hệ thống sao rồi?', 'get_system_overview'],
  ['Tủ demo số mười bị gì vậy?', 'get_cabinet'],
  ['Bật tay tủ demo số hai.', null],
  ['Xác nhận.', null],
  ['Trả tủ đó về chạy theo lịch.', null],
  ['Phường nào đang có lỗi?', 'list_alarms'],
  ['Tối qua tủ số ba bật lúc mấy giờ?', 'get_cabinet_history'],
  ['Tắt nhánh hai tủ số bảy.', null],
  ['Hủy.', null],
  ['Im lặng mười lăm phút.', null],
  ['Mã E hai không một nghĩa là gì?', 'explain_alarm_code'],
  ['Có sự cố nào quá hạn không?', 'list_incidents'],
  ['Lịch bật tắt của tủ demo số năm thế nào?', 'get_schedule'],
  ['Dòng rò tủ demo số bốn hai mươi bốn giờ qua có bất thường không?', 'get_cabinet_history'],
  ['Quận nào đang có nhiều cảnh báo nhất?', 'list_alarms'],
  ['Báo cáo tình hình đầu ca.', 'get_system_overview'],
  ['Tủ demo số một có đang sáng không?', 'get_cabinet'],
  ['Kiểm tra giúp tôi tủ demo số sáu.', 'get_cabinet'],
  ['Đồng ý.', null],
  ['Cảm ơn Jarvis.', null],
];

// numbers count the same written either way ("số hai" = "số 2"), as the router reads them
const words = (s: string) => wordsToDigits(fold(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()).split(' ').filter(Boolean);

/** word accuracy = 1 - word error rate (Levenshtein over words), floored at 0 */
function wordAccuracy(ref: string, hyp: string) {
  const a = words(ref);
  const b = words(hyp);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return Math.max(0, 1 - d[a.length]![b.length]! / Math.max(1, a.length));
}

const pct = (xs: number[], p: number) => [...xs].sort((x, y) => x - y)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? NaN;

const health = await voice.health();
if (!health) {
  console.error(`voice sidecar not reachable at ${cfg.voice.url}`);
  process.exit(1);
}
console.log(`STT ${JSON.stringify(health.stt)} · TTS ${JSON.stringify(health.tts)}\n`);

const ttsMs: number[] = [];
const sttMs: number[] = [];
const rtf: number[] = [];
let close = 0;
let routedRight = 0;
let routedCases = 0;
for (const [i, [text, want]] of SAMPLES.entries()) {
  let t = performance.now();
  const { audio, mime } = await voice.synth(text);
  ttsMs.push(performance.now() - t);
  t = performance.now();
  const res = await fetch(`${cfg.voice.url}/stt`, { method: 'POST', headers: { 'content-type': mime }, body: audio });
  const stt = (await res.json()) as { text: string; ms: number; audioMs: number };
  sttMs.push(performance.now() - t);
  rtf.push(stt.ms / Math.max(1, stt.audioMs));
  const acc = wordAccuracy(text, stt.text);
  if (acc >= 0.8) close++;
  const got = route(stt.text, { cabinet: { id: 'x', code: 'DM0010', name: 'Tủ demo 10' } })?.name ?? null;
  const ok = got === want;
  if (want) {
    routedCases++;
    if (ok) routedRight++;
  }
  console.log(`${String(i + 1).padStart(2)} ${acc >= 0.8 ? 'ok  ' : 'DIFF'} ${(acc * 100).toFixed(0).padStart(3)}%  stt ${stt.ms.toString().padStart(5)} ms  ${ok ? '' : `route ${got ?? '-'} (want ${want ?? '-'}) `}| ${text} -> ${stt.text}`);
}
console.log(`\nTTS one sentence   p50 ${pct(ttsMs, 50).toFixed(0)} ms  p95 ${pct(ttsMs, 95).toFixed(0)} ms`);
console.log(`STT one sentence   p50 ${pct(sttMs, 50).toFixed(0)} ms  p95 ${pct(sttMs, 95).toFixed(0)} ms  (engine time / audio length p50 ${pct(rtf, 50).toFixed(2)})`);
console.log(`transcript close   ${close}/${SAMPLES.length} (word accuracy >= 80 %; spec 9 wants >= 18/20 on real recordings)`);
console.log(`router from voice  ${routedRight}/${routedCases} data questions -> right tool`);
