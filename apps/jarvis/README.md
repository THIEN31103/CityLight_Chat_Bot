# Jarvis — trợ lý điều hành CityLight

Trợ lý tiếng Việt (chữ, sau này cả giọng nói) cho phòng điều hành. App riêng `apps/jarvis`, **không sửa** `apps/api`, `apps/workers`, `apps/web`, `packages/db`, `infra/`; chỉ nói chuyện với server qua `/api/v1` (và socket.io từ milestone 2) bằng phiên đăng nhập của chính người điều hành.

Đặc tả: `E:\CITY_LIGHT\chat_box\PROMPT_JARVIS_GOP.md`. Tài liệu này ghi những gì **đã đối chiếu với code** (`main` 018b276) và chỗ lệch với đặc tả. Code thắng.

## Trạng thái

| Milestone | Nội dung | Trạng thái |
|---|---|---|
| 1 | Khảo sát API, khung app, config, api-client, SQLite, fake + Ollama provider, sanitize | **xong code, unit test, chạy với stack local** (2026-11-12), **đo LLM** (2026-11-14); chưa đo STT / TTS (xem "Còn thiếu") |
| 2 | Console chat chữ, tool đọc, system prompt, lịch sử, quyền dùng Jarvis, trần token | **xong, chờ duyệt** (2026-11-14): 130 unit test, chạy với stack local + `qwen3:4b-instruct` (xem "Milestone 2") |
| 3 | Giọng nói | chưa |
| 4 | Guard + hành động | chưa |
| 5 | Proactive, briefing, trial (hỏi Bảo trước) | chưa |

## Quyết định khác đặc tả

| # | Đặc tả | Đã chốt | Lý do |
|---|---|---|---|
| D1 | G9: Claude `claude-haiku-5-5` mặc định | **LLM miễn phí chạy trên máy qua Ollama**, mặc định `qwen3:4b-instruct` (đã đo, xem "Số đo") | Đức Thiện chốt 2026-11-10: không dùng API trả phí. Interface `LlmProvider` giữ nguyên để thêm Claude sau |
| D2 | Xưng hô theo cấu hình | Jarvis xưng "tôi", gọi người dùng là **"bạn"** | Đức Thiện chốt |
| D3 | PTT (giữ Space) | **Một nút bật / tắt chế độ giọng nói**; khi bật, VAD tự nhận hết câu. Không wake word | Đức Thiện chốt |
| D4 | SQLite: `node:sqlite` hoặc `better-sqlite3` | **`node:sqlite`** (có sẵn trong Node 22, không cần build native trên Windows) | Node in `ExperimentalWarning`; script tắt bằng `--disable-warning=ExperimentalWarning`. Vitest 2 không nhận `node:sqlite` khi import tĩnh nên `store/db.ts` nạp bằng `createRequire` |
| D5 | Trần token / ngày (G8) | Đếm **tổng mọi người dùng** trong ngày giờ VN | Đặc tả không nói theo người hay toàn hệ thống; tổng là cách giữ chi phí / tải máy chắc nhất. Đổi được ở milestone 2 |
| D6 | Tài khoản demo | **manager** do Bảo cấp (milestone 5) | Đức Thiện chốt |
| D7 | Console Vite + TS | **HTML + CSS + ES module thuần** trong `console/`, không bước build | Một trang nhỏ, ít phụ thuộc; server phục vụ thẳng. Đổi sang Vite khi console lớn hơn (giọng nói, milestone 3) |
| D8 | System prompt tiếng Việt, LLM tự chọn tool, 20 lượt ngữ cảnh | Prompt **tiếng Anh** (trả lời vẫn tiếng Việt), **bộ định tuyến từ khóa** chạy tool đọc trước khi gọi model, **8 tool** thay vì 11, gửi model **6 tin gần nhất** (ngữ cảnh vẫn giữ 20) | Đo trên `qwen3:4b-instruct`: prompt Việt dài → đúng tool 3 / 8 và bịa số; prompt Anh ngắn → 7 / 8; có lịch sử dài model lại bịa. Router + nhắc lại một lần → 7 / 7 câu dữ liệu đúng tool (xem "Milestone 2") |
| D9 | Lịch sử thời gian bật / tắt | Suy ra từ công suất (`get_cabinet_history`), nói "khả năng" | API không có lịch sử `LQ2` / `LQ3` (chỗ lệch 3) |

## API đã xác minh (đọc từ code)

Base `…/api/v1` (`apps/api/src/main.ts` `setGlobalPrefix('api/v1')`). Lỗi luôn là RFC 9457: `{ type, title, status, detail, code, params? }` (`infra.ts` `problem()`, `errors.ts`), lỗi zod → `422 invalid_request`.

### Đăng nhập (`apps/api/src/auth.ts`)

| Bước | Request | Kết quả |
|---|---|---|
| Đăng nhập | `POST /auth/login` `{ email, password, remember? }` (public, 20 lần / phút / IP) | không 2FA: `{ requires2fa:false, user }` + cookie `cl_sid` (httpOnly) và `cl_csrf`; có 2FA: `{ requires2fa:true }` + cookie `cl_2fa` (path `/api/v1/auth`, 5 phút) |
| 2FA | `POST /auth/2fa/verify` `{ code: 6 số }` hoặc `{ recoveryCode }` | `{ user }` + `cl_sid`, `cl_csrf` |
| Ai đang đăng nhập | `GET /auth/me` | `User` (`packages/shared/src/domain.ts`): `id, email, fullName, role, scopeAll, scopeAreaIds, totpEnabled, totpRequired, lang…` |
| Xác thực lại | `POST /auth/reauth` `{ code }` | mở cửa sổ 300 s cho route `@RequireReauth` (`403 reauth_required`) |
| Đăng xuất | `POST /auth/logout` | 204, xóa cookie |

- **CSRF**: mọi method khác GET / HEAD / OPTIONS phải có header `x-csrf-token` = cookie `cl_csrf` → không có thì `403 csrf_failed`.
- Sai mật khẩu / 2FA 5 lần → khóa 15 phút (`423 account_locked`). Phiên 12 h (Jarvis gửi `remember:false`).
- Role có `cabinet.control` (operator, manager, admin) **bắt buộc 2FA** trừ khi server đặt `AUTH_REQUIRE_2FA=false`. Chưa bật 2FA → mọi route trả `403 totp_setup_required`, socket bị ngắt. Console phải bảo người dùng bật 2FA trên web trước.

### Quyền theo role (`packages/shared/src/permissions.ts`)

| | admin | manager | operator | viewer | maintenance |
|---|---|---|---|---|---|
| Phạm vi tủ | tất cả | tất cả | khu vực được giao | khu vực | khu vực |
| `alarm.view` (`/alarms`, `/alarm-rules`) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `cabinet.control` (lệnh từng tủ) | ✓ | ✓ | ✓ | | |
| `alarm.ack` | ✓ | ✓ | ✓ | | |
| `batch.run` (lô lệnh) | ✓ | ✓ | ✓ | | |
| `log.view` (`/commands`, `/command-batches`) | ✓ | ✓ | ✓ | | |
| `incident.view` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `system.view` (`/system/stats`) | ✓ | | | | |
| `device.identity` (thấy LTID) | ✓ | | | | |

### Đọc

| Endpoint | Quyền | Ghi chú đã kiểm |
|---|---|---|
| `GET /map/stats` | đăng nhập | `{ cabinets:{offline,fault,dimming,on,off,unknown,total}, onlinePct, overdueIncidents, energyTodayKwh:null }` theo phạm vi |
| `GET /search?q=` | đăng nhập | ≥ 2 ký tự, tối đa 10, tìm tên / mã / địa chỉ; `CabinetSummary` |
| `GET /cabinets/:id` | đăng nhập | `{ cabinet, state, capabilities, schedule, thresholds }`. **`cabinet.imei`, `simIccid` trả cho mọi role** (chỉ `ltid` bị lọc theo role) |
| `GET /cabinets/:id/diagnostics` | đăng nhập | `{ items, lastBootAt, bootsLast24h, selfTest }`, chữ theo `lang`; **PLGO chỉ có ở đây** (`state` không có `logoLink`) |
| `GET /cabinets/:id/telemetry?metrics=&from=&to=` | đăng nhập | metric chỉ có `vL1..3, iL1..3, pTotalKw, pfTotal, leakMa, tempC`; mặc định 6 h; ~300 điểm; > 7 ngày lấy bảng giờ |
| `GET /cabinets/:id/alarms?limit=` | đăng nhập | ≤ 100 |
| `GET /cabinets/:id/commands?limit=` | đăng nhập | ≤ 200, `Command` (`requestedBy` = **email** người gửi) |
| `GET /alarms?active=true&severity=&type=&district=&from=&to=&page=&size=` | `alarm.view` | `Page<Alarm>`, `size` ≤ 200 |
| `GET /alarm-rules` | `alarm.view` | `{ type, code, title, severity, condition, enabled, thresholdDefault }[]` theo `lang` |
| `GET /areas/tree` | đăng nhập | `{ areas:{id,name,parentId,kind,cabinetCount}[], unassigned }` |
| `GET /areas/:id/cabinets` | đăng nhập | **chỉ khớp `ward_id`** (id quận trả mảng rỗng) |
| `GET /zones/:id/schedule` | `map.view` | id **vùng** (zone), không phải khu vực |
| `GET /incidents` | `incident.view` | phân trang |
| `GET /commands/:id` | đăng nhập + phạm vi | `Command` |
| `GET /server-time`, `GET /health` | public | |
| `GET /system/stats` | `system.view` (chỉ admin) | không dùng cho role khác |

Lỗi khi đọc một tủ: `404 not_found` (không có) hoặc **`403 forbidden_scope`** (ngoài khu vực) — `cabinets.ts` `assertCabinet`.

### Lệnh (milestone 4 mới dùng; đọc để thiết kế guard)

- `POST /cabinets/:id/commands` (`cabinet.control`, 202) `{ type, params }` + header `Idempotency-Key` (8–100 `[\w-]`). Type + params: `MANUAL_ALL {on}`, `MANUAL_BRANCH {branch:1|2, on}`, `AUTO {}`, `PULSE_ON {}`, `DIAG {}`.
- Từ chối ngay: `409 cabinet_offline`, `cabinet_unsafe_firmware` (1307ebc), `capability_unsupported`, `cabinet_decommissioned`, `idempotency_conflict`; `429 too_many_commands` (30 / phút / user), `429 cabinet_busy` (5 lệnh chờ / tủ); `422 invalid_params`.
- Trạng thái: `queued → sent → acked → confirmed`, hoặc `acked_unconfirmed`, `failed`, `timeout`, `cancelled`. Chỉ `confirmed` mới là "đã sáng / đã tắt".
- Lô lệnh (`schedules.ts`, `batch.run`): `POST /command-batches/preview` rồi `POST /command-batches` với `{ kind:'control', command:{ type, params }, zoneIds:[uuid], codes:"DM0001 DM0002", otp }`. Type lô chỉ `MANUAL_ALL, MANUAL_BRANCH, AUTO, PULSE_ON` (không có `DIAG`). Đích là **vùng (zone) hoặc chuỗi mã tủ**, không phải khu vực. OTP kiểm bằng TOTP hiện tại.
- `POST /alarms/:id/ack` (`alarm.ack`): đã ack rồi → `404 no_unacked_alarm`.

### Realtime (`apps/api/src/realtime.ts`)

Path `/socket.io`, xác thực bằng cookie `cl_sid` trong handshake. Sự kiện: `cabinet.state`, `alarm.raised`, `alarm.cleared`, `command.updated`, `batch.progress`. Server lọc theo khu vực và bỏ LTID trước khi gửi.

## Chỗ lệch với đặc tả (cần biết khi làm tiếp)

1. **Tủ ngoài khu vực trả `403 forbidden_scope`**, không phải "not found" (đặc tả mục 11). Tìm kiếm thì không trả tủ đó. Jarvis nói "không thấy tủ trong phạm vi của bạn" cho cả hai.
2. **IMEI và ICCID** có trong `/cabinets/:id` cho mọi role → `sanitizeForLlm` bỏ (đã test).
3. **Không có lịch sử trạng thái nhánh** (`LQ2` / `LQ3`) qua API: telemetry chỉ có điện áp, dòng, công suất, rò, nhiệt. Câu "tối qua tủ 3 bật lúc mấy giờ" chỉ suy ra được từ công suất / dòng tăng ("khả năng bật lúc…") hoặc từ lệnh đã gửi. Muốn chính xác cần API mới (ví dụ lịch sử `branch1_on/branch2_on`) — **đề xuất, không tự thêm** (G1). Cần Bảo quyết.
4. `Command.requestedBy` là email → lọc trong sanitize (đã test).
5. Lô lệnh nhắm vào vùng hoặc mã tủ, không nhắm khu vực: `propose_batch_control(area)` phải đổi khu vực → danh sách mã qua `/areas/:id/cabinets` (chỉ phường).
6. `/areas/:id/cabinets` chỉ nhận id phường.
7. Lịch bật lại sau khi tắt tay: lấy từ `schedule` trong `/cabinets/:id` (đã gộp lịch vùng), không cần `/zones/:id/schedule`.
8. Có trạng thái lệnh `acked_unconfirmed`: Jarvis phải nói "tủ đã nhận lệnh nhưng chưa thấy đèn đổi".

## Cấu trúc (milestone 1)

```text
apps/jarvis/
  .env.example         biến môi trường (copy thành .env, không commit)
  src/config.ts        đọc + kiểm env bằng zod; allowlist "DM0001..DM0010"
  src/api/client.ts    cookie trong bộ nhớ, CSRF, 2FA, reauth, Idempotency-Key, timeout, lỗi RFC 9457
  src/api/read.ts      các endpoint đọc ở bảng trên
  src/sanitize/llm.ts  G6: bỏ LTID, IMEI, ICCID, email, SĐT, frame LTID'/LIME'/LUSR'/LPAS', khóa bí mật; làm tròn tọa độ
  src/store/db.ts      SQLite: access, conversations, messages, settings, token_usage; dọn lịch sử
  src/brain/llm.ts     interface LlmProvider + factory
  src/brain/providers/ollama.ts  LLM miễn phí trên máy (/api/chat, stream NDJSON, tool calling)
  src/brain/providers/fake.ts    provider giả cho test (mục 5.6)
  src/main.ts          tiến trình: config, DB, audit, dọn lịch sử, console server
  src/console/         server.ts (trang + API + SSE chat), session.ts (phiên console, giới hạn câu / phút)
  src/brain/           agent.ts (vòng tool), router.ts (từ khóa → tool), context.ts (ngữ cảnh ca), system-prompt.ts
  src/tools/           registry.ts (bọc tool: kiểm input, timeout, sanitize, rút gọn), read.ts (8 tool đọc), names.ts (tên nói → mã tủ)
  src/store/           access.ts (G4), history.ts (G7), settings.ts (G8)
  src/audit/log.ts     audit JSONL
  console/             index.html, style.css, app.js (không build)
  scripts/smoke.ts     chạy thử với API thật: đăng nhập, đọc, kiểm sanitize (JARVIS_SMOKE_QUERY = từ khóa tìm tủ)
  scripts/bench-llm.ts đo độ trễ + chọn đúng tool của model đang cấu hình
  test/                vitest; stub-api.ts giả lập phần API mà client dùng
```

`data/` (jarvis.db, audit) và `.env` đã nằm trong `.gitignore` gốc.

## Chạy

```bash
cp apps/jarvis/.env.example apps/jarvis/.env      # rồi sửa
npm run start -w @citylight/jarvis                 # http://127.0.0.1:8790/health
npm test -w @citylight/jarvis                      # unit test
npm run typecheck -w @citylight/jarvis
```

Chạy thử với API thật (stack local, tài khoản test):

```bash
JARVIS_SMOKE_EMAIL=... JARVIS_SMOKE_PASSWORD=... npm run smoke -w @citylight/jarvis -- 123456
```

### Stack local trên máy Đức Thiện

Docker chỉ có **trong WSL2 Ubuntu** (không có trên Windows, không có Docker Desktop). Máy ảo WSL tự tắt khi không còn tiến trình `wsl.exe` nào, kéo theo các container, nên giữ một phiên WSL mở suốt lúc test.

```bash
wsl.exe -d Ubuntu -- sleep 7200                                     # giữ WSL sống (để chạy nền)
node infra/scripts/gen-emqx-acl.mjs
wsl.exe -d Ubuntu -- bash -lc "cd /mnt/e/CITY_LIGHT/server_citylight && docker compose -f infra/docker-compose.yml --env-file infra/.env up -d"
node --env-file=.env --import tsx packages/db/src/migrate.ts
cd apps/api && node --env-file=../../.env --import tsx src/main.ts  # API :3000 (chạy từ apps/api: cần tsconfig decorators)
cd apps/workers && node --env-file=../../.env --import tsx src/ingest.ts
cd apps/workers && node --env-file=../../.env --import tsx src/command-worker.ts
cd apps/simulator && node --env-file=../../infra/.env --import tsx src/index.ts --count 20   # tủ giả cần tài khoản thiết bị ở infra/.env
```

Fleet giả local có mã `TL01.xxxx` (không có `DM00xx` như trial): `JARVIS_SMOKE_QUERY=TL01`. Role manager / operator bắt buộc 2FA, nên chạy smoke bằng một tài khoản test có 2FA (cách các e2e của repo làm: tạo `*@e2e-….citylight.test`, bật 2FA qua API, xóa khi xong).

Đo LLM (cần Ollama đang chạy và đã `ollama pull qwen3:4b-instruct`):

```bash
npm run bench:llm -w @citylight/jarvis -- 3
```

## Kiểm thử đã chạy (milestone 1)

- `vitest`: 46 test Jarvis pass (config, sanitize, api-client trên stub, fake + Ollama wire format, store); toàn repo 245 / 245.
- `tsc --noEmit` sạch.
- `main.ts` chạy, `/health` trả `{ status:"ok", llm, api, schema:1 }`.
- `scripts/smoke.ts` chạy với stub: đăng nhập 2FA, đọc, sanitize không còn LTID / IMEI / ICCID.
- **2026-11-12, API thật** (stack local trong WSL, 510 tủ trong DB, 20 tủ giả đang gửi): tài khoản manager test bật 2FA qua API, rồi smoke 14 / 14 bước ok — health, login → challenge, 2fa/verify, me, map/stats (510 tủ), alarms (37 đang mở), alarm-rules (37 mã), areas/tree (102), search `TL01`, chi tiết tủ (2084 B), diagnostics (12 mục), telemetry, sanitize (2014 B, không còn LTID / IMEI / ICCID), logout. Mỗi lần đọc 6–40 ms. Tài khoản test đã xóa.

## Milestone 2 — console chữ

Mở `http://127.0.0.1:8790`, đăng nhập bằng tài khoản CityLight (2FA nếu có).

- **Chat**: trả lời chạy dần (SSE), trạng thái "đang nghĩ / đang tra cứu: …", nút Dừng, cuộc chat mới, danh sách cuộc chat của mình (xem lại, xóa). Dòng cố định "Quản trị viên có thể xem nội dung chat".
- **Tool đọc** (`src/tools/read.ts`, 8 tool): tổng quan, tình trạng tủ, lịch sử tủ, cảnh báo gom theo mã + quận, giải thích mã, tủ theo khu vực, lịch, sự cố. Tên nói ra ("tủ demo số mười", "demo10", "DM10") → `src/tools/names.ts`. Nhiều tủ khớp → hỏi lại. "Tủ đó" → tủ đang nói tới.
- **Bộ định tuyến** (`src/brain/router.ts`): câu rõ ý (mã E…, sự cố, cảnh báo theo quận, tình hình hệ thống, tủ X bị gì / lịch / tối qua) → code gọi tool trước. Câu dữ liệu mà model vẫn trả lời không qua tool → hủy bản nháp, nhắc lại một lần (`TOOL_NUDGE`).
- **Quản trị** (tab Quản trị): cấp quyền dùng Jarvis theo luật G4 (`src/store/access.ts`), cấu hình (câu / phút, trần token, ngày giữ lịch sử, công tắc điều khiển), lịch sử chat người khác (mỗi lần xem ghi audit), token theo người.
- **Audit** `data/audit/YYYY-MM-DD.jsonl`: đăng nhập, câu hỏi, câu trả lời, tool, đổi quyền / cấu hình, xem chat người khác. Không có mật khẩu, mã, cookie, LTID, IMEI, email.
- **Bảo mật console**: cookie `jv_sid` HttpOnly + SameSite=Strict, CSRF riêng (`x-jarvis-csrf`), kiểm Origin, CSP chỉ cho `self` + Google Fonts, chỉ nghe 127.0.0.1 trừ khi có token.

### Chạy thử với model thật (2026-11-14, stack local, 20 tủ giả, API chạy `AUTH_REQUIRE_2FA=false` để admin local chưa có 2FA đăng nhập được)

| Câu hỏi | Tool | Thời gian | Câu trả lời (rút gọn) |
|---|---|---|---|
| Xin chào Jarvis | — | 3,9 s (nạp model) | Chào, giới thiệu |
| Hệ thống thế nào rồi? | get_system_overview | 5,9 s | 510 tủ, 19 hoạt động, 491 mất kết nối, 486 cảnh báo, chủ yếu E101 |
| Tủ TL01.0009 bị gì? | get_cabinet | 6,1 s | Đang tắt, rò 10 mA, không cảnh báo |
| Lịch bật tắt của tủ đó thế nào? | get_schedule | 5,7 s | 18:00 – 05:45, lịch cố định |
| Quận nào đang có nhiều cảnh báo nhất? | list_alarms | 4,3 s | Quận 3 (20 tủ E101), Quận 7, Phú Nhuận |
| Mã E201 nghĩa là gì? | explain_alarm_code | 5,0 s | Mất kết nối PLC_KEY, điều kiện LCLI=1 PCON=0 |
| Tối qua tủ TL01.0016 bật lúc mấy giờ? | get_cabinet_history | 6,9 s | Không xác định được, công suất luôn ~0,1 kW |
| Có sự cố nào quá hạn không? | list_incidents | 2,5 s | Không có |

Trước router + prompt Anh, cùng bộ câu: 0 – 3 / 7 gọi tool, có câu bịa số ("156 tủ"). `/alarms` trả tối đa 200 dòng một trang nên nhóm cảnh báo theo quận chỉ tính trên 200 cảnh báo mới nhất (tổng vẫn đúng).

## Số đo LLM (2026-11-14, `scripts/bench-llm.ts`, 4 câu × 3 lượt, chế độ chữ)

Ollama 0.40.16 cài ở `E:\ollama\app`, model ở `E:\ollama\models` (biến người dùng `OLLAMA_MODELS`). Prompt hệ thống ngắn + 2 tool, ngữ cảnh 4096.

| Model | Chữ / tool đầu tiên p50 | Trọn câu p50 / p95 | Đúng tool | Ghi chú |
|---|---|---|---|---|
| `qwen3:4b` | 258 ms | **63 s** / 76 s | 3 / 6 | Bản Thinking-2507: `think=false` và `/no_think` **không** tắt được, model suy nghĩ bằng tiếng Anh tới 1024 token. Không dùng được |
| **`qwen3:4b-instruct`** | **150 ms** | **1,9 s** / 2,0 s | **6 / 6** | Trả lời thẳng, tiếng Việt tự nhiên. Lần đầu nạp model ~7 s |

- Đạt mục tiêu chế độ chữ mục 9 (chữ đầu tiên p50 ≤ 1,5 s). Câu cần tool: thời gian trên chỉ tính tới lúc model gọi tool, chưa cộng thời gian API + lượt trả lời thứ hai (đo ở milestone 2).
- Model 3,5 GB với ngữ cảnh 4096 không vừa GPU 4 GB: ~34 % chạy trên CPU, ~20 token/s. Ngữ cảnh 2048: 28 % CPU, ~24 token/s, chỉ nhanh hơn chút → giữ 4096 cho kết quả tool. Lúc chạy máy còn ~760 MB RAM trống.
- Model đọc "tủ demo số mười" thành `{"cabinet":"demo10"}`: tool tìm tủ ở milestone 2 phải chuẩn hóa tên nói (số chữ → số, bỏ khoảng trắng, thử mã `DM0010`) trước khi gọi `/search`.

## Còn thiếu (cần máy / quyết định)

- **Đo STT / TTS** (mục 9): cần `faster-whisper` + thư viện CUDA (~1–1,5 GB) + model, `edge-tts`. Chưa cài. STT sẽ phải chia 4 GB VRAM với LLM.
- Câu trả lời 2,5 – 7 s (2 lượt model, ~1,9 K token prompt, 1 / 3 model chạy CPU). Mục 9 đặt chữ đầu ≤ 1,5 s: lượt có router đạt ~0,5 – 2 s; GPU lớn hơn hoặc model nhỏ hơn sẽ nhanh hơn.

## Phần cứng máy hiện tại

RTX 3050 Laptop 4 GB VRAM, RAM 7,7 GB, i7-11800H, ổ C còn ~19 GB (cài lên E:).

## Dữ liệu và bảo mật

- Cookie phiên chỉ nằm trong bộ nhớ, không ghi đĩa, không log. Không log mật khẩu, mã 2FA / OTP, CSRF.
- LLM chạy trên máy (Ollama): dữ liệu tủ không ra ngoài. TTS `edge-tts` là dịch vụ cloud của Microsoft: câu Jarvis đọc sẽ đi qua đó (đã lọc theo G6).
- Thu quyền một manager **không** tự thu quyền những người manager đó đã cấp (mục 8.1, làm ở milestone 2).
