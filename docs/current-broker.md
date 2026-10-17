# Broker hiện tại của team (để tham khảo, không dùng)

## Đã đo (2026-10-17, đọc-only, kết nối như `00 Notes/tools/mqtt_sniff.py`)

| Thử | Kết quả |
|---|---|
| TCP `14.187.114.85:1883` | 48 ms (server ở VN) |
| CONNECT không user/pass | `CONNACK 0` → **anonymous được phép** |
| SUBSCRIBE `$SYS/#` | SUBACK `0x80` → **bị từ chối** |

Thử thêm subscribe `#` + kiểm cổng 18083/9001/8083… bị auto mode chặn (production read), **chưa chạy**.

## Suy luận

- `$SYS/#` bị từ chối + anonymous mở: khớp `acl.conf` mặc định của **EMQX** (deny `$SYS/#` và `#` cho client không phải localhost). Mosquitto mặc định cho subscribe `$SYS`. → Khả năng cao: EMQX để cấu hình mặc định. Khả năng 2: Mosquitto có ACL tự viết.
- IP broker đã đổi 3 lần: `113.173.254.213` → `123.20.131.229` → `14.187.114.85`, có vẻ đều là dải VNPT FTTH (chưa whois) → nhiều khả năng máy văn phòng/nhà, IP động, port-forward, không phải VPS.
- Tên topic `stm32/ec25/*` giống code mẫu, chưa thiết kế cho sản phẩm.

## Rủi ro

1. Ai biết IP cũng publish lệnh vào `stm32/ec25/cmd`; firmware cũ `1307ebc` không lọc LTID → tác động mọi tủ, đổi được LTID.
2. IP động + firmware gắn IP → đổi IP là mọi tủ rớt, phải nạp lại / ra tủ.
3. Không TLS.
4. Một máy, không rõ backup / giám sát.

Xác nhận chính xác: hỏi team (phần mềm broker gì, chạy ở máy nào, backend viết bằng gì).
