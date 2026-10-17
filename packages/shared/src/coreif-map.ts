// Default CoreIF telemetry key -> field mapping (spec section 5).
// The server stores this as editable config (device_field_map); this is the seed.

export interface FieldMapEntry {
  key: string;
  field: string;
  type: 'string' | 'int' | 'decimal' | 'bool' | 'point' | 'iso' | 'enum';
  scale: number | null;
  unit: string | null;
  note: string;
  supported: boolean;
}

export const DEFAULT_FIELD_MAP: FieldMapEntry[] = [
  { key: 'LTID', field: 'cabinet.ltid', type: 'string', scale: null, unit: null, note: 'Khóa nhận diện tủ', supported: true },
  { key: 'LIME', field: 'imei', type: 'string', scale: null, unit: null, note: '', supported: true },
  { key: 'LGPS', field: 'gpsDevice', type: 'point', scale: null, unit: null, note: 'X trước khi có fix GNSS; định dạng cần frame mẫu', supported: true },
  { key: 'LBAT', field: 'batteryMv', type: 'int', scale: 1, unit: 'mV', note: '', supported: true },
  { key: 'LACI', field: 'acInput', type: 'string', scale: null, unit: null, note: 'Chưa rõ nghĩa', supported: true },
  { key: 'LERR', field: 'lteError', type: 'int', scale: 1, unit: null, note: '', supported: true },
  { key: 'LCLI', field: 'busStatus', type: 'enum', scale: null, unit: null, note: '0 OK, 1 mất PLC, 2 mất PM, 3 mất CT, 4 mất cả 3', supported: true },
  { key: 'CTVL', field: 'leakMa', type: 'int', scale: 1, unit: 'mA', note: '', supported: true },
  { key: 'CTTE', field: 'tempC', type: 'int', scale: 1, unit: '°C', note: '1000 = lỗi cảm biến', supported: true },
  { key: 'MCON', field: 'pmOnline', type: 'bool', scale: null, unit: null, note: '', supported: true },
  { key: 'MPU1', field: 'vL1', type: 'decimal', scale: 1, unit: 'V', note: '', supported: true },
  { key: 'MPU2', field: 'vL2', type: 'decimal', scale: 1, unit: 'V', note: '', supported: true },
  { key: 'MPU3', field: 'vL3', type: 'decimal', scale: 1, unit: 'V', note: '', supported: true },
  { key: 'MPI1', field: 'iL1', type: 'decimal', scale: 1, unit: 'A', note: 'Dòng pha', supported: true },
  { key: 'MPI2', field: 'iL2', type: 'decimal', scale: 1, unit: 'A', note: 'Dòng pha', supported: true },
  { key: 'MPI3', field: 'iL3', type: 'decimal', scale: 1, unit: 'A', note: 'Dòng pha', supported: true },
  { key: 'MCO1', field: 'pfL1', type: 'int', scale: 0.01, unit: null, note: 'Mất dấu âm (u32)', supported: true },
  { key: 'MCO2', field: 'pfL2', type: 'int', scale: 0.01, unit: null, note: '', supported: true },
  { key: 'MCO3', field: 'pfL3', type: 'int', scale: 0.01, unit: null, note: '', supported: true },
  { key: 'MCOS', field: 'pfTotal', type: 'int', scale: 0.01, unit: null, note: '', supported: true },
  { key: 'MPOW', field: 'pTotalKw', type: 'decimal', scale: 1, unit: 'kW', note: 'Đơn vị cần xác nhận', supported: true },
  { key: 'PCON', field: 'plcOnline', type: 'bool', scale: null, unit: null, note: '', supported: true },
  { key: 'LQ2', field: 'branch1On', type: 'bool', scale: null, unit: null, note: 'Trạng thái thật nhánh 1', supported: true },
  { key: 'LQ3', field: 'branch2On', type: 'bool', scale: null, unit: null, note: 'Trạng thái thật nhánh 2', supported: true },
  { key: 'PMAN', field: 'manualMode', type: 'bool', scale: null, unit: null, note: '', supported: true },
  { key: 'PIN5', field: 'cmdEcho.mode2', type: 'bool', scale: null, unit: null, note: 'Echo lệnh', supported: true },
  { key: 'LINE1', field: 'cmdEcho.line1', type: 'bool', scale: null, unit: null, note: 'Echo lệnh', supported: true },
  { key: 'LINE2', field: 'cmdEcho.line2', type: 'bool', scale: null, unit: null, note: 'Echo lệnh', supported: true },
  { key: 'PTIM', field: 'deviceTime', type: 'iso', scale: null, unit: null, note: 'X khi mất PLC', supported: true },
  { key: 'LTIM', field: 'lastServerTime', type: 'iso', scale: null, unit: null, note: '', supported: true },
  { key: 'PDOR', field: 'doorOpen', type: 'bool', scale: null, unit: null, note: 'Chờ firmware bật cờ', supported: false },
  { key: 'PFLT', field: 'contactorFault', type: 'bool', scale: null, unit: null, note: 'Chờ firmware bật cờ', supported: false },
  { key: 'MKWH', field: 'energyKwh', type: 'decimal', scale: 1, unit: 'kWh', note: 'Tương lai', supported: false },
  { key: 'MFRQ', field: 'freqHz', type: 'decimal', scale: 1, unit: 'Hz', note: 'Tương lai', supported: false },
  { key: 'LCSQ', field: 'simSignal', type: 'int', scale: 1, unit: null, note: 'Tương lai', supported: false },
];
