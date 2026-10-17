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
| S13 | Broker giai đoạn 1 giữ ACL dạng file + username bí mật cho backend; **không** dùng HTTP authn/authz của EMQX vì khiến mọi publish phụ thuộc API sống. Giai đoạn 2: EMQX built-in database cho tài khoản từng tủ, API đồng bộ qua REST quản trị EMQX. |

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
