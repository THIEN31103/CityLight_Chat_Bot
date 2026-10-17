# CityLight Server

Nền tảng giám sát / điều khiển tủ chiếu sáng CityLight V2 (broker MQTT + backend + web). Quy mô thiết kế 10.000 tủ. **Dự án production.**

- Spec: [`docs/spec.md`](docs/spec.md) · Quyết định: [`docs/decisions.md`](docs/decisions.md)
- Project overview: [`../03 Projects/CityLight Server.md`](../03%20Projects/CityLight%20Server.md)
- Repo git riêng (nested trong repo firmware, đã exclude ở `.git/info/exclude` của repo firmware).

## Trạng thái mốc

| Mốc | Trạng thái |
|---|---|
| **M1-UI** giao diện đầy đủ (mock) | ✅ chạy được, 18 màn hình + 12 tab chi tiết tủ, dữ liệu giả 600 tủ |
| M0 nền (Docker, CoreIF parser, simulator) | ⏳ cần cài Docker Desktop |
| M1 → M11 | chưa bắt đầu (xem `docs/spec.md` mục 16) |

## Chạy web (M1-UI)

Yêu cầu: Node.js ≥ 22.

```bash
npm install
npm run dev:web
```

Mở http://localhost:5173. Mặc định chạy **mock API** (handler MSW gọi trực tiếp trong trang qua `getResponse`, không dùng Service Worker vì trình duyệt tắt SW sau ~30 s idle làm app ngừng tải), không cần backend. Khi có API thật: `VITE_USE_MOCK=false npm run dev:web` (Vite proxy `/api` → `localhost:3000`).

### Tài khoản mẫu (chỉ trong mock, `apps/web/src/mocks/seed.ts`)

Mật khẩu chung: `demo`. Tài khoản có 2FA nhập mã `123456`.

| Email | Vai trò | 2FA |
|---|---|---|
| `admin@citylight.local` | Quản trị | có |
| `dieuhanh@citylight.local` | Điều hành | có |
| `giamsat@citylight.local` | Giám sát (chỉ xem) | không |
| `duytu@citylight.local` | Đội duy tu | không |

Dữ liệu mock tạo lại mỗi lần tải lại trang (phiên đăng nhập được giữ trong `sessionStorage`).

## Cấu trúc

```text
apps/web/            React + Vite + TS (MapLibre, ECharts, TanStack Query/Table, Tailwind, Radix)
  src/mocks/         mock API (MSW) + mock DB: trạng thái, vòng đời lệnh, lô đồng bộ, realtime giả
  src/lib/api.ts     client /api/v1 — dùng chung cho mock và API thật
  src/lib/realtime.ts  lớp realtime (mock emitter → Socket.IO ở M1)
packages/shared/     type domain, nhãn, quyền RBAC, ánh xạ CoreIF mặc định
docs/                spec, quyết định, device contract, kiến trúc
```

Sắp có: `apps/api` (NestJS), `apps/workers` (ingest, command, rules, scheduler), `apps/simulator`, `packages/coreif`, `packages/db`, `infra/`.

## Ghi chú kỹ thuật

- Bản đồ nền (`src/pages/map/mapStyle.ts`): mặc định "Tự động" = VersaTiles Colorful (sáng) / Eclipse (tối) — mở, không cần key, tự host được cho production. Chọn thêm trong nút Lớp: CARTO Voyager / Dark Matter (đẹp nhưng dùng thương mại cần gói CARTO), OpenFreeMap Liberty / Positron, Vệ tinh, Vệ tinh + tên đường (Esri).
- Icon bản đồ là SVG tự vẽ (`src/pages/map/mapIcons.ts`): ghim tủ theo màu + ký hiệu trạng thái, trụ đèn sáng/tắt; tuyến tô màu theo trạng thái nhánh.
- `vite.config.ts` loại `maplibre-gl` khỏi pre-bundle (MapLibre 6 nạp worker theo đường dẫn tương đối).
- Bundle production ~2.8 MB (chưa code-split) — tách chunk theo trang ở M7/M11.
- Ô hiện "—" / "Chờ firmware" = thiết bị chưa gửi dữ liệu đó (spec mục 4.2, 5).
- Frame CoreIF thô không bao giờ gửi về trình duyệt; UI chỉ hiện mô tả lệnh (`describeCommand`). Frame chỉ lưu ở command log phía server.
