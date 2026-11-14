import { describe, expect, it } from 'vitest';
import { FILLER, Speaker, type SpokenChunk } from '../src/console/speaker';
import type { TtsAudio, TtsProvider } from '../src/voice/client';
import { SentenceSplitter, sayCabinetCode, sayTime, toSpeech } from '../src/voice/speech-text';

describe('speech text (spec 4.2)', () => {
  it.each([
    [17, 5, '5 giờ 5 phút chiều'],
    [18, 0, '6 giờ tối'],
    [6, 30, '6 giờ 30 phút sáng'],
    [12, 0, '12 giờ trưa'],
    [5, 45, '5 giờ 45 phút sáng'],
  ])('%i:%i -> %s', (h, m, said) => expect(sayTime(h, m)).toBe(said));

  it.each([
    ['DM0010', 'dê mờ 10'],
    ['TL01.0009', 'tê lờ 1, số 9'],
    ['XYZ', 'XYZ'],
  ])('cabinet %s -> %s', (code, said) => expect(sayCabinetCode(code)).toBe(said));

  it.each([
    ['Tủ DM0010 mất kết nối từ 17:05.', 'Tủ dê mờ 10 mất kết nối từ 5 giờ 5 phút chiều.'],
    ['Mã E201 là mất PLC.', 'Mã E hai không một là mất pê lờ xê.'],
    ['Điện áp 229.5 V, dòng 12,3 A, rò 30 mA.', 'Điện áp 229 phẩy 5 vôn, dòng 12 phẩy 3 am pe, rò 30 mi li am pe.'],
    ['Công suất 1.2 kW, online 98%.', 'Công suất 1 phẩy 2 ki lô oát, trực tuyến 98 phần trăm.'],
    ['Lịch 18:00 – 05:45 từ 14/11/2026.', 'Lịch 6 giờ tối – 5 giờ 45 phút sáng từ ngày 14 tháng 11 năm 2026.'],
    ['Xem https://x.vn/a và id 6b3f8f3e-2a51-4c1e-9d7a-6a1f6f1b2c10 **ngay** 😊', 'Xem và id ngay'],
    ['PLGO=3: cáp mạng.', 'pê lờ giê o bằng 3: cáp mạng.'],
    // the words the user heard read wrong (2026-11-14)
    ['491 tủ đang offline, không nhận được dữ liệu telemetry.', '491 tủ đang mất kết nối, không nhận được dữ liệu đo.'],
    ['Kiểm tra cáp ETH và module LOGO, firmware cũ.', 'Kiểm tra cáp e tê hát và mô đun lô gô, phần mềm thiết bị cũ.'],
    ['Jarvis thấy GPS lệch, sóng 4G yếu.', 'gia vít thấy giê pê ét lệch, sóng bốn giê yếu.'],
  ])('%s', (text, said) => expect(toSpeech(text)).toBe(said));
});

describe('sentence splitter', () => {
  it('gives each sentence as soon as it ends, keeps numbers and codes whole', () => {
    const s = new SentenceSplitter();
    expect(s.push('Tủ TL01.0009 đang ')).toEqual([]);
    expect(s.push('tắt, dòng 12.5 A. Không có')).toEqual(['Tủ TL01.0009 đang tắt, dòng 12.5 A.']);
    expect(s.push(' cảnh báo! Lịch')).toEqual(['Không có cảnh báo!']);
    expect(s.flush()).toEqual(['Lịch']);
    expect(s.flush()).toEqual([]);
  });

  it('a long first sentence is spoken from its first clause; later clauses only when long; decimals never cut', () => {
    const s = new SentenceSplitter();
    expect(s.push('Hệ thống có 510 tủ, trong đó 19 tủ')).toEqual(['Hệ thống có 510 tủ,']);
    expect(s.push(' đang hoạt động, 491 tủ')).toEqual([]);
    expect(s.push(' mất kết nối. Có 12,5 kW')).toEqual(['trong đó 19 tủ đang hoạt động, 491 tủ mất kết nối.']);
    expect(s.flush()).toEqual(['Có 12,5 kW']);
  });
});

/** TTS that answers instantly (or after `delay` ms) with the text as bytes */
class FakeTts implements TtsProvider {
  calls: string[] = [];
  constructor(private readonly delay: (text: string) => number = () => 0) {}
  async synth(text: string): Promise<TtsAudio> {
    this.calls.push(text);
    await new Promise((r) => setTimeout(r, this.delay(text)));
    return { audio: new TextEncoder().encode(text), mime: 'audio/wav' };
  }
}

const said = (chunks: SpokenChunk[]) => chunks.map((c) => new TextDecoder().decode(c.audio));

describe('speaker', () => {
  it('speaks sentences in order even when a later one is synthesized first', async () => {
    const tts = new FakeTts((t) => (t.startsWith('Một') ? 40 : 0));
    const out: SpokenChunk[] = [];
    const sp = new Speaker(tts, false, (c) => out.push(c), new AbortController().signal);
    sp.text('Một hai ba. Bốn năm sáu. ');
    sp.text('Bảy');
    await sp.end();
    expect(said(out)).toEqual(['Một hai ba.', 'Bốn năm sáu.', 'Bảy']);
    expect(out.map((c) => c.seq)).toEqual([1, 2, 3]);
    expect(sp.firstAudioMs).not.toBeNull();
  });

  it('a data question: nothing is said before a tool ran; a dropped draft is never heard; the filler covers the wait', async () => {
    const tts = new FakeTts();
    const out: SpokenChunk[] = [];
    const filler = async () => ({ audio: new TextEncoder().encode(FILLER), mime: 'audio/wav' });
    const sp = new Speaker(tts, true, (c) => out.push(c), new AbortController().signal, filler);
    sp.text('Hệ thống có 156 tủ. ');
    sp.reset();
    sp.tool();
    sp.text('Hệ thống có 510 tủ. ');
    await sp.end();
    expect(said(out)).toEqual([FILLER, 'Hệ thống có 510 tủ.']);
    expect(tts.calls.join(' ')).not.toContain('156');
  });

  it('text written before the tool call is said instead of the filler', async () => {
    const out: SpokenChunk[] = [];
    const sp = new Speaker(new FakeTts(), true, (c) => out.push(c), new AbortController().signal, async () => ({ audio: new Uint8Array([1]), mime: 'x' }));
    sp.text('Để tôi xem tủ đó. ');
    sp.tool();
    await sp.end();
    expect(said(out)).toEqual(['Để tôi xem tủ đó.']);
  });

  it('stops sending once aborted (barge-in)', async () => {
    const ac = new AbortController();
    const out: SpokenChunk[] = [];
    const sp = new Speaker(new FakeTts(() => 20), false, (c) => out.push(c), ac.signal);
    sp.text('Câu một. Câu hai. ');
    ac.abort();
    sp.stop();
    await sp.end();
    expect(out).toEqual([]);
  });

  it('a TTS failure is recorded, the other sentences still go out', async () => {
    const tts: TtsProvider = { synth: async (t) => (t.includes('hỏng') ? Promise.reject(new Error('tts down')) : { audio: new Uint8Array([1]), mime: 'audio/wav' }) };
    const out: SpokenChunk[] = [];
    const sp = new Speaker(tts, false, (c) => out.push(c), new AbortController().signal);
    sp.text('Câu hỏng. Câu tốt. ');
    await sp.end();
    expect(out).toHaveLength(1);
    expect(sp.errors).toEqual(['tts down']);
  });
});
