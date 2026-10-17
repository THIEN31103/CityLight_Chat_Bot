# FE/BE workflow và API (đề xuất 2026-10-17)

Bản nháp, chờ thông tin màn hình web hiện tại để chốt spec + OpenAPI.

## Quy trình contract-first

```text
Yêu cầu/màn hình ─> Data model ─> API contract (OpenAPI) ─┬─> BE implement + test
                                                          └─> FE dùng client sinh tự động
                                   ─> Staging (tủ test) ─> Production
```

- FastAPI tự sinh OpenAPI; FE sinh TS client (orval / openapi-typescript) → BE đổi field thì FE báo lỗi lúc build.
- 3 môi trường dev → staging → prod.

## Quy ước REST

- Tài nguyên số nhiều + version: `/api/v1/cabinets/{ltid}`. GET đọc, POST tạo, PATCH sửa một phần, DELETE xóa.
- JSON; thời gian ISO 8601 có offset.
- Phân trang/lọc: `?page=1&size=50&area=Q1&status=offline`.
- Lỗi RFC 9457 `{"type","title","status","detail"}` + mã HTTP đúng (400/401/403/404/409/422).

## Endpoint (nháp)

| Endpoint | Mục đích |
|---|---|
| `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` | Phiên đăng nhập |
| `GET /cabinets?status=&area=` | Danh sách + trạng thái mới nhất |
| `GET /cabinets/{ltid}` | Chi tiết: shadow, telemetry gần nhất, thông tin lắp đặt |
| `GET /cabinets/{ltid}/telemetry?from=&to=&metrics=` | Lịch sử, tự gộp phút/giờ khi khoảng dài |
| `POST /cabinets/{ltid}/commands` | Gửi lệnh (bất đồng bộ) |
| `GET /cabinets/{ltid}/commands` | Lịch sử lệnh |
| `PUT /cabinets/{ltid}/schedule` | Đặt lịch; BE tách thành lệnh T10..T21 |
| `GET /alarms?state=active`, `POST /alarms/{id}/ack` | Cảnh báo |
| `GET /audit-logs` | Nhật ký thao tác |
| `/users`, `/areas` | Quản trị |

## Luồng lệnh (bất đồng bộ)

```text
FE  POST /cabinets/CTY0005/commands {"key":"PMAN","value":1}  + Idempotency-Key: <uuid>
BE  kiểm quyền + giá trị → lưu status=pending → publish MQTT
 <- 202 Accepted {"id":"cmd_123","status":"pending"}
    ack echo rc:0 → acked | rc:-1/-2 → failed
    LQ2/LQ3/PMAN đổi đúng → confirmed
    >30 s không ack → timeout
BE  WebSocket "command.updated" → FE
```

## Realtime

- Một WebSocket (hoặc SSE); FE subscribe theo màn hình (`cabinet:CTY0005`, `alarms`).
- Sự kiện: `telemetry.updated`, `cabinet.online/offline`, `command.updated`, `alarm.raised`.
- Mở trang: REST lấy snapshot; WS chỉ là delta; mất kết nối → nối lại + REST lại.

## Auth

- Session cookie httpOnly + Secure + SameSite (FE và API cùng domain). Không JWT trong localStorage.
- RBAC: `admin` / `operator` / `viewer`, có thể theo khu vực. Audit mọi lệnh và thay đổi cấu hình.

## Cấu trúc code

BE (FastAPI):
```text
api/       router, validate (Pydantic), response
services/  nghiệp vụ: lệnh, lịch, cảnh báo
repos/     DB (SQLAlchemy), migration Alembic
mqtt/      ingest worker + publisher; parser CoreIF tách riêng, có unit test
```

FE (React + Vite + TS): TanStack Query (cache/retry/invalidate theo WS), React Router, Ant Design hoặc shadcn, ECharts, Leaflet (bản đồ tủ), react-hook-form + zod, client sinh từ OpenAPI.

## Vận hành

- Git: nhánh theo tính năng + merge request; CI test/lint/build Docker image.
- Docker Compose trên VPS; Caddy/Nginx HTTPS tự động.
- Log có cấu trúc, uptime monitor, cảnh báo server chết, backup DB hằng ngày ra ngoài.
