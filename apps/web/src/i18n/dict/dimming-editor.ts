// Dimming profile editor (components/DimmingEditor.tsx), used by the cabinet Dimming tab and the Dimming page.
import { defineDict } from '@citylight/shared';

export const DIMMING_EDITOR = defineDict(
  {
    segment: (i: number) => `Thời đoạn ${i}`,
    start: 'Bắt đầu {time}',
    end: 'Kết thúc {time}',
    startAria: (i: number) => `Bắt đầu thời đoạn ${i}`,
    endAria: (i: number) => `Kết thúc thời đoạn ${i}`,
    levelAria: (i: number) => `Mức năng lượng thời đoạn ${i}`,
    preview: 'Xem trước mức sáng trong đêm',
    saving: 'Tiết kiệm ước tính:',
    noLamps: 'Chưa có dữ liệu đèn nhóm này (nhập trụ / đèn ở Bản đồ) — chưa ước tính được kWh',
    /** count = number of lamps, n = the same number formatted */
    lamps: (_count: number, n: string) => `${n} đèn`,
    kwhPerNight: '{v} kWh/đêm',
    kwhPerYear: '{v} kWh/năm',
    moneyPerYear: '{v} đ/năm',
    price: '(giá {v} đ/kWh)',
    lampsWithoutPower: (_count: number, n: string) => `${n} đèn chưa có công suất`,
  },
  {
    segment: (i: number) => `Segment ${i}`,
    start: 'Start {time}',
    end: 'End {time}',
    startAria: (i: number) => `Segment ${i} start`,
    endAria: (i: number) => `Segment ${i} end`,
    levelAria: (i: number) => `Segment ${i} power level`,
    preview: 'Preview of the light level through the night',
    saving: 'Estimated saving:',
    noLamps: 'No lamp data for this group (enter poles / lamps on the Map) — kWh cannot be estimated yet',
    lamps: (count: number, n: string) => `${n} ${count === 1 ? 'lamp' : 'lamps'}`,
    kwhPerNight: '{v} kWh/night',
    kwhPerYear: '{v} kWh/year',
    moneyPerYear: '{v} VND/year',
    price: '(price {v} VND/kWh)',
    lampsWithoutPower: (count: number, n: string) => `${n} ${count === 1 ? 'lamp' : 'lamps'} without rated power`,
  },
);
