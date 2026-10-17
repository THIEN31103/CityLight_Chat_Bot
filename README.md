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
| M1 → M11 | chưa bắt đầu (xem `docs/spec.md` mục 16) |

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

**Bảo mật broker giai đoạn 1:** tủ kết nối anonymous (firmware chưa có user/pass). EMQX 5 không cho anonymous khi bật authenticator và không phân quyền theo listener, nên backend được nhận diện bằng **username bí mật** trong ACL sinh từ `infra/.env` (`infra/emqx/acl.conf.tmpl`). M1 chuyển sang xác thực HTTP qua `apps/api`.

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

Sắp có: `apps/api` (NestJS) và `apps/workers` (ingest, command, rules, scheduler) ở M1.

## Ghi chú kỹ thuật

- Bản đồ nền (`src/pages/map/mapStyle.ts`): mặc định "Tự động" = VersaTiles Colorful (sáng) / Eclipse (tối) — mở, không cần key, tự host được cho production. Chọn thêm trong nút Lớp: CARTO Voyager / Dark Matter (đẹp nhưng dùng thương mại cần gói CARTO), OpenFreeMap Liberty / Positron, Vệ tinh, Vệ tinh + tên đường (Esri).
- Icon bản đồ là SVG tự vẽ (`src/pages/map/mapIcons.ts`): ghim tủ theo màu + ký hiệu trạng thái, trụ đèn sáng/tắt; tuyến tô màu theo trạng thái nhánh.
- `.npmrc` `legacy-peer-deps=true`: drizzle-orm khai báo peer tùy chọn (react-native, expo…) xung đột React 18 của web.
- `LGPS` = `lat'lon'sats` chứa dấu `'`: parser tách mỗi cặp ở dấu `'` ĐẦU TIÊN. Telemetry lưu theo giờ nhận của server, không dùng PTIM làm khóa (PTIM chỉ chính xác tới phút).
- `vite.config.ts` loại `maplibre-gl` khỏi pre-bundle (MapLibre 6 nạp worker theo đường dẫn tương đối).
- Bundle production ~2.8 MB (chưa code-split) — tách chunk theo trang ở M7/M11.
- Ô hiện "—" / "Chờ firmware" = thiết bị chưa gửi dữ liệu đó (spec mục 4.2, 5).
- Frame CoreIF thô không bao giờ gửi về trình duyệt; UI chỉ hiện mô tả lệnh (`describeCommand`). Frame chỉ lưu ở command log phía server.
