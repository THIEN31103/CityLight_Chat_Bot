# PROMPT: Xây dựng lại hệ thống Giám sát & Điều khiển Chiếu sáng Công cộng (Smart Lighting Platform)

> **Cách dùng:** Gửi toàn bộ nội dung này cho agent. Các mục có ký hiệu **[CÓ THỂ ĐỔI]** là lựa chọn mặc định, bạn chỉnh trước khi gửi nếu cần.

---

## 0. Vai trò & mục tiêu

Bạn là kỹ sư full-stack senior. Nhiệm vụ: xây dựng **từ đầu** một nền tảng web giám sát và điều khiển từ xa hệ thống chiếu sáng công cộng quy mô thành phố (khoảng 10000 tủ điều khiển, hàng chục nghìn trụ/đèn). Hệ thống phải có **đầy đủ chức năng** như hệ thống đang vận hành được mô tả bên dưới. Giao diện và bố cục được phép thiết kế lại cho hiện đại, đẹp và dễ dùng hơn, nhưng **không được bỏ sót chức năng nào**.

Nguyên tắc:

- Không sao chép tên thương hiệu, logo hay bản quyền của hệ thống cũ. Dùng tên sản phẩm trung tính, ví dụ "LightOps", và để tên/logo cấu hình được.
- Ở đâu chưa rõ thông tin (đặc biệt là giao thức thiết bị), **không tự bịa**. Thiết kế lớp trừu tượng (adapter), ghi giả định vào `docs/ASSUMPTIONS.md` và làm tiếp.
- Ưu tiên: đúng chức năng → an toàn khi điều khiển thiết bị → hiệu năng → thẩm mỹ.

---

## 1. Bối cảnh: hệ thống hiện tại làm gì

Đây là hệ thống SCADA-lite cho chiếu sáng đô thị:

- Mỗi **tủ điều khiển chiếu sáng** (gọi tắt là tủ) có một bộ điều khiển (TĐK), kết nối về trung tâm qua SIM 4G. Tủ cấp điện cho 2 nhánh đèn (N1, N2) và đo điện 3 pha.
- Mỗi tủ cấp điện cho nhiều **tuyến**. Mỗi tuyến gồm nhiều **trụ**, mỗi trụ có 1 hoặc nhiều **đèn**. Một số đèn là đèn thông minh, điều khiển được từng bóng qua mạng PAN.
- Người vận hành theo dõi trạng thái trên bản đồ, bật/tắt bằng tay, đặt lịch bật/tắt, đặt mức tiết giảm công suất theo khung giờ, đặt ngưỡng cảnh báo điện, xem biểu đồ điện năng và xử lý sự cố (kể cả phản ánh từ tổng đài công dân 1022).
- Giờ bật/tắt đèn có thể tự tính theo **cảm biến độ rọi (LUX)** của từng vùng.
- Hệ thống còn hiển thị lớp **camera giám sát** và **cây xanh** trên bản đồ. Phần giới thiệu nhắc tới **tưới nước tự động**, đây là module mở rộng.
- Người dùng truy cập qua VPN.

---

## 2. Công nghệ đề xuất [CÓ THỂ ĐỔI]

| Thành phần | Mặc định |
|---|---|
| Backend | Node.js + TypeScript + NestJS (hoặc .NET 8 nếu team quen C#) |
| CSDL chính | PostgreSQL 16 + PostGIS (dữ liệu không gian) |
| Dữ liệu chuỗi thời gian | TimescaleDB (extension của Postgres): điện áp, dòng, kWh, LUX |
| Cache / pub-sub / hàng đợi | Redis (+ BullMQ cho hàng đợi lệnh) |
| Kết nối thiết bị | Lớp Adapter. Mặc định MQTT (EMQX/Mosquitto), có thêm adapter TCP/Modbus/OPC-UA để cắm sau |
| Realtime lên trình duyệt | WebSocket (Socket.IO) |
| Frontend | React 18 + TypeScript + Vite, TanStack Query, Zustand |
| UI kit | Tailwind CSS + shadcn/ui (Radix), icon Lucide |
| Bản đồ | MapLibre GL JS (vector, hiệu năng cao) hoặc Leaflet + markercluster. Hỗ trợ nền OSM, nền vệ tinh, nền WMS/tile của thành phố (URL cấu hình được) |
| Biểu đồ | Apache ECharts |
| Bảng dữ liệu | TanStack Table (lọc, ẩn/hiện cột, phân trang server-side) |
| Xuất Excel | exceljs |
| Auth | JWT access + refresh token (httpOnly cookie), TOTP 2FA (otplib), reCAPTCHA hoặc hCaptcha khi đăng nhập |
| i18n | Tiếng Việt (mặc định) + English |
| Triển khai | Docker Compose (dev), có Dockerfile production, cấu hình qua `.env` |
| Kiểm thử | Vitest/Jest (unit), Supertest (API), Playwright (E2E) |

---

## 3. Mô hình dữ liệu (tối thiểu)

Agent tự chuẩn hóa thêm, nhưng phải có đủ các thực thể và trường sau.

**Tổ chức & phân cấp**

- `organizations`: đơn vị chủ quản.
- `management_units`: khu quản lý, ví dụ "Khu quản lý Giao thông Đô thị số 1..4", "Trung tâm Hầm sông Sài Gòn". Dùng làm đơn vị đồng bộ cấu hình tiết giảm.
- `areas`: quận/huyện/khu vực, ví dụ "Quận 8", "Khu vực 2 (Quận 9 cũ) – TP Thủ Đức". Phân cấp cha-con, mỗi khu vực có số tủ.
- `wards`: phường/xã.
- `lux_zones`: vùng LUX, ví dụ "Quận 1", "Các tuyến đặc biệt (Phạm Văn Đồng, Xa lộ Hà Nội, QL1, QL22, Võ Văn Kiệt, Mai Chí Thọ)", "Công viên", "Địa bàn Khu 1 (trừ đường Phạm Văn Đồng và Công viên)"… Một tủ có thể thuộc **Zone 1** và **Zone 2**.

**Tài sản chiếu sáng**

- `cabinets` (tủ):
  - Định danh: `id`, `code` (vd `TM298.17`), `name` (vd "Bàn Cờ 1").
  - Địa chỉ: địa chỉ, đường, phường, quận, `management_unit_id`, `zone1_id`, `zone2_id`.
  - Vị trí: `geom` (Point), `gps_from_device` (Point).
  - Phần cứng: `is_connected_type` (tủ kết nối trung tâm hay tủ thường), `sim_serial`, `sim_network`, `sim_signal`, `battery_pct`, `photo_url`, `pan_id`.
  - Trạng thái: `status`, `door_status`, `last_seen_at`.
- `routes` (tuyến): `code` (vd `BC_BC1`, `H128_BC_BC1`), `cabinet_id`, `branch` (N1/N2).
- `poles` (trụ): `code` (vd `BC_BC1_5`), `route_id`, `geom`, `lamp_count`, `legacy_code` (vd "cũ 1A").
- `lamps` (đèn): `code` (L1..Ln), `pole_id`, `cabinet_id`, `lamp_group` (0 – Đèn chính, 1 – Đèn giao lộ, 2 – Đèn trên cầu, 3 – Nhóm mở rộng), `rated_power_w`, `is_smart`, `status`.
- `cameras`, `trees`: id, code, geom, thuộc tính cơ bản. Camera có thêm `stream_url`.
- `favorites`: vị trí ưa thích theo user (tên, tâm bản đồ, zoom).

**Cấu hình & điều khiển**

- `cabinet_schedules`:
  - Chế độ 1: giờ mở đèn từ–đến, giờ tiết giảm từ–đến.
  - Chế độ 2: giờ mở nhánh 1 (bật/tắt riêng) từ–đến, giờ mở nhánh 2 (bật/tắt riêng) từ–đến, giờ tiết giảm từ–đến.
  - Cờ chế độ nào đang dùng.
- `cabinet_thresholds`: mỗi ngưỡng có cờ bật/tắt riêng.
  - Điện áp pha: ngưỡng cao, ngưỡng thấp, độ dao động.
  - Dòng I1, I2 (thiết kế mở rộng được cho I3): ngưỡng cao, ngưỡng thấp, độ dao động, ngưỡng không tải.
- `dimming_profiles`: theo `lamp_group`, gồm 5 thời đoạn.
  - Mỗi thời đoạn có mốc bắt đầu và kết thúc tính bằng **phút kể từ 00:00 ngày bật đèn**. Giá trị có thể > 1440 để biểu diễn sau nửa đêm, ví dụ 1320 = 22:00, 1440 = 24:00, 1560 = 02:00 hôm sau, 1680 = 04:00.
  - Mỗi thời đoạn có mức năng lượng 0–100%.
  - Giá trị mặc định cần seed: 100% (bật đèn → 22h), 75% (22h–24h), 50% (0h–2h), 75% (2h–4h), 100% (4h → tắt đèn).
- `commands`: hàng đợi lệnh xuống thiết bị. Trường: `id`, `cabinet_id`, `type`, `payload`, `requested_by`, `status` (queued/sent/acked/failed/timeout), các mốc thời gian, `error`.

**Dữ liệu đo (hypertable TimescaleDB)**

- `cabinet_telemetry`: thời điểm, `cabinet_id`.
  - Điện áp: V L1N, L2N, L3N.
  - Dòng: I1, I2, I3, I trung bình, tần số Hz.
  - cos φ tổng và từng pha.
  - Công suất 3 pha: P (kW), S (kVA), Q (kVAr), và P/S/Q từng pha.
  - Năng lượng tích lũy: kWh, kVAh, kVArh.
  - Trạng thái nhánh N1/N2.
- `lamp_telemetry`: thời điểm, `lamp_id`, trạng thái, công suất W, dòng A, mức dim.
- `lux_readings`: thời điểm, `lux_zone_id`, giá trị lux.
- `lux_daily_schedule`: ngày, vùng, giờ mở, giờ tắt (tính từ LUX).

**Cảnh báo, sự cố, nhật ký**

- `alarms`: `cabinet_id`/`lamp_id`, loại, nội dung, `started_at`, `ended_at`, `duration`, `is_active`, `acknowledged_by`.
- `incidents`: xem chi tiết các cột ở mục 4.6.
- `activity_logs`: ghi lại **mọi thao tác ghi**.
  - Trường: `id`, `user_id`, `action`, `target`, `old_value`, `new_value`, `ip`, `created_at`.
  - Định dạng hiển thị giống hệ thống cũ, ví dụ `Cập nhật giá trị TM298__07.Device1.SETTIME => True`, `Cập nhật giá trị TM530__05.1.1_33_MAN_CTR => 1`.
- `sync_logs`: nhật ký đồng bộ theo vùng (cấu hình tiết giảm, lịch LUX). Trường: vùng, loại đồng bộ, số tủ thành công/thất bại, chi tiết từng tủ, người thực hiện, thời gian.

**Người dùng**

- `users`: email, password hash (argon2), ngôn ngữ, `totp_secret`, `totp_enabled`, `security_code` (mã bảo mật/API key cá nhân, xoay được), `viber_id`, trạng thái.
- `roles`, `permissions`, `user_scopes`: giới hạn user theo khu vực/khu quản lý.

---

## 4. Chức năng chi tiết (bắt buộc đủ)

### 4.1 Xác thực & tài khoản

- Trang đăng nhập:
  - Email, mật khẩu, chọn ngôn ngữ (Tiếng Việt/English), "Ghi nhớ đăng nhập".
  - Captcha.
  - Khóa tạm thời sau N lần sai.
- **Tài khoản cá nhân**:
  - Đổi mật khẩu.
  - Xem và tạo lại mã bảo mật.
  - Đăng ký/hủy nhận tin báo qua Viber. Làm thành lớp `NotificationChannel` để sau này cắm thêm Zalo, Telegram, Email, SMS.
  - Bật/tắt 2FA (TOTP, có QR code và mã khôi phục).
- **Phân quyền RBAC** + phạm vi dữ liệu theo khu vực. Gợi ý vai trò: Quản trị, Điều hành (được điều khiển), Giám sát (chỉ xem), Xí nghiệp/đội duy tu (xử lý sự cố).
- Truy cập trang không đủ quyền phải hiện **trang 403 rõ ràng**. Không được đẩy về trang đăng nhập (đây là lỗi của hệ thống cũ).
- Trang quản trị: quản lý người dùng, vai trò, phạm vi và danh mục (khu vực, khu quản lý, vùng LUX, nhóm đèn). Hệ thống cũ có thể đã có nhưng tài khoản khảo sát không thấy, vẫn phải làm.

### 4.2 Thanh điều hướng chung

- Logo, tên hệ thống, **đồng hồ giờ máy chủ** (đồng bộ theo server, chạy từng giây).
- Nút về trang chính.
- **Chuông cảnh báo lỗi**: dropdown các cảnh báo mới nhất kèm badge số lượng, có link "Xem tất cả". Khi không có gì thì hiện "Không có cảnh báo mới".
- **Menu Sự cố**: Chưa xử lý, Yêu cầu xử lý, Chưa cần & đã xử lý, Tất cả, Báo cáo sự cố tổng quan.
- **Menu chức năng**: Đồng bộ cấu hình tiết giảm, Dữ liệu LUX, Nhật ký LUX, Nhật ký cảnh báo lỗi, Nhật ký thao tác, Nhật ký đồng bộ (+ Quản trị nếu có quyền).
- Menu tài khoản: tài khoản cá nhân, đăng xuất.
- Menu trợ giúp: hướng dẫn sử dụng, hướng dẫn kết nối VPN, giới thiệu.
- Chuyển chế độ sáng/tối.

### 4.3 Trang chính: bản đồ điều hành

**Bộ đếm trạng thái** (realtime). Bấm vào một ô thì lọc bản đồ/danh sách theo trạng thái đó.

- Tủ: Lỗi/Mất kết nối, Nghỉ, Sáng đèn, Tiết giảm.
- Đèn: 4 trạng thái tương tự.
- Mỗi trạng thái có màu và icon riêng. Không dùng **chỉ màu** để phân biệt (cần cho người mù màu).

**Bản đồ**

- Marker tủ, đổi màu theo trạng thái. Tủ kết nối trung tâm và tủ thường dùng biểu tượng khác nhau.
- Marker trụ, nối thành tuyến (polyline) từ tủ. Nhãn trụ hiện tên, kèm "(2 đèn)" nếu có nhiều đèn.
- Rê chuột lên trụ: tooltip `Trụ: <code> (#id) · Tủ: <tên> · Tuyến: <code>`.
- **Clustering** khi zoom xa, vì phải chịu được vài chục nghìn điểm.
- Bấm tủ thì mở **bảng chi tiết tủ** (mục 4.4).
- Bấm trụ hoặc đèn thì mở panel nhỏ với thông tin và trạng thái từng đèn. Hệ thống cũ chưa có phần này, làm thêm.

**Lớp hiển thị** (bật/tắt, lưu lựa chọn theo user):

- Tủ chiếu sáng kết nối trung tâm, Tủ chiếu sáng thường, Trụ chiếu sáng, Đèn chiếu sáng, Camera giám sát, Cây xanh.
- Nền: vệ tinh / bản đồ thường / bản đồ nền của thành phố.
- Hiện tên đối tượng, hiện mã đối tượng.

**Thanh công cụ**

- Tìm tủ theo mã/tên/địa chỉ, có autocomplete; chọn thì bay tới vị trí.
- Vị trí ưa thích: lưu, chọn, xóa.
- Ẩn/hiện panel danh sách.
- Đo khoảng cách (nhiều điểm, hiện tổng mét).
- Về vị trí hiện tại (geolocation).
- Nút xem vệ tinh/bản đồ thường.

**Chế độ chỉnh sửa** (chỉ vai trò có quyền):

- Kéo marker để đổi vị trí tủ/trụ.
- **Thêm đối tượng hàng loạt**: chọn 2 đối tượng (ví dụ 2 trụ), nhập khoảng cách, hệ thống tự sinh các trụ dọc đoạn giữa với mã tự tăng.
- Thay đổi được giữ ở trạng thái nháp. Có nút **Lưu thay đổi** / **Hủy các thay đổi**, và ghi nhật ký thao tác.

**Panel danh sách bên trái**

- Dạng bảng: các tủ trong bán kính 2 km quanh tâm bản đồ. Cột: checkbox hiển thị trên bản đồ, icon trạng thái, tên tủ. Mở rộng một dòng thì thấy các trụ/tuyến bên trong.
- Dạng cây: Đơn vị → Khu vực (kèm số tủ, ví dụ "Quận Bình Thạnh (302)") → Phường → Tủ.
- Bấm một mục thì bản đồ bay tới vị trí đó.

### 4.4 Bảng chi tiết tủ (modal hoặc drawer lớn, gồm 11 tab)

Tiêu đề: `<mã> - <tên>`, màu theo trạng thái. Bảng này cập nhật realtime khi đang mở.

1. **Điều khiển**
   - Sơ đồ trực quan: tủ + nhánh N1, N2 (bóng đèn sáng/tắt), nhãn trạng thái tủ (Sáng đèn / Nghỉ / Tiết giảm / Mất kết nối).
   - Điều khiển bằng tay: bật/tắt toàn tủ, bật/tắt nhánh 1, bật/tắt nhánh 2.
   - Hiển thị: trạng thái hoạt động TĐK, nút mở cài đặt thông số, trạng thái cửa tủ (đang đóng/mở).
   - **Chế độ 1**: thời gian mở đèn từ–đến (giờ:phút), thời gian tiết giảm từ–đến.
   - **Chế độ 2**: thời gian mở nhánh 1 (có checkbox) từ–đến, thời gian mở nhánh 2 (có checkbox) từ–đến, thời gian tiết giảm từ–đến.
   - Thời gian hiện tại của TĐK (ngày/tháng/năm giờ:phút), nút **Đồng bộ thời gian với máy chủ trung tâm**.
   - Nút **Định vị tủ theo tọa độ GPS**: lấy GPS từ thiết bị và so với vị trí trên bản đồ.
   - **An toàn**: mọi lệnh điều khiển phải có hộp xác nhận ghi rõ tên tủ và hành động. Theo dõi trạng thái lệnh (đang gửi → thiết bị xác nhận / lỗi / quá thời gian). Không cho gửi lệnh khi tủ mất kết nối, trừ khi có tùy chọn xếp hàng chờ. Ghi nhật ký thao tác.
2. **Cài đặt**: thông số cảnh báo lỗi.
   - Điện áp pha: ngưỡng cao, ngưỡng thấp, độ dao động (V). Hiện giá trị hiện tại của L1N, L2N, L3N bên cạnh.
   - Mỗi nhánh dòng I1, I2: ngưỡng cao, ngưỡng thấp, độ dao động, ngưỡng không tải (A). Hiện giá trị hiện tại bên cạnh.
   - Mỗi ngưỡng có checkbox bật/tắt. Có nút Lưu & gửi xuống tủ.
3. **Giám sát**: lưới số liệu realtime.
   - cos φ.
   - Công suất thực 3 pha (kW), công suất biểu kiến 3 pha (kVA), công suất phản kháng 3 pha (kVAr).
   - Tổng năng lượng tiêu thụ (kWh), tổng năng lượng biểu kiến (kVAh), tổng năng lượng phản kháng (kVArh).
   - I1, I2, I3, I trung bình (A), tần số (Hz), L1N, L2N, L3N (V).
   - Theo từng pha 1/2/3: cos φ, P, S, Q.
4. **Điện áp**: biểu đồ đường 3 pha theo thời gian, chọn khoảng thời gian, checkbox **Tạm dừng** để dừng cập nhật trực tiếp.
5. **Dòng điện**: tương tự tab Điện áp, cho I1, I2, I3.
6. **KWh**: biểu đồ điện năng tiêu thụ theo giờ trong ngày và theo ngày trong 30 ngày gần nhất.
7. **Tiết giảm**: xem và chỉnh hồ sơ tiết giảm áp cho riêng tủ này (kế thừa từ cấu hình vùng, cho phép ghi đè). Hệ thống cũ **lỗi khi tải tab này**, bản mới phải chạy được.
8. **Đèn**:
   - Tóm tắt: số đèn kết nối, số đèn đang tắt, mức công suất hiện tại, PAN ID.
   - Lưới đèn L1…Ln, mỗi đèn có trạng thái và dropdown **nhóm đèn**.
   - Chọn nhiều đèn để điều khiển bật/tắt/dim. Nút định vị đèn trên bản đồ.
9. **Giám sát đèn**: bảng từng đèn với trạng thái kết nối, trạng thái bật, tên, công suất (W), dòng (A), mức dim.
10. **Thông tin**:
    - Tọa độ GPS; SIM (seri / nhà mạng / cường độ sóng); trạng thái pin (%); Zone 1; Zone 2.
    - **Ảnh thực tế của tủ**: upload, xem, thay ảnh.
    - Thông tin hành chính: địa chỉ, đường, phường, quận, khu quản lý.
11. **Cảnh báo**: 20 cảnh báo lỗi gần nhất của tủ, gồm nội dung, thời điểm, thời gian kéo dài. Hệ thống cũ **lỗi khi tải tab này**, bản mới phải chạy được.

### 4.5 Cảnh báo lỗi

- Bộ máy sinh cảnh báo (rule engine) chạy phía server từ telemetry:
  - Mất kết nối: không nhận dữ liệu sau X phút, X cấu hình được.
  - Vượt ngưỡng điện áp/dòng.
  - Dao động quá mức.
  - Không tải: đèn bật nhưng dòng thấp, nghĩa là có thể cháy bóng hoặc mất cắp cáp.
  - Mở cửa tủ.
  - Đèn lỗi, pin yếu, mất GPS.
- Trang **Cảnh báo lỗi**:
  - Tab "Cảnh báo hiện hữu" và tab "Tất cả cảnh báo".
  - Lọc theo khu vực, loại, thời gian. Có phân trang và xác nhận đã biết (acknowledge).
- **Đảm bảo nhất quán**: số tủ đang lỗi/mất kết nối trên bộ đếm phải khớp với danh sách cảnh báo hiện hữu. Hệ thống cũ báo khoảng 78 tủ lỗi nhưng trang cảnh báo lại "Không có lỗi nào", bản mới phải sửa.
- Đẩy thông báo realtime (WebSocket) và tùy chọn gửi qua Viber hoặc các kênh khác theo đăng ký của user.

### 4.6 Quản lý sự cố

**Trang danh sách**

- Bên trái: cây phân cấp (checkbox "Hiện cây phân cấp") theo quận/huyện → phường. Cây **phải load được dữ liệu**; hệ thống cũ bị trống.
- Bộ lọc khoảng thời gian (mặc định từ đầu tháng tới hôm nay).
- Lọc trạng thái (radio): Tất cả, Chưa xử lý (0), Yêu cầu xử lý (10), Chưa cần xử lý (20), Đã xử lý (30), Chưa cần & đã xử lý (20+30). URL giữ tham số lọc, ví dụ `?q=0`, `?q=20_30`, `?q=all`.
- Lọc theo từng cột, **ẩn/hiện cột**, phân trang (20/50/100 dòng mỗi trang), **Xuất Excel** đúng theo bộ lọc hiện tại.

**Các nhóm cột**

- *Mã*.
- *Tủ điều khiển*: tên tủ, đường, phường/xã, quận/huyện, địa chỉ tủ.
- *Thông tin sự cố*: năm, quý, tháng, thời điểm ghi nhận, thời điểm đồng bộ, người báo, phân loại, nội dung, hình 1/2/3, tọa độ, địa chỉ sự cố (tương đối), trạng thái.
- *Sự cố 1022*: mã sự cố, người báo, SĐT liên hệ, trạng thái.
- *Giám sát*: thời điểm tiếp nhận, người tiếp nhận, ý kiến giám sát, hạn xử lý.
- *Xí nghiệp*: thời điểm xử lý, người xử lý, nội dung xử lý, hình xử lý.
- *Liên kết duy tu*: mã công việc, thực hiện lúc, người thực hiện, hình hoàn thành, danh sách mã công việc.

**Quy trình**

- Tạo sự cố bằng tay, từ cảnh báo, hoặc nhập từ 1022 qua `Incident1022Adapter` (API/webhook; định dạng chưa biết thì để mock).
- Luồng: tiếp nhận → giám sát duyệt hoặc chuyển xử lý (có hạn xử lý) → xí nghiệp xử lý và upload hình → đóng. Liên kết với mã công việc duy tu.
- Trang chi tiết sự cố có timeline các bước, ảnh, vị trí trên bản đồ.

**Báo cáo sự cố tổng quan**

- Chọn tháng.
- Biểu đồ thống kê sự cố theo ngày và trạng thái xử lý (đường + cột chồng).
- Thêm: thống kê theo khu vực, theo phân loại, thời gian xử lý trung bình, tỷ lệ quá hạn.

### 4.7 Dữ liệu LUX & Nhật ký LUX

- Trang **Giám sát độ LUX**:
  - Bên trái: dropdown đơn vị và danh sách vùng LUX (radio), mỗi vùng có id.
  - Bên phải: biểu đồ **giờ bật/tắt theo ngày** (2 đường: giờ mở, giờ tắt; trục Y từ 18:00 qua 06:00), bảng ngày | giờ mở | giờ tắt, và **biểu đồ LUX trong 2 ngày gần nhất** (kéo chọn để zoom, chuột phải để reset zoom).
  - Nút đồng bộ lịch bật/tắt theo LUX xuống các tủ của vùng. Phải có xác nhận, kết quả ghi vào nhật ký đồng bộ.
- Thuật toán: bật khi LUX dưới ngưỡng bật trong N phút liên tục, tắt khi trên ngưỡng tắt. Ngưỡng cấu hình theo vùng. Có lịch dự phòng theo giờ mặt trời mọc/lặn tính từ tọa độ khi mất dữ liệu cảm biến.
- Trang **Nhật ký LUX**: lịch sử giá trị LUX và các lần đổi lịch theo vùng, lọc theo thời gian.

### 4.8 Đồng bộ cấu hình tiết giảm năng lượng

- Chọn **nhóm đèn**: Đèn chính / Đèn giao lộ / Đèn trên cầu / Nhóm mở rộng.
- **Thời đoạn tiết giảm**: 5 thời đoạn, mỗi thời đoạn có checkbox bật và thanh trượt 2 đầu cho mốc bắt đầu–kết thúc. Hiển thị dạng **giờ:phút**, không hiển thị số phút thô như hệ thống cũ. Thời đoạn sau phải bắt đầu đúng chỗ thời đoạn trước kết thúc (tự ràng buộc).
- **Mức năng lượng theo từng thời đoạn**: thanh trượt 0–100%.
- Thêm: **biểu đồ xem trước** mức sáng theo thời gian trong đêm và ước tính kWh tiết kiệm.
- **Chọn khu vực để đồng bộ**: Khu quản lý 1..4, Trung tâm Hầm sông Sài Gòn…
- Nút **Đồng bộ thông số**:
  - Hộp xác nhận ghi số tủ bị ảnh hưởng.
  - Gửi lệnh hàng loạt qua hàng đợi, có thanh tiến trình realtime.
  - Kết quả từng tủ (thành công / lỗi / mất kết nối), cho phép gửi lại các tủ lỗi.
  - Ghi vào nhật ký đồng bộ và nhật ký thao tác.

### 4.9 Nhật ký

- **Nhật ký thao tác**: bảng gồm mã, hành động, người thực hiện, thời điểm. Có phân trang, lọc theo user/thời gian/tủ/loại hành động, xuất Excel. Ghi tự động cho mọi API ghi và mọi lệnh thiết bị.
- **Nhật ký đồng bộ theo vùng**: 2 dropdown (đơn vị, vùng), bảng các lần đồng bộ, mở rộng xem chi tiết từng tủ. Hệ thống cũ trang này trống, bản mới phải có dữ liệu.
- **Nhật ký cảnh báo lỗi**: xem 4.5.

### 4.10 Trợ giúp

- Hướng dẫn sử dụng (markdown, quản trị viên sửa được).
- Hướng dẫn kết nối VPN.
- Trang giới thiệu.

### 4.11 Module mở rộng (giai đoạn 2, chỉ cần thiết kế sẵn chỗ)

- **Camera giám sát**: lớp bản đồ, xem stream (HLS/WebRTC) qua URL cấu hình.
- **Cây xanh**: lớp bản đồ và hồ sơ cây.
- **Tưới nước tự động**: van/bơm, lịch tưới, độ ẩm. Dùng chung khung thiết bị và lệnh với chiếu sáng.

---

## 5. Lớp kết nối thiết bị (quan trọng)

Hệ thống cũ dùng tên tag dạng `<MãTủ>__<số>.Device1.SETTIME` hoặc `<MãTủ>__<số>.1.1_33_MAN_CTR`, gợi ý một gateway kiểu OPC/SCADA. **Giao thức thực tế chưa biết**, nên:

1. Định nghĩa interface `DeviceAdapter`:
   - `connect`, `onTelemetry`, `sendCommand(cabinetId, command) → Promise<Ack>`, `onStatusChange`.
2. Các loại lệnh tối thiểu:
   - `MANUAL_CONTROL` (all/N1/N2, on/off)
   - `SET_TIME` (đồng bộ giờ)
   - `SET_SCHEDULE` (chế độ 1/2)
   - `SET_THRESHOLDS`
   - `SET_DIMMING_PROFILE`
   - `REQUEST_GPS`
   - `LAMP_CONTROL` (danh sách đèn, on/off/dim%)
   - `SET_LAMP_GROUP`
   - `READ_ALL` (đọc lại toàn bộ thông số)
3. Hàng đợi lệnh: có retry, timeout, idempotency key, chống gửi trùng. Giới hạn tốc độ cho lệnh hàng loạt.
4. Bảng ánh xạ tag ↔ trường dữ liệu cấu hình được, để sau này nối với gateway thật mà không phải sửa code.
5. Viết **trình giả lập thiết bị** (`simulator`):
   - Sinh khoảng 1.600 tủ, 30.000 trụ, 40.000 đèn quanh TP.HCM.
   - Phát telemetry có quy luật ngày/đêm, tạo ngẫu nhiên các tình huống lỗi (khoảng 5% mất kết nối, quá áp, không tải).
   - Phản hồi lệnh với độ trễ và tỷ lệ lỗi cấu hình được.
   - Dùng cho dev và demo.

---

## 6. Lỗi đã thấy ở hệ thống cũ, bản mới phải xử lý

1. Tab **Tiết giảm** và **Cảnh báo** trong chi tiết tủ báo "There was an error processing the request".
2. Bộ đếm cho thấy khoảng 78 tủ lỗi/mất kết nối, nhưng trang Cảnh báo lỗi báo "Không có lỗi nào chờ xử lý".
3. Cây quận/phường ở trang Sự cố không load, nên danh sách luôn trống.
4. Tổng số tủ trong cây khu vực (khoảng 1.479) không khớp tổng bộ đếm trạng thái (khoảng 1.588). Bản mới cần có cách hiển thị tủ "chưa phân khu vực".
5. Vào trang không đủ quyền (Nhật ký LUX) bị đẩy về trang đăng nhập thay vì báo 403. Menu còn hiện mục user không có quyền.
6. Thanh trượt tiết giảm hiển thị số phút thô (1320, 1440…) thay vì giờ.
7. Bấm vào trụ trên bản đồ không có phản hồi gì.
8. 2FA không bắt buộc với tài khoản có quyền điều khiển. Bản mới cho phép quản trị bắt buộc 2FA theo vai trò.

---

## 7. Yêu cầu phi chức năng

- **Bảo mật**:
  - HTTPS, CSRF, rate limit, khóa đăng nhập, mật khẩu argon2.
  - Bắt buộc 2FA theo vai trò.
  - Kiểm tra quyền ở **backend** cho mọi API, không chỉ ẩn nút ở frontend.
  - Validate đầu vào (zod/class-validator).
  - Không log mật khẩu hay token.
  - Bí mật để trong `.env`.
- **An toàn vận hành**: lệnh điều khiển và đồng bộ hàng loạt phải xác nhận 2 bước. Có thể cấu hình yêu cầu nhập lại mật khẩu/OTP với lệnh hàng loạt.
- **Hiệu năng**:
  - Bản đồ mượt với 40.000+ điểm (clustering, vector tiles hoặc load theo khung nhìn).
  - API danh sách phân trang ở server.
  - Telemetry gom lại bằng continuous aggregates (5 phút, giờ, ngày), có chính sách lưu trữ (raw 90 ngày, aggregate lâu dài).
- **Realtime**: trạng thái tủ trên bản đồ cập nhật trong vòng 5 giây kể từ khi nhận telemetry.
- **Đa ngôn ngữ**: vi/en cho toàn bộ giao diện. Định dạng ngày theo `dd/MM/yyyy HH:mm:ss`, múi giờ Asia/Ho_Chi_Minh.
- **Responsive**: desktop là chính. Trên tablet/điện thoại vẫn xem được bản đồ, cảnh báo và sự cố, để đội hiện trường dùng.
- **Khả năng truy cập**: tương phản đạt WCAG AA, điều hướng được bằng bàn phím, trạng thái có cả icon và chữ chứ không chỉ màu.
- **Quan sát hệ thống**: log có cấu trúc, endpoint `/health`, metrics cơ bản (số tủ online, độ trễ lệnh).

---

## 8. Định hướng giao diện

- Phong cách: dashboard điều hành hiện đại, sạch, nhiều không gian. Có chế độ sáng và **tối**; chế độ tối hợp với phòng điều hành ban đêm.
- Bố cục gợi ý:
  - Thanh trên cùng gọn.
  - Thanh bên trái thu gọn được (bộ đếm trạng thái dạng thẻ KPI + danh sách/cây).
  - Bản đồ chiếm phần lớn màn hình.
  - Chi tiết tủ mở dạng **drawer bên phải**, để vẫn nhìn được bản đồ, thay vì modal che kín.
- Bảng màu trạng thái thống nhất:
  - Lỗi/Mất kết nối: đỏ
  - Nghỉ: xám
  - Sáng đèn: xanh lá
  - Tiết giảm: vàng hổ phách
- Thao tác nguy hiểm dùng màu và hộp xác nhận rõ ràng. Thông báo bằng toast. Khi đang tải dùng skeleton.
- Trang chủ có thêm KPI tổng quan: % tủ online, kWh hôm nay so với hôm qua, số sự cố quá hạn.

---

## 9. API (định hướng REST + WebSocket)

Prefix `/api/v1`. Có tài liệu OpenAPI/Swagger tự sinh.

| Nhóm | Endpoint chính |
|---|---|
| Auth | `POST /auth/login`, `/auth/refresh`, `/auth/logout`, `/auth/2fa/setup`, `/auth/2fa/verify` |
| Tài khoản | `GET/PATCH /me`, `POST /me/password`, `POST /me/security-code/rotate`, `POST /me/notifications/viber` |
| Bản đồ | `GET /map/objects?bbox=&layers=&zoom=`, `GET /map/stats`, `GET /search?q=` |
| Phân cấp | `GET /areas/tree`, `GET /cabinets/nearby?lat=&lng=&radius=2000` |
| Tủ | `GET /cabinets/:id`, `PATCH /cabinets/:id`, `POST /cabinets/:id/photo`, `GET /cabinets/:id/telemetry?metric=&from=&to=&interval=`, `GET /cabinets/:id/energy?range=day/30d`, `GET/PUT /cabinets/:id/schedule`, `GET/PUT /cabinets/:id/thresholds`, `GET/PUT /cabinets/:id/dimming`, `GET /cabinets/:id/lamps`, `GET /cabinets/:id/alarms?limit=20` |
| Lệnh | `POST /cabinets/:id/commands`, `GET /commands/:id`, `POST /commands/bulk` |
| Chỉnh sửa bản đồ | `POST /map/edits` (lưu theo lô), `POST /poles/bulk-generate` |
| Cảnh báo | `GET /alarms?active=`, `POST /alarms/:id/ack` |
| Sự cố | `GET /incidents?status=&from=&to=&area=...`, `GET /incidents/export.xlsx`, `POST/PATCH /incidents`, `POST /incidents/:id/transition`, `GET /incidents/report?month=` |
| LUX | `GET /lux/zones`, `GET /lux/zones/:id/readings`, `GET /lux/zones/:id/schedule`, `POST /lux/zones/:id/sync` |
| Tiết giảm | `GET/PUT /dimming-profiles/:lampGroup`, `POST /dimming-profiles/sync` |
| Nhật ký | `GET /logs/activity`, `GET /logs/sync`, `GET /logs/lux` |
| Quản trị | CRUD `users`, `roles`, `areas`, `management-units`, `lux-zones`, `cameras`, `trees` |
| WebSocket | Kênh `cabinet:status`, `cabinet:{id}:telemetry`, `alarms`, `commands:{id}`, `sync:{jobId}`, `server:time` |

---

## 10. Kế hoạch giao nộp

Làm theo từng mốc. Mỗi mốc phải chạy được, có test và cập nhật README.

1. **M1 – Nền tảng**: cấu trúc monorepo (`apps/api`, `apps/web`, `apps/simulator`, `packages/shared`), Docker Compose (Postgres+PostGIS+Timescale, Redis, MQTT), auth + RBAC + 2FA, seed dữ liệu giả lập.
2. **M2 – Bản đồ & trạng thái**: bản đồ, lớp hiển thị, bộ đếm, danh sách bảng/cây, tìm kiếm, ưa thích, đo khoảng cách, realtime.
3. **M3 – Chi tiết tủ & điều khiển**: đủ 11 tab, hàng đợi lệnh, simulator phản hồi lệnh, nhật ký thao tác.
4. **M4 – Cảnh báo & sự cố**: rule engine, trang cảnh báo, quản lý sự cố + báo cáo + xuất Excel, adapter 1022 (mock).
5. **M5 – LUX & tiết giảm**: trang LUX, thuật toán lịch, đồng bộ hàng loạt, nhật ký đồng bộ và nhật ký LUX.
6. **M6 – Chỉnh sửa bản đồ & quản trị**: chế độ chỉnh sửa, sinh trụ hàng loạt, trang quản trị, trợ giúp.
7. **M7 – Hoàn thiện**: i18n, dark mode, responsive, tối ưu hiệu năng (test với dữ liệu giả lập đầy đủ), E2E Playwright cho các luồng chính, tài liệu triển khai.

**Tiêu chí nghiệm thu** (tối thiểu):

- Chạy được bằng `docker compose up`. Đăng nhập bằng tài khoản seed và thấy khoảng 1.600 tủ trên bản đồ, bộ đếm khớp với dữ liệu.
- Mọi chức năng trong mục 4 dùng được. Cả 8 lỗi ở mục 6 không còn xuất hiện.
- Gửi lệnh bật/tắt một tủ: thấy trạng thái lệnh thay đổi, trạng thái tủ cập nhật trên bản đồ, có dòng trong nhật ký thao tác.
- Đồng bộ tiết giảm cho một khu quản lý: thấy tiến trình, kết quả từng tủ và bản ghi nhật ký đồng bộ.
- User không đủ quyền gọi API điều khiển nhận 403. Trên giao diện không thấy menu/nút đó.
- Có `README.md`, `docs/ARCHITECTURE.md`, `docs/ASSUMPTIONS.md` và Swagger.

---

## 11. Cách làm việc

- Trước khi code, gửi lại: (a) sơ đồ kiến trúc ngắn, (b) schema DB, (c) danh sách màn hình. Sau đó làm lần lượt theo mốc.
- Khi gặp điểm chưa rõ, ghi vào `docs/ASSUMPTIONS.md`, chọn phương án hợp lý nhất và làm tiếp. Chỉ dừng lại hỏi khi quyết định đó khó đảo ngược, ví dụ giao thức thiết bị thật.
- Commit nhỏ, thông điệp rõ ràng. Không để TODO trong các luồng điều khiển thiết bị.
