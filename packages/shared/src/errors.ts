// Device error catalog: every alarm the server raises maps to one code with cause + field checks.
// Sources are what the LTE firmware actually reports (dev_key_uid_dgb):
//   LCLI 0 ok / 1 PLC lost / 2 PM lost / 3 CT lost / 4 all three / X other combination
//   MCON / PCON slave liveness, CTTE=1000 DS18B20 fault, PTIM (LOGO RTC, minute resolution),
//   stm32/ec25/boot frame, LDIA RS485 self-test report "A?D?B?C?", LED PC6 patterns.
// LERR is declared in firmware but never set (always 0) and LACI is always X, so the server
// derives faults from the fields above instead.

import type { AlarmSeverity, AlarmType } from './domain';
import type { Lang } from './i18n';

export type ErrorCategory = 'Kết nối' | 'RS485' | 'PLC / LOGO' | 'Điện năng' | 'Cảm biến' | 'Tải đèn' | 'Lệnh' | 'Thiết bị';

export interface ErrorDef {
  code: string;
  type: AlarmType;
  title: string;
  category: ErrorCategory;
  severity: AlarmSeverity;
  /** Telemetry evidence the rule looks at. */
  source: string;
  cause: string;
  checks: string[];
  /** false = needs a firmware change before it can fire. */
  supported: boolean;
}

export const ERROR_CATALOG: ErrorDef[] = [
  // ---------- Kết nối ----------
  {
    code: 'E101', type: 'offline', title: 'Mất kết nối tủ', category: 'Kết nối', severity: 'critical',
    source: 'Không nhận frame telemetry > 60 s',
    cause: 'Tủ mất nguồn, mất sóng 4G / SIM, LTE treo hoặc không nối được broker.',
    checks: [
      'Xem LED PC6 trên board LTE: nháy 4 Hz 3 s rồi tắt = lỗi SIM; nháy 0,2 Hz = có 4G nhưng chưa nối broker; nháy 1 Hz = bình thường.',
      'Kiểm tra nguồn tủ và aptomat cấp cho bộ điều khiển.',
      'Kiểm tra SIM (còn tiền / data, APN v-internet), anten 4G.',
    ],
    supported: true,
  },
  {
    code: 'E102', type: 'reboot', title: 'Bộ điều khiển khởi động lại', category: 'Kết nối', severity: 'minor',
    source: 'Frame stm32/ec25/boot',
    cause: 'LTE vừa khởi động: mất nguồn ngắn, watchdog hoặc reset tay.',
    checks: ['Nếu lặp lại nhiều lần trong ngày: kiểm tra nguồn 12/24 V cấp cho bộ điều khiển và sụt áp khi đóng contactor.'],
    supported: true,
  },
  {
    code: 'E103', type: 'flapping', title: 'Kết nối chập chờn', category: 'Kết nối', severity: 'major',
    source: '≥ 3 lần mất / có lại kết nối trong 1 giờ',
    cause: 'Sóng 4G yếu, anten lỏng, hoặc nguồn không ổn định.',
    checks: ['Kiểm tra vị trí và đầu nối anten 4G.', 'Đối chiếu với các lần khởi động lại (E102).'],
    supported: true,
  },
  // ---------- RS485 ----------
  {
    code: 'E201', type: 'plc_lost', title: 'Mất kết nối PLC_KEY', category: 'RS485', severity: 'critical',
    source: 'LCLI=1 / PCON=0',
    cause: 'LTE không đọc được PLC_KEY (slave id 4) trên RS485. Không biết trạng thái nhánh, không gửi được lệnh.',
    checks: ['Kiểm tra nguồn và LED của board PLC_KEY.', 'Kiểm tra dây A/B RS485 tới PLC_KEY và đầu cuối 120 Ω.', 'PLC_KEY chưa active key sẽ không trả lời.'],
    supported: true,
  },
  {
    code: 'E202', type: 'pm_lost', title: 'Mất kết nối PM_KEY', category: 'RS485', severity: 'major',
    source: 'LCLI=2 / MCON=0',
    cause: 'LTE không đọc được PM_KEY (slave id 3). Không có số liệu điện năng.',
    checks: ['Kiểm tra nguồn và LED của board PM_KEY.', 'Kiểm tra dây RS485 tới PM_KEY.'],
    supported: true,
  },
  {
    code: 'E203', type: 'ct_lost', title: 'Mất kết nối CT_KEY', category: 'RS485', severity: 'major',
    source: 'LCLI=3',
    cause: 'LTE không đọc được CT_KEY (slave id 2). Không có dòng rò và nhiệt độ tủ.',
    checks: ['Kiểm tra nguồn và LED của board CT_KEY.', 'Kiểm tra dây RS485 tới CT_KEY.'],
    supported: true,
  },
  {
    code: 'E204', type: 'bus_down', title: 'Mất cả 3 slave RS485', category: 'RS485', severity: 'critical',
    source: 'LCLI=4',
    cause: 'Cả PLC, PM, CT cùng không trả lời: nhiều khả năng lỗi bus RS485 phía LTE (transceiver, dây A/B đảo, chập) hoặc mất nguồn chung cho các board slave.',
    checks: ['Chạy "Tự kiểm tra RS485" (lệnh LDIA) và xem kết quả RX/DE/TX.', 'Kiểm tra nguồn chung của các board slave.', 'Kiểm tra dây A/B có bị đảo hoặc chập.'],
    supported: true,
  },
  {
    code: 'E205', type: 'multi_slave_lost', title: 'Mất 2 slave RS485', category: 'RS485', severity: 'major',
    source: 'LCLI=X',
    cause: 'Hai trong ba board (PLC / PM / CT) không trả lời — thường do một đoạn dây RS485 hoặc nguồn chung bị hở.',
    checks: ['Xem MCON / PCON để biết board nào còn trả lời.', 'Kiểm tra đoạn dây RS485 nối tiếp giữa các board.'],
    supported: true,
  },
  {
    code: 'E206', type: 'rs485_selftest_fail', title: 'Tự kiểm tra RS485 báo lỗi', category: 'RS485', severity: 'major',
    source: 'Báo cáo LDIA (A?D?B?C?)',
    cause: 'Transceiver RS485 trên board LTE có vấn đề: RX không được lái, DE kẹt mức cao, hoặc bus bị kéo thấp.',
    checks: [
      'RO=0 lúc rảnh: A/B chập hoặc đảo, thiếu điện trở phân cực, hoặc IC thu hỏng.',
      'RO=Z: IC thu chết, RE kẹt mức cao hoặc đường PB11 hở.',
      'B1C1 (bus luôn 1 khi phát): chưa kết luận được — kiểm bằng LED slave hoặc đồng hồ đo.',
    ],
    supported: true,
  },
  // ---------- PLC / LOGO ----------
  {
    code: 'E301', type: 'logo_lost', title: 'Mất kết nối LOGO (qua module ETH)', category: 'PLC / LOGO', severity: 'critical',
    source: 'PCON=1 nhưng PTIM không đổi > 5 phút',
    cause: 'PLC_KEY vẫn trả lời nhưng không đọc được LOGO: module Ethernet EBT3001 kẹt / mất cấu hình, cáp mạng, hoặc LOGO mất nguồn. Trạng thái nhánh (LQ2/LQ3) đang là giá trị cũ.',
    checks: ['Xem LED PB5 trên PLC_KEY: tắt = chưa xác nhận được ETH / LOGO.', 'Kiểm tra cáp mạng ETH ↔ LOGO và nguồn LOGO.', 'Reset PLC_KEY để chạy lại cấu hình ETH (tự thử lại tối đa 5 lần).'],
    supported: true,
  },
  {
    code: 'E302', type: 'clock_drift', title: 'Sai giờ LOGO', category: 'PLC / LOGO', severity: 'minor',
    source: '|PTIM − giờ máy chủ| > 5 phút',
    cause: 'Đồng hồ LOGO lệch; lịch bật/tắt sẽ chạy sai giờ.',
    checks: ['Bấm "Đồng bộ thời gian với máy chủ" (lệnh LTIM).', 'Nếu lặp lại: kiểm tra pin RTC của LOGO.'],
    supported: true,
  },
  {
    code: 'E303', type: 'schedule_mismatch', title: 'Đèn lệch lịch', category: 'PLC / LOGO', severity: 'major',
    source: 'LQ2/LQ3 khác lịch đã gửi > 10 phút (bỏ qua khi PMAN=1)',
    cause: 'Đèn sáng ngoài giờ hoặc tắt trong giờ: lịch trong LOGO khác lịch máy chủ, LOGO sai giờ, hoặc contactor không đóng.',
    checks: ['Gửi lại lịch cho tủ.', 'Kiểm tra giờ LOGO (E302).', 'Kiểm tra contactor và cầu chì nhánh.'],
    supported: true,
  },
  {
    code: 'E304', type: 'contactor_fault', title: 'Lỗi contactor', category: 'PLC / LOGO', severity: 'critical',
    source: 'PFLT=1 (LOGO V0.6)',
    cause: 'LOGO báo contactor không phản hồi đúng.',
    checks: ['Kiểm tra cuộn hút và tiếp điểm phụ của contactor.'],
    supported: false,
  },
  {
    code: 'E305', type: 'door_open', title: 'Mở cửa tủ', category: 'PLC / LOGO', severity: 'major',
    source: 'PDOR=1 (LOGO I4)',
    cause: 'Cửa tủ đang mở.',
    checks: ['Xác nhận có đội đang làm việc tại tủ; nếu không: nghi phá hoại.'],
    supported: false,
  },
  // ---------- Điện năng ----------
  {
    code: 'E401', type: 'dh_meter_lost', title: 'Đồng hồ điện DH không trả lời', category: 'Điện năng', severity: 'major',
    source: 'MCON=1 nhưng U/I/P đều = 0',
    cause: 'PM_KEY vẫn trả lời nhưng đọc đồng hồ DH thất bại (PM_KEY xóa số liệu về 0), hoặc mất điện lưới toàn tủ.',
    checks: ['Kiểm tra nguồn và dây RS485 giữa PM_KEY và đồng hồ DH (slave id 1, 9600).', 'Kiểm tra điện lưới đầu vào tủ.'],
    supported: true,
  },
  {
    code: 'E402', type: 'phase_loss', title: 'Mất pha', category: 'Điện năng', severity: 'critical',
    source: 'Một pha U < 50 V, pha khác bình thường',
    cause: 'Mất một pha điện lưới hoặc đứt cầu chì / aptomat pha đó.',
    checks: ['Đo điện áp đầu vào từng pha.', 'Kiểm tra cầu chì và aptomat tổng.'],
    supported: true,
  },
  { code: 'E403', type: 'over_voltage', title: 'Quá áp', category: 'Điện năng', severity: 'major', source: 'U pha > ngưỡng cao (debounce 30 s)', cause: 'Điện áp lưới cao, giảm tuổi thọ đèn.', checks: ['Báo điện lực khu vực nếu kéo dài.'], supported: true },
  { code: 'E404', type: 'under_voltage', title: 'Thấp áp', category: 'Điện năng', severity: 'major', source: 'U pha < ngưỡng thấp (debounce 30 s)', cause: 'Điện áp lưới thấp, đèn có thể không khởi động.', checks: ['Báo điện lực khu vực nếu kéo dài.'], supported: true },
  { code: 'E405', type: 'phase_unbalance', title: 'Lệch pha', category: 'Điện năng', severity: 'minor', source: 'Chênh lệch dòng giữa các pha > 30 %', cause: 'Phân bổ tải không đều hoặc một phần đèn trên một pha bị hỏng.', checks: ['Kiểm tra số đèn sáng trên từng pha.'], supported: true },
  { code: 'E406', type: 'low_pf', title: 'Hệ số công suất thấp', category: 'Điện năng', severity: 'minor', source: 'cosφ tổng < 0,85 khi đèn sáng', cause: 'Bộ nguồn / chấn lưu đèn xuống cấp.', checks: ['Kiểm tra bộ nguồn đèn trên tuyến.'], supported: true },
  { code: 'E407', type: 'voltage_swing', title: 'Điện áp dao động', category: 'Điện năng', severity: 'minor', source: 'Biên độ U pha trong 5 phút > ngưỡng dao động', cause: 'Lưới điện chập chờn hoặc tiếp xúc kém ở đầu cáp nguồn.', checks: ['Kiểm tra đầu cốt cáp nguồn vào tủ.', 'Báo điện lực khu vực nếu kéo dài.'], supported: true },
  // ---------- Cảm biến ----------
  { code: 'E501', type: 'leak_current', title: 'Rò dòng', category: 'Cảm biến', severity: 'critical', source: 'CTVL > ngưỡng mA', cause: 'Rò điện xuống đất trên tuyến — nguy cơ điện giật.', checks: ['Cô lập từng nhánh để khoanh vùng.', 'Kiểm tra cáp ngầm, hộp nối, cột đèn bị ngập nước.'], supported: true },
  { code: 'E502', type: 'over_temp', title: 'Nhiệt độ tủ cao', category: 'Cảm biến', severity: 'minor', source: 'CTTE > ngưỡng °C', cause: 'Tủ nóng: thông gió kém hoặc thiết bị phát nhiệt bất thường.', checks: ['Kiểm tra quạt / khe thông gió.', 'Kiểm tra đầu cốt contactor có bị nóng.'], supported: true },
  { code: 'E503', type: 'temp_sensor_fault', title: 'Lỗi cảm biến nhiệt DS18B20', category: 'Cảm biến', severity: 'minor', source: 'CTTE=1000', cause: 'CT_KEY không đọc được DS18B20 (đứt dây OneWire PB6 hoặc cảm biến hỏng).', checks: ['Kiểm tra dây cảm biến nhiệt tới CT_KEY.'], supported: true },
  // ---------- Tải đèn ----------
  { code: 'E601', type: 'no_load', title: 'Không tải', category: 'Tải đèn', severity: 'major', source: 'Nhánh đang sáng nhưng dòng < ngưỡng không tải', cause: 'Cháy nhiều bóng, đứt / mất cắp cáp, hoặc contactor không đóng.', checks: ['Kiểm tra thực tế đèn trên tuyến.', 'Kiểm tra cáp và contactor nhánh.'], supported: true },
  { code: 'E602', type: 'over_current', title: 'Quá dòng', category: 'Tải đèn', severity: 'major', source: 'I pha > ngưỡng cao', cause: 'Chập trên tuyến hoặc đấu thêm tải trái phép.', checks: ['Kiểm tra tuyến cáp và các điểm đấu nối.'], supported: true },
  { code: 'E603', type: 'current_swing', title: 'Dòng điện dao động', category: 'Tải đèn', severity: 'minor', source: 'Biên độ I pha trong 5 phút > ngưỡng dao động, khi trạng thái nhánh không đổi', cause: 'Đèn chập chờn, bộ nguồn hỏng hoặc tiếp xúc kém trên tuyến.', checks: ['Kiểm tra đèn nhấp nháy trên tuyến.', 'Kiểm tra hộp nối, đầu cốt.'], supported: true },
  // ---------- Lệnh ----------
  { code: 'E701', type: 'cmd_rejected', title: 'Lệnh bị từ chối', category: 'Lệnh', severity: 'minor', source: 'Ack rc=-1 (ghi Modbus xuống PLC_KEY lỗi) hoặc rc=-2 (thiết bị không hỗ trợ)', cause: 'Lệnh không ghi được xuống PLC_KEY hoặc firmware không hỗ trợ key.', checks: ['Xem trạng thái PLC_KEY (E201).', 'Kiểm tra phiên bản firmware tủ.'], supported: true },
  { code: 'E702', type: 'cmd_unconfirmed', title: 'Lệnh không có tác dụng', category: 'Lệnh', severity: 'major', source: 'Ack rc=0 nhưng LQ2/LQ3/PMAN không đổi trong 60 s', cause: 'PLC_KEY đã nhận nhưng LOGO không thực hiện: mất kết nối LOGO, chương trình LOGO khác bản v17c, hoặc contactor hỏng.', checks: ['Kiểm tra E301 (mất LOGO).', 'Xác nhận LOGO chạy chương trình _v2_thucong_v17c.'], supported: true },
  { code: 'E703', type: 'cmd_timeout', title: 'Lệnh quá thời gian', category: 'Lệnh', severity: 'minor', source: 'Không nhận ack trong 30 s', cause: 'Tủ không nhận được lệnh (mất 4G lúc gửi, QoS 0) hoặc LTE bận.', checks: ['Gửi lại lệnh khi tủ online.'], supported: true },
  // ---------- Thiết bị ----------
  { code: 'E801', type: 'gps_nofix', title: 'Chưa có định vị GPS', category: 'Thiết bị', severity: 'minor', source: 'LGPS=X > 10 phút sau khởi động', cause: 'Anten GNSS hỏng / che khuất.', checks: ['Kiểm tra anten GPS của module EC25.'], supported: true },
  { code: 'E802', type: 'gps_drift', title: 'Lệch vị trí GPS', category: 'Thiết bị', severity: 'minor', source: 'GPS thiết bị cách vị trí khai báo > 200 m', cause: 'Tọa độ khai báo sai hoặc bộ điều khiển bị lắp sang tủ khác.', checks: ['Đối chiếu vị trí thực tế, cập nhật tọa độ tủ.'], supported: true },
  { code: 'E803', type: 'battery_low', title: 'Pin dự phòng yếu', category: 'Thiết bị', severity: 'minor', source: 'LBAT < ngưỡng mV', cause: 'Pin dự phòng của bộ điều khiển xuống cấp.', checks: ['Thay pin dự phòng.'], supported: true },
  { code: 'E804', type: 'fw_unsafe', title: 'Firmware cũ không lọc LTID', category: 'Thiết bị', severity: 'major', source: 'fw_profile = v2-1307ebc', cause: 'Firmware cũ thực thi mọi lệnh trên topic chung — web chặn điều khiển tủ này.', checks: ['Nâng cấp firmware LTE lên bản có lọc LTID.'], supported: true },
  { code: 'E805', type: 'spoof_suspect', title: 'Nghi giả mạo tủ (IMEI không khớp)', category: 'Thiết bị', severity: 'major', source: 'Frame mang LTID của tủ nhưng IMEI (LIME) khác IMEI đã ghi nhận; frame bị bỏ qua', cause: 'Ai đó gửi dữ liệu giả lên broker bằng LTID của tủ, hoặc modem EC25 của tủ vừa được thay.', checks: ['Nếu vừa thay modem: Chấp nhận IMEI mới trong cảnh báo (hoặc Học lại IMEI).', 'Nếu không thay gì: dữ liệu giả, giữ nguyên IMEI; xem IP/thời điểm trong frame thô và báo người quản trị hệ thống.'], supported: true },
];

export const ERROR_CATEGORY_LABELS: Record<Lang, Record<ErrorCategory, string>> = {
  vi: { 'Kết nối': 'Kết nối', RS485: 'RS485', 'PLC / LOGO': 'PLC / LOGO', 'Điện năng': 'Điện năng', 'Cảm biến': 'Cảm biến', 'Tải đèn': 'Tải đèn', Lệnh: 'Lệnh', 'Thiết bị': 'Thiết bị' },
  en: { 'Kết nối': 'Connection', RS485: 'RS485', 'PLC / LOGO': 'PLC / LOGO', 'Điện năng': 'Power', 'Cảm biến': 'Sensors', 'Tải đèn': 'Lamp load', Lệnh: 'Commands', 'Thiết bị': 'Device' },
};

/** English text of each catalog entry (S49), by code. */
export const ERROR_CATALOG_EN: Partial<Record<string, Pick<ErrorDef, 'title' | 'source' | 'cause' | 'checks'>>> = {};

/** The catalog in one language (codes, types, severities and categories are the same; category label: ERROR_CATEGORY_LABELS). */
export function errorCatalog(lang: Lang): ErrorDef[] {
  return lang === 'vi' ? ERROR_CATALOG : ERROR_CATALOG.map((e) => ({ ...e, ...ERROR_CATALOG_EN[e.code] }));
}

export const ERROR_BY_TYPE: Partial<Record<AlarmType, ErrorDef>> = Object.fromEntries(ERROR_CATALOG.map((e) => [e.type, e]));

export function errorOf(type: AlarmType): ErrorDef | undefined {
  return ERROR_BY_TYPE[type];
}

/** Decode the LDIA RS485 self-test summary "A?D?B?C?" (same verdicts as BOARD_LTE_KEY/Mylib/Master_modbus.c). */
export function decodeRs485SelfTest(summary: string): { rx: string; de: string; tx: string; fail: boolean } {
  const m = /^A(.)D(.)B(.)C(.)$/.exec(summary);
  if (!m) return { rx: 'Không đọc được báo cáo', de: '—', tx: '—', fail: true };
  const [, a, d, b, c] = m as unknown as [string, string, string, string, string];
  let fail = false;
  let rx: string;
  if (a === '1') rx = 'OK — RO được lái, bus rảnh mức cao';
  else if (a === '0') ((rx = 'LỖI — RO mức thấp lúc rảnh (A/B chập hoặc đảo, thiếu phân cực, IC thu hỏng)'), (fail = true));
  else if (a === 'Z') ((rx = 'LỖI — RO không được lái (IC thu chết, RE kẹt cao, PB11 hở)'), (fail = true));
  else ((rx = 'LỖI — RO không ổn định (nhiễu hoặc IC hỏng)'), (fail = true));
  let de: string;
  if (a !== '1' && a !== '0') de = 'Không kiểm được (phía RX lỗi)';
  else if (d === a) de = 'OK — driver tắt khi DE=0';
  else ((de = 'LỖI — bus theo DI khi DE=0 (DE kẹt cao)'), (fail = true));
  let tx: string;
  if (b === '1' && c === '0') tx = 'OK — echo qua chip, driver và receiver đều chạy';
  else if (b === 'Z' && c === 'Z') tx = 'Không kiểm được (RE nối DE) — xem LED RS485 của slave';
  else if (b === '1' && c === '1') ((tx = 'Chưa kết luận — RO luôn 1 khi DE=1 (driver không kéo thấp, hoặc RE nối DE + pull-up). Kiểm bằng LED slave / đồng hồ'), (fail = true));
  else if (b === '0' && c === '0') ((tx = 'LỖI — bus kẹt thấp khi phát (DI/PB10 không tới chip hoặc driver hỏng)'), (fail = true));
  else ((tx = 'LỖI / không rõ — echo bất thường'), (fail = true));
  return { rx, de, tx, fail };
}
