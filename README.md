# CityLight Server

Nền tảng giám sát / điều khiển tủ chiếu sáng CityLight V2 (broker MQTT + backend + web). Quy mô thiết kế 10.000 tủ. **Dự án production.**

- Spec: [`docs/spec.md`](docs/spec.md) · Quyết định: [`docs/decisions.md`](docs/decisions.md)
- Repo: https://github.com/dgbao2704/server_citylight (thư mục làm việc `D:\Viet_Nghiep_Project\CityLight\Server`).
- Project overview + nhật ký: workspace firmware `release_citylight/city_light_v2/03 Projects/CityLight Server.md`.
- Giao thức thiết bị: `docs/device-contract.md` (nguồn sự thật là repo firmware `city_light_v2`, `CLAUDE.md` + `BOARD_LTE_KEY/Mylib/core_if.c`).

## Trạng thái mốc

| Mốc | Trạng thái |
|---|---|
| **M1-UI** giao diện đầy đủ (mock) | ✅ chạy được, 18 màn hình + 12 tab chi tiết tủ, dữ liệu giả 600 tủ |
| **M0** nền tảng backend | ✅ compose (EMQX 5.8.6, PG 16.15 + TimescaleDB 2.30.2 + PostGIS 3.6.4, Redis 7.4) chạy; migrate OK (30 bảng, 2 hypertable, 3 continuous aggregate); `coreif` 22 test; E2E với EMQX thật 20/20 (gồm ACL); tải thử 1.000 tủ giả |
| **M1** ingest + API + web hybrid | ✅ ingest worker (batch, trạng thái, cảnh báo sức khỏe E1xx–E8xx, quét offline theo lô), API NestJS (đăng nhập session, bản đồ, tủ, telemetry, chẩn đoán, cảnh báo, Socket.IO), web `--mode hybrid`; thử tải 10.000 tủ 16 phút: 921.570 dòng, 0 lỗi, trễ ghi DB < 0,6 s; offline 9.923 tủ phát hiện trong 52–64 s |
| **M2** 2FA + phân quyền khu vực | ✅ TOTP bắt buộc cho admin/operator (QR, mã khôi phục), phạm vi khu vực ở mọi API đọc + Socket.IO, quản lý user (mật khẩu tạm, đặt lại mật khẩu/2FA, mở khóa), CSRF, rate limit đăng nhập; `npm run e2e:api` 40/40 |
| **M4** lệnh thật | ✅ `command-worker` (hàng đợi Postgres, 1 lệnh/tủ, ack + retry + timeout, xác nhận bằng telemetry), API gửi/xem/hủy lệnh + đặt lịch, chặn tủ offline / firmware cũ, idempotency, nhật ký, Socket.IO; `npm run e2e:commands` 27/27 |
| **M3** bản đồ | ✅ API thật cho bản đồ/KPI/tìm kiếm/cây khu vực (từ M1) + vị trí đã lưu (`favorites`); nén gzip (`map/cabinets` 10.000 tủ: 3,4 MB → 600 KB); đo trên trình duyệt: zoom/kéo 135 FPS, không tác vụ dài; `npm run e2e:map` 32/32 (KPI = bản đồ = danh sách = cây ở 3 phạm vi) |
| **M5** cảnh báo | ✅ luật ngưỡng (áp/dòng/dao động/lệch pha/cosφ/rò/nhiệt/pin), lệch lịch, sai giờ LOGO, lệch GPS, chống nhiễu 30 s; API ngưỡng + quy tắc + đăng ký thông báo; `notify-worker` Telegram (liên kết `/start <mã>`, phạm vi, gom tin, tóm tắt); cảnh báo sự kiện lệnh E701–E703; `npm run e2e:alarms` 26/26 |
| **M6** lịch & hàng loạt | ✅ `scheduler` tự đưa mọi tủ về lịch mong muốn (riêng > vùng; không đẩy lịch mặc định; tủ offline nhận khi online lại), lịch thiên văn (suncalc, dùng chung web/server), API lịch vùng + xem trước + bỏ lịch riêng, lệnh hàng loạt theo vùng có mã 2FA, tiến độ realtime, kết quả từng tủ, gửi lại; `npm run e2e:schedules` 25/25, tải 1.000 tủ: 992 ok trong 57 s |
| **M7** sự cố | ✅ tạo từ cảnh báo / thủ công, luồng giao → xử lý → đóng do server kiểm (quyền + phạm vi), người xử lý là user Bảo trì, "Việc của tôi", ảnh hiện trường / sau xử lý (magic bytes, 5 MB), Excel `.xlsx` sự cố + cảnh báo theo bộ lọc, báo cáo tháng, nhắc quá hạn qua Telegram; `npm run e2e:incidents` 36/36 |
| **M8** GIS & quản trị | ✅ tuyến/trụ/đèn trên bản đồ theo khung nhìn, chỉnh sửa nháp (vẽ tuyến, thêm/dời/xóa trụ, sửa đèn) lưu 1 lần có chống ghi đè, sinh trụ theo mét, nhập Excel/CSV có kiểm trước; quản trị khu vực / khu QL / vùng, đăng ký tủ lạ, sửa / ngừng dùng tủ, cấu hình mất kết nối; `npm run e2e:gis` 22/22 (+ tải 200.000 trụ), `npm run e2e:admin` 25/25 |
| **M9** Tiết giảm | ✅ hồ sơ theo nhóm đèn 3 tầng (tủ > vùng > hệ thống > mặc định), bỏ hồ sơ riêng, kiểm 1–5 thời đoạn liền nhau, ước tính kWh / đ theo đèn GIS thật + giá điện (Cấu hình); đồng bộ / `SET_DIMMING` vẫn 409 tới khi firmware hỗ trợ; `npm run e2e:dimming` 26/26 |
| M10 Tủ thật | chưa bắt đầu: VPS đã sẵn, chờ trỏ tủ bàn (`LDOM=13.55.91.187`, `LPOR=1883`) |
| **M11** VPS & vận hành | ✅ VPS AWS Lightsail (HTTPS sslip.io, chỉ mở 1883/80/443), backup 02:15 + kéo về laptop hằng ngày, diễn tập khôi phục 34 bảng 0 lệch, watchdog 5 phút báo Telegram, `npm run e2e:browser` 14/14 (`e2e:vps` 6/6 lên production), runbook [`docs/runbook.md`](docs/runbook.md). Còn: monitor bên ngoài VPS (UptimeRobot / alarm Lightsail, cần tài khoản) |

## Chạy web (M1-UI)

Yêu cầu: Node.js ≥ 22.

```bash
npm install
npm run dev:web
```

Mở http://localhost:5173. Mặc định chạy **mock API** (handler MSW gọi trực tiếp trong trang qua `getResponse`, không dùng Service Worker vì trình duyệt tắt SW sau ~30 s idle làm app ngừng tải), không cần backend. Khi có API thật: `VITE_USE_MOCK=false npm run dev:web` (Vite proxy `/api` → `localhost:3000`).

### Deploy bản demo (Cloudflare Workers – static assets)

Repo GitHub private `dgbao2704/server_citylight` nối với Cloudflare (Workers Builds, project `citylight-demo`): mỗi lần push `main` → tự build + `npx wrangler deploy` theo `wrangler.jsonc` (thư mục `apps/web/dist`, SPA fallback). Link dạng `https://citylight-demo.<subdomain>.workers.dev`.

| Thiết lập Cloudflare | Giá trị |
|---|---|
| Framework preset | None |
| Build command | `npm run build:web` |
| Deploy command | `npx wrangler deploy` (đọc `wrangler.jsonc`) |
| Root directory | (để trống) |
| Node | `.nvmrc` = 22 |

- Chạy ở domain gốc nên không cần `VITE_BASE`. SPA fallback: `not_found_handling` trong `wrangler.jsonc`. Tên Worker trong `wrangler.jsonc` phải trùng tên project trên dashboard.
- Header bảo mật/cache: `apps/web/public/_headers`.
- Giới hạn người xem: Cloudflare Zero Trust → Access (chỉ email được mời).
- Đây chỉ là bản giao diện + dữ liệu giả. Hệ thống thật (broker, API, DB) deploy lên VPS ở M11.

### Tài khoản mẫu (chỉ trong mock, `apps/web/src/mocks/seed.ts`)

Mật khẩu chung: `demo`. Tài khoản có 2FA nhập mã `123456`.

| Email | Vai trò | 2FA |
|---|---|---|
| `admin@citylight.local` | Quản trị | có |
| `dieuhanh@citylight.local` | Điều hành | có |
| `giamsat@citylight.local` | Giám sát (chỉ xem) | không |
| `duytu@citylight.local` | Đội duy tu | không |

Dữ liệu mock tạo lại mỗi lần tải lại trang (phiên đăng nhập được giữ trong `sessionStorage`).

## Backend local (M0)

Yêu cầu thêm: **Docker Desktop** (WSL2). Trên máy này Docker cài theo user tại `%LOCALAPPDATA%\Programs\DockerDesktop` — mở Docker Desktop trước khi chạy.

**Bảo mật broker giai đoạn 1:** tủ kết nối anonymous (firmware chưa có user/pass). EMQX 5 không cho anonymous khi bật authenticator và không phân quyền theo listener, nên backend được nhận diện bằng **username bí mật** trong ACL sinh từ `infra/.env` (`infra/emqx/acl.conf.tmpl`). Không dùng xác thực HTTP của EMQX (mỗi publish phụ thuộc API → API restart là mất telemetry); giai đoạn 2 dùng built-in database của EMQX, API chỉ đồng bộ tài khoản tủ sang.

```bash
cp infra/.env.example infra/.env        # đặt mật khẩu thật + MQTT_BACKEND_USER ngẫu nhiên
cp .env.example .env
npm run infra:up                        # sinh infra/emqx/acl.conf rồi chạy EMQX :1883 (dashboard :18083), Postgres+Timescale+PostGIS :5432, Redis :6379
npm run db:migrate                      # bảng + hypertable + continuous aggregates
npm run sim -- --count 100              # 100 tủ giả gửi CoreIF lên EMQX
npm test                                # unit test packages/coreif
npm run e2e:local                       # kiểm tra end-to-end KHÔNG cần Docker (broker nhúng aedes)
MQTT_URL=mqtt://localhost:1883 MQTT_USERNAME=<MQTT_BACKEND_USER> npm run e2e:local   # với EMQX thật (+3 bài ACL)
```

## Chạy hệ thống thật (M1)

```bash
npm run infra:up                         # EMQX + Postgres/Timescale/PostGIS + Redis
npm run db:migrate && npm run db:seed    # bảng + tài khoản admin (SEED_ADMIN_* trong .env)
npm run sim:register -- --count 10000    # đăng ký fleet tủ giả vào DB (vị trí cố định theo LTID)
npm run dev:api                          # API :3000 (/api/v1, /socket.io)   — hoặc container: xem dưới
npm run dev:ingest                       # ingest worker
npm run dev:cmd                          # command-worker (gửi lệnh xuống tủ)
npm run dev:notify                       # notify-worker (Telegram; cần TELEGRAM_BOT_TOKEN)
npm run dev:scheduler                    # scheduler (đưa tủ về lịch mong muốn)
npm run sim -- --count 300               # tủ giả gửi lên EMQX
npm run dev:web:hybrid                   # web :5173/5174, API thật + mock cho phần chưa làm
```

Chạy API + các worker (ingest, command, notify, scheduler) bằng Docker: `docker compose -f infra/docker-compose.yml --env-file infra/.env --profile app up -d --build`.

### Thông báo Telegram (M5)

1. Tạo bot với @BotFather trên Telegram (`/newbot`), lấy token.
2. Dán token vào `infra/.env`: `TELEGRAM_BOT_TOKEN=...` (và `WEB_URL=` nếu muốn tin có link về web), rồi `docker compose -f infra/docker-compose.yml --env-file infra/.env --profile app up -d notify-worker`.
3. Mỗi người: web → Tài khoản → Nhận thông báo → "Liên kết Telegram" → mở link, bấm Start. Chọn mức cảnh báo nhận rồi Lưu.
4. Gửi `/stop` cho bot để tắt; "Hủy liên kết" trên web để xóa hẳn.

### Đăng nhập & phân quyền (M2)

- `TOTP_ENC_KEY` (32 byte hex, trong `.env` và `infra/.env`) mã hóa secret 2FA. **Mất key = mọi user phải cài lại 2FA**; giữ key cùng bản backup DB nhưng ở chỗ khác.
- Admin và Điều hành **bắt buộc 2FA**: lần đăng nhập đầu sẽ hiện màn cài 2FA (Google Authenticator / Microsoft Authenticator / Authy). `AUTH_REQUIRE_2FA=false` chỉ để test local.
- Tạo user ở Quản trị → Người dùng: hệ thống trả mật khẩu tạm (hiện 1 lần), user phải đổi khi đăng nhập. User mới **không thấy tủ nào** tới khi gán khu vực hoặc tick "Toàn hệ thống".
- Mất điện thoại: dùng mã khôi phục, hoặc admin bấm "Đặt lại 2FA".
- `npm run e2e:api` (cần API container đang chạy): 40 kiểm tra 2FA/CSRF/phạm vi/thu hồi session/khóa tài khoản/rate limit, tự tạo và xóa user `*@e2e.citylight.test`. Bài rate limit chạy cuối: đợi 1 phút trước khi chạy lại.
- `npm run e2e:commands` (cần api + ingest + command-worker đang chạy, ~90 s): 27 kiểm tra vòng đời lệnh với tủ giả SIM9991–9996 (mất PLC, mất LOGO, mất ack, firmware cũ), tự tạo và xóa user `*@e2e-cmd.citylight.test`. Không chạy cùng `npm run sim` ≥ 9990 tủ.
- `npm run e2e:map` (~5 s): bộ đếm KPI khớp bản đồ, danh sách, lọc theo trạng thái, cây khu vực và DB với 3 phạm vi (toàn hệ thống / 1 quận / 1 phường), không lộ tủ ngoài phạm vi; vị trí đã lưu. Tự tạo/xóa user `*@e2e-map.citylight.test`.
- `npm run e2e:alarms` (cần api + ingest đang chạy, ~2,5 phút): ngưỡng → cảnh báo mở sau ~30 s / đóng sau ~30 s, bộ đếm Lỗi, Telegram giả lập trên localhost (liên kết, phạm vi, mức, gom tin, `/stop`). Không cần bot thật; tự tạo/xóa user `*@e2e-alarm.citylight.test`.
- `npm run e2e:schedules` (cần api + ingest + command-worker + scheduler, ~3 phút): lịch vùng / riêng / thiên văn tới tủ giả, tủ offline bắt kịp, batch có mã 2FA + tiến độ + gửi lại. Thêm `-- --load 1000` để chạy batch 1.000 tủ ở Vùng Bắc. Trả lịch Vùng Thủ Đức về như cũ khi xong.
- `npm run e2e:incidents` (cần api + scheduler, ~1,5 phút): cảnh báo → sự cố → giao → ảnh → xử lý → đóng, quyền / phạm vi, ảnh giả bị từ chối, Excel đọc lại, báo cáo khớp DB, nhắc quá hạn. Tự tạo/xóa user `*@e2e-inc.citylight.test`.
- `npm run e2e:gis` (cần api, ~20 s): nhập Excel (lỗi theo dòng, thay tuyến), bản đồ theo zoom / phạm vi, chỉnh sửa có xung đột, sinh trụ đúng khoảng cách. `-- --load 200000` sinh trụ giả cho cả đội và đo bản đồ (xóa sau khi đo).
- `npm run e2e:admin` (cần api + ingest, ~2 phút): danh mục, tủ lạ → đăng ký → ingest nhận ngay, ngừng dùng / dùng lại, cấu hình mất kết nối áp dụng ngay.
- **VPS (M11, 2026-10-19):** AWS Lightsail Sydney, `/opt/citylight`, web `https://13-55-91-187.sslip.io`, MQTT `13.55.91.187:1883`. Cập nhật: `git archive HEAD | ssh … tar -x -C /opt/citylight`, web build (`VITE_API_MODE=real npx vite build`) → `/opt/citylight/web-dist`, rồi
  `docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml --env-file infra/.env --profile app up -d --build`; migration: `… run --rm --no-deps -w /app/packages/db api node --import tsx src/migrate.ts`. Chỉ mở 1883 + 80/443; `.env` sinh trên VPS, không rời máy. Backup `infra/scripts/backup-db.sh` (cron 02:15, giữ 14 ngày; laptop kéo về `D:CityLightBackupsps`; diễn tập `restore-drill.sh` đạt 2026-10-19); watchdog `infra/scripts/watchdog.sh` (cron 5 phút, Telegram).
  Vận hành (kiểm nhanh, watchdog, backup/khôi phục, cập nhật, sự cố): [`docs/runbook.md`](docs/runbook.md). E2E trình duyệt: `npm run e2e:vps` (production, không đăng nhập), `npm run e2e:browser` (+ luồng đăng nhập trên web mock; site thật: `E2E_UI_URL`, `E2E_EMAIL`, `E2E_PASSWORD`, `E2E_TOTP_SECRET`, `E2E_CABINET`, `E2E_ALLOW_COMMANDS=1`).
  Xem DB bằng GUI (DBeaver/pgAdmin): db chỉ bind `127.0.0.1:5432` trên VPS → `ssh -i ~/.ssh/citylight_aws -N -L 15432:127.0.0.1:5432 ubuntu@13.55.91.187`, rồi nối `localhost:15432`, DB/user `citylight`, mật khẩu `POSTGRES_PASSWORD` trong `/opt/citylight/infra/.env`.
- `npm run e2e:dimming` (cần api, ~10 s): hồ sơ 3 tầng + kế thừa, kiểm 422, quyền / phạm vi, ước tính khớp đèn nhập, giá điện, đồng bộ → 409, nhật ký. Dùng nhóm đèn 3; hồ sơ hệ thống nhóm 3 và các dòng cấu hình có sẵn được trả lại.
- `npm run e2e:relocate` (cần api + ingest, ~1 phút): GPS thiết bị lạ, đề xuất vị trí theo GPS (ít điểm / GPS nhảy / đạt / đã khớp), quyền + phạm vi, hộp thoại cũ → 409, dời tủ + nhật ký, lớp lệch GPS trên bản đồ (S41).
- `npm run e2e:guards` (cần api + ingest, ~1,5 phút): khóa IMEI (ghi nhận, frame IMEI lạ bị bỏ + E805, danh sách IMEI, chấp nhận / học lại, quyền), 2 IMEI cùng LTID khi đăng ký, giá trị vô lý, giới hạn 5 + 1 frame/s (S42). `E2E_CSP=1 npm run e2e:browser`: luồng web trên bản build + đúng CSP của Caddyfile, qua mọi bản đồ nền.
- Ảnh sự cố nằm trong volume Docker `uploads` (`/data/uploads` trong container api): **sao lưu cùng với DB**.
- Không chạy các e2e có simulator liền nhau quá sát: tủ giả của bài trước mất kết nối sau 60 s và sinh cảnh báo / thông báo trong bài sau.
- Các e2e đều đăng nhập: chạy cách bài rate limit của `e2e:api` ít nhất 1 phút (cùng IP, 20 lần/phút), nếu không sẽ bị 429.
- Sau lưng proxy (Caddy trên VPS) đặt `TRUST_PROXY` (IP/CIDR của proxy; số hop không còn được fastify ≥ 5.12 hỗ trợ) để lấy IP thật cho rate limit; mặc định tắt.

**Thử tải 10.000 tủ trên Windows:** Docker Desktop chỉ chuyển tiếp ~2.000 kết nối từ host vào container (ECONNRESET sau đó) — chạy simulator *trong* mạng Docker:

```bash
npx esbuild apps/simulator/src/index.ts --bundle --platform=node --format=esm --outfile=.tmp/sim.mjs   --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"
docker run -d --name citylight-sim --network infra_default -v "$PWD/.tmp:/app:ro" node:22-alpine   node /app/sim.mjs --count 10000 --broker mqtt://emqx:1883
```

## Cấu trúc

```text
apps/web/            React + Vite (M1-UI, mock API trong trang)
apps/simulator/      tủ giả nói đúng CoreIF như BOARD_LTE_KEY (telemetry, ack, lọc LTID, boot, LDIA, kịch bản lỗi)
packages/shared/     type domain, nhãn, RBAC, ánh xạ CoreIF, bảng mã lỗi E101–E804
packages/coreif/     parse/build frame CoreIF, telemetry, ack, boot, demo (LDIA, time-sync), lệnh
packages/db/         Drizzle schema, migration (0000 extensions, 0001 bảng, 0002 Timescale) + sql/post (continuous aggregates)
infra/               docker-compose (EMQX 5.8, TimescaleDB-HA pg16, Redis 7.4) + ACL EMQX
docs/                spec, quyết định, device contract, kiến trúc
```

`apps/api/` NestJS (Fastify, session cookie, Socket.IO) · `apps/workers/` ingest (kèm luật cảnh báo), command-worker, notify-worker, scheduler.

## Ghi chú kỹ thuật

- Bản đồ nền (`src/pages/map/mapStyle.ts`): mặc định "Tự động" = VersaTiles Colorful (sáng) / Eclipse (tối) — mở, không cần key, tự host được cho production. Chọn thêm trong nút Lớp: CARTO Voyager / Dark Matter (đẹp nhưng dùng thương mại cần gói CARTO), OpenFreeMap Liberty / Positron, Vệ tinh, Vệ tinh + tên đường (Esri).
- Icon bản đồ là SVG tự vẽ (`src/pages/map/mapIcons.ts`): ghim tủ theo màu + ký hiệu trạng thái, trụ đèn sáng/tắt; tuyến tô màu theo trạng thái nhánh.
- `.npmrc` `legacy-peer-deps=true`: drizzle-orm khai báo peer tùy chọn (react-native, expo…) xung đột React 18 của web.
- `LGPS` = `lat'lon'sats` chứa dấu `'`: parser tách mỗi cặp ở dấu `'` ĐẦU TIÊN. Telemetry lưu theo giờ nhận của server, không dùng PTIM làm khóa (PTIM chỉ chính xác tới phút).
- `vite.config.ts` loại `maplibre-gl` khỏi pre-bundle (MapLibre 6 nạp worker theo đường dẫn tương đối).
- Bundle production ~2.8 MB (chưa code-split) — tách chunk theo trang ở M7/M11.
- Ô hiện "—" / "Chờ firmware" = thiết bị chưa gửi dữ liệu đó (spec mục 4.2, 5).
- Frame CoreIF thô không bao giờ gửi về trình duyệt; UI chỉ hiện mô tả lệnh (`describeCommand`). Frame chỉ lưu ở command log phía server.
