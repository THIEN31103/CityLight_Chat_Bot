// "Bản tin đầu ca" said in code, not by the model (user test 2026-11-28): which texts ask for it, and the area named.
import { describe, expect, it } from 'vitest';
import { parseShiftRequest } from '../src/console/server';

describe('parseShiftRequest', () => {
  it.each([
    ['Bản tin đầu ca', {}],
    ['bản tin đầu ca.', {}],
    ['xem bản tin đầu ca quận 1', { area: 'quận 1' }],
    ['Bản tin đầu ca Phường 2', { area: 'Phường 2' }],
    ['bản tin đầu ca cho phường 2 quận 3 nhé', { area: 'phường 2 quận 3' }],
    ['giao ca TP Thủ Đức', { area: 'TP Thủ Đức' }],
    ['tóm tắt ca khu vực Quận 3', { area: 'Quận 3' }],
  ])('"%s" asks for the report', (text, want) => {
    expect(parseShiftRequest(text)).toEqual(want);
  });
  it.each(['bản tin đầu ca có gì?', 'bản tin đầu ca là gì', 'Hệ thống thế nào rồi?', 'bản tin', 'tắt đèn quận 1', 'bản tin đầu ca hôm nay của quận 1 thế nào vậy bạn ơi nhỉ'])('"%s" is not', (text) => {
    expect(parseShiftRequest(text)).toBeNull();
  });
});
