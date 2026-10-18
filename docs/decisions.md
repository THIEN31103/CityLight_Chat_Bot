# Decisions

## Đã chốt (Bảo, 2026-10-17)

| # | Quyết định |
|---|---|
| S1 | Tự làm server riêng (broker + BE + FE), không chờ team IT. |
| S2 | **Không dùng chung broker hiện tại** (`14.187.114.85`). Broker riêng do mình vận hành. |
| S3 | Mức độ: production 100%. Thiết kế theo cách doanh nghiệp vận hành, không theo kiểu demo. |
| S4 | Không tự code broker MQTT từ đầu: tự host broker có sẵn. Hướng đang nghiêng về **EMQX** (Bảo nói "giả sử dùng EMQX"). |
| S5 | Cần máy chạy 24/24 cho broker. |
| S6 | Hệ thống **mới hoàn toàn**, không liên quan / không tích hợp hệ thống cũ nào. `prompt_xay_dung_lai_he_thong_chieu_sang.md` chỉ là **tham khảo** chức năng, không copy hết, không nhắc lại hệ thống cũ (lỗi cũ, tag cũ, 1022…) trong spec. |
| S7 | Quy mô thiết kế: **10.000 tủ**. |
| S8 | Chức năng web mà firmware chưa hỗ trợ (dim, kWh, cửa tủ, SIM, báo lịch, đèn/trụ…) **vẫn làm trước** trên web; firmware cập nhật sau. Web phải chịu được dữ liệu thiếu (`X` / chưa có). |
| S9 | Chỉ quản lý tủ CityLight của mình → giao thức thiết bị = CoreIF (đã biết), qua adapter để đổi được khi firmware nâng cấp. |
| S10 | Hạ tầng: **làm và test trên local trước** (Docker Compose), tương lai thuê VPS rồi deploy. |
| S11 | Stack BE: Bảo giao "miễn tối ưu" → spec v0.1 chọn **TypeScript monorepo: NestJS + Postgres/Timescale/PostGIS + Redis/BullMQ + EMQX + React/MapLibre** (thay đề xuất FastAPI P4). Chi tiết `spec.md` mục 2. |

| S12 | M1: cảnh báo sức khỏe thiết bị (suy từ telemetry) làm ngay ở M1; gửi lệnh thật để M4 (Bảo đồng ý 2026-10-17). |
| S14 | M2: TOTP (RFC 6238) tự viết trên `node:crypto` (~60 dòng, kiểm bằng vector RFC 4226/6238), **không** dùng otplib như spec ghi. Secret mã hóa AES-256-GCM bằng `TOTP_ENC_KEY`; mã khôi phục 8 cái, hash argon2id, dùng 1 lần; mỗi mã TOTP chỉ dùng 1 lần (`totp_last_step`). 2FA bắt buộc cho vai trò có `cabinet.control` (admin, operator); `AUTH_REQUIRE_2FA=false` chỉ để test local (Bảo duyệt 2026-10-17). |
| S15 | M2: phạm vi = `users.scope_all` hoặc danh sách khu vực (`user_scopes`, gồm cả khu vực con). Admin luôn toàn hệ thống. **User mới mặc định không thấy tủ nào** tới khi được gán (Bảo duyệt 2026-10-17). Tủ chưa phân khu vực chỉ user toàn hệ thống thấy. Tủ ngoài phạm vi → `403 forbidden_scope`. Đổi vai trò/phạm vi/khóa → xóa session + ngắt socket ngay (Redis `cl:auth`). |
| S16 | M2: CSRF double-submit, token = SHA-256(`csrf:`+session id) gửi trong cookie đọc được `cl_csrf`, web gửi lại ở header `X-CSRF-Token`. Chưa có dịch vụ email: tạo user / đặt lại mật khẩu trả **mật khẩu tạm hiện 1 lần**, user phải đổi ở lần đăng nhập đầu. `TRUST_PROXY` mặc định tắt (tránh giả IP để né rate limit). Captcha để khi lên VPS. |
| S13 | Broker giai đoạn 1 giữ ACL dạng file + username bí mật cho backend; **không** dùng HTTP authn/authz của EMQX vì khiến mọi publish phụ thuộc API sống. Giai đoạn 2: EMQX built-in database cho tài khoản từng tủ, API đồng bộ qua REST quản trị EMQX. |
| S17 | M4 (Bảo duyệt A–E, 2026-10-18): hàng đợi lệnh = bảng `commands` trong Postgres (`deadline_at`, `step`, `attempts`), worker lấy lệnh theo NOTIFY `cl_commands` + quét 500 ms, **không dùng BullMQ** (thứ tự theo từng tủ cần BullMQ Pro groups). Một `command-worker` hoạt động (advisory lock), bản thứ hai chờ dự phòng. |
| S18 | M4: **mỗi tủ chỉ 1 lệnh đang chạy**: ack firmware chỉ có `id` (LTID) + danh sách key, không có mã lệnh → khớp ack theo LTID + tập key. Lệnh sau chờ lệnh trước kết thúc (tối đa ~60 s). Ack đến muộn sau timeout bị bỏ qua. |
| S19 | M4: vòng đời `queued → sent → acked → confirmed / acked_unconfirmed`, `failed` (rc ≠ 0, ghi key + rc), `timeout` (không ack 30 s; MANUAL/AUTO/SET_TIME gửi lại 1 lần), `cancelled` (chỉ khi còn queued). Xác nhận bằng telemetry trong 20 s: MANUAL (`PMAN`+`LQ2`/`LQ3`), AUTO (`PMAN'0`), SET_TIME (`PTIM` lệch ≤ 2 phút). SET_SCHEDULE / PULSE_ON / DIAG dừng ở `acked`. `LDIA` rc −1 = tự kiểm tra báo lỗi → `acked` + ghi chú, không phải lỗi lệnh. |
| S20 | M4: API **từ chối ngay, không xếp hàng**: tủ offline (`409 cabinet_offline`), firmware `1307ebc` (`409 cabinet_unsafe_firmware`, chặn **mọi** lệnh kể cả đặt lịch vì không lọc LTID), thiếu capability. Quyền `cabinet.control` (lịch: `schedule.manage`) + phạm vi khu vực; `Idempotency-Key`; 30 lệnh/phút/user; ≤ 5 lệnh chờ/tủ; gửi tối đa 20 lệnh/s xuống broker. `PULSE_ON` = 2 frame `PI2O'0` rồi `PI2O'1`. Nhật ký: "Gửi lệnh", "Kết quả lệnh", "Hủy lệnh". |
| S21 | M5 (Bảo duyệt A–F, 2026-10-18): luật đo lường chạy **trong ingest** (`shared/rules.ts`, hàm thuần + unit test); ngưỡng = tủ > zone > mặc định, nạp lại qua Redis `cl:config` + mỗi 60 s. `notify-worker` riêng gửi thông báo (gọi HTTP ra ngoài không nằm trên đường ingest). |
| S22 | M5 chống nhiễu: luật đo lường mở sau khi điều kiện giữ **30 s**, đóng sau 30 s hết điều kiện; đèn lệch lịch mở sau **20 phút** (xung bật tay PI2O / nút I2 giữ đèn 15 phút), sai giờ 2 phút, lệch GPS 5 phút. Bỏ luật điện áp/dòng khi mất PM / đồng hồ DH; không luật đo lường khi offline. Lệch lịch chỉ xét tủ có lịch do máy chủ áp (`schedule_applied`) vì firmware không đọc lại lịch LOGO; cửa sổ tiết giảm T012 có sẵn trong LOGO có thể gây "tắt trong lịch" giả. Chưa làm: không tải (cần ánh xạ pha ↔ nhánh), cửa tủ / contactor (chờ firmware). Thêm loại E407 dao động áp, E603 dao động dòng. |
| S23 | M5 thông báo: Telegram trước (Zalo OA cần OA doanh nghiệp, email cần SMTP). Liên kết bằng mã 1 lần + `/start <mã>`, worker long-poll `getUpdates` (không cần IP public); `/stop` tắt. Người nhận: mức ≥ mức user chọn (mặc định Cao), user active, tủ trong phạm vi khu vực. Báo "hết" chỉ cho Cao/Nghiêm trọng. Gom theo user: tin đầu chờ 3 s, sau đó 30 s/lần; > 5 cảnh báo → 1 tin tóm tắt theo loại + khu vực. Bot chặn (403) → tắt đăng ký. Lệnh failed/unconfirmed/timeout → cảnh báo sự kiện E701/E702/E703. |
| S24 | M6 (Bảo duyệt A–F, 2026-10-18): worker `scheduler` giữ mọi tủ ở **lịch mong muốn** (lịch riêng của tủ > lịch vùng), so với `schedule_applied` mỗi 5 phút, ngay khi lịch đổi (Redis `cl:schedules`) và ngay khi tủ online trở lại (cờ `cameOnline` từ ingest). **Không bao giờ đẩy lịch mặc định**: tủ chưa có lịch cấu hình trên máy chủ giữ lịch đặt tay trong LOGO. Chặn gửi lại cùng một lịch đã **thất bại** trong 30 phút (trừ khi tủ vừa online lại); lịch khác thì gửi ngay. Lệnh do scheduler gửi có `requested_by` = `SYSTEM_USER_ID`, hiện "Hệ thống", chỉ ghi nhật ký khi lỗi. |
| S25 | M6 lịch thiên văn: `suncalc` theo tâm vùng (lịch riêng của tủ: theo vị trí tủ), bật = lặn + offset, tắt = mọc hôm sau + offset, làm tròn phút, tính theo ngày Việt Nam; chỉ thay khung nhánh 1 (Chế độ 1: cả tủ), nhánh 2 giữ giờ đặt tay. Cùng một hàm (`shared/schedule.ts`) cho scheduler, API xem trước và biểu đồ web. Lịch vùng chỉ người có phạm vi toàn hệ thống được sửa. |
| S26 | M6 lệnh hàng loạt: theo vùng ∩ phạm vi user, mỗi tủ online một lệnh qua hàng đợi M4; tủ offline ghi `offline` (lịch: scheduler gửi sau), firmware 1307ebc ghi `failed`. **Bắt buộc mã 2FA hiện tại** (chống dùng lại như đăng nhập) khi tạo và khi gửi lại. Tiến độ `batch.progress` (tối đa 1 sự kiện/s/batch) tới người tạo + user toàn hệ thống; nhật ký 1 dòng/batch. Hàng đợi: lệnh người dùng chờ được ưu tiên trước lệnh hàng loạt / scheduler; hạn chờ 120 s (lệnh tay) / 30 phút (hàng loạt). Tiết giảm → 409. |
| S27 | M7 (Bảo duyệt A–H, 2026-10-18): luồng sự cố do **server** kiểm (`shared/incidents.ts`, web dùng chung): mới → giao xử lý (người + hạn) → báo đã xử lý → đóng; nhánh chưa cần xử lý / yêu cầu xử lý lại / mở lại. Giao + đóng cần `incident.manage`, báo xử lý cần `incident.resolve`; Bảo trì chỉ báo xử lý việc **giao cho mình** (quản lý làm thay được). Người xử lý là **user thật** có `incident.resolve` và có tủ trong phạm vi (cùng tổ chức). Phạm vi khu vực ở mọi API. Mã `SC00001` từ sequence. |
| S28 | M7 tạo sự cố từ cảnh báo (phân loại + nội dung gợi ý theo loại cảnh báo), mỗi cảnh báo tối đa 1 sự cố đang mở (unique index), **không tự động tạo** (tránh bão sự cố khi mất mạng diện rộng). Bảo trì cũng báo được sự cố. |
| S29 | M7 ảnh: JPG/PNG/WebP nhận diện bằng **magic bytes**, ≤ 5 MB, ≤ 10 ảnh/sự cố, 2 nhóm (hiện trường / sau xử lý), lưu đĩa (`UPLOAD_DIR`, volume `uploads` — sao lưu cùng DB), trả qua API sau khi kiểm phạm vi (`nosniff`, CSP none). Excel `.xlsx` (exceljs) theo **toàn bộ bộ lọc**, tối đa 50.000 dòng, giờ Việt Nam, cho sự cố và cảnh báo. Quá hạn = đang giao và quá hạn; scheduler kiểm mỗi phút, nhắc người xử lý **1 lần** mỗi hạn (Telegram), timeline ghi "Quá hạn xử lý". `uuid` override 11.1.1 (exceljs) giữ production 0 lỗ hổng. |

## Đề xuất, chờ Bảo chốt

| # | Đề xuất | Lý do |
|---|---|---|
| P1 | Máy chủ = **VPS tại VN, IP tĩnh** (Viettel IDC / FPT / BizFly…), không dùng máy văn phòng IP động | SLA, điện, không CGNAT. Máy văn phòng chỉ cho test |
| P2 | Tủ trỏ tới **tên miền** (`mqtt.<domain>`), không trỏ IP | Firmware đã hỗ trợ LDOM = hostname qua UART2; đổi server chỉ đổi DNS |
| P3 | Broker: EMQX 1 node (BSL ≥5.9 free single node) hoặc Mosquitto 2.x | EMQX: dashboard, auth DB/HTTP. Nếu bán server kèm sản phẩm → kiểm BSL, hoặc EMQX 5.8 (Apache) / Mosquitto |
| P4 | Stack: **FastAPI (Python) + PostgreSQL/TimescaleDB + React (Vite, TS)**, Docker Compose, Caddy/Nginx HTTPS | Bảo quen Python. Phương án thay: BE TypeScript (NestJS/Fastify) |
| P5 | Không Kafka / K8s / microservice | ~1000 tủ × 1 frame/10 s = 100 msg/s, 1 VPS đủ |
| P6 | Giai đoạn 1 giữ nguyên firmware; ACL: anonymous chỉ publish telemetry/echo, chỉ subscribe cmd; chỉ backend (có user/pass) được publish `cmd` | Chặn lệnh giả ngay, không cần đổi firmware |
| P7 | Giai đoạn 2 firmware: user/pass mỗi tủ, client ID = LTID, topic theo tủ, QoS 1 cho lệnh/ack, LWT | Hiện client ID `ec25_<tick>` có thể trùng |
| P8 | Giai đoạn 3: TLS 8883, server cert + password; **không** mutual TLS | Forum Quectel: EC25 hay lỗi `+QMTOPEN: 0,-1` với client cert |
| P9 | Auth web: session cookie httpOnly/Secure/SameSite (không JWT trong localStorage); RBAC admin/operator/viewer (+ theo khu vực) | |
| P10 | Contract-first: OpenAPI do FastAPI sinh → FE sinh TS client (orval / openapi-typescript) | Tránh lệch FE/BE |

## Còn chờ thông tin từ Bảo

- Màn hình + chức năng web giám sát hiện tại (ảnh chụp).
- Số tủ hiện tại / dự kiến; số user; phân quyền theo khu vực / khách hàng (multi-tenant?).
- Đã có VPS / domain chưa.
- Server dùng nội bộ hay bán kèm cho khách (ảnh hưởng license EMQX).
- Có cần chạy song song / tương thích API với web của team không.
