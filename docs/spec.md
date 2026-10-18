# CityLight Server — Spec v0.1 (2026-10-17)

Nền tảng giám sát / điều khiển tủ chiếu sáng CityLight V2. Hệ thống **mới hoàn toàn**. Quy mô thiết kế **10.000 tủ**.
Tham khảo chức năng: `../prompt_xay_dung_lai_he_thong_chieu_sang.md` (chỉ tham khảo). Giao thức thiết bị: `device-contract.md`. Quyết định: `decisions.md`.

Trạng thái: spec v0.1 Bảo duyệt "tương đối ổn" (2026-10-17). **M1-UI xong** (web mock, `apps/web`). **M0 + M1 xong** (ingest + API + web hybrid, thử tải 10.000 tủ). **M2 xong** (2FA TOTP, phạm vi khu vực ở REST + Socket.IO, quản lý user, CSRF, rate limit; quyết định S14–S16). **M4 lệnh xong** (command-worker, vòng đời lệnh, S17–S20; drawer các tab dữ liệu thật đã có từ M1). **M3 bản đồ xong** (2026-10-18: favorites, gzip, đo 10k tủ, e2e:map; sửa mặc định `cabinet_state.status` = offline). **M5 cảnh báo xong** (luật ngưỡng/lịch/giờ/GPS trong ingest, notify-worker Telegram, S21–S23). **M6 lịch & hàng loạt xong** (scheduler giữ lịch mong muốn, lịch thiên văn, batch có OTP + tiến độ, S24–S26; tải 1.000 tủ). **M7 sự cố xong** (luồng server kiểm, người xử lý là user, ảnh, Excel sự cố + cảnh báo, báo cáo tháng, nhắc quá hạn; S27–S29). **M8 GIS & quản trị xong** (tuyến/trụ/đèn, chỉnh sửa nháp 1 transaction, sinh trụ, nhập Excel, danh mục, đăng ký/ngừng dùng tủ, cấu hình; S30–S33). **M9 tiết giảm xong** (hồ sơ 3 tầng tủ > vùng > hệ thống, kiểm chung, ước tính theo đèn GIS + giá điện, gửi vẫn chặn đúng 409; S34–S37). Tiếp theo: M10 (thử với tủ thật).

---

## 1. Nguyên tắc

1. **Đúng → an toàn điều khiển → hiệu năng → đẹp.**
2. **Web đi trước firmware.** Chức năng firmware chưa hỗ trợ vẫn làm UI + API + DB; hiện "Chưa hỗ trợ" theo *capability* của từng tủ, không báo lỗi. Khi firmware thêm key, chỉ thêm ánh xạ (mục 5), không viết lại logic.
3. **Không tin `rc:0`.** Lệnh chỉ "xác nhận" khi telemetry đổi theo.
4. **Quyền kiểm ở backend** cho mọi API; FE chỉ ẩn/hiện.
5. **Mọi thao tác ghi đều có audit log.**
6. **Tủ tự chạy khi server chết** (lịch nằm trong LOGO). Server không bao giờ là điều kiện để đèn sáng đúng lịch.
7. **Local trước, VPS sau.** Toàn bộ chạy bằng `docker compose up` trên máy Bảo; deploy VPS dùng cùng image.

---

## 2. Stack (chốt theo tiêu chí "tối ưu")

| Thành phần | Chọn | Lý do |
|---|---|---|
| Ngôn ngữ | **TypeScript** cả FE + BE | Dùng chung type (telemetry, lệnh, DTO) giữa FE/BE/simulator → ít lệch nhất |
| Monorepo | npm workspaces (Node 22) | Có sẵn trên máy, không cần cài thêm; chuyển pnpm/Turborepo sau nếu build chậm |
| Backend API | **NestJS** (Fastify adapter) | Module rõ ràng, DI, guard RBAC, OpenAPI tự sinh, hợp dự án lớn nhiều module |
| DB | **PostgreSQL 16 + TimescaleDB + PostGIS** (image `timescale/timescaledb-ha`) | Một DB cho nghiệp vụ + chuỗi thời gian + không gian |
| ORM / query | Drizzle ORM (+ SQL thô cho Timescale/PostGIS) | Gần SQL, type-safe, không giấu query nặng |
| Cache / hàng đợi | **Redis 7 + BullMQ** | Trạng thái mới nhất của 10k tủ, hàng đợi lệnh, rate limit, pub/sub giữa các process |
| Broker | **EMQX 5.x 1 node** | 10k kết nối dư sức, shared subscription, dashboard, auth/ACL qua HTTP/DB |
| MQTT client | mqtt.js | |
| Realtime | Socket.IO + Redis adapter | Room theo tủ/kênh, tự reconnect, scale nhiều instance |
| Frontend | React 18 + Vite + TS, React Router 6, TanStack Query/Table, Zustand, MSW (mock API) | |
| UI | Tailwind + shadcn/ui, icon Lucide | |
| Bản đồ | **MapLibre GL JS** + Supercluster | Vector, mượt với hàng chục nghìn điểm |
| Biểu đồ | Apache ECharts | |
| Excel | exceljs | |
| Auth | Session cookie httpOnly/Secure/SameSite + CSRF token, argon2, TOTP 2FA (otplib) | Không để token trong localStorage |
| Validation | zod (schema dùng chung `packages/shared`) | |
| Test | Vitest (unit), Supertest (API), Playwright (E2E), k6 (tải) | |
| Reverse proxy (VPS) | Caddy (HTTPS tự động) | |
| Quan sát | pino log JSON, `/health`, Prometheus metrics, Uptime Kuma | |

Ghi chú: captcha dùng **tự host** (vd ALTCHA) hoặc chỉ rate-limit + khóa tạm, không phụ thuộc Google.

---

## 3. Kiến trúc

```text
                    ┌────────────── EMQX (1883; sau 8883 TLS) ──────────────┐
   10.000 tủ ──MQTT─┤ ACL: tủ chỉ publish tele/echo, chỉ subscribe cmd       │
                    └──────┬──────────────────────────────▲─────────────────┘
          $share/ingest/…  │                              │ publish cmd
                    ┌──────▼──────┐   Redis    ┌──────────┴─────────┐
                    │ ingest      │──streams──>│ command-worker     │ PG queue: gửi, retry, timeout,
                    │ parse CoreIF│            │ (ack matcher)      │ rate-limit hàng loạt
                    │ batch insert│            └──────────▲─────────┘
                    └──┬───────┬──┘                       │ job
        COPY/batch     │       │ last-state + events      │
   ┌───────────────────▼┐    ┌─▼──────────────┐    ┌──────┴──────────┐
   │ Postgres           │    │ Redis          │<───│ api (NestJS)    │<── REST /api/v1
   │ +Timescale +PostGIS│<───│ state, pub/sub │    │ + Socket.IO     │<── WebSocket
   └────────▲───────────┘    └─▲──────────────┘    └──────▲──────────┘
            │                  │                          │
   ┌────────┴──────────────────┴──┐                ┌──────┴──────┐
   │ rules-worker (cảnh báo,      │                │ web (React) │
   │ offline detector)            │                └─────────────┘
   │ scheduler (lịch thiên văn,   │
   │ đồng bộ giờ định kỳ, job đêm)│
   └──────────────────────────────┘
```

Process (cùng codebase, khác entrypoint): `api`, `ingest`, `command-worker`, `rules-worker`, `scheduler`. Local chạy chung; VPS tách container để scale riêng.

### 3.1 Ngân sách tải (10.000 tủ)

| Mục | Số |
|---|---|
| Telemetry | 10k × 1/10 s ≈ **1.000 msg/s** (đỉnh khi thay đổi dồn: ~3.000 msg/s) |
| Dòng raw / ngày | ~86 triệu → nén Timescale (~10–20×) |
| Ingest | gom lô 500 ms hoặc 1.000 dòng → `COPY`/multi-row insert |
| Bản đồ realtime | trạng thái đổi → cập nhật FE ≤ 5 s |
| Lệnh hàng loạt | rate-limit mặc định 20 lệnh/s (cấu hình) |
| Server VPS đề xuất | 8 vCPU / 16–32 GB / NVMe 500 GB+ |

### 3.2 Lưu trữ

- `telemetry_raw`: hypertable, chunk 1 ngày, nén sau 2 ngày, **giữ 90 ngày**.
- Continuous aggregates: `5m`, `1h`, `1d` (min/max/avg U, I, P, cosφ; năng lượng). Giữ lâu dài.
- `frames_raw` (chuỗi frame gốc): giữ 7 ngày, phục vụ debug.

---

## 4. Lớp thiết bị (Device Adapter)

```ts
interface DeviceAdapter {
  onTelemetry(cb: (ltid: string, t: TelemetryPatch, raw: string) => void): void;
  onAck(cb: (ltid: string, acks: {key: string; rc: number}[], raw: string) => void): void;
  send(ltid: string, ops: DeviceOp[]): Promise<SendResult>;  // build frame CoreIF, publish
  capabilities(fwProfile: string): CapabilitySet;
}
```

- Adapter mặc định: **`CoreIfV2Adapter`** (topic chung, QoS 0, LTID trong payload — firmware hiện tại).
- Adapter tương lai: **`CoreIfV3Adapter`** (topic riêng từng tủ `citylight/<LTID>/{tele,cmd,ack}`, QoS 1, user/pass) — thêm khi firmware giai đoạn 2 xong. Tủ chọn adapter theo `fw_profile`.
- **Bắt buộc trước khi vận hành 10k tủ:** V3. Với V2, mỗi lệnh gửi tới *mọi* tủ subscribe topic chung.

### 4.1 Lệnh logic → CoreIF

| Lệnh logic | Frame CoreIF (luôn có `LTID'<id>`) | Xác nhận bằng |
|---|---|---|
| `MANUAL` toàn tủ bật/tắt | `PLN1'v&PLN2'v&PMAN'1` | `PMAN=1`, `LQ2=v`, `LQ3=v` |
| `MANUAL` nhánh N1/N2 | `PLN1'v&PMAN'1` / `PLN2'v&PMAN'1` | `LQ2`/`LQ3` |
| `AUTO` (về lịch) | `PMAN'0` | `PMAN=0` |
| `SET_SCHEDULE` Chế độ 1 | `PI50'0&T10'<on>&T20'<off>` | ack rc (chưa đọc lại được lịch) |
| `SET_SCHEDULE` Chế độ 2 | `PI50'1&LINE1'a&LINE2'b&T10'..&T20'..&T11'..&T21'..` | ack rc |
| `SET_TIME` | `LTIM'<now +07:00>` | `PTIM` khớp ±2 phút |
| `PULSE_ON` | `PI2O'0` rồi `PI2O'1` | ack rc |
| `DIAG` | `LDIA'1` | ack + `stm32/ec25/demo` |
| `SET_DIMMING`, `SET_LAMP_GROUP`, `LAMP_CONTROL`, `READ_ALL`, `SET_THRESHOLDS_DEVICE` | — chưa có trên firmware | API trả `409 capability_unsupported`; UI disable |

Quy tắc firmware server phải tôn trọng:
- Giờ ISO luôn `+07:00`; T-keys chỉ dùng HH:MM.
- PLC_KEY bỏ qua lệnh cùng giá trị với `LINE*`, `PI50`, `PI2O` → muốn "ép lại" phải gửi giá trị ngược trước. `PMAN/PLN*` thì luôn có tác dụng.
- Cả `LINE1=0` và `LINE2=0` → LOGO quay về Chế độ 1 (UI cảnh báo trước khi gửi).
- ≤ 16 key / frame.
- `T12/T22` (tiết giảm) đang tắt trên LTE → coi là capability `dimming_window` = chưa hỗ trợ.

### 4.2 Capability theo `fw_profile`

| Capability | `v2-1307ebc` (cũ) | `v2-current` | Tương lai |
|---|---|---|---|
| `telemetry.basic` (U/I/cosφ/P, CT, nhiệt độ, GPS, pin) | ✅ | ✅ | ✅ |
| `branch_state` (LQ2/LQ3) | ❌ | ✅ | ✅ |
| `manual_control` (PMAN/PLN) | ❌ | ✅ | ✅ |
| `schedule_write` | ✅ | ✅ | ✅ |
| `schedule_readback` | ❌ | ❌ | firmware |
| `ltid_filter` (an toàn) | ❌ | ✅ | ✅ |
| `door`, `contactor_fault` | ❌ | ❌ (cờ tắt) | bật cờ |
| `energy_counters` (kWh/kVAh/kVArh) | ❌ | ❌ | firmware |
| `power_full` (S, Q, P từng pha, Hz) | ❌ | ❌ | firmware |
| `sim_info` (ICCID, CSQ, nhà mạng) | ❌ | ❌ | firmware |
| `dimming`, `smart_lamps` | ❌ | ❌ | phần cứng mới |
| `per_cabinet_topic`, `qos1`, `auth` | ❌ | ❌ | giai đoạn 2 |

Tủ `v2-1307ebc`: **chặn gửi lệnh** từ web (không lọc LTID → ảnh hưởng mọi tủ), chỉ giám sát.

---

## 5. Ánh xạ telemetry CoreIF → trường dữ liệu

Bảng cấu hình (`device_field_map`), sửa không cần deploy code.

| Key | Trường | Kiểu / đơn vị | Ghi chú |
|---|---|---|---|
| `LTID` | `cabinet.ltid` | string | khóa nhận diện |
| `LIME` | `imei` | string | |
| `LGPS` | `gps_device` | Point | `X` trước fix; **định dạng cần frame mẫu thật** |
| `LBAT` | `battery_mv` | int mV | |
| `LACI` | `ac_input` | ? | **chưa rõ nghĩa**, cần hỏi firmware |
| `LERR` | `lte_error` | int | |
| `LCLI` | `bus_status` | 0/1/2/3/4/X | 0 OK, 1 mất PLC, 2 mất PM, 3 mất CT, 4 mất cả 3 |
| `CTVL` | `leak_ma` | int mA | |
| `CTTE` | `temp_c` | int °C | 1000 = lỗi cảm biến → null |
| `MCON` | `pm_online` | bool | |
| `MPU1..3` | `v_l1n..v_l3n` | V, 0.1 | 0 khi đồng hồ mất |
| `MPI1..3` | `i_l1..i_l3` | A, 0.1 | dòng **pha** (chưa ánh xạ nhánh) |
| `MCO1..3` | `pf_l1..pf_l3` | int ×100 | cosφ = giá trị/100; firmware dùng u32 → **mất dấu âm** |
| `MCOS` | `pf_total` | int ×100 | |
| `MPOW` | `p_total` | 0.1 | **đơn vị cần xác nhận** (firmware chia 1000 giá trị đồng hồ → nhiều khả năng kW) |
| `PCON` | `plc_online` | bool | |
| `LQ2` / `LQ3` | `branch1_on` / `branch2_on` | bool / X | trạng thái thật |
| `PMAN` | `manual_mode` | bool / X | |
| `PIN5`, `LINE1`, `LINE2` | `cmd_echo.*` | bool | **echo lệnh**, không phải trạng thái |
| `PTIM` | `device_time` | ISO | `X` khi mất PLC |
| `LTIM` | `last_server_time` | ISO | |
| `PDOR` / `PFLT` | `door_open` / `contactor_fault` | bool | khi firmware bật |
| *(tương lai)* `MKWH`, `MKVAH`, `MKVARH`, `MFRQ`, `MPS*`, `MPQ*`, `LICC`, `LCSQ`… | | | thêm dòng vào bảng khi firmware có |

`X` → `null` (không ghi đè giá trị cũ trong last-state nhưng ghi null vào chuỗi thời gian).
Frame không có `LTID` hoặc LTID chưa đăng ký → vào `unknown_devices` (admin duyệt đăng ký).

---

## 6. Trạng thái tủ (suy ra ở server)

Ưu tiên từ trên xuống:

| Trạng thái | Điều kiện |
|---|---|
| **Mất kết nối** | không có frame > `offline_after` (mặc định 60 s, cấu hình) |
| **Lỗi** | online nhưng có cảnh báo mức *critical* đang mở (mất PLC, mất PM, rò dòng vượt ngưỡng, contactor…) |
| **Tiết giảm** | (tương lai) đang trong khung dim |
| **Sáng đèn** | `branch1_on` hoặc `branch2_on` |
| **Nghỉ** | online, cả hai nhánh tắt |
| **Không xác định** | online nhưng `PCON=0` (không biết nhánh) |

Bộ đếm, bản đồ, danh sách, trang cảnh báo **đọc cùng một nguồn** (bảng `cabinet_state` + Redis) → luôn khớp nhau. Tủ chưa phân khu vực hiện trong nhóm "Chưa phân khu vực".

---

## 7. Data model

### Tổ chức
- `organizations`, `management_units`, `areas` (cây cha-con, PostGIS polygon tùy chọn), `wards`, `zones` (vùng lịch/tiết giảm; một tủ thuộc tối đa 2 zone).

### Tài sản
- `cabinets`: `id`, `ltid` (unique), `code`, `name`, địa chỉ, `ward_id`, `area_id`, `management_unit_id`, `zone1_id`, `zone2_id`, `geom` (Point, vị trí khai báo), `fw_profile`, `adapter`, `photo_url`, `sim_iccid`, `installed_at`, `status_override` (bảo trì), `notes`.
- `cabinet_state` (1 dòng/tủ, cập nhật liên tục): `last_seen_at`, `online`, `derived_status`, các trường last-value mục 5, `gps_device`, `updated_at`.
- `routes` (tuyến: `cabinet_id`, `branch` N1/N2, `geom` LineString), `poles` (`route_id`, `geom`, `code`, `lamp_count`), `lamps` (`pole_id`, `lamp_group`, `rated_power_w`, `is_smart`).
- `favorites` (user, tên, tâm, zoom).

### Cấu hình
- `schedules`: theo zone hoặc tủ (tủ ghi đè zone). `mode` 1/2, `on1/off1`, `on2/off2`, `branch1_enabled`, `branch2_enabled`, `source` (manual/astronomical), `offset_on_min`, `offset_off_min`.
- `schedule_applied`: giá trị server đã gửi thành công cho từng tủ (desired vs đã ack) — thay cho readback khi firmware chưa có.
- `thresholds`: theo zone hoặc tủ; mỗi ngưỡng có `enabled`: U cao/thấp/dao động, I cao/thấp/dao động/không tải (theo pha, sau này theo nhánh), rò dòng mA, nhiệt độ °C, pin thấp mV.
- `dimming_profiles`: theo `lamp_group` + zone/tủ, 5 thời đoạn (`start_min`, `end_min` cho phép > 1440, `level_pct`). Lưu sẵn, chưa gửi được.
- `device_field_map`: mục 5.

### Lệnh
- `commands`: `id`, `cabinet_id`, `type`, `params` (JSON), `frame`, `batch_id`, `idempotency_key`, `requested_by`, `status` (`queued → sent → acked → confirmed` | `failed` | `timeout` | `cancelled`), `ack_rc` (JSON theo key), `queued_at/sent_at/acked_at/confirmed_at`, `error`.
- `command_batches`: lệnh hàng loạt (zone/danh sách), tổng/thành công/lỗi/offline, tiến độ.

### Dữ liệu đo
- `telemetry_raw` (hypertable): `ts`, `cabinet_id`, các cột số mục 5 (null khi `X`).
- `telemetry_5m/1h/1d` (continuous aggregates).
- `energy_daily` (khi có bộ đếm kWh; trước đó ước lượng từ tích phân `p_total`, gắn cờ `estimated`).
- `frames_raw` (7 ngày).

### Cảnh báo, sự cố, nhật ký
- `alarm_rules` (loại, điều kiện, mức độ, debounce), `alarms` (`cabinet_id`, `type`, `severity`, `message`, `value`, `started_at`, `ended_at`, `active`, `acked_by/at`).
- `incidents` (mã, tủ, nguồn: alarm/manual, phân loại, nội dung, vị trí, ảnh, `status`, `assignee`, `deadline`, kết quả xử lý, ảnh xử lý) + `incident_events` (timeline).
- `activity_logs` (`user_id`, `action`, `target_type/id`, `old_value`, `new_value`, `ip`, `ts`) — ghi tự động bằng interceptor cho mọi API ghi.
- `sync_logs` (= `command_batches` + chi tiết từng tủ).

### Người dùng
- `users` (email, argon2 hash, ngôn ngữ, TOTP, trạng thái, khóa tạm), `roles`, `permissions`, `role_permissions`, `user_scopes` (area/management_unit), `notification_subscriptions` (kênh: zalo/telegram/email; loại cảnh báo; phạm vi).

---

## 8. Cảnh báo (rules-worker)

| Loại | Điều kiện (mặc định, cấu hình theo zone/tủ) | Firmware |
|---|---|---|
| Mất kết nối | không frame > 60 s | ✅ |
| Mất PLC / PM / CT | `PCON=0` / `MCON=0` / `LCLI` báo CT mất, kéo dài > 30 s | ✅ |
| Quá / thấp áp | U pha ngoài [ngưỡng], debounce 30 s | ✅ |
| Dao động áp/dòng | biên độ trong 5 phút > ngưỡng | ✅ |
| Quá dòng | I pha > ngưỡng | ✅ |
| Không tải | nhánh đang sáng nhưng dòng < ngưỡng (cần ánh xạ pha ↔ nhánh, cấu hình theo tủ) | ✅ (cần cấu hình) |
| Rò dòng | `CTVL` > ngưỡng mA | ✅ |
| Nhiệt độ tủ | `CTTE` > ngưỡng; `1000` → lỗi cảm biến | ✅ |
| Sai giờ TĐK | \|`PTIM` − giờ server\| > 5 phút | ✅ |
| Sáng ngoài lịch / tắt trong lịch | trạng thái nhánh lệch lịch đã áp > 10 phút (bỏ qua khi `PMAN=1`) | ✅ |
| Pin yếu | `LBAT` < ngưỡng | ✅ |
| Mất GPS / lệch vị trí | GPS thiết bị cách vị trí khai báo > 200 m | ✅ |
| Mở cửa tủ | `PDOR=1` | chờ cờ |
| Lỗi contactor | `PFLT=1` | chờ cờ |

- Cảnh báo có `started_at/ended_at`, tự đóng khi hết điều kiện; ack bởi user.
- Chống bão cảnh báo: tủ đang **mất kết nối** thì không sinh các cảnh báo đo lường.
- Đẩy realtime qua WebSocket + `NotificationChannel` (Zalo OA, Telegram, Email; thêm kênh = thêm class).
- Đã làm ở M5 (S21–S23): `packages/shared/src/rules.ts` (luật + chống nhiễu), `apps/workers/src/notify-worker.ts` (Telegram, gom tin). Luật "Sáng ngoài lịch / tắt trong lịch" mở sau 20 phút (không phải 10) vì xung bật tay giữ đèn 15 phút.

---

## 9. Lịch thiên văn (thay cảm biến LUX)

- Mỗi zone có tọa độ tâm. Scheduler tính giờ mặt trời lặn/mọc hằng ngày (thư viện `suncalc`) + offset (vd bật = lặn + 10 phút, tắt = mọc − 10 phút).
- Job 12:00 mỗi ngày: zone `source=astronomical` → tạo batch `SET_SCHEDULE` cho các tủ trong zone (chỉ gửi khi giá trị đổi so với `schedule_applied`, để tránh spam).
- Biểu đồ giờ bật/tắt theo ngày cho từng zone. Khi sau này có cảm biến LUX, thêm nguồn `lux` cùng giao diện.
- Đã làm ở M6 (S24–S25), khác bản đầu: không chạy job 12:00 mà **scheduler đối chiếu liên tục** (5 phút + khi lịch đổi + khi tủ online lại), chỉ gửi khi khác `schedule_applied`; không đẩy lịch mặc định.

---

## 10. Màn hình

### Khung chung
- Thanh trên: logo/tên (cấu hình), đồng hồ giờ server, chuông cảnh báo (badge + 10 mới nhất), menu Sự cố, menu Chức năng, tài khoản, trợ giúp, sáng/tối.
- Trang 403 rõ ràng; menu chỉ hiện mục có quyền.

### Danh sách màn hình

| # | Màn hình | Nội dung |
|---|---|---|
| S1 | Đăng nhập | email, mật khẩu, ghi nhớ, captcha tự host, khóa tạm, bước 2FA |
| S2 | **Bản đồ điều hành** | thẻ KPI trạng thái (bấm để lọc), KPI tổng (% online, kWh hôm nay, sự cố quá hạn); bản đồ MapLibre + cluster; lớp: tủ / tuyến / trụ / đèn, nền OSM/vệ tinh/tile tùy chỉnh; tìm kiếm autocomplete; vị trí ưa thích; đo khoảng cách; vị trí hiện tại; panel trái dạng bảng (tủ gần tâm bản đồ) và dạng cây (đơn vị → khu vực → phường → tủ, có "Chưa phân khu vực") |
| S3 | **Chi tiết tủ** (drawer phải, realtime) | tab: **Điều khiển** (sơ đồ tủ + N1/N2, bật/tắt toàn tủ/nhánh, về tự động, Chế độ 1/2, giờ TĐK + đồng bộ giờ, trạng thái lệnh), **Giám sát** (lưới số liệu; ô chưa hỗ trợ hiện "—"), **Điện áp**, **Dòng điện** (biểu đồ, chọn khoảng, tạm dừng live), **Năng lượng** (kWh theo giờ/30 ngày; ước lượng khi chưa có bộ đếm), **Rò dòng & nhiệt độ**, **Cài đặt ngưỡng** (lưu ở server), **Tiết giảm** (hồ sơ kế thừa zone, ghi đè; "chưa hỗ trợ trên thiết bị"), **Đèn** (danh sách đèn GIS; điều khiển khi có đèn thông minh), **Thông tin** (GPS thiết bị vs khai báo, SIM, pin, IMEI, firmware, zone, ảnh tủ upload, hành chính), **Cảnh báo** (20 gần nhất), **Lệnh** (lịch sử lệnh của tủ) |
| S4 | Chi tiết trụ / đèn (panel nhỏ) | thông tin, tuyến, tủ, đèn |
| S5 | Chế độ chỉnh sửa bản đồ | kéo marker, vẽ tuyến, sinh trụ hàng loạt theo khoảng cách, nháp → Lưu / Hủy, audit |
| S6 | **Cảnh báo** | tab Hiện hữu / Tất cả; lọc khu vực, loại, mức độ, thời gian; ack; xuất Excel |
| S7 | **Sự cố** — danh sách | cây khu vực, lọc thời gian/trạng thái (URL giữ bộ lọc), lọc cột, ẩn/hiện cột, phân trang server, xuất Excel theo bộ lọc |
| S8 | Sự cố — chi tiết | timeline, ảnh, bản đồ, chuyển trạng thái (tiếp nhận → giao xử lý + hạn → xử lý + ảnh → đóng) |
| S9 | Báo cáo sự cố | theo tháng: theo ngày × trạng thái, theo khu vực, theo phân loại, thời gian xử lý TB, tỷ lệ quá hạn |
| S10 | **Lịch chiếu sáng** | lịch theo zone (thủ công / thiên văn + offset), biểu đồ giờ bật/tắt theo ngày, đồng bộ xuống tủ của zone |
| S11 | **Tiết giảm** | nhóm đèn, 5 thời đoạn (slider hiển thị giờ:phút, tự nối liền), mức %, biểu đồ xem trước + ước tính kWh tiết kiệm, chọn zone, đồng bộ (khi firmware hỗ trợ) |
| S12 | **Đồng bộ hàng loạt** (dùng chung S10/S11/giờ) | xác nhận số tủ ảnh hưởng, tiến độ realtime, kết quả từng tủ, gửi lại tủ lỗi |
| S13 | Nhật ký thao tác | lọc user/thời gian/tủ/hành động, xuất Excel |
| S14 | Nhật ký đồng bộ | theo zone, mở rộng xem từng tủ |
| S15 | Tài khoản cá nhân | đổi mật khẩu, 2FA (QR + mã khôi phục), đăng ký kênh thông báo |
| S16 | **Quản trị** | user, vai trò, phạm vi; danh mục khu vực / khu quản lý / zone / nhóm đèn; **đăng ký tủ** (LTID, fw_profile, vị trí; duyệt `unknown_devices`); ánh xạ telemetry; quy tắc cảnh báo; cấu hình hệ thống (offline_after, rate limit) |
| S17 | Giám sát hệ thống (admin) | số tủ online, msg/s, độ trễ ingest, hàng đợi lệnh, lỗi ack |
| S18 | Trợ giúp | hướng dẫn (markdown admin sửa được), giới thiệu |

UI: dark/light, desktop chính, tablet/điện thoại xem được bản đồ + cảnh báo + sự cố; trạng thái luôn có **icon + chữ + màu** (đỏ lỗi/mất kết nối, xám nghỉ, xanh lá sáng, hổ phách tiết giảm); vi/en, `dd/MM/yyyy HH:mm:ss`, Asia/Ho_Chi_Minh.

---

## 11. API (`/api/v1`, OpenAPI tự sinh)

| Nhóm | Endpoint |
|---|---|
| Auth | `POST /auth/login`, `POST /auth/2fa/verify`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/2fa/setup`, `POST /auth/2fa/disable` |
| Tài khoản | `PATCH /me`, `POST /me/password`, `GET/PUT /me/notifications` |
| Bản đồ | `GET /map/cabinets?bbox=&zoom=&status=` (cluster ở server khi zoom xa), `GET /map/assets?bbox=&layers=`, `GET /map/stats`, `GET /search?q=` |
| Phân cấp | `GET /areas/tree` (kèm số tủ), `GET /cabinets/nearby?lat=&lng=&radius=` |
| Tủ | `GET /cabinets?…` (phân trang), `GET /cabinets/:id`, `PATCH /cabinets/:id`, `POST /cabinets/:id/photo`, `GET /cabinets/:id/state`, `GET /cabinets/:id/telemetry?metrics=&from=&to=&interval=auto`, `GET /cabinets/:id/energy?range=`, `GET/PUT /cabinets/:id/schedule`, `GET/PUT /cabinets/:id/thresholds`, `GET/PUT /cabinets/:id/dimming`, `GET /cabinets/:id/alarms?limit=`, `GET /cabinets/:id/commands` |
| Lệnh | `POST /cabinets/:id/commands` (header `Idempotency-Key`, trả `202`), `GET /commands/:id`, `POST /commands/:id/cancel`, `POST /command-batches`, `GET /command-batches/:id`, `POST /command-batches/:id/retry-failed` |
| Tài sản GIS | CRUD `routes`, `poles`, `lamps`; `POST /map/edits` (lưu theo lô), `POST /poles/generate` |
| Cảnh báo | `GET /alarms?active=&area=&type=&from=&to=`, `POST /alarms/:id/ack`, `GET /alarms/export.xlsx` |
| Sự cố | `GET /incidents?…`, `GET /incidents/export.xlsx`, `POST /incidents`, `PATCH /incidents/:id`, `POST /incidents/:id/transition`, `POST /incidents/:id/photos`, `GET /incidents/report?month=` |
| Lịch / tiết giảm | `GET/PUT /zones/:id/schedule`, `GET /zones/:id/schedule/preview?days=30`, `GET/PUT /dimming-profiles/:group`, sync qua `POST /command-batches` |
| Nhật ký | `GET /logs/activity`, `GET /logs/sync` |
| Quản trị | CRUD `users`, `roles`, `areas`, `management-units`, `zones`, `lamp-groups`, `alarm-rules`, `field-map`; `GET /devices/unknown`, `POST /devices/unknown/:ltid/register` |
| Hệ thống | `GET /health`, `GET /metrics` (nội bộ), `GET /system/stats` |

Lỗi: RFC 9457 `{type,title,status,detail,code}`; `code` ví dụ `capability_unsupported`, `cabinet_offline`, `cabinet_unsafe_firmware`, `forbidden_scope`.

### WebSocket (Socket.IO)

| Room / event | Nội dung |
|---|---|
| `map` → `cabinet.state` | delta trạng thái (ltid, status, nhánh) — FE lọc theo bbox |
| `cabinet:<id>` → `telemetry` | giá trị mới khi drawer đang mở |
| `alarms` → `alarm.raised/cleared/acked` | theo phạm vi user |
| `command:<id>` / `cabinet:<id>` → `command.updated` | trạng thái lệnh |
| `batch:<id>` → `batch.progress` | tiến độ đồng bộ |
| `server` → `time` | giờ server mỗi 1 s (hoặc FE tự chạy sau khi lấy offset) |

Kết nối lại → FE gọi lại REST snapshot.

---

## 12. Vòng đời lệnh

Đã làm ở M4 (quyết định S17–S20, code `apps/api/src/commands.ts`, `apps/workers/src/command-worker.ts`).

```text
POST /cabinets/:id/commands {type, params}  + Idempotency-Key
  api: quyền + scope, fw an toàn, capability, tủ online (offline → 409, không xếp hàng), validate params
       → commands(status=queued) → Socket.IO "queued" → NOTIFY cl_commands → 202 {id}
command-worker (1 bản hoạt động, advisory lock), mỗi tủ 1 lệnh đang chạy:
  build frame (SET_TIME lấy giờ lúc gửi) → publish → sent
  ack (echo, khớp LTID + tập key, trong 30 s) → frame kế tiếp (PULSE_ON) | acked (rc 0) | failed (rc ≠ 0)
  telemetry thỏa "xác nhận bằng" (mục 4.1) trong 20 s → confirmed; quá hạn → acked_unconfirmed
  không ack 30 s → gửi lại 1 lần (MANUAL/AUTO/SET_TIME) → timeout
  quá 120 s trong hàng đợi / tủ mất kết nối trước khi gửi → failed
mọi bước → commands + Socket.IO command.updated; yêu cầu và kết quả → activity_logs
```

- Lệnh nguy hiểm (tắt nhánh, hàng loạt) → hộp xác nhận ghi rõ tên tủ / số tủ; hàng loạt có thể yêu cầu nhập lại OTP.
- Mỗi tủ chỉ 1 lệnh đang chạy (ack không có mã lệnh); lệnh sau chờ. Hủy được khi còn `queued`.
- Lệnh hàng loạt: rate-limit, tiến độ, gửi lại tủ lỗi.

---

## 13. Bảo mật

- HTTPS (VPS), session cookie httpOnly/Secure/SameSite=Lax + CSRF token, argon2id, khóa 15 phút sau 5 lần sai, rate limit theo IP/user.
- **2FA bắt buộc theo vai trò** (mặc định bắt buộc với vai trò có quyền điều khiển).
- RBAC + scope dữ liệu ở backend (guard NestJS + điều kiện SQL).
- Không log mật khẩu, token, mã OTP. Bí mật trong `.env`, không commit.
- Broker: ACL như `architecture.md`; dashboard EMQX chỉ mở nội bộ; backend dùng user/pass riêng.
- Backup Postgres hằng ngày (pg_dump + WAL khi lên VPS) ra nơi khác; thử khôi phục định kỳ.

---

## 14. Cấu trúc repo

```text
citylight-server/
  apps/
    api/            NestJS: modules auth, users, cabinets, map, commands, alarms, incidents,
                    schedules, dimming, logs, admin, realtime, system
    workers/        entrypoints: ingest, command-worker, rules-worker, scheduler
    web/            React + Vite
    simulator/      tủ giả nói đúng CoreIF V2 (và V3 sau)
  packages/
    shared/         zod schema, type DTO, enum trạng thái, capability
    coreif/         parser/builder CoreIF + test từ frame thật
    db/             Drizzle schema, migration, seed
  infra/
    docker-compose.yml        (local: emqx, postgres-timescale-postgis, redis, apps)
    docker-compose.prod.yml   (VPS: + caddy, backup, monitoring)
    emqx/                     acl.conf, cấu hình
  docs/             ARCHITECTURE.md, ASSUMPTIONS.md, RUNBOOK.md
```

Repo git **riêng** (không nằm trong repo firmware); thư mục `server/docs/` ở repo firmware giữ tài liệu thiết kế cho tới khi chuyển.

---

## 15. Simulator

- Sinh N tủ (mặc định 10.000) quanh TP.HCM, mỗi tủ là một client MQTT **gửi đúng frame CoreIF** như LTE (cùng topic, chu kỳ 10 s, gom khi thay đổi).
- Mô phỏng ngày/đêm theo lịch đã nhận (T10/T20…), PMAN/PLN, ack đúng format (`id`, `rc`), độ trễ và tỷ lệ lỗi cấu hình được.
- Kịch bản lỗi: ~5% mất kết nối, quá áp, mất PLC (`PCON'0`, `X`), rò dòng, nhiệt độ cao, firmware cũ.
- Dùng cho dev, demo và **test tải 10k** (k6 cho API + simulator cho MQTT).

---

## 16. Mốc giao nộp (local trước)

| Mốc | Nội dung | Nghiệm thu |
|---|---|---|
| **M0 Nền** | monorepo, docker compose local (EMQX + Postgres/Timescale/PostGIS + Redis), `packages/coreif` + test từ frame thật, simulator 100 tủ | `docker compose up`; simulator → EMQX → log parse đúng |
| **M1-UI Giao diện đầy đủ (mock)** | đủ S1–S18 + mọi tab chi tiết tủ, bấm qua lại được; dữ liệu từ mock API (MSW) dùng chung type `packages/shared`; bản đồ vài trăm tủ giả; lệnh đổi trạng thái giả (queued → confirmed); chưa cần backend/DB. Làm song song / trước M0 | `npm run dev -w @citylight/web` mở được mọi màn hình; tắt mock = gọi API thật, không sửa UI |
| **M1 Ingest & trạng thái** | ingest batch, `cabinet_state`, offline detector, telemetry raw + aggregates, đăng ký tủ / unknown devices | simulator 10k tủ, ingest ổn định, độ trễ < 2 s, CPU/RAM đo được |
| **M2 Auth & khung web** | login, session, 2FA, RBAC + scope, 403, khung layout, dark mode, i18n | user không quyền gọi API → 403 |
| **M3 Bản đồ** | MapLibre + cluster theo bbox, KPI, lọc, tìm kiếm, cây/bảng, realtime | 10k tủ mượt; bộ đếm khớp danh sách |
| **M4 Chi tiết tủ & lệnh** | drawer các tab có dữ liệu thật, biểu đồ, hàng đợi lệnh, vòng đời lệnh, audit | bật/tắt nhánh trên simulator: queued → confirmed, bản đồ đổi màu, có nhật ký |
| **M5 Cảnh báo** | rules-worker, trang cảnh báo, chuông, thông báo Telegram/Zalo | cảnh báo tự mở/đóng; bộ đếm lỗi = cảnh báo hiện hữu |
| **M6 Lịch & đồng bộ hàng loạt** | lịch zone, lịch thiên văn, batch + tiến độ + gửi lại, nhật ký đồng bộ | đồng bộ 1 zone 1.000 tủ simulator có tiến độ + kết quả từng tủ |
| **M7 Sự cố** | danh sách, chi tiết, luồng xử lý, ảnh, báo cáo, Excel | luồng đầy đủ một sự cố từ cảnh báo |
| **M8 Tài sản GIS & quản trị** | tuyến/trụ/đèn, chế độ chỉnh sửa, sinh trụ, trang quản trị đầy đủ | |
| **M9 Tiết giảm & đèn** (UI trước firmware) | hồ sơ dim, xem trước, ước tính tiết kiệm; tab đèn | lưu được; gửi bị chặn đúng `capability_unsupported` |
| **M10 Thử với tủ thật** | tủ trên bàn nối broker local (port-forward modem) hoặc VPS thử | frame thật hiển thị, lệnh PMAN/PLN → Q2/Q3 đổi |
| **M11 VPS & vận hành** | compose prod, Caddy HTTPS, backup, monitoring, runbook, E2E Playwright | khôi phục backup thành công; uptime monitor |

Test với tủ thật: tủ đi 4G nên không vào được laptop sau NAT → cần port-forward 1883 trên modem văn phòng (và IP/DDNS) **hoặc** thuê VPS sớm cho M10.

---

## 17. Việc firmware cần làm để web đầy đủ (backlog)

| Ưu tiên | Việc | Board | Mở khóa |
|---|---|---|---|
| **P0 trước 10k** | Topic riêng từng tủ + QoS 1 + user/pass + client ID = LTID (+ LWT) | LTE | an toàn + đồng bộ hàng loạt |
| P1 | Bật `PDOR`/`PFLT` | LTE | cảnh báo cửa, contactor |
| P1 | Gửi bộ đếm năng lượng + S/Q/Hz từ đồng hồ DH | LTE (PM đã đọc 60 thanh ghi) | tab Năng lượng, Giám sát đầy đủ |
| P1 | Gửi ICCID / CSQ / nhà mạng | LTE | tab Thông tin |
| P1 | Đọc lại lịch đang chạy trong LOGO + gửi lên | PLC + LTE | shadow lịch, READ_ALL |
| P2 | Tín hiệu mất LOGO riêng | PLC + LTE | trạng thái lỗi chính xác |
| P2 | cosφ có dấu (bỏ u32) | LTE | |
| P2 | Gửi `fw_version` trong frame | LTE | tự nhận capability |
| P3 | TLS 8883 | LTE | mã hóa |
| sau | Dim / đèn thông minh | phần cứng mới | tiết giảm, tab Đèn |

---

## 18. Giả định & câu hỏi mở

- `LGPS` định dạng, `LACI` nghĩa, `MPOW` đơn vị: cần frame mẫu thật + xác nhận firmware.
- Ánh xạ pha ↔ nhánh N1/N2 cho cảnh báo không tải: cấu hình theo tủ, mặc định chưa đặt.
- Phân cấp tổ chức (organization / management unit / area / ward / zone) là đề xuất; điều chỉnh khi có khách hàng cụ thể.
- Multi-tenant (nhiều khách hàng trên một server): **chưa làm**, nhưng mọi bảng có `organization_id` để mở sau.
- License EMQX: 1 node miễn phí (BSL ≥ 5.9); nếu bán server kèm sản phẩm phải xem lại.
