# Device contract (tủ ↔ server)

Tóm tắt phần server cần biết. Nguồn sự thật: `../../CLAUDE.md` (mục CoreIF Protocol, MQTT details) và `BOARD_LTE_KEY/Mylib/core_if.c`, `BOARD_LTE_KEY/Core/Src/main.c`. Đọc code 2026-10-17, nhánh `dev_key_uid_dgb` @ `5af6d3c`.

## Kết nối MQTT (EC25)

| Mục | Giá trị hiện tại | Ghi chú cho server |
|---|---|---|
| Giao thức | MQTT 3.1.1, TCP thường, cổng 1883 | `AT+QMTCFG="ssl",0,0,0` (TLS tắt; nhánh SSL + user/pass đang comment trong `main.c`) |
| Auth | **Không user/pass** (`AT+QMTCONN=0,"<cid>"`) | Broker phải cho anonymous ở giai đoạn 1 |
| Client ID | `ec25_<HAL_GetTick ms>` | Không định danh tủ; có thể trùng. Định danh tủ bằng `LTID` trong payload |
| Keepalive | 60 s | |
| QoS | Publish QoS 0 (`AT+QMTPUBEX=0,0,0,0,...`), subscribe QoS 0 | Có thể mất frame |
| Host/port | `MQTT_HOST`/`MQTT_PORT` compile-time, hoặc `LDOM`/`LPOR` từ flash provisioning (UART2) | **LDOM nhận hostname** → dùng tên miền. LDOM/LPOR/LTID **không** đổi được qua MQTT (`rc:-2`) |
| Reconnect | `link_task` mỗi 30 s kiểm `AT+CPIN?`/`AT+QIACT?`, mất sau 2 lần fail, reconnect + subscribe lại | Firmware mới `e4d0e6a`+. Firmware cũ `1307ebc` không subscribe lại |
| APN | `v-internet` | |

## Topic

| Topic | Hướng | Nội dung |
|---|---|---|
| `electrical_cabinets_default` | tủ → server | Telemetry CoreIF, **chung mọi tủ** |
| `stm32/ec25/cmd` | server → tủ | Lệnh CoreIF, **chung mọi tủ**, lọc bằng `LTID` |
| `stm32/ec25/echo` | tủ → server | Ack JSON |
| `stm32/ec25/demo` | tủ → server | Báo cáo `LDIA` (RS485 self-test) |
| `stm32/ec25/boot` | ? | Có trong `mqtt_sniff.py`, chưa kiểm firmware |

## Telemetry

- Frame: `*#KEY'VAL&KEY'VAL$`. Chu kỳ 10 s; thay đổi → gom 2 s; `LQ2`/`LQ3`/`PMAN` đổi → 0.5 s (`FAST_FEEDBACK 1`); tối thiểu 1 s giữa 2 frame.
- Keys: `LTID LDOM LPOR LIME LGPS LTIM LCLI LBAT LACI LERR CTVL CTTE MCON MPU1-3 MPI1-3 MCO1-3 MCOS MPOW PCON PIN5 LINE1 LINE2 LQ2 LQ3 PMAN PTIM`. `X` = không có dữ liệu.
- Ý nghĩa quan trọng:
  - `LQ2`/`LQ3` = nhánh 1/2 đang sáng thật (LOGO Q2/Q3). `PMAN` = đang ở chế độ thủ công.
  - `LINE1`/`LINE2`/`PIN5` = **echo lệnh**, không phải trạng thái thật.
  - `PCON`/`MCON` = PLC/PM có trả lời; `LCLI` 0 = mọi slave OK, 1 PLC mất, 2 PM mất, 3 CT mất, 4 cả ba, X tổ hợp khác.
  - `PTIM` = giờ LOGO (độ phân giải phút), `X` khi `PCON'0`. `LTIM` = echo giờ server gửi.
  - `LGPS'X` trước fix GNSS đầu tiên.
  - `CTVL` dòng rò mA, `CTTE` nhiệt độ °C (1000 = lỗi DS18B20). `MPU/MPI/MCO/MCOS/MPOW` từ đồng hồ DH (0 khi đồng hồ mất).
- Chưa gửi: `PDOR` (cửa), `PFLT` (lỗi contactor) — `TELE_SEND_DOOR_FAULT 0`.
- Chưa có: lịch đang chạy trong LOGO (T10..T22), tín hiệu "mất LOGO" riêng.

## Lệnh (downlink)

- Mỗi frame **bắt buộc** `LTID'<id>` (địa chỉ đích, không phân biệt hoa thường). Sai/thiếu → bỏ, không ack. `LTID'ALL` chỉ chạy `LTIM`.
- ≤ 16 key/frame. Key ≤ 7 ký tự, không phân biệt hoa thường.
- Lệnh có tác dụng: `T10/T20` (lịch nhánh 1), `T11/T21` (lịch nhánh 2, Chế độ 2), `PI50` (Chế độ 2), `LINE1/LINE2`, `PI2O` (xung bật tay), `LTIM` (giờ server), `PMAN`, `PLN1/PLN2`, `LDIA`. `T12/T22` (tiết giảm) đang tắt (`rc:-2`).
- ISO: `YYYY-MM-DDTHH:MM:SS[.mmm]` + offset; **luôn gửi giờ địa phương `+07:00`**, không gửi `Z`.
- Ack trên `stm32/ec25/echo`: `{"id":"CTY0005","ack":[{"k":"PI2O","rc":0}],"ts":<ms>}`.
  - `rc 0` = đã ghi xuống PLC_KEY (**chưa chứng minh LOGO làm**), `-1` = giá trị sai / Modbus fail, `-2` = key không hỗ trợ.
  - Xác nhận thật = telemetry `LQ2`/`LQ3`/`PMAN` đổi theo.
- PLC_KEY chỉ chuyển lệnh khi giá trị **đổi**; gửi lại cùng giá trị không có tác dụng.

## Firmware cũ ngoài hiện trường (`1307ebc`)

- Không lọc `LTID`: thực thi mọi lệnh trên `cmd`, frame có `LTID` sẽ **đổi** LTID của tủ.
- Ack không có `id`. Không subscribe lại sau reconnect.
- Server phải tính đến việc tồn tại song song 2 loại firmware cho tới khi nâng cấp hết.
