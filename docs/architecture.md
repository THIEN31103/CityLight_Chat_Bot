# Kiến trúc production (đề xuất 2026-10-17)

## Tổng thể

```text
Tủ (EC25) ─ mqtt.<domain>:1883 (sau 8883 TLS) ─> Broker (EMQX/Mosquitto)
                                                   │ chỉ backend được publish lệnh
  Ingest worker ── parse CoreIF ──> PostgreSQL + TimescaleDB
  Command service (queue lệnh, chờ ack, timeout, audit)
  Alarm engine (offline, CT rò, nhiệt độ, mất PLC/PM/CT, sau này cửa/contactor)
  API REST + WebSocket <── Caddy/Nginx HTTPS <── Web React
  Monitoring (Uptime Kuma / Prometheus) + backup DB hằng ngày ra ngoài server
```

## Pattern lấy từ hệ thống doanh nghiệp

- **Device registry**: bảng tủ (LTID, GPS, khu vực, firmware, last seen, credential).
- **Device shadow**: desired (server muốn, vd lịch) vs reported (tủ báo). Hạn chế: tủ chưa báo lịch đang chạy → shadow lịch chỉ một chiều cho tới khi firmware bổ sung.
- **Command log + ack**: pending → acked (`rc`) → confirmed (telemetry đổi theo) / failed / timeout; audit ai/khi nào.
- **Telemetry**: lưu frame thô + cột đã parse; nén / downsample dữ liệu cũ.
- **Tủ tự chạy khi server chết**: đã có (lịch nằm trong LOGO).
- **Không over-engineer**: không Kafka/K8s/microservice ở quy mô này.
- **TALQ** (REST/JSON giữa CMS và mạng thiết bị) là chuẩn liên thông ngành chiếu sáng; để sau, chỉ cần API sạch.

## Máy chủ

| | VPS (đề xuất) | Máy văn phòng |
|---|---|---|
| IP | tĩnh | động → cần DDNS (No-IP/DuckDNS/Cloudflare) |
| Rủi ro | ít | cúp điện, modem reboot, CGNAT, nhà mạng chặn cổng |
| Dùng cho | production | test |

Tủ test trên bàn đi 4G → không vào được laptop sau NAT trừ khi port-forward; thuê VPS rẻ để test nhanh hơn.

## Lộ trình

**Giai đoạn 1 — không sửa firmware**
1. VPS Ubuntu + Docker, EMQX một lệnh; firewall chỉ 1883/443/22; dashboard 18083 chỉ IP mình.
2. ACL: anonymous chỉ publish `electrical_cabinets_default` + `stm32/ec25/echo` (+ `demo`), chỉ subscribe `stm32/ec25/cmd`; backend user/pass riêng mới được publish `cmd`.
3. DNS `mqtt.<domain>` → VPS. Đặt LDOM qua UART2 cho tủ test; `mqtt_sniff.py` đổi HOST để xem frame.
4. Backend + web (xem `api-design.md`). Bước nhỏ: parser CoreIF + test từ frame thật → ingest + online/offline → dashboard → lệnh có ack → auth/alarm/deploy.
5. Chuyển tủ hiện trường dần: LDOM chỉ đổi qua UART2 hoặc nạp lại → phải ra tủ.

**Giai đoạn 2 — firmware LTE (cờ compile-time, commit riêng)**
- User/pass mỗi tủ, client ID = LTID; topic theo tủ `citylight/<LTID>/{tele,cmd,ack}` + ACL theo tủ; QoS 1 cho lệnh/ack + id chống trùng; LWT báo offline tức thì.

**Giai đoạn 3 — TLS 8883**
- Server cert + password. Không mutual TLS (EC25 hay lỗi `+QMTOPEN: 0,-1`).

## Firmware cần bổ sung cho web đầy đủ

- Báo lịch đang chạy (T10..T22) lên server (PLC + LTE).
- Bật `PDOR`/`PFLT`.
- Tín hiệu "mất LOGO" riêng (thanh ghi mới, 2 board).
