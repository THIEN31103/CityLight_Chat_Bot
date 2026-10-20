# Languages (S49)

The UI, Telegram messages and exports exist in **Vietnamese (`vi`, source of truth) and English (`en`)**, chosen per
user (`users.lang`, header switch `VI | EN`, login page select). A screen shows **one** language, never a mix.

## How a screen gets its text

```ts
// i18n/dict/<area>.ts
import { defineDict, plural } from '@citylight/shared';
export const ALARMS = defineDict(
  { title: 'Cảnh báo lỗi', count: (n: number) => `${n} cảnh báo`, ack: 'Xác nhận {code}?' },
  { title: 'Fault alarms', count: (n: number) => plural(n, 'alarm', 'alarms'), ack: 'Acknowledge {code}?' },
);

// in the component
const t = useDict(ALARMS);          // re-renders on language change
<h1>{t.title}</h1> {t.count(total)} {fill(t.ack, { code })}
// outside React (toast in a mutation callback, module helpers): dictNow(ALARMS)
```

- `defineDict(vi, en)`: TypeScript requires `en` to have exactly the keys of `vi` (strings for strings, same function
  signature for functions). Missing English = type error.
- One dictionary file per area; keys grouped by component. Words used everywhere: `dict/common.ts` (`COMMON`).
- Enum labels (status, severity, command type/status, incident status, role): `useLabels()` -> `LABELS[lang]`
  from `@citylight/shared` (not the `*_LABELS` constants, which are Vietnamese for the server).
- API errors: `lib/api.ts` translates by `code` with `dict/errors.ts` (`params` from the API fill `{placeholders}`);
  pages keep showing `e.message`.
- Dates: dayjs locale follows the language; formats stay `DD/MM/YYYY HH:mm`. Numbers: `fmtNum` / `locale()`.
- Data stays as entered: cabinet / area names, notes, alarm messages and log details already stored are not translated.

## Terminology (vi -> en)

Keep as is in both languages: CityLight, LTID, IMEI, GPS, GNSS, MQTT, 2FA, TOTP, PLC, LOGO, CT, PM, LTE, EC25, SIM,
RS485, Modbus, firmware, telemetry, kWh, V, A, mA, °C, error codes (E101…).

| Tiếng Việt | English |
|---|---|
| tủ (điện chiếu sáng) | cabinet |
| nhánh / N1, N2 | branch / B1, B2 |
| trụ / tuyến / đèn | pole / route / lamp |
| sáng đèn / nghỉ / mất kết nối / không xác định | lights on / off / offline / unknown |
| tiết giảm | dimming |
| Chế độ 1 / Chế độ 2 | Mode 1 / Mode 2 |
| lịch chiếu sáng | lighting schedule |
| thủ công / tự động | manual / automatic |
| xung bật tay | manual-on pulse |
| cảnh báo / sự cố | alarm / incident |
| xác nhận (cảnh báo) | acknowledge |
| khu vực / quận / phường / vùng / khu quản lý | area / district / ward / zone / management unit |
| Nhà cung cấp / Quản lý / Điều hành / Giám sát / Đội duy tu | Provider / Manager / Operator / Viewer / Maintenance crew |
| phạm vi (khu vực) | scope |
| ngưỡng | threshold |
| rò dòng / nhiệt độ / điện áp / dòng điện / công suất / năng lượng | leakage current / temperature / voltage / current / power / energy |
| giá điện | electricity price |
| nhật ký thao tác / nhật ký đồng bộ | activity log / sync log |
| đồng bộ hàng loạt / lô | bulk sync / batch |
| đăng ký tủ / thiết bị chưa đăng ký | cabinet registration / unregistered devices |
| ngừng dùng tủ | decommission cabinet |
| ánh xạ telemetry | telemetry field map |
| chẩn đoán | diagnostics |
| chỉ đường | directions |
| xác thực 2 lớp / mã khôi phục / mật khẩu tạm | two-factor authentication (2FA) / recovery code / temporary password |
| xác thực lại | re-authenticate |
| khóa tài khoản / mở khóa | lock account / unlock |

English style: plain, short, sentence case ("Save changes", not "Save Changes"), American spelling, no "please",
no exclamation marks. Same meaning as the Vietnamese, not a word-for-word copy.
