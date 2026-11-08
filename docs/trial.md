# Trial một khách — hướng A′ (S60)

Mỗi khách thử nghiệm có **một bộ trial riêng trên VPS**, tách khỏi production: DB, Redis, API và các worker riêng. **Broker EMQX đặt ở máy khách**. Tủ nối vào broker của khách; worker trên VPS nối tới broker đó qua WireGuard. Trên máy khách không có code, DB hay secret nào của server.

```text
Tủ (4G) ──1883──> Máy khách: EMQX (infra/customer/)          1885 chỉ trên 10.88.0.2, có mật khẩu
                                 │ WireGuard (máy khách gọi ra, UDP 51820)
VPS 13.55.91.187 ─ wg0 10.88.0.1 ┘
  production (project infra)         : giữ nguyên
  trial (project citylight-trial)    : trial-db, trial-redis, trial-api, trial-ingest, trial-command, trial-notify, trial-scheduler
  caddy (chung)                      : SITE_HOST → api:3000, TRIAL_HOST → trial-api:3000 (Caddy + trial-api chung mạng riêng `citylight-edge`, S61; trial-api không chạm mạng production)
```

## File

| File | Vai trò |
|---|---|
| `infra/docker-compose.trial.yml` | Bộ trial. Mọi service có tiền tố `trial-`, vì `trial-api` nằm chung mạng với production, nơi tên `db` / `redis` / `api` đã trỏ vào container production. Không publish cổng nào. Mỗi container có giới hạn RAM/CPU (tổng tối đa ~2,4 GB, thực tế dùng ~0,6 GB) để trial không lấn sang production |
| `infra/docker-compose.trial.local.yml` | Chỉ dùng để test trên laptop (`TRIAL_LOCAL=1`) |
| `infra/.env.trial` | Secret của trial, sinh bằng `infra/scripts/gen-trial-env.sh`. Gitignored, mode 600, chỉ nằm trên VPS. Mẫu: `.env.trial.example` |
| `infra/customer/` | Gói giao khách: compose chỉ có EMQX + README cài đặt. `infra/scripts/trial-customer-bundle.sh` render ra `infra/customer/out/`, CSV tài khoản **chỉ chứa mật khẩu đã băm** (sha256 + salt) |
| `infra/wireguard/*.tmpl` | Mẫu `wg0.conf` cho VPS (chặn mọi kết nối MỚI đi vào từ `wg0`, cả `INPUT` lẫn `DOCKER-USER`) và cho máy khách |
| `infra/caddy/trial.caddy` | Site trial. Bật bằng cách chép vào `infra/caddy-sites/` (thư mục này gitignored) |
| `infra/scripts/trial-ctl.sh` | `up / down / ps / logs / migrate / seed / seed-region / backup / drill / watchdog / bundle` cho bộ trial |
| `packages/shared/regions/hcm-2025.json` | Phạm vi hoạt động (S62): ranh giới + 168 phường/xã TP. Hồ Chí Minh mới. Sinh lại bằng `build-hcm-2025.mjs` (nguồn ghi trong đầu file) |

Các script `backup-db.sh`, `restore-drill.sh`, `watchdog.sh` nhận tham số qua biến môi trường. Giá trị mặc định vẫn là production; `trial-ctl.sh` truyền giá trị của trial. Watchdog trial:
- kiểm `10.88.0.2:1885` qua VPN;
- đọc `cl:ingest:mqtt` trong Redis trial;
- gửi cảnh báo `[TRIAL] CityLight` qua **bot và admin của production**.

## Siết thêm (S61)

- Ingest trial bật 4 chốt chặn: tổng frame/s, dòng `frames_raw`/phút, số tủ lạ, kích thước DB (giá trị trong `docker-compose.trial.yml`, đổi bằng biến cùng tên trong `.env.trial`). DB chạm `INGEST_MAX_DB_MB` → ngừng ghi lịch sử, watchdog báo. Thử: `npm run e2e:flood` với cùng giá trị `INGEST_MAX_*`.
- Caddy ↔ `trial-api` qua mạng riêng `citylight-edge`. Thứ tự lần đầu: `dc up -d caddy` (tạo mạng) rồi mới `trial-ctl.sh up`.
- Backup trial được mã hóa `age` như production và kéo về `D:\CityLightBackups\vps-trial`.

## Phạm vi hoạt động: TP. Hồ Chí Minh mới (S62)

- Compose trial đặt `SERVICE_REGION=hcm-2025` cho mọi service. Production không đặt nên không đổi gì.
- Cây khu vực = 38 nhóm "(cũ)" × 168 phường/xã. Nạp một lần sau `seed` (chạy lại không sao): `sh infra/scripts/trial-ctl.sh seed-region`. Web không thêm / sửa / xóa khu vực được nữa.
- API từ chối tọa độ tủ / trụ / tuyến ngoài vùng (dung sai 300 m). GPS tủ ngoài vùng → E807.
- Bản đồ trial vẽ viền vùng và không cho kéo ra xa.
- Bộ trial đã chạy sẵn thì deploy S62 = build image như runbook 5, rồi `trial-ctl.sh seed-region` và `trial-ctl.sh up`. Kiểm: `npm run e2e:region` (`API_URL` + `DATABASE_URL` của trial; trên VPS chạy trong container `trial-api`).

### Lớp 4: broker khách chỉ nhận IP Việt Nam (chạy từ 2026-11-08)

Code: `infra/customer/cl-geoip.sh` + `cl-geoip.service` + `cl-geoip-update.{service,timer}` (`install.sh` cài). Lần đầu nạp 1 655 CIDR VN. Kiểm 8/11: laptop IP VN vào được 1883, VPS Sydney bị chặn (timeout). Xem: `sudo cl-geoip.sh status`, `journalctl -k | grep cl-geoip-drop`. Docker publish thêm `[::]:1883` nhưng máy khách không có IPv6 public nên chưa cần luật IPv6.

Cổng 1883 trên máy khách chỉ mở cho dải IP Việt Nam, để bớt các lượt dò từ nước ngoài. Tủ đi 4G Viettel / VNPT / MobiFone nên luôn ra IP VN.

1. Lấy danh sách IPv4 của VN từ APNIC (`delegated-apnic-latest`, dòng `apnic|VN|ipv4`, khoảng 1 000 dải) vào một `ipset` tên `cl-vn4` (kiểu `hash:net`).
2. Docker publish cổng nên luật phải nằm trong `DOCKER-USER` (chuỗi `INPUT` không thấy): cho qua `192.168.1.0/24` (LAN, NAT loopback) và `cl-vn4`, còn lại `DROP` với `--dport 1883`. Có `LOG` giới hạn tốc độ để xem ai bị chặn.
3. Một systemd timer cập nhật `ipset` mỗi tuần (`ipset swap`, danh sách không lúc nào trống) và nạp lại luật sau khi máy khởi động.
4. Cài cần `sudo` (Bảo gõ): `apt install ipset`, chép script + unit vào `/usr/local/sbin` và `/etc/systemd/system`.
5. Rủi ro: dải IP 4G mới chưa có trong danh sách APNIC thì tủ đó không vào được. Xử lý: xem log `DROP`, thêm dải vào `allow-extra.txt`. Tắt nhanh: `systemctl stop cl-geoip` (gỡ luật).
6. Không khóa cổng SSH 2246 theo cách này: đó là cổng quản trị của khách, cần họ đồng ý.

## Dựng trên VPS (bước 3 của plan, hỏi Bảo trước)

1. Backup production + diễn tập khôi phục (`sh infra/scripts/restore-drill.sh`).
2. Chép code (deploy như runbook 5) và build image (`citylight-server:dev` dùng chung cho cả hai bộ).
3. Sinh secret và **cất `DEVICE_MASTER_KEY` + `MQTT_DEVICE_PASSWORD` ra ngoài VPS** (cần cho build firmware trial):
   ```bash
   SEED_ADMIN_EMAIL=<email Bảo> sh infra/scripts/gen-trial-env.sh
   ```
4. WireGuard:
   ```bash
   sudo apt install -y wireguard-tools
   ```
   Sinh khóa trên VPS, tạo `/etc/wireguard/wg0.conf` từ `wg0-vps.conf.tmpl`, rồi `sudo systemctl enable --now wg-quick@wg0`. Trên Lightsail firewall mở **UDP 51820 chỉ cho IP `14.224.163.63`**.
5. Dựng bộ trial:
   ```bash
   sh infra/scripts/trial-ctl.sh migrate
   sh infra/scripts/trial-ctl.sh seed
   sh infra/scripts/trial-ctl.sh seed-region
   sh infra/scripts/trial-ctl.sh up
   ```
6. Caddy:
   - thêm `TRIAL_HOST=trial.13-55-91-187.sslip.io` vào `infra/.env`;
   - chạy `cp infra/caddy/trial.caddy infra/caddy-sites/`;
   - tạo lại Caddy:
     ```bash
     dc up -d caddy
     ```
     Production gián đoạn vài giây.
   - Kiểm `e2e:vps` cho production và `curl https://$TRIAL_HOST/api/v1/health`.
7. Thêm 2 dòng cron (đầu file `trial-ctl.sh`) và tạo thư mục `backups-trial/`.
8. **Kiểm lại production không đổi**: `e2e:vps`, trang hệ thống, watchdog production.

## Máy khách (bước 4, làm xong 2026-11-08)

1. Trên VPS chạy `sh infra/scripts/trial-ctl.sh bundle`.
2. Chép `infra/customer/out/` + `install.sh` + `cl-geoip*` sang máy khách `~/citylight-broker`. Cách đã dùng (không để bản nào trên laptop):
   ```bash
   ssh vps 'tar -C /opt/citylight/infra/customer/out -cf - .' | ssh -p 2246 cstm@14.224.163.63 'umask 077; mkdir -p ~/citylight-broker && tar -C ~/citylight-broker -xf -'
   ```
3. Trên máy khách, một lần `sudo` (Bảo gõ mật khẩu): `cd ~/citylight-broker && sudo sh install.sh < /dev/null 2>&1 | tee install.log`. Script: gói → khóa WireGuard + `wg0` → Docker sau `wg0` → EMQX → lớp 4, in khóa công khai khách. **Phải có `< /dev/null`**: chạy `sudo … | tee` mà không có nó thì `apt-get` bị dừng (SIGTTOU) và script treo.
4. Trên VPS: thêm `[Peer]` khách vào `/etc/wireguard/wg0.conf` (backup `.bak-<ngày>`) và `sudo wg set wg0 peer <customer.pub> allowed-ips 10.88.0.2/32`. Kiểm: handshake, `ping 10.88.0.2`, cổng 1885.
5. Từ VPS: `ALERT_ENV_FILE=/dev/null sh infra/scripts/trial-ctl.sh watchdog --test` → `checks: all ok`. Log `trial-ingest` có `subscribed 4 topics on mqtt://10.88.0.2:1885`. Thêm cron watchdog trial (đầu file `trial-ctl.sh`).

Kết quả 2026-11-08: khóa công khai khách `+/lCjT8ME690r9VpzUPrpD8PkmLkQyWO1Vxd+Bdwrmk=`, RTT qua VPN 227 ms; tài khoản tủ trial được CONNACK, sai mật khẩu / ẩn danh bị từ chối.

Đổi tài khoản trên broker khách: render lại bundle, chép đè `emqx/`, rồi `docker compose down -v && up -d` ở phía khách. EMQX chỉ nạp file CSV cho tài khoản chưa tồn tại, và broker không giữ dữ liệu nào cần lưu.

## Test trên laptop (đã chạy khi viết S60)

```bash
ROOT=$PWD OUT=$PWD/.tmp/trial/.env.trial SEED_ADMIN_EMAIL=trial-admin@citylight.local \
  TRIAL_MQTT_URL=mqtt://host.docker.internal:21885 SITE_HOST=localhost:3100 sh infra/scripts/gen-trial-env.sh
ROOT=$PWD ENV_FILE=$PWD/.tmp/trial/.env.trial OUT=$PWD/.tmp/trial/customer sh infra/scripts/trial-customer-bundle.sh
(cd .tmp/trial/customer && MQTT_PORT=21883 BACKEND_BIND=127.0.0.1 BACKEND_PORT=21885 docker compose up -d)
export TRIAL_LOCAL=1 ROOT=$PWD ENV_FILE=$PWD/.tmp/trial/.env.trial
sh infra/scripts/trial-ctl.sh migrate && sh infra/scripts/trial-ctl.sh seed && sh infra/scripts/trial-ctl.sh up
```

Sau đó chạy `e2e:signing` và `e2e:broker-outage` vào bộ trial: `API_URL=http://localhost:3100`, DB `localhost:15432`, Redis `localhost:16379`, `E2E_CAB_URL=mqtt://localhost:21883`, `E2E_BACKEND_URL` / `E2E_MQTT_URL` trỏ tới broker khách, `E2E_EMQX_CONTAINER=citylight-trial-emqx`. `e2e:broker-outage` cần tủ SIM91xx trong DB trial: chạy `sim:register -- --count 9102` với `DATABASE_URL` của trial, rồi **restart `citylight-trial-ingest`**. Ingest chỉ nạp registry lúc khởi động hoặc khi nhận `cl:config`, nên tủ ghi thẳng vào DB sẽ bị coi là `unknown`. Kết quả ghi trong S60.

## Hoàn tác

- Bộ trial: `sh infra/scripts/trial-ctl.sh down`. Volume vẫn giữ; muốn xóa dữ liệu trial thì cố ý thêm `-v`.
- Caddy: xóa `infra/caddy-sites/trial.caddy`, rồi `dc up -d caddy`.
- VPN: `sudo systemctl disable --now wg-quick@wg0`.
- Phía khách: `docker compose down`. Tủ mất kết nối nhưng đèn vẫn chạy theo lịch LOGO.
