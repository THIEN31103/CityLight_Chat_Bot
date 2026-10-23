# CityLight Server — tổng quan (bản để trình bày / demo)

Cập nhật 2026-10-22. Số liệu đo trên production ngày 21/10. Chi tiết kỹ thuật: `spec.md`, `decisions.md` (S1–S55), `runbook.md`.

## 1. Một câu

Hệ thống **giám sát và điều khiển tủ chiếu sáng** tự vận hành (broker MQTT + backend + web), thiết kế cho **10.000 tủ**.
Production trên AWS (Sydney) tại `https://13-55-91-187.sslip.io`, đã nối tủ thật.

## 2. Kiến trúc

```text
Tủ (LTE EC25 4G) --MQTT 1883, user/pass--> EMQX (broker tự host)
                                              |  listener nội bộ 1885
                         ingest worker  <-----+-----> command-worker (gửi lệnh, chờ ack, xác nhận)
                              |                        scheduler (lịch tự động, lịch thiên văn)
                              v                        notify-worker (Telegram)
                PostgreSQL + TimescaleDB + PostGIS, Redis
                              |
                        API NestJS (REST + Socket.IO realtime)
                              |
                   Caddy HTTPS  -->  Web React (Việt / Anh)
```

- Một VPS, Docker Compose; không Kafka / K8s (quy mô này một máy là đủ).
- Tủ chỉ nói chuyện với broker; web không bao giờ nói chuyện trực tiếp với tủ.

## 3. Chức năng

| Nhóm | Nội dung |
|---|---|
| Bản đồ | Tủ theo trạng thái (sáng / nghỉ / lỗi / mất kết nối / tiết giảm / không rõ); bấm thẻ trạng thái → danh sách tủ → bay tới tủ; tìm kiếm, cây khu vực, vị trí đã lưu, chỉ đường Google Maps |
| Chi tiết tủ | 12 tab: điện áp / dòng / công suất 3 pha, dòng rò, nhiệt độ, GPS, giờ LOGO, chẩn đoán từng khối (4G, RS485, PLC, LOGO/ETH, đồng hồ điện, cảm biến) |
| Điều khiển | Bật/tắt từng nhánh hoặc cả tủ (thủ công), về tự động, đặt lịch, đồng bộ giờ. Nút: viền vàng = đang gửi, tô màu + ✓ = tủ đã xác nhận đèn đổi |
| Lịch & hàng loạt | Lịch vùng / riêng tủ, lịch thiên văn; lệnh hàng loạt theo vùng có mã 2FA, tiến độ realtime |
| Cảnh báo | 40+ mã E1xx–E8xx: mất kết nối, mất PLC/PM/CT, **mất LOGO kèm nguyên nhân** (ETH / cáp / LOGO), quá/thấp áp, mất pha, rò điện, nhiệt, lệch lịch, sai giờ, lệch GPS, nghi giả mạo. Chống nhiễu 30 s; Telegram |
| Sự cố | Tạo từ cảnh báo, giao người xử lý, ảnh hiện trường, Excel, báo cáo tháng, nhắc quá hạn |
| GIS | Tuyến / trụ / đèn trên bản đồ, vẽ / sửa, nhập Excel (đã thử 200.000 trụ) |
| Tiết giảm | Hồ sơ theo nhóm đèn, ước tính kWh và tiền điện. **Chưa gửi xuống tủ** (firmware chưa hỗ trợ, server trả 409) |
| Quản trị | Đăng ký tủ (thiết bị lạ tự hiện ra), user + phân quyền theo khu vực, nhật ký thao tác, Việt/Anh theo từng user |

Phân quyền: **Nhà cung cấp** (phía mình) > **Quản lý** (cao nhất phía khách) > Điều hành > Bảo trì / Xem. Mô hình: **mỗi khách một server riêng**.

## 4. An toàn

- Đăng nhập: 2FA bắt buộc, nhập lại 2FA cho thao tác nhạy cảm, khóa sau 5 lần sai, Telegram báo đăng nhập từ IP lạ.
- Lệnh: một lệnh / tủ tại một thời điểm, ack + retry + timeout, xác nhận bằng telemetry thật; chặn tủ offline và firmware cũ.
- Chống giả mạo: MQTT bắt buộc tài khoản, ACL chỉ backend gửi lệnh; **khóa IMEI theo tủ** (frame IMEI khác bị bỏ qua, E805; thay board LTE → "Chấp nhận (đã thay modem)"); lọc giá trị vô lý; giới hạn tần suất frame theo tủ.
- Web: HTTPS, CSP, cookie httpOnly, CSRF; DB không mở ra Internet.

## 5. Vận hành

Backup DB 02:15 mỗi đêm + kéo về laptop; diễn tập khôi phục 34 bảng 0 lệch; watchdog 5 phút báo Telegram; runbook đầy đủ; mỗi lần deploy chạy `e2e:vps`.

## 6. Số đo

| Chỉ số | Kết quả |
|---|---|
| Thử tải (laptop) | **10.000 tủ** 16 phút: 921.570 dòng, 0 lỗi, ghi DB < 0,6 s; phát hiện offline trong 52–64 s |
| Bản đồ | 10.000 tủ: dữ liệu nén 600 KB, kéo/zoom 135 FPS |
| Tủ thật qua 4G | **87 lệnh, 0 lỗi / 0 timeout**; ack 0,7–2,3 s, xác nhận đèn đổi 2,6–4,6 s |
| Mất LOGO (firmware `LOGO_DIAG`) | E301 kèm nguyên nhân trong ~10 s (trước: ~6 phút); đã thấy trên phần cứng `PLGO=2` (rút UART ETH), `PLGO=3` (rút cáp LAN) |
| VPS hiện tại | 2 vCPU / 3,8 GB: CPU < 2%, RAM 1,6 GB, đĩa 24%; request từ VN ~0,55 s (0,29 s là đường truyền tới Sydney) |
| Kiểm thử tự động | 133 unit test + 15 bộ e2e |

## 7. Hiện trạng và giới hạn

- M10 (tủ thật) gần xong: còn thử rút 4G, GPS, `LDIA`.
- Sau demo 21/10 (đã code 23/10, chưa deploy): topic lệnh riêng mỗi tủ (S53), ẩn lỗi DS18B20 khi tủ không lắp cảm biến (S54), xuất Excel / CSV (S55). Đang làm: lệnh hàng loạt theo vùng + mã tủ + điều khiển. Chờ bàn: nhập bản đồ CAD.
- Tiết giảm chờ firmware / phần cứng dim. Lịch chỉ xác nhận được "đã nhận" (tủ chưa gửi lịch đang chạy).
- **Đĩa**: đổi chính sách lưu trữ hoặc thêm đĩa trước khi vượt ~1.000 tủ (runbook mục 8).
- MQTT dùng chung một mật khẩu; tiếp theo: mỗi tủ một mật khẩu, rồi TLS. Chưa có tên miền riêng, chưa có monitor ngoài, backup chưa mã hóa (chờ khóa).

## 8. Lộ trình

1. Mỗi tủ một mật khẩu MQTT; firmware gửi cửa / contactor, lịch đang chạy, kWh; chính sách lưu trữ.
2. Tên miền riêng, TLS MQTT, server đặt tại VN (đã khảo sát một máy 8 vCPU / 15 GB: đủ chạy, cần mở cổng 1883 + HTTPS, deploy ~2–2,5 h).
3. Tiết giảm thật, đèn thông minh.

## 9. Câu hỏi hay gặp

| Câu hỏi | Trả lời |
|---|---|
| Mất 4G thì sao? | Tủ vẫn chạy theo lịch trong LOGO; có mạng lại tự nối; server báo mất kết nối sau ~60 s |
| Server sập thì đèn tắt? | Không. Lịch nằm trong LOGO; server chỉ giám sát và điều khiển |
| Gửi lệnh giả được không? | Không: broker cần tài khoản, ACL chỉ cho backend gửi lệnh, tủ lọc lệnh theo ID tủ |
| Lên 10.000 tủ? | Đã thử tải 10.000 tủ; cần thêm đĩa và mật khẩu riêng từng tủ |
| Dữ liệu lưu bao lâu? | Telemetry 90 ngày (nén sau 2 ngày), frame thô 7 ngày, backup mỗi đêm |

## 10. Kịch bản demo gợi ý

- Trước giờ demo: bật tủ bàn ≥ 10 phút trước, kiểm `TM01.0001` xanh; liên kết Telegram nếu muốn demo cảnh báo về điện thoại.
- Bản đồ → bấm thẻ trạng thái → danh sách → chi tiết tủ.
- Điều khiển từng nhánh (nút đổi màu sau ~3–5 s) → về tự động; đặt lịch; đồng bộ giờ.
- Rút dây ETH → E301 nêu nguyên nhân trong ~10 s, cắm lại tự đóng.
- Việt/Anh, phân quyền, nhật ký, chỉ đường.
- Tránh: tiết giảm (409), bấm I2 khi đang thủ công (LOGO bàn chạy `_v17c`, bản `_v17d` chưa nạp).
