# Chạy CityLight + Jarvis trên GitHub Codespaces

Cả hệ thống thử chạy trên máy của GitHub, máy tính của bạn chỉ mở trình duyệt. Hệ thống gồm Postgres, MQTT, Redis, API, các worker, 1.000 tủ giả lập (65 tủ kết nối), web CityLight, Jarvis và giọng đọc Piper. Chỉ dùng **dữ liệu giả lập**.

Miễn phí: tài khoản GitHub cá nhân có 120 giờ-lõi mỗi tháng, tức khoảng **60 giờ** với máy 2 lõi / 8 GB, cộng 15 GB lưu trữ. Không cần thẻ.

## Lần đầu (khoảng 10 phút)

1. Mở repo trên GitHub → nút xanh **Code** → tab **Codespaces** → **Create codespace on dthien_jarvis**.
   Nếu muốn chọn máy, bấm "…" → **New with options**: chọn **2-core**.
2. GitHub hỏi 2 secret (chỉ lưu trong tài khoản của bạn, không vào repo):
   - `GROQ_API_KEY`: khóa Groq của bạn (console.groq.com).
   - `CITYLIGHT_ADMIN_PASSWORD`: mật khẩu bạn tự đặt (ít nhất 12 ký tự) cho tài khoản thử **admin@citylight.test**.

   Nếu bỏ trống mật khẩu, máy tự tạo mật khẩu ngẫu nhiên và ghi vào `~/.citylight/admin-login.txt`.
3. Chờ cài đặt chạy xong (cửa sổ "Terminal" hiện từng bước `[setup] 1/7 … 7/7`), rồi hệ thống tự khởi động.
4. Mở tab **PORTS** (cạnh Terminal):
   - cổng **5173** → web CityLight; bấm ✦ để mở Jarvis;
   - cổng **8790** → Jarvis trực tiếp.

   Đăng nhập bằng `admin@citylight.test` và mật khẩu ở bước 2. Lần đầu dùng micro, trình duyệt sẽ hỏi quyền.

Các cổng ở chế độ **Private**: chỉ bạn (đăng nhập GitHub) mở được. Đừng đổi sang Public.

## Những lần sau

- Mở lại: github.com/codespaces → chọn codespace → **Open**. Hệ thống tự chạy lại sau khoảng 1 phút.
- **Tắt khi không dùng** để đỡ tốn giờ: github.com/codespaces → "…" → **Stop codespace**. Nếu quên, máy tự ngủ sau 30 phút không dùng.
- Dữ liệu (tủ, lịch sử chat) vẫn còn giữa các lần mở. Xóa codespace là mất hết, lần sau tạo lại từ đầu.

## Khi có lỗi

| Việc | Lệnh trong Terminal |
|---|---|
| Xem log | `ls ~/.citylight/logs` rồi `tail -50 ~/.citylight/logs/jarvis.log` (hoặc `api.log`, `web.log`…) |
| Chạy lại các dịch vụ | `bash .devcontainer/start.sh` |
| Tắt hết dịch vụ | `bash .devcontainer/stop.sh` |
| Cài lại từ đầu (giữ dữ liệu) | `bash .devcontainer/setup.sh` |

- Jarvis báo thiếu khóa Groq: thêm secret `GROQ_API_KEY` ở GitHub → **Settings → Codespaces → Secrets**, cho phép repo này dùng, rồi Stop và Open lại codespace.
- Thêm secret sau khi đã tạo codespace: GitHub chỉ đưa secret vào khi codespace khởi động lại.

## Cấu trúc trong codespace

- `/workspaces/CityLight_Chat_Bot`: nhánh `dthien_jarvis` (Jarvis), nơi bạn sửa code.
- `/workspaces/citylight`: nhánh `dthien_jarvis_web` (server + web CityLight), lấy tự động từ chính repo này.
- Mật khẩu Postgres, Redis, MQTT được tạo ngẫu nhiên lúc cài, nằm trong các file `.env` của codespace, không vào git. 2FA tắt vì đây là bản thử.
