# Jarvis — trợ lý điều hành CityLight

Trợ lý tiếng Việt (chữ, sau này cả giọng nói) cho phòng điều hành. App riêng `apps/jarvis`, **không sửa** `apps/api`, `apps/workers`, `apps/web`, `packages/db`, `infra/`; chỉ nói chuyện với server qua `/api/v1` (và socket.io từ milestone 2) bằng phiên đăng nhập của chính người điều hành.

Hướng dẫn cho người dùng (Jarvis làm được gì, cách hỏi, cách ra lệnh): [KHA_NANG.md](KHA_NANG.md).

Đặc tả: `E:\CITY_LIGHT\chat_box\PROMPT_JARVIS_GOP.md`. Tài liệu này ghi những gì **đã đối chiếu với code** (`main` 018b276) và chỗ lệch với đặc tả. Code thắng.

## Trạng thái

| Milestone | Nội dung | Trạng thái |
|---|---|---|
| 1 | Khảo sát API, khung app, config, api-client, SQLite, fake + Ollama provider, sanitize | **xong code, unit test, chạy với stack local** (2026-11-12), **đo LLM** (2026-11-14); chưa đo STT / TTS (xem "Còn thiếu") |
| 2 | Console chat chữ, tool đọc, system prompt, lịch sử, quyền dùng Jarvis, trần token | **xong, chờ duyệt** (2026-11-14): 130 unit test, chạy với stack local + `qwen3:4b-instruct` (xem "Milestone 2") |
| 3 | Giọng nói | **xong, chờ duyệt** (2026-11-14): nút giọng nói, VAD, STT trên GPU + TTS Piper trên máy, đọc theo câu, barge-in; tiếng đầu ~0,3 – 0,5 s sau khi nói xong; còn đo độ đúng trên ghi âm thật |
| 4 | Guard + hành động | **phần 1 xong, chờ duyệt** (2026-11-15): lệnh từng tủ (bật / tắt / nhánh / về lịch / xung / chẩn đoán) qua lệnh chờ + xác nhận T1 / T2, allowlist, kill switch, theo dõi tới `confirmed`, audit, test tĩnh. **Chưa**: lô lệnh T3 + OTP, xác nhận cảnh báo, socket.io (đang hỏi lại `GET /commands/:id`), nhập lại 2FA khi `reauth_required` (xem "Milestone 4") |
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

## Milestone 3 — giọng nói

Nút **🎙 Giọng nói** trong ô chat bật / tắt chế độ giọng nói (D3). Khi bật: micro mở với khử vọng / khử ồn / tự chỉnh âm lượng của Chrome, VAD năng lượng tự tìm đầu và cuối câu (im ~650 ms), mỗi câu gửi lên `/api/voice` dạng PCM 16 kHz. Jarvis nghe → chữ → cùng luồng trả lời như chat chữ → **đọc từng câu ngay khi câu đó viết xong**. Nói chen > 250 ms khi Jarvis đang nghĩ / nói → Jarvis im ngay và nghe câu mới (barge-in).

```text
console/voice.js, mic-worklet.js   micro, VAD, chuyển 16 kHz, phát âm thanh theo thứ tự
src/voice/client.ts                SttProvider / TtsProvider -> sidecar HTTP
src/voice/speech-text.ts           chữ hiển thị -> chữ để đọc (giờ, đơn vị, mã lỗi, mã tủ); tách câu khi đang stream
src/console/speaker.ts             đọc theo câu, đúng thứ tự; giữ lại bản nháp chưa có tool; câu đệm "Để tôi kiểm tra."
voice/sidecar.py                   faster-whisper (STT) + Piper (TTS, mặc định) hoặc edge-tts, HTTP 127.0.0.1:8791
voice/requirements.txt             gói Python của sidecar
scripts/bench-voice.ts             20 câu mẫu mục 11: TTS -> STT -> router
```

### Cài và chạy sidecar (Windows, máy này)

```bash
py -3.11 -m venv E:/jarvis-voice/venv
E:/jarvis-voice/venv/Scripts/python.exe -m pip install -r apps/jarvis/voice/requirements.txt
cd E:/jarvis-voice/piper && ../venv/Scripts/python.exe -m piper.download_voices vi_VN-vais1000-medium
# chạy (model whisper tự tải lần đầu vào HF_HOME)
HF_HOME=E:/jarvis-voice/hf STT_MODEL=small STT_DEVICE=cuda STT_COMPUTE=int8_float16 TTS_ENGINE=piper \
  PIPER_VOICE=E:/jarvis-voice/piper/vi_VN-vais1000-medium.onnx \
  E:/jarvis-voice/venv/Scripts/python.exe -u apps/jarvis/voice/sidecar.py
```

GPU (khuyên dùng, lệnh trên): cần thêm `nvidia-cublas-cu12==12.4.5.8` và `nvidia-cudnn-cu12==9.1.0.70` (~1 GB; mạng chập chờn thì tải file .whl của cuDNN bằng `curl -C -` rồi `pip install` file đó). Sidecar tự thêm DLL của chúng vào PATH. Không có GPU: `STT_DEVICE=cpu STT_COMPUTE=int8` (2,2 s / câu).

### Quyết định

| # | Đặc tả | Đã chốt | Lý do |
|---|---|---|---|
| D10 | TTS `edge-tts` (cloud) | **Piper `vi_VN-vais1000-medium` chạy trên máy** (mặc định), edge-tts còn làm tùy chọn `TTS_ENGINE=edge` | 2026-11-14: edge-tts 7.0.2 bị dịch vụ từ chối (403); bản 7.3.1 trả "không có âm thanh" cho 8 / 12 câu tiếng Việt, mỗi lần lỗi mất ~2,6 s. Piper: 0,06 s / câu, miễn phí, không ra mạng |
| D11 | STT stream (partial) + Silero VAD | STT **cả câu** sau khi VAD trình duyệt báo hết câu; Silero VAD của faster-whisper (`vad_filter`) cắt im lặng | Đơn giản, đủ cho 1 – 2 câu ngắn; partial để sau nếu cần hiện chữ khi đang nói |
| D12 | Kết nối WebSocket cho audio | `POST /api/voice` (PCM) + SSE trả về (chữ + âm thanh base64 từng câu) | Cùng cơ chế với chat chữ, không thêm thư viện; câu Jarvis ngắn |
| D13 | — | Whisper hay "bịa" câu kiểu "Hãy subscribe kênh…" với tiếng rất ngắn: sidecar bỏ đoạn có `no_speech_prob` cao hoặc chứa các cụm đó | Đo: "Hủy." → câu quảng cáo YouTube |

### Số đo (2026-11-14, `npm run bench:voice`, giọng Piper đọc 20 câu mẫu, CPU i7-11800H)

| STT | Nghe 1 câu p50 / p95 | Gần đúng (≥ 80 % từ) | Router đúng tool từ câu nghe được |
|---|---|---|---|
| `small` int8 CPU 8 luồng | 2,2 s / 2,5 s | 12 / 20 | 10 / 12 |
| `base` int8 CPU | 0,7 s / 3,8 s | 10 / 20 | 8 / 12 |
| `small` int8_float16 GPU (RTX 3050 4 GB), beam 1 | 0,20 s / 0,40 s | 9 – 11 / 20 | 9 – 10 / 12 |
| **`small` GPU, beam 5 + câu gợi ý + lọc ồn** (mặc định từ 2026-11-14) | **0,27 s / 0,48 s** | **16 / 20** | **11 / 12** |

Bản mặc định: `STT_BEAM=5` trên GPU; câu gợi ý (`initial_prompt`) là những câu người điều hành hay nói, viết đúng chính tả; bỏ đoạn mà model tự nghi ngờ (`avg_logprob < -1.0`, chỉnh bằng `STT_MIN_LOGPROB`) hoặc lặp vòng (`compression_ratio > 2.4`). Ồn trắng, tiếng gõ phím, phòng im: 3 / 3 không thành chữ (trước đó một tiếng click từng ra "Chịp job."). Đánh đổi: từ rất ngắn "Hủy." bị bỏ — milestone 4 cần hủy bằng nút hoặc câu dài hơn ("hủy lệnh đó"). Console: tiếng < 550 ms không gửi đi, phải có tiếng ≥ 200 ms mới bắt đầu câu.

- **Mặc định nên dùng GPU** (`STT_DEVICE=cuda STT_COMPUTE=int8_float16`): nhanh gấp 10 CPU, chỉ ~430 MB VRAM. Đo cả khi LLM đang nằm trên GPU (tổng 2,7 GB / 4 GB): STT vẫn 0,2 s, LLM giữ nguyên 66 % GPU / 34 % CPU. Sidecar tự "làm nóng" CUDA lúc khởi động (lần đầu trước đó mất 1,5 s và nghe ra rỗng).
- Độ đúng như nhau giữa CPU và GPU (cùng model); khác biệt 10 – 12 / 20 là do giọng máy Piper khó nghe. Cần 20 câu ghi âm thật (mục 11) để đo đúng.
- TTS Piper: p50 0,05 – 0,06 s, p95 0,1 – 0,15 s mỗi câu.
- Cả vòng qua console với STT GPU (Piper đọc câu hỏi → `/api/voice` → tool → đọc trả lời):

| Câu nói | Nghe được | STT | Tiếng đầu sau khi STT xong | Cả câu trả lời |
|---|---|---|---|---|
| Hệ thống thế nào rồi? | "Hệ thống chiến nào rồi?" → get_system_overview | 0,17 s | 0,2 s (câu đệm) | 8,5 s |
| Tủ TL01.0009 bị gì? | "Tủ thề 01.000 chính bị gì?" → get_cabinet (vẫn ra đúng tủ) | 0,31 s | 1,9 s | 7,8 s |
| Quận nào đang có nhiều cảnh báo nhất? | đúng → list_alarms | 0,30 s | 0,1 s (câu đệm) | 6,7 s |
| Mã E hai không một nghĩa là gì? | "Mà E201…" → explain_alarm_code E201 | 0,27 s | 0,0 s (câu đệm sẵn) | 6,3 s |

  Người dùng nghe tiếng Jarvis (câu đệm) ~0,3 – 0,5 s sau khi nói xong: đạt mục 9 (≤ 2,5 s). Câu có nội dung đầu tiên ~2 – 3 s, toàn bộ câu trả lời 6 – 8 s: phần chậm còn lại là LLM (1 / 3 chạy CPU vì GPU 4 GB).
- Giọng Piper là giọng máy, khó nghe hơn người thật cho STT; đánh giá thật cần 20 câu ghi âm của Bảo (mục 11). Mã lỗi đọc từng chữ số ("E hai không một") được router ghép lại (`spokenAlarmCode`).

## Milestone 4 — chốt chặn + điều khiển (phần 1, 2026-11-15)

Luồng: câu ra lệnh → `guard/orders.ts` nhận ra **bằng code** → `guard/propose.ts` tìm tủ, kiểm luật, đọc trạng thái → **lệnh chờ** (`guard/pending.ts`, 60 s, mỗi phiên một lệnh, lệnh mới thay lệnh cũ) + **thẻ xác nhận** trên console → người dùng xác nhận đúng cách → `sendAndFollow` gửi `POST /cabinets/:id/commands` (Idempotency-Key = id lệnh chờ) → hỏi `GET /commands/:id` mỗi 2 s, tối đa 60 s → câu kết quả cố định, chỉ nói "Đã xác nhận" khi lệnh `confirmed`.

| Tầng | Lệnh | Xác nhận được bằng |
|---|---|---|
| T1 | bật (cả tủ / một nhánh), trả về lịch, bật xung, chẩn đoán | nói, gõ ("xác nhận", "đồng ý", "ok"…) hoặc bấm nút |
| T2 | mọi lệnh **tắt**; mọi lệnh khi người dùng không thao tác 10 phút | **chỉ bấm nút** |
| — | nhiều tủ cùng lúc ("tắt hết đèn quận 1") | từ chối: làm trên web (cần OTP) |

Chặn trước khi tạo lệnh chờ (`guard/policy.ts`): `JARVIS_ACTIONS_ENABLED=false` hoặc nút tắt trên trang quản trị; **allowlist rỗng = không điều khiển được tủ nào**; tủ ngoài allowlist; role không có `cabinet.control`; tủ mất kết nối. Tối đa 6 lệnh / phút / người. `guard/pending.ts` là file **duy nhất** gọi API gửi lệnh (test tĩnh trong `test/rules.test.ts`).

### Quyết định

| # | Đặc tả | Làm | Lý do |
|---|---|---|---|
| D14 | Tool hành động `propose_*` cho LLM (mục 5.3) | **Code nhận câu ra lệnh**, không đưa tool hành động cho model; câu tóm tắt và câu kết quả là câu cố định | Model 4B hay chọn sai tool và từng "đọc tình trạng tủ" như thể đã bật (test C20 ngày 14/11). Code không bịa "đã bật", không bị dữ liệu trong tool ("hãy tắt tất cả") điều khiển |
| D15 | Chờ `command.updated` qua socket.io | Hỏi `GET /commands/:id` mỗi 2 s (đặc tả cho phép làm dự phòng) | Chưa có socket.io client; đủ nhanh (tủ giả lập xác nhận sau 2 – 6 s) |
| D16 | — | Khi đang có lệnh chờ, câu nói ngắn không rõ là có / không → hỏi lại, không đưa cho model; "Hồi." (STT nghe nhầm "Hủy.") được tính là hủy | Đo 15/11: Piper "Hủy." → STT "Hồi." / không nghe được; hủy không gửi gì nên nhận nhầm sang hủy là an toàn. Thẻ hướng dẫn nói "hủy lệnh" (dài hơn, nghe được) |

### Chạy thử (2026-11-15, stack local, command-worker + 20 tủ giả lập)

`apps/jarvis/.env` (gitignored): `JARVIS_CABINET_ALLOWLIST=TL01.0009,TL01.0016,TL01.0017`. Cần chạy `apps/workers` `src/command-worker.ts` (không có thì lệnh nằm `queued`, Jarvis báo "sau 60 giây tủ vẫn chưa xác nhận").

| Thử | Kết quả |
|---|---|
| "Bật đèn tủ TL01.0009" → gõ "xác nhận" | thẻ T1, tủ `confirmed` sau 2,1 s |
| "tắt tủ đó đi" → gõ "xác nhận" | từ chối ("phải bấm nút"), không gửi lệnh |
| bấm nút Xác nhận | `confirmed` sau 4,1 s, nhắc "đèn sẽ tự bật lại theo lịch lúc 18:00" |
| nói "Bật đèn tủ đó lên" → nói "Xác nhận" (giọng Piper) | `confirmed` sau 4,8 s |
| tủ ngoài allowlist / "tắt hết đèn quận 1" | từ chối, không có thẻ |
| bộ test thật `jarvis-e2e-chat.mts` nhóm M (7 ca) | 7 / 7, tổng số lệnh gửi = số lần xác nhận hợp lệ |

## Chạy AI + nghe giọng trên Groq (2026-11-17, máy quá nặng)

Ollama (~3,5 GB) và Whisper trên GPU là hai phần nặng nhất. Groq có gói miễn phí không cần thẻ, API kiểu OpenAI, có gọi công cụ và Whisper `large-v3-turbo` (giới hạn 11/2026 theo các trang tổng hợp: AI ~1.000 câu / ngày, nghe giọng 8 giờ âm thanh / ngày; xem số thật trong trang quản lý Groq).

| # | Đặc tả / trước đây | Làm | Lý do |
|---|---|---|---|
| D17 | LLM chạy trên máy (Ollama) | Thêm `LLM_PROVIDER=groq` (`brain/providers/openai-compat.ts`); Ollama vẫn là mặc định, đổi bằng một dòng `.env` | Máy 7,7 GB RAM / GPU 4 GB không gánh nổi cả stack + model |
| D18 | STT trên máy (faster-whisper small, GPU) | Thêm `STT_PROVIDER=groq` (`voice/groq-stt.ts`, cùng câu gợi ý và bộ lọc "nghe bịa" như sidecar); sidecar chạy `STT_MODEL=none` chỉ còn đọc (Piper) | Bỏ được Whisper trên GPU; model lớn có thể nghe tiếng Việt tốt hơn bản small |

Dữ liệu ra ngoài máy: câu hỏi, câu trả lời, kết quả công cụ (đã lọc LTID / IMEI / email / số điện thoại theo G6) và âm thanh từng câu nói. Dữ liệu giả lập thì được; dữ liệu thật của khách cần khách đồng ý (mục 10). Khóa `GROQ_API_KEY` chỉ nằm trong `apps/jarvis/.env` (gitignored), chỉ gửi trong header `Authorization`, không ghi log.

```
# apps/jarvis/.env
LLM_PROVIDER=groq
GROQ_API_KEY=...            # tự dán, không commit
STT_PROVIDER=groq
# LLM_MODEL=openai/gpt-oss-20b   (mặc định khi để trống)
```

Sidecar chỉ đọc: chạy như cũ nhưng `STT_MODEL=none` (không cần `STT_DEVICE=cuda`).

### Đo thật (2026-11-17, tài khoản Groq miễn phí, stack local + 20 tủ giả lập)

- Giới hạn đọc từ header của Groq: **mỗi model 8.000 token / phút và 1.000 câu / ngày**; một câu hỏi của Jarvis tốn ~2.000 token → một model chịu ~4 câu / phút. Model dùng được: `openai/gpt-oss-20b`, `openai/gpt-oss-120b`, `qwen/qwen3.8-27b` (qwen **gọi công cụ sai** trên Groq nên không dùng).
- Khi một model hết lượt (429), câu chuyển sang model kế (`LLM_FALLBACK_MODELS`, mặc định `openai/gpt-oss-120b`); hết cả thì chờ số giây Groq yêu cầu (tối đa 15 s) rồi thử lại một lần.
- Bộ test thật `jarvis-e2e-chat.mts`: **72 / 72**; thời gian một câu p50 3,7 s, p90 15 s (p90 là lúc test hỏi dồn dập, phải chờ hạn mức). Lần chạy đầu, chưa xoay vòng model: 48 / 72 (hết lượt).
- Nghe giọng `whisper-large-v3-turbo`: 0,4 – 2,7 s mỗi câu, nghe "Mã E201 là gì?" đúng từng chữ; mạng chập chờn 2 / 8 lần lúc đầu → thử lại 1 lần khi lỗi mạng.
- Bộ nhớ khi chạy: Piper ~176 MB, Jarvis + API + worker + giả lập (node) ~250 MB, Docker trong WSL ~350 MB. Trước đây riêng Ollama ~3,5 GB và Whisper trên GPU ~1 GB.
- Sửa theo model mới: tên trường tiếng Việt trong kết quả công cụ (model chép chữ "offline", không hiểu "districts"), chỉ giữ câu của lượt cuối (một lần bị lặp câu), "Tôi không biết." trống trong khi công cụ có dữ liệu → hỏi lại model một lần (`DATA_NUDGE`).

## Sửa 2026-11-20: câu trả lời bị "đè", luật lẫn nhau

Bạn báo: AI trả lời, rồi một luật trong code xen vào, câu khác đè lên câu vừa hiện ("cho tui một mã tủ để điều khiển đi", 17/11 15:11).

| # | Nguyên nhân | Sửa |
|---|---|---|
| D19 | Chữ của model hiện ra ngay, code chỉ quyết định giữ / bỏ khi model viết xong (luật "câu hỏi dữ liệu mà chưa tra", "không biết" cụt, câu viết trước khi gọi công cụ) | `agent.ts`: câu hỏi cần dữ liệu mà chưa có dữ liệu thì **không hiện** gì của model; có dữ liệu rồi thì giữ 40 ký tự đầu (`SHOW_AFTER`) rồi mới chạy chữ; chào hỏi chạy chữ ngay. Bản nháp bị bỏ không bao giờ lên màn hình |
| D20 | Hướng dẫn model còn câu cũ "chỉ đọc được dữ liệu, muốn bật / tắt thì làm trên web" — trái với code (milestone 4) | Hướng dẫn mới: bật / tắt do code Jarvis lo và luôn hỏi xác nhận; model chỉ chỉ cách ra lệnh, không bao giờ nói đã bật hay không bật được. Câu cố định dự phòng sửa theo |
| D21 | "Tủ nào điều khiển được?" không có công cụ nào trả lời | `isAllowedCabinetsQuestion` → câu cố định liệt kê danh sách tủ được phép (hoặc lý do đang tắt điều khiển) |
| D22 | Gói miễn phí Groq 8.000 token / phút / model, mỗi câu ~2.000 token, 65 % là mô tả 8 công cụ | Router đã tra dữ liệu thì lượt đầu **không gửi danh sách công cụ**: còn ~900 – 1.300 token / câu, trả lời 0,8 – 1,2 s |
| D23 | Sau D22, model muốn gọi công cụ trong lượt không có danh sách công cụ → Groq từ chối cả câu: "Tool choice is none, but model called a tool" (người dùng báo, "khu vực nào cũng được đi") | Gặp lỗi đó thì hỏi lại đúng lượt ấy kèm công cụ (`TOOL_NOT_OFFERED`); lỗi khác vẫn báo như cũ |
| D24 | "Liệt kê 10 tủ đang hoạt động bình thường" → model hỏi lại khu vực vì `get_area_cabinets` bắt buộc khu vực | `get_area_cabinets`: khu vực không bắt buộc (bỏ trống = toàn hệ thống, lấy từ `map/cabinets`), thêm lọc `state` (binh_thuong = có kết nối, không lỗi; dang_sang; dang_tat; co_loi; mat_ket_noi) và `limit`. Router tự tra cho câu "liệt kê / danh sách / tủ nào / N tủ" + trạng thái, trừ câu "bao nhiêu" và câu có tên khu vực. "khu vực nào cũng được" không còn bị hiểu là hỏi danh sách khu vực |
| D25 | "quận 1" khớp cả Quận 1, Quận 10, Phường 1 → hỏi lại | Người dùng nói "quận / huyện" hay "phường / xã" thì chọn đúng loại khu vực |
| D26 | "Tại sao tủ TL12.0006 không điều khiển được" → model đọc `capabilities` của tủ và nói tủ đó "thực tế cũng điều khiển được" | Bỏ `capabilities` khỏi kết quả `get_cabinet`; hướng dẫn model có danh sách tủ được phép (do quản trị đặt, tủ khác điều khiển trên web). Câu từ chối của code nêu luôn danh sách và lý do |
| D27 | "10 tủ đang bị lỗi" khi không có tủ lỗi → "Không biết." (cả sau DATA_NUDGE) | Lọc trạng thái không ra tủ nào thì kết quả ghi rõ "Không có tủ nào có lỗi. Hiện có: …"; "không biết" trần lần hai → câu cố định `DATA_FAIL_ANSWER` |
| D28 | "TL07.0013 mất kết nối từ khi nào" → "Không biết thời điểm" (tủ chưa từng kết nối, lastSeen null); model viết chữ "online" | `lastSeen` null → "chưa từng gửi dữ liệu lên hệ thống"; khóa trạng thái đổi sang tiếng Việt (`ket_noi`, `plc`, `dong_ho_dien`, `cua_tu`) |
| D29 | "Bạn có thể liệt kê các tủ như nào" → model liệt kê lại tủ của câu trước | `isListHowQuestion` → câu cố định nói cách hỏi; router không tra danh sách cho câu hỏi "như nào / thế nào" |
| D30 | Thử giọng thật 21/11 (14 câu): Groq viết mã tủ đủ kiểu — "TL1 số 16", "TL01.00016", "TL1.0009", "H1TL1.0009", "TL1009" — code không hiểu | `normalizeCodes` đưa về dạng thật `TL01.0016` trước khi router, bộ đọc lệnh và tra tủ dùng; "TL1009" mơ hồ (TL01.0009 / TL10.0009) thì tra cả hai, có cả hai thì hỏi lại; "H1" = "nhánh 1" |
| D31 | Jarvis hỏi "tắt … ở tủ nào?", bạn chỉ nói mã tủ → câu đó sang AI, AI tự hỏi "nhánh 1 hay nhánh 2?" / "có muốn tắt…?" và "có" không xác nhận gì | Code nhớ lệnh vừa hỏi 60 giây (`askedCabinet`), một lần: câu trả lời có mã tủ hoàn tất lệnh, nhánh nói kèm thì theo nhánh đó. Hướng dẫn AI: không tự hỏi xác nhận bật / tắt |
| D32 | "Tắt nhánh một tủ …" bị hiểu là tắt cả hai nhánh ("một" đứng một mình không thành số) | `branchOf`: "nhánh một / hai" là nhánh đó, "cả hai nhánh", "nhánh một và nhánh hai" là cả hai |
| D33 | "Có, tủ TL01.0009 đang sáng" rồi "tắt hai nhánh của tủ đó" → Jarvis không biết "tủ đó" | Danh sách tủ nhớ các tủ vừa đưa (không gửi cho AI); câu trả lời nhắc đúng một tủ thì tủ đó thành "tủ đó". Khóa `nhanh_1` / `nhanh_2` / `che_do` tiếng Việt (AI viết "Branch 1") |
| D34 | So 6 cách nghe của Groq trên chính 14 bản ghi: turbo / large-v3 × gợi ý dài / ngắn / không | **Giữ turbo + gợi ý dài**: đúng nhất; gợi ý ngắn bịa chữ ("Tắt, xác nhận, hủy lệnh"), không gợi ý thì "TL" thành "Đây là", câu ngắn thành quảng cáo YouTube; large-v3 không hơn. Âm lượng micro ổn (−19 đến −29 dB) |
| D35 | Bạn muốn xác nhận lệnh tắt bằng giọng (thử giọng 21/11). Đặc tả cũ: lệnh tắt (T2) chỉ bấm nút | **Đổi theo yêu cầu, lệch đặc tả 6.x:** T2 nhận câu nói / gõ **đúng chữ** "xác nhận" hoặc "đồng ý" (`isExplicitConfirm`, chỉ thêm từ đệm); "ok", "có", "được", "làm đi" vẫn chỉ xác nhận T1. Nên báo Bảo |
| D36 | "Liệt kê 39 tủ mất kết nối" → lỗi đỏ: Groq kiểm `maximum: 30` trong schema và từ chối cả câu | Bỏ `maximum` khỏi schema công cụ, giới hạn trong code (danh sách tủ tối đa 50); lỗi "Tool call validation failed" thì báo lại AI một lần (`TOOL_ARGS_REFUSED`) |
| D37 | "khu vực khu đức" (nghe sai Thủ Đức) → "Tôi đã tra dữ liệu nhưng chưa trả lời được" | Tên khu vực không khớp: lấy khu vực duy nhất sai ≤ 2 chữ cái và ghi "hiểu là …"; không có thì trả danh sách quận |
| D38 | "TL01 số 9.0009", "tủ khác để điều khiển", "tủ vừa mới bật", AI bảo nói hai lệnh để tắt hai nhánh | Đọc được mã nói hai lần; câu hỏi danh sách tủ được phép; "tủ vừa / ấy / kia / lúc nãy" = tủ đang nói tới; hướng dẫn AI: hai nhánh là một lệnh "tắt đèn tủ X" |
| D39 | Nói "xác nhận" → lệnh chạy đúng (tủ báo confirmed sau 3,4 s) nhưng micro bắt tiếng động, coi là nói chen vào, cắt việc theo dõi: Jarvis nói "bạn đã dừng theo dõi", nhật ký ghi "timeout" | Lệnh đã gửi thì luôn theo dõi tới kết quả thật (không gắn với nút Dừng / nói chen); trình duyệt lúc đang theo dõi lệnh chỉ dừng giọng đọc |
| D40 | "TL01 số mười sáu." → TL01.0010: dấu chấm dính vào "sáu" nên "mười sáu" không thành 16 | `wordsToDigits` bỏ dấu câu cuối chữ khi đọc số; dấu câu kết thúc số ("nhánh hai, tủ" không thành 2 + 4); "không", "sáu", "bảy", "ba", "tám", "chín", "bốn" đứng một mình vẫn là chữ ("có sáng không." vẫn là câu hỏi) |
| D41 | "TL16.0009" (nghe sai TL01.0009) → "không tìm thấy tủ" | Mã không có thật mà đúng một tủ được phép sai ≤ 2 ký tự → dùng tủ đó và nói trước "Không có tủ TL16.0009, tôi hiểu là tủ TL01.0009." (vẫn phải xác nhận) |
| D42 | "TL166" → chỉ hỏi "ở tủ nào?" | Nói lại mã đã nghe: "Tôi nghe mã TL166 nhưng không có tủ nào như vậy…" |
| D43 | Mã tủ khó nhớ: "ở Thủ Đức có rất nhiều tủ mà tôi chỉ nhớ mang máng" | **Tìm tủ bằng mô tả** (`guard/finder.ts`, code quyết định, không qua AI): khu vực (cả tên nghe sai), tên đường (nhớ một phần / sai một chữ), số nhà, trạng thái. Chỉ xét tủ được phép điều khiển; tủ đang kết nối trước. Còn 1 tủ → khung xác nhận; 2–5 → đọc có số ("số 1 …"), người dùng nói "số 2"; nhiều hơn → hỏi thêm tên đường / trạng thái; nhiều mà chỉ ≤ 5 tủ kết nối → đọc luôn các tủ đó. Câu "tắt đèn quận 1" vẫn là lệnh nhiều tủ (OTP trên web); "tắt đèn một tủ ở quận 1" là tìm một tủ |
| D44 | Groq viết "tủ" thành "tổ" / "tụ" ("điều khiển tổ ở khu vực quận 1") | `markCabinetWord` (một chỗ cho cả router, lệnh, bộ tìm tủ) nhận "tổ" / "tụ" là "tủ", trừ "tổ đội", "tổ trưởng", "tổ bảo trì", "tụ bù", "tụ điện" |
| D45 | "Tôi muốn điều khiển tủ ở quận 1" (chưa nói bật / tắt) → AI trả lời sai "không có tủ nào trong danh sách" | Code tìm tủ như D43 với lệnh để trống; chọn xong ("số 1") Jarvis hỏi "Bạn muốn bật đèn, tắt đèn…?", câu "bật đèn" sau đó thành lệnh cho đúng tủ đó |
| D46 | "Khu vực nào có tủ điều khiển được?" và danh sách được phép dài (45 tủ) | Câu hỏi danh sách nhận "khu vực / quận / phường nào"; trên 5 tủ thì đọc theo quận: "Quận 1: TL01.0009, …; TP Thủ Đức: 42 tủ, 3 đang kết nối" |
| D47 | "Hệ thống khu vực thủ đích thế nào" → AI đọc số của cả hệ thống | Router: câu hỏi tình hình có "khu vực / quận / phường / TP + tên" → `get_area_cabinets` cho khu vực đó (tên nghe sai vẫn đoán theo D37) |
| D48 | AI đoán "TL12" là "Quận 12" (không có quận này; TL12 là TP Thủ Đức) và dẫn người dùng tới đó | Hướng dẫn AI ghi tủ được phép **theo tên khu vực** (đọc từ bản đồ, lưu 1 phút / phiên) và câu "mã tủ không cho biết quận"; câu "chưa tủ nào được phép" của bộ tìm tủ nói "Tủ được phép ở: TP Thủ Đức (42 tủ), Quận 1 (3 tủ)" |
| D49 | "Ngoài khu vực Thủ Đức" bị hiểu là "ở Thủ Đức" | Bộ tìm tủ hiểu "ngoài / trừ / không phải" + khu vực: bỏ khu vực đó (và khu vực hỏi trước) |
| D50 | Thử thêm 3 câu gợi ý cho Groq trên 49 bản ghi 21/11: có tên quận; ghép; có tên quận nhưng không mã tủ | **Giữ câu gợi ý cũ.** Có tên quận thì nghe đúng "Thủ Đức", "điều khiển" hơn, nhưng mã tủ mẫu trong gợi ý làm Groq **ghi nhầm mã** (nói TL01.0009 ra "TLA1.0016"), "Hủy lệnh" thành "Quý lệnh"; bỏ mã tủ thì Groq bịa câu quảng cáo YouTube cho cả câu rõ. Nghe sai còn lại xử lý trong code (D30, D37, D40, D44) |
| D51 | Máy cá nhân quá nặng; Cloudflare miễn phí không chạy được Postgres / MQTT / worker chạy liên tục | **GitHub Codespaces** trên repo của bạn (`.devcontainer/`): máy 2 lõi / 8 GB, Docker trong codespace, tự dựng cả hệ thống thử. Jarvis thêm `JARVIS_EXTRA_ORIGINS` (chỉ `https://`) để nhận yêu cầu qua địa chỉ chuyển tiếp của Codespaces; console vẫn chỉ nghe 127.0.0.1 |
| D52 | Groq lặp câu ("Xin chào. Xin chào. Xin chào."), nghe "Thủ Đức" thành "khẩu đức" / "thủ đích", "tủ" thành "tổ" / "tụ"; AI chép lại chữ sai vào câu trả lời | **Sửa ngay chữ nghe được** (`src/voice/heard.ts`) trước khi hiện, ghi nhật ký và trả lời: gộp câu giống hệt nhau liền kề, đổi các dạng nghe sai của Thủ Đức ("khẩu đức", "thủ đích", "thủ đất") thành "Thủ Đức", "tổ" / "tụ" / "tố" thành "tủ" (trừ "tổ đội", "tổ trưởng", "tụ bù"…, như D44). Chỉ áp dụng cho câu nói, câu gõ giữ nguyên |
| D53 | Thử 23/11: sau danh sách 3 tủ, "Bật đèn tủ số hệ" (số hai nghe sai) làm mất danh sách, rồi "Bật đèn tủ số 2" bị tìm như một tủ tên "số 2" ("không tìm thấy") | Chọn số hiểu cả câu có lệnh ("bật đèn tủ số 2", "tắt tay cả hai nhánh tủ số 3"), lệnh trong câu được dùng luôn; "số hệ" / "số hay" = số 2. Số nghe không ra thì giữ danh sách và đọc lại "Bạn chọn số mấy? số 1: … (mã)". "bật nhánh 2" vẫn là nhánh, không phải số 2 |
| D54 | Groq nghe câu ngắn sai nhất ("số hai" thành "số hệ"); câu gợi ý cố định cho mọi câu | **Gợi ý theo lúc** (`sttHintFor`): vừa đọc danh sách tủ thì gợi ý "Bạn chọn số mấy? Số một. Số hai…"; vừa chọn một tủ thì gợi ý các việc (bật đèn, tắt nhánh…); đang hỏi "tủ nào?" thì gợi ý tên quận thật. Phần đầu là câu gợi ý ngắn (`STT_BASE`), phần cuối là điều đang chờ, vì Whisper coi gợi ý là câu vừa nói trước đó. **Không gợi ý gì khi một lệnh đang chờ "xác nhận"**: Whisper có thể viết lại gợi ý từ tiếng ồn, mà chữ đó gửi lệnh. Không có mã tủ trong gợi ý (D50) |
| D55 | Tên đường / khu vực nghe sai, mỗi lần phải thêm tay (D52) | **Sửa theo dữ liệu thật** (`snapPlaces`): tên quận, phường và tên đường (từ tên tủ "Lý Thường Kiệt 9") người dùng xem được, đọc lại mỗi 5 phút. Chỉ tên từ hai chữ trở lên; sai một chữ cái thì sửa, sai hai chữ cái chỉ khi ngay sau "quận", "phường", "khu vực", "đường", "ở"…; sai dấu ("thảo diễn") cũng sửa; hai tên khớp ngang nhau thì để nguyên |
| D56 | So `whisper-large-v3` (bản đầy đủ) với `whisper-large-v3-turbo` trên 41 bản ghi giọng thật 21/11 có câu đúng | **Giữ turbo.** Chữ đúng nguyên văn gần bằng nhau (75,1% / 75,5%), nhưng sau khi Jarvis dọn (mã tủ, tủ/tổ, Thủ Đức) turbo 94,9%, câu đúng hết 34/41; bản đầy đủ 88,9%, 31/41 vì nghe mã tủ tệ hơn ("TL01.0009" thành "T là một số chính", "TL169"); thời gian giữa 343 ms / 415 ms. Câu đúng soạn lại theo ngữ cảnh; 13 bản ghi không rõ câu thì bỏ |
| D57 | Gemini góp ý 23/11 (đề xuất "kiểm tra trước khi gửi lệnh"): Jarvis chỉ chặn tủ mất kết nối, không nhắc cảnh báo hay sự cố đang mở của tủ | **Lưu ý trước khi gửi** (`precheck` trong `guard/propose.ts`): đọc cảnh báo đang mở của tủ (nặng nhất trước, nói tối đa 2) và sự cố hiện trường chưa xong của tủ đó (có "quá hạn"), ghi vào câu trả lời và thẻ xác nhận (dòng màu cam). Lệnh bật đèn khi tủ báo dòng rò, quá dòng, lỗi contactor hoặc quá nhiệt thì thêm "Nên kiểm tra hiện trường trước khi bật đèn". **Không bao giờ chặn hay đổi lệnh**: vận hành viên quyết định. Đọc lỗi (API, không có quyền xem sự cố) thì bỏ qua lưu ý. Thẻ lệnh tắt sửa lại chữ: nói hoặc gõ đúng "xác nhận" cũng gửi được (D39), không chỉ bấm nút |
| D58 | Góp ý Gemini 23/11: "tối nay tủ nào lẽ ra phải sáng mà đang tắt?" | Công cụ **`find_schedule_mismatch`** dựa trên cảnh báo **E303 "Đèn lệch lịch"** của máy chủ, không tự đọc lịch 1.000 tủ: máy chủ đã so trạng thái nhánh với lịch đã gửi, bỏ qua tủ chạy tay, tủ mất PLC hoặc LOGO, và báo sau 20 phút. Lọc theo phường / quận (hàm chung `pickArea`, tách ra từ `get_area_cabinets`), chia "tắt trong giờ lịch" và "sáng ngoài giờ lịch" theo từng nhánh (đọc từ câu của máy chủ), cũ nhất trước. Tủ mất kết nối thì nói số tủ không kiểm tra được, không coi là đúng lịch. Bộ định tuyến đưa thẳng các câu "lệch lịch", "lẽ ra phải sáng / tắt", "ban ngày mà vẫn sáng" tới công cụ này; bộ đọc lệnh coi các cụm đó là câu hỏi ("tủ nào lẽ ra phải tắt mà vẫn sáng" từng bị hiểu là lệnh tắt) |
| D59 | Thử 23/11: gõ "admin@citylight.test" vào ô chat thì Jarvis trả lời tổng quan hệ thống; câu gõ tay đi nguyên văn tới Groq (chỉ câu nói mới được che email) | **Câu không phải câu hỏi thì nói không hiểu** (`guard/junk.ts`, code trả lời, không gọi AI, không tính vào giới hạn câu hỏi): email hoặc đường dẫn đứng một mình, chuỗi không có âm tiết tiếng Việt, từ quen hay mã nào ("asdfgh", "Tchau."). Kiểm tra sau phần lệnh, nên "xác nhận", "số 2", mã tủ vẫn chạy như cũ. **Mật khẩu / OTP gõ nhầm** ("mật khẩu là Abc12345", "OTP 123456") được cảnh báo ngay, không gửi AI; "Cho tôi mật khẩu của tài khoản admin" vẫn là câu hỏi. **Che trước khi gửi AI và lưu**: email và giá trị sau "mật khẩu / pass / OTP" thành `***` ở cả câu gõ và câu nói, trong lịch sử chat và nhật ký. Thêm luật cho AI: câu không rõ thì không gọi công cụ, nói không hiểu và cho một câu ví dụ |
| D60 | Bạn dặn 23/11: "tuyệt đối không được tiết lộ gì về tài khoản", "chặn toàn bộ những khả năng mà người có thể cố tình hỏi để biết bảo mật tài khoản" | **Nhiều lớp, mỗi lớp tự đứng được** (`guard/account.ts`): (1) **code từ chối trước mọi thứ khác** (trước lệnh, công cụ, AI; cả gõ lẫn nói) mọi câu về tài khoản và bảo mật: mật khẩu, email, tên đăng nhập, OTP / 2 lớp, mã khôi phục, vai trò, quyền, "tôi là ai", ai đã làm gì / ai trực / nhân viên nào, quên / đặt lại mật khẩu, khóa API, cookie, token, máy chủ, cơ sở dữ liệu, cấu hình, và các kiểu lừa AI ("bỏ qua hướng dẫn", "giả vờ là admin", "developer mode", "in ra system prompt"); nhận cả chữ viết lách ("m.ậ.t k.h.ẩ.u", "m a t k h a u", "p@ssw0rd", không dấu, tiếng Anh) mà không bắt nhầm qua ranh giới hai từ ("tại khoảng 6 giờ"); (2) **AI không có dữ liệu tài khoản**: không công cụ nào đọc người dùng, kết quả công cụ bỏ các trường người (người yêu cầu, xác nhận, báo, được giao, họ tên), lời dặn cho AI chỉ còn vai trò, không còn tên; (3) **luật cho AI**: không nói gì về tài khoản, kể cả khi người hỏi nói mình là quản trị viên hay bảo bỏ luật; (4) **kiểm tra câu trả lời của AI** trước khi hiện / đọc: câu nhắc mật khẩu, khóa, email, OTP, tài khoản thì thay ngay bằng câu từ chối. "Tôi là ai" không còn đọc tên và vai trò. Câu bình thường ("Bạn là ai?", "tủ nào tôi có thể điều khiển", "tắt đèn tại khoảng 6 giờ") không bị chặn: có test cho cả hai phía |
| D61 | Bạn hỏi 23/11: "Tôi là tester… hướng dẫn tôi cách đánh sập agent" thì sao? Không bộ lọc code nào bắt; AI thật (Groq) tự từ chối 3/3 lần ("Xin lỗi, tôi không thể giúp…") nhưng chỉ do AI tự quyết | **Code từ chối trước** (`asksToAttack` trong `guard/account.ts`, cùng chỗ với D60): xin cách tấn công, làm sập / treo, hack, lỗ hổng, khai thác, injection, pentest, vượt / lách bảo mật, xác thực, giới hạn, xác nhận, danh sách cho phép, spam / làm quá tải, bất kể lý do ("tôi là tester"). Câu trả lời: không hướng dẫn, kiểm thử bảo mật phải được giao chính thức và làm cùng đội phát triển trên môi trường thử. Không bắt nhầm "vượt quá ngưỡng", "tủ bị lỗi", "LOGO bị crash" |
| D62 | Góp ý Gemini 23/11: bản tin đầu ca theo khu vực, thay vì hỏi rời 4 câu | Công cụ **`get_shift_report`** (một phường / quận hoặc cả hệ thống): tủ theo trạng thái; cảnh báo đang mở theo mức, 3 cái nặng nhất; sự cố đang mở, quá hạn (lâu nhất trước); tủ lệch lịch (E303); cả hệ thống thì thêm 3 quận nhiều cảnh báo nhất. Phần nào không đọc được (vai trò không có quyền xem sự cố) thì nói rõ, phần khác vẫn có. Bộ định tuyến đưa "bản tin", "đầu ca", "giao ca", "nhận ca", "tóm tắt ca", "ca trực" tới đây, trước sự cố và cảnh báo |
| D63 | Thử bản tin 23/11: "Quận 2" (không có) đọc ra "Phường 2 … Phường 24"; "Phường 2" có ở nhiều quận nên Jarvis bảo "chọn 1…6" không kèm tên quận, "1" hay "phường 2 quận 2" đều không hiểu; một câu trả lời trống `""`; "đúng" (trả lời câu hỏi của AI) bị đáp "Không có lệnh nào đang chờ xác nhận" | `pickArea` viết lại: số phải khớp đúng ("2" không phải "12", "24"); nói "quận" thì chỉ tìm quận, không có thì nói "Không có Quận 2" và kể quận thật; hiểu "phường 2 quận 3", "Phường 2, Quận 3", "phường 2 của quận 3"; khi trùng tên, lựa chọn ghi kèm quận ("Phường 2 (Quận 3)"). Câu trả lời trống thay bằng "Tôi chưa trả lời được câu này…". "Đúng", "ok", "không" khi không có lệnh chờ thì để AI trả lời; chỉ "xác nhận", "đồng ý", "hủy" mới nhận câu cố định |
| D64 | Bạn hỏi 23/11 "tester có đánh sập được không": cả Jarvis dùng chung một khóa Groq miễn phí. Đo 23/11: mỗi model 1.000 lượt / ngày, 8.000 token / phút; một câu hỏi ~4.800 token, 2–3 lượt. Vài tài khoản hỏi dồn hay nói liên tục là hết lượt chung | **Trần chung** (chỉ mặc định khi dùng Groq; đổi trong `.env`, 0 = tắt): `JARVIS_GLOBAL_PER_MIN` 4 câu / phút cho cả hệ thống, `JARVIS_PER_USER_PER_DAY` 150 câu / người / 24 giờ, `JARVIS_STT_PER_MIN` 15 lần nghe / phút cho cả hệ thống (Groq cho 20). `RateLimiter.allowAll`: chỉ tính lượt khi mọi cửa sổ còn chỗ, báo cần chờ bao lâu, ghi nhật ký `rate_limited`. Câu xác nhận, hủy và lệnh không tính; câu nói khi đang có lệnh chờ chỉ tính lượt nghe, nên "xác nhận" bằng giọng không bị chặn lúc đông người |
| D65 | Góp ý Gemini 23/11: chẩn đoán dòng rò theo ngưỡng từng tủ, không chỉ thấp nhất / cao nhất / trung bình | `get_cabinet_history` thêm **`chan_doan_ro`** (`leakReport`): ngưỡng rò riêng của tủ (từ cấu hình ngưỡng của tủ; chưa đặt thì nói), số lần vượt, lần đầu / lần cuối, xu hướng (1/3 cuối so với 1/3 đầu: tăng dần khi gấp 1,5 lần và hơn 2 mA), rò trung bình lúc đèn sáng / tắt, và **"cả hai nhánh đang tắt nhưng vẫn có dòng"** (kiểm tra contactor). Chỉ nói số liệu, nguyên nhân để kiểm tra hiện trường. Bộ định tuyến đưa "dòng rò tủ đó có tăng không", "rò tủ X tuần này" tới đây (7 ngày khi có "tuần") |
| D66 | Góp ý Gemini 23/11: lịch sử can thiệp theo tháng (trước chỉ xem được 30 lệnh trong 7 ngày) | Công cụ **`get_cabinet_interventions`** (một tủ, mặc định 30 ngày, tối đa 90): lệnh theo loại (theo chữ của thẻ xác nhận), số lệnh thất bại, 5 lệnh gần nhất; cảnh báo theo mã, cái nào còn mở; sự cố hiện trường của tủ. **Không bao giờ nói ai gửi lệnh hay xử lý** (D60; test kiểm tra không lọt tên). Bộ định tuyến đưa "tháng này", "N ngày qua", "N tháng", "can thiệp", "bao nhiêu lần / mấy lần", "lịch sử lệnh / sự cố / cảnh báo" của một tủ tới đây |

## Còn thiếu (cần máy / quyết định)

- 20 câu ghi âm thật (Bảo, mục 11) để đo đúng độ chính xác STT.
- Câu trả lời chữ 2,5 – 7 s (2 lượt model, ~1,9 K token prompt, 1 / 3 model chạy CPU). GPU lớn hơn hoặc model nhỏ hơn sẽ nhanh hơn.

## Phần cứng máy hiện tại

RTX 3050 Laptop 4 GB VRAM, RAM 7,7 GB, i7-11800H, ổ C còn ~19 GB (cài lên E:).

## Dữ liệu và bảo mật

- Cookie phiên chỉ nằm trong bộ nhớ, không ghi đĩa, không log. Không log mật khẩu, mã 2FA / OTP, CSRF.
- LLM (Ollama), STT (faster-whisper) và TTS (Piper) đều chạy trên máy: tiếng nói và dữ liệu tủ không ra ngoài. Chỉ khi chọn `TTS_ENGINE=edge` thì câu Jarvis đọc mới đi qua dịch vụ cloud của Microsoft (đã lọc theo G6). Âm thanh không được lưu, chỉ lưu chữ đã lọc.
- Thu quyền một manager **không** tự thu quyền những người manager đó đã cấp (mục 8.1, làm ở milestone 2).
