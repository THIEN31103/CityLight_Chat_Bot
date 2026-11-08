# CityLight — broker MQTT thử nghiệm trên máy khách

Máy này chỉ chạy **EMQX** (broker MQTT mã nguồn mở, Apache-2.0). Tủ điện nối vào cổng 1883 của máy này. Server CityLight nối vào cổng 1885 qua đường hầm WireGuard. Trên máy không có mã nguồn, cơ sở dữ liệu hay khóa bí mật của server. File `emqx/device-users.csv` chỉ chứa mật khẩu đã băm.

## Việc của quản trị mạng phía khách

1. Router: chuyển cổng **TCP 1883** từ IP public về `192.168.1.40:1883`.
2. Cho phép đi ra **UDP 51820** tới `13.55.91.187` (WireGuard do máy này gọi ra).

## Cài nhanh

`sudo sh install.sh < /dev/null 2>&1 | tee install.log` làm hết các bước dưới, kèm lớp chặn chỉ cho IP Việt Nam vào cổng 1883 (`cl-geoip`). Gỡ lớp chặn nhanh: `sudo systemctl stop cl-geoip`. Thêm dải IP được phép: `/etc/cl-geoip/allow-extra.txt` rồi `sudo systemctl restart cl-geoip`.

## Cài đặt (Ubuntu, quyền sudo)

1. Cài Docker và WireGuard:
   ```bash
   sudo apt update && sudo apt install -y docker.io docker-compose-v2 wireguard-tools
   ```
2. WireGuard: sinh khóa ngay trên máy này, gửi **khóa công khai** `customer.pub` cho CityLight, nhận lại khóa công khai của VPS. Tạo `/etc/wireguard/wg0.conf` theo mẫu `wg0-customer.conf.tmpl` (CityLight gửi kèm), rồi:
   ```bash
   sudo systemctl enable --now wg-quick@wg0
   ping -c 3 10.88.0.1
   ```
3. Docker phải khởi động **sau** WireGuard, vì cổng 1885 chỉ mở trên địa chỉ `10.88.0.2`:
   ```bash
   sudo mkdir -p /etc/systemd/system/docker.service.d
   printf '[Unit]\nAfter=wg-quick@wg0.service\nWants=wg-quick@wg0.service\n' | sudo tee /etc/systemd/system/docker.service.d/after-wg.conf
   sudo systemctl daemon-reload
   ```
4. Chạy broker từ thư mục này:
   ```bash
   sudo docker compose up -d
   sudo docker compose ps        # emqx: healthy
   ```

## Vận hành

- Xem log: `sudo docker compose logs --tail 100 emqx`.
- Dừng hoặc khởi động lại: `sudo docker compose stop` / `start`. Khi broker dừng, tủ mất kết nối nhưng **đèn vẫn chạy theo lịch** trong LOGO.
- CityLight đổi tài khoản: nhận thư mục mới, chép đè `emqx/`, rồi chạy `sudo docker compose down -v && sudo docker compose up -d`. Lệnh này xóa dữ liệu trong EMQX và nạp lại tài khoản; broker không giữ dữ liệu nào cần lưu.
- Không mở dashboard 18083 ra mạng.
