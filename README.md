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
| M5 → M11 | chưa bắt đầu (xem `docs/spec.md` mục 16) |

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
npm run sim -- --count 300               # tủ giả gửi lên EMQX
npm run dev:web:hybrid                   # web :5173/5174, API thật + mock cho phần chưa làm
```

Chạy API + ingest + command-worker bằng Docker: `docker compose -f infra/docker-compose.yml --env-file infra/.env --profile app up -d --build`.

### Đăng nhập & phân quyền (M2)

- `TOTP_ENC_KEY` (32 byte hex, trong `.env` và `infra/.env`) mã hóa secret 2FA. **Mất key = mọi user phải cài lại 2FA**; giữ key cùng bản backup DB nhưng ở chỗ khác.
- Admin và Điều hành **bắt buộc 2FA**: lần đăng nhập đầu sẽ hiện màn cài 2FA (Google Authenticator / Microsoft Authenticator / Authy). `AUTH_REQUIRE_2FA=false` chỉ để test local.
- Tạo user ở Quản trị → Người dùng: hệ thống trả mật khẩu tạm (hiện 1 lần), user phải đổi khi đăng nhập. User mới **không thấy tủ nào** tới khi gán khu vực hoặc tick "Toàn hệ thống".
- Mất điện thoại: dùng mã khôi phục, hoặc admin bấm "Đặt lại 2FA".
- `npm run e2e:api` (cần API container đang chạy): 40 kiểm tra 2FA/CSRF/phạm vi/thu hồi session/khóa tài khoản/rate limit, tự tạo và xóa user `*@e2e.citylight.test`. Bài rate limit chạy cuối: đợi 1 phút trước khi chạy lại.
- `npm run e2e:commands` (cần api + ingest + command-worker đang chạy, ~90 s): 27 kiểm tra vòng đời lệnh với tủ giả SIM9991–9996 (mất PLC, mất LOGO, mất ack, firmware cũ), tự tạo và xóa user `*@e2e-cmd.citylight.test`. Không chạy cùng `npm run sim` ≥ 9990 tủ.
- `npm run e2e:map` (~5 s): bộ đếm KPI khớp bản đồ, danh sách, lọc theo trạng thái, cây khu vực và DB với 3 phạm vi (toàn hệ thống / 1 quận / 1 phường), không lộ tủ ngoài phạm vi; vị trí đã lưu. Tự tạo/xóa user `*@e2e-map.citylight.test`.
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

`apps/api/` NestJS (Fastify, session cookie, Socket.IO) · `apps/workers/` ingest, command-worker (rules / scheduler ở các mốc sau).

## Ghi chú kỹ thuật

- Bản đồ nền (`src/pages/map/mapStyle.ts`): mặc định "Tự động" = VersaTiles Colorful (sáng) / Eclipse (tối) — mở, không cần key, tự host được cho production. Chọn thêm trong nút Lớp: CARTO Voyager / Dark Matter (đẹp nhưng dùng thương mại cần gói CARTO), OpenFreeMap Liberty / Positron, Vệ tinh, Vệ tinh + tên đường (Esri).
- Icon bản đồ là SVG tự vẽ (`src/pages/map/mapIcons.ts`): ghim tủ theo màu + ký hiệu trạng thái, trụ đèn sáng/tắt; tuyến tô màu theo trạng thái nhánh.
- `.npmrc` `legacy-peer-deps=true`: drizzle-orm khai báo peer tùy chọn (react-native, expo…) xung đột React 18 của web.
- `LGPS` = `lat'lon'sats` chứa dấu `'`: parser tách mỗi cặp ở dấu `'` ĐẦU TIÊN. Telemetry lưu theo giờ nhận của server, không dùng PTIM làm khóa (PTIM chỉ chính xác tới phút).
- `vite.config.ts` loại `maplibre-gl` khỏi pre-bundle (MapLibre 6 nạp worker theo đường dẫn tương đối).
- Bundle production ~2.8 MB (chưa code-split) — tách chunk theo trang ở M7/M11.
- Ô hiện "—" / "Chờ firmware" = thiết bị chưa gửi dữ liệu đó (spec mục 4.2, 5).
- Frame CoreIF thô không bao giờ gửi về trình duyệt; UI chỉ hiện mô tả lệnh (`describeCommand`). Frame chỉ lưu ở command log phía server.
