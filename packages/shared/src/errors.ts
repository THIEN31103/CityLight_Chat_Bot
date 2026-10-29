// Device error catalog: every alarm the server raises maps to one code with cause + field checks.
// Sources are what the LTE firmware actually reports (dev_key_uid_dgb):
//   LCLI 0 ok / 1 PLC lost / 2 PM lost / 3 CT lost / 4 all three / X other combination
//   MCON / PCON slave liveness, CTTE=1000 DS18B20 fault, PTIM (LOGO RTC, minute resolution),
//   stm32/ec25/boot frame, LDIA RS485 self-test report "A?D?B?C?", LED PC6 patterns.
// LERR is declared in firmware but never set (always 0) and LACI is always X, so the server
// derives faults from the fields above instead.

import type { AlarmSeverity, AlarmType } from './domain';
import { defineDict, type Lang } from './i18n';

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
    source: 'PCON=1 và PLGO=2..5, hoặc PTIM=X > 15 s, hoặc phút PTIM không đổi > 150 s',
    cause: 'PLC_KEY vẫn trả lời nhưng không đọc được LOGO. Firmware có LOGO_DIAG hỏi module ETH và báo chỗ hỏng qua PLGO: 2 = ETH im (UART PLC_KEY ↔ ETH / module), 3 = ETH sống nhưng mất TCP (cáp mạng, nguồn LOGO, IP), 4 = có TCP nhưng LOGO không trả Modbus, 5 = ETH sai cấu hình. Trạng thái nhánh (LQ2/LQ3) không còn tin được.',
    checks: ['Xem LED PB5 trên PLC_KEY: sáng = LOGO trả lời, chớp 1 Hz = ETH sống nhưng LOGO không trả lời, tắt = ETH không trả lời.', 'PLGO=2: kiểm tra dây UART và nguồn module ETH. PLGO=3: cáp mạng ETH ↔ LOGO, nguồn LOGO. PLGO=4: chương trình / cài đặt Modbus của LOGO.', 'Reset PLC_KEY để chạy lại cấu hình ETH (tự thử lại tối đa 5 lần).'],
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
  { code: 'E805', type: 'spoof_suspect', title: 'Nghi giả mạo tủ (IMEI không khớp)', category: 'Thiết bị', severity: 'major', source: 'Frame mang LTID của tủ nhưng IMEI (LIME) khác IMEI đã ghi nhận; frame bị bỏ qua. Tủ ký lệnh: cả UID board (LUID) khác UID đã ghi nhận', cause: 'Ai đó gửi dữ liệu giả lên broker bằng LTID của tủ, hoặc modem EC25 / board LTE của tủ vừa được thay.', checks: ['Nếu vừa thay modem / board LTE: Chấp nhận IMEI mới (và UID mới nếu có) trong cảnh báo (hoặc Học lại IMEI).', 'Nếu không thay gì: dữ liệu giả, giữ nguyên IMEI; xem IP/thời điểm trong frame thô và báo người quản trị hệ thống.'], supported: true },
  { code: 'E806', type: 'sig_invalid', title: 'Chữ ký định danh không hợp lệ', category: 'Thiết bị', severity: 'major', source: 'Bộ định danh LUID/LSEQ/LSIG trong telemetry ký sai (khóa ký D7-lite)', cause: 'Ai đó gửi bộ định danh giả lên broker, hoặc firmware tủ được build với khóa master khác khóa của server.', checks: ['Đối chiếu dấu vân tay khóa (LKFP) trên UART2 SHOW với trang tủ.', 'Nếu tủ thật ký sai: nạp lại firmware build đúng khóa của khách này.', 'Nếu không: dữ liệu giả, báo người quản trị hệ thống.'], supported: true },
];

export const ERROR_CATEGORY_LABELS: Record<Lang, Record<ErrorCategory, string>> = {
  vi: { 'Kết nối': 'Kết nối', RS485: 'RS485', 'PLC / LOGO': 'PLC / LOGO', 'Điện năng': 'Điện năng', 'Cảm biến': 'Cảm biến', 'Tải đèn': 'Tải đèn', Lệnh: 'Lệnh', 'Thiết bị': 'Thiết bị' },
  en: { 'Kết nối': 'Connection', RS485: 'RS485', 'PLC / LOGO': 'PLC / LOGO', 'Điện năng': 'Power', 'Cảm biến': 'Sensors', 'Tải đèn': 'Lamp load', Lệnh: 'Commands', 'Thiết bị': 'Device' },
};

type ErrorText = Pick<ErrorDef, 'title' | 'source' | 'cause' | 'checks'>;

/** English text of each catalog entry (S49), by code. A test checks that every ERROR_CATALOG code is here. */
export const ERROR_CATALOG_EN: Partial<Record<string, ErrorText>> = {
  // ---------- Connection ----------
  E101: {
    title: 'Cabinet offline',
    source: 'No telemetry frame for > 60 s',
    cause: 'The cabinet has no power, no 4G signal / SIM problem, the LTE board hung, or it cannot reach the broker.',
    checks: [
      'Look at LED PC6 on the LTE board: 4 Hz blinking for 3 s then off = SIM fault; 0.2 Hz = 4G up but not connected to the broker; 1 Hz = normal.',
      'Check the cabinet power supply and the circuit breaker feeding the controller.',
      'Check the SIM (credit / data left, APN v-internet) and the 4G antenna.',
    ],
  },
  E102: {
    title: 'Controller restarted',
    source: 'stm32/ec25/boot frame',
    cause: 'The LTE board just started: short power loss, watchdog or manual reset.',
    checks: ['If it happens several times a day: check the 12/24 V supply of the controller and voltage dips when the contactor closes.'],
  },
  E103: {
    title: 'Unstable connection',
    source: '≥ 3 connection drops / recoveries within 1 hour',
    cause: 'Weak 4G signal, loose antenna, or unstable power supply.',
    checks: ['Check the 4G antenna position and connector.', 'Compare with the controller restarts (E102).'],
  },
  // ---------- RS485 ----------
  E201: {
    title: 'PLC_KEY not responding',
    source: 'LCLI=1 / PCON=0',
    cause: 'The LTE board cannot read PLC_KEY (slave id 4) on RS485. Branch states are unknown and commands cannot be sent.',
    checks: ['Check the power supply and LEDs of the PLC_KEY board.', 'Check the RS485 A/B wires to PLC_KEY and the 120 Ω termination.', 'A PLC_KEY without an activated key does not respond.'],
  },
  E202: {
    title: 'PM_KEY not responding',
    source: 'LCLI=2 / MCON=0',
    cause: 'The LTE board cannot read PM_KEY (slave id 3). No power data.',
    checks: ['Check the power supply and LEDs of the PM_KEY board.', 'Check the RS485 wiring to PM_KEY.'],
  },
  E203: {
    title: 'CT_KEY not responding',
    source: 'LCLI=3',
    cause: 'The LTE board cannot read CT_KEY (slave id 2). No leakage current or cabinet temperature.',
    checks: ['Check the power supply and LEDs of the CT_KEY board.', 'Check the RS485 wiring to CT_KEY.'],
  },
  E204: {
    title: 'All 3 RS485 slaves lost',
    source: 'LCLI=4',
    cause: 'PLC, PM and CT all fail to respond: most likely an RS485 bus fault on the LTE side (transceiver, A/B swapped, short circuit) or loss of the common supply of the slave boards.',
    checks: ['Run the RS485 self-test (LDIA command) and look at the RX/DE/TX results.', 'Check the common supply of the slave boards.', 'Check whether A/B are swapped or shorted.'],
  },
  E205: {
    title: '2 RS485 slaves lost',
    source: 'LCLI=X',
    cause: 'Two of the three boards (PLC / PM / CT) do not respond — usually an open RS485 wire section or common supply.',
    checks: ['Look at MCON / PCON to see which board still responds.', 'Check the daisy-chained RS485 wiring between the boards.'],
  },
  E206: {
    title: 'RS485 self-test failed',
    source: 'LDIA report (A?D?B?C?)',
    cause: 'Fault in the RS485 transceiver of the LTE board: RX not driven, DE stuck high, or bus pulled low.',
    checks: [
      'RO=0 when idle: A/B shorted or swapped, missing bias resistors, or faulty receiver IC.',
      'RO=Z: receiver IC dead, RE stuck high, or PB11 trace open.',
      'B1C1 (bus always 1 while transmitting): inconclusive — check with the slave LEDs or a multimeter.',
    ],
  },
  // ---------- PLC / LOGO ----------
  E301: {
    title: 'LOGO not responding (via ETH module)',
    source: 'PCON=1 and PLGO=2..5, or PTIM=X for > 15 s, or the PTIM minute unchanged for > 150 s',
    cause: 'PLC_KEY still responds but cannot read the LOGO. Firmware with LOGO_DIAG asks the ETH module and reports the broken side in PLGO: 2 = ETH silent (UART PLC_KEY ↔ ETH / module), 3 = ETH alive but no TCP (network cable, LOGO power, IP), 4 = TCP up but the LOGO does not answer Modbus, 5 = ETH settings wrong. Branch states (LQ2/LQ3) can no longer be trusted.',
    checks: ['Look at LED PB5 on PLC_KEY: on = LOGO answers, 1 Hz blink = ETH alive but the LOGO does not answer, off = ETH does not answer.', 'PLGO=2: check the UART wires and the ETH module power. PLGO=3: ETH ↔ LOGO network cable, LOGO power. PLGO=4: LOGO program / Modbus settings.', 'Reset PLC_KEY to rerun the ETH configuration (it retries up to 5 times on its own).'],
  },
  E302: {
    title: 'LOGO clock wrong',
    source: '|PTIM − server time| > 5 min',
    cause: 'The LOGO clock has drifted; the on/off schedule will run at the wrong time.',
    checks: ['Press "Sync time with the server" (LTIM command).', 'If it happens again: check the LOGO RTC backup battery.'],
  },
  E303: {
    title: 'Lights not following the schedule',
    source: 'LQ2/LQ3 differ from the sent schedule for > 10 min (ignored while PMAN=1)',
    cause: 'Lights on outside the schedule or off within it: the schedule in the LOGO differs from the server schedule, the LOGO clock is wrong, or the contactor does not close.',
    checks: ['Send the schedule to the cabinet again.', 'Check the LOGO clock (E302).', 'Check the contactor and the branch fuses.'],
  },
  E304: {
    title: 'Contactor fault',
    source: 'PFLT=1 (LOGO V0.6)',
    cause: 'The LOGO reports that the contactor does not respond correctly.',
    checks: ['Check the contactor coil and auxiliary contacts.'],
  },
  E305: {
    title: 'Cabinet door open',
    source: 'PDOR=1 (LOGO I4)',
    cause: 'The cabinet door is open.',
    checks: ['Confirm a crew is working at the cabinet; if not, suspect tampering.'],
  },
  // ---------- Power ----------
  E401: {
    title: 'DH power meter not responding',
    source: 'MCON=1 but U/I/P all = 0',
    cause: 'PM_KEY still responds but reading the DH meter fails (PM_KEY clears the values to 0), or the whole cabinet lost mains power.',
    checks: ['Check the power supply and the RS485 wiring between PM_KEY and the DH meter (slave id 1, 9600).', 'Check the mains input of the cabinet.'],
  },
  E402: {
    title: 'Phase loss',
    source: 'One phase U < 50 V, the other phases normal',
    cause: 'One mains phase is missing, or the fuse / circuit breaker of that phase is blown or tripped.',
    checks: ['Measure the input voltage of each phase.', 'Check the fuses and the main circuit breaker.'],
  },
  E403: { title: 'Overvoltage', source: 'Phase U > high threshold (30 s debounce)', cause: 'High mains voltage, shortens lamp life.', checks: ['Report it to the local power utility if it persists.'] },
  E404: { title: 'Undervoltage', source: 'Phase U < low threshold (30 s debounce)', cause: 'Low mains voltage, lamps may fail to start.', checks: ['Report it to the local power utility if it persists.'] },
  E405: { title: 'Phase imbalance', source: 'Current difference between phases > 30 %', cause: 'Uneven load distribution, or some lamps on one phase have failed.', checks: ['Check how many lamps are lit on each phase.'] },
  E406: { title: 'Low power factor', source: 'Total cosφ < 0.85 while lights are on', cause: 'Lamp drivers / ballasts are degraded.', checks: ['Check the lamp drivers on the route.'] },
  E407: { title: 'Voltage fluctuation', source: 'Phase U range over 5 min > fluctuation threshold', cause: 'Unstable grid or poor contact at the supply cable terminals.', checks: ['Check the lugs of the supply cable entering the cabinet.', 'Report it to the local power utility if it persists.'] },
  // ---------- Sensors ----------
  E501: { title: 'Leakage current', source: 'CTVL > threshold mA', cause: 'Earth leakage on the route — electric shock hazard.', checks: ['Isolate the branches one at a time to locate it.', 'Check underground cables, junction boxes and flooded poles.'] },
  E502: { title: 'High cabinet temperature', source: 'CTTE > threshold °C', cause: 'The cabinet is overheating: poor ventilation or abnormal heat from equipment.', checks: ['Check the fan / ventilation slots.', 'Check whether the contactor terminals are hot.'] },
  E503: { title: 'DS18B20 temperature sensor fault', source: 'CTTE=1000', cause: 'CT_KEY cannot read the DS18B20 (broken OneWire wire on PB6 or faulty sensor).', checks: ['Check the temperature sensor wiring to CT_KEY.'] },
  // ---------- Lamp load ----------
  E601: { title: 'No load', source: 'Branch lit but current < no-load threshold', cause: 'Many lamps burnt out, cable cut / stolen, or the contactor does not close.', checks: ['Check the lamps on the route on site.', 'Check the branch cable and contactor.'] },
  E602: { title: 'Overcurrent', source: 'Phase I > high threshold', cause: 'Short circuit on the route or unauthorized extra load.', checks: ['Check the cable route and the connection points.'] },
  E603: { title: 'Current fluctuation', source: 'Phase I range over 5 min > fluctuation threshold, with branch states unchanged', cause: 'Flickering lamps, faulty drivers or poor contact on the route.', checks: ['Look for flickering lamps on the route.', 'Check junction boxes and lugs.'] },
  // ---------- Commands ----------
  E701: { title: 'Command rejected', source: 'Ack rc=-1 (Modbus write to PLC_KEY failed) or rc=-2 (not supported by the device)', cause: 'The command could not be written to PLC_KEY, or the firmware does not support the key.', checks: ['Check the PLC_KEY state (E201).', 'Check the cabinet firmware version.'] },
  E702: { title: 'Command had no effect', source: 'Ack rc=0 but LQ2/LQ3/PMAN unchanged within 60 s', cause: 'PLC_KEY received it but the LOGO did not act on it: LOGO not responding, LOGO program other than v17c, or faulty contactor.', checks: ['Check E301 (LOGO not responding).', 'Confirm the LOGO runs the _v2_thucong_v17c program.'] },
  E703: { title: 'Command timed out', source: 'No ack within 30 s', cause: 'The cabinet did not receive the command (4G lost while sending, QoS 0) or the LTE board was busy.', checks: ['Send the command again once the cabinet is online.'] },
  // ---------- Device ----------
  E801: { title: 'No GPS fix', source: 'LGPS=X for > 10 min after boot', cause: 'GNSS antenna faulty or obstructed.', checks: ['Check the GPS antenna of the EC25 module.'] },
  E802: { title: 'GPS position drift', source: 'Device GPS > 200 m from the registered position', cause: 'The registered coordinates are wrong, or the controller was fitted to another cabinet.', checks: ['Compare with the actual location and update the cabinet coordinates.'] },
  E803: { title: 'Backup battery low', source: 'LBAT < threshold mV', cause: 'The backup battery of the controller is worn.', checks: ['Replace the backup battery.'] },
  E804: { title: 'Old firmware without LTID filter', source: 'fw_profile = v2-1307ebc', cause: 'Old firmware executes every command on the shared topic — the web blocks control of this cabinet.', checks: ['Upgrade the LTE firmware to a version with the LTID filter.'] },
  E805: {
    title: 'Suspected cabinet spoofing (IMEI mismatch)',
    source: "Frame carries the cabinet's LTID but an IMEI (LIME) other than the recorded one; frame ignored. Signing cabinets: also a board UID (LUID) other than the recorded one",
    cause: "Someone is publishing fake data to the broker with the cabinet's LTID, or the cabinet's EC25 modem / LTE board was just replaced.",
    checks: [
      'If the modem / LTE board was just replaced: accept the new IMEI (and the new UID, if any) in the alarm (or relearn the IMEI).',
      'If nothing was replaced: the data is fake, keep the IMEI; look at the IP / time in the raw frame and report it to the system administrator.',
    ],
  },
  E806: {
    title: 'Invalid identity signature',
    source: 'The LUID/LSEQ/LSIG identity block in the telemetry has a wrong signature (D7-lite signing key)',
    cause: 'Someone is publishing a fake identity to the broker, or the cabinet firmware was built with a master key other than the server one.',
    checks: [
      'Compare the key fingerprint (LKFP) in UART2 SHOW with the cabinet page.',
      "If the real cabinet signs wrongly: flash firmware built with this customer's key.",
      'Otherwise: the data is fake, report it to the system administrator.',
    ],
  },
};

const catalogCache: Partial<Record<Lang, ErrorDef[]>> = { vi: ERROR_CATALOG };

/** The catalog in one language (codes, types, severities and categories are the same; category label: ERROR_CATEGORY_LABELS). */
export function errorCatalog(lang: Lang): ErrorDef[] {
  return (catalogCache[lang] ??= ERROR_CATALOG.map((e) => ({ ...e, ...ERROR_CATALOG_EN[e.code] })));
}

/** Vietnamese entries by alarm type (server side). */
export const ERROR_BY_TYPE: Partial<Record<AlarmType, ErrorDef>> = Object.fromEntries(ERROR_CATALOG.map((e) => [e.type, e]));

export function errorOf(type: AlarmType, lang: Lang = 'vi'): ErrorDef | undefined {
  return lang === 'vi' ? ERROR_BY_TYPE[type] : errorCatalog(lang).find((e) => e.type === type);
}

/** Catalog entry by code ("E201") in one language. */
export function errorByCode(code: string, lang: Lang = 'vi'): ErrorDef | undefined {
  return errorCatalog(lang).find((e) => e.code === code);
}

/** Verdict texts of the LDIA RS485 self-test. */
export const RS485_SELFTEST_TEXT = defineDict(
  {
    unreadable: 'Không đọc được báo cáo',
    rxOk: 'OK — RO được lái, bus rảnh mức cao',
    rxLow: 'LỖI — RO mức thấp lúc rảnh (A/B chập hoặc đảo, thiếu phân cực, IC thu hỏng)',
    rxZ: 'LỖI — RO không được lái (IC thu chết, RE kẹt cao, PB11 hở)',
    rxUnstable: 'LỖI — RO không ổn định (nhiễu hoặc IC hỏng)',
    deUntestable: 'Không kiểm được (phía RX lỗi)',
    deOk: 'OK — driver tắt khi DE=0',
    deStuck: 'LỖI — bus theo DI khi DE=0 (DE kẹt cao)',
    txOk: 'OK — echo qua chip, driver và receiver đều chạy',
    txUntestable: 'Không kiểm được (RE nối DE) — xem LED RS485 của slave',
    txInconclusive: 'Chưa kết luận — RO luôn 1 khi DE=1 (driver không kéo thấp, hoặc RE nối DE + pull-up). Kiểm bằng LED slave / đồng hồ',
    txStuckLow: 'LỖI — bus kẹt thấp khi phát (DI/PB10 không tới chip hoặc driver hỏng)',
    txOdd: 'LỖI / không rõ — echo bất thường',
  },
  {
    unreadable: 'Report could not be read',
    rxOk: 'OK — RO driven, bus idle high',
    rxLow: 'FAIL — RO low when idle (A/B shorted or swapped, missing bias, faulty receiver IC)',
    rxZ: 'FAIL — RO not driven (receiver IC dead, RE stuck high, PB11 open)',
    rxUnstable: 'FAIL — RO unstable (noise or faulty IC)',
    deUntestable: 'Not testable (RX side failed)',
    deOk: 'OK — driver off when DE=0',
    deStuck: 'FAIL — bus follows DI when DE=0 (DE stuck high)',
    txOk: 'OK — echo through the chip, driver and receiver both work',
    txUntestable: "Not testable (RE tied to DE) — check the slaves' RS485 LEDs",
    txInconclusive: 'Inconclusive — RO always 1 when DE=1 (driver not pulling low, or RE tied to DE + pull-up). Check with the slave LEDs / a multimeter',
    txStuckLow: 'FAIL — bus stuck low while transmitting (DI/PB10 not reaching the chip, or faulty driver)',
    txOdd: 'FAIL / unclear — abnormal echo',
  },
);

/** Decode the LDIA RS485 self-test summary "A?D?B?C?" (same verdicts as BOARD_LTE_KEY/Mylib/Master_modbus.c). */
export function decodeRs485SelfTest(summary: string, lang: Lang = 'vi'): { rx: string; de: string; tx: string; fail: boolean } {
  const T = RS485_SELFTEST_TEXT[lang];
  const m = /^A(.)D(.)B(.)C(.)$/.exec(summary);
  if (!m) return { rx: T.unreadable, de: '—', tx: '—', fail: true };
  const [, a, d, b, c] = m as unknown as [string, string, string, string, string];
  let fail = false;
  let rx: string;
  if (a === '1') rx = T.rxOk;
  else if (a === '0') ((rx = T.rxLow), (fail = true));
  else if (a === 'Z') ((rx = T.rxZ), (fail = true));
  else ((rx = T.rxUnstable), (fail = true));
  let de: string;
  if (a !== '1' && a !== '0') de = T.deUntestable;
  else if (d === a) de = T.deOk;
  else ((de = T.deStuck), (fail = true));
  let tx: string;
  if (b === '1' && c === '0') tx = T.txOk;
  else if (b === 'Z' && c === 'Z') tx = T.txUntestable;
  else if (b === '1' && c === '1') ((tx = T.txInconclusive), (fail = true));
  else if (b === '0' && c === '0') ((tx = T.txStuckLow), (fail = true));
  else ((tx = T.txOdd), (fail = true));
  return { rx, de, tx, fail };
}
