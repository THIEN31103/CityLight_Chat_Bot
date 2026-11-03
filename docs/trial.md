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
| `infra/scripts/trial-ctl.sh` | `up / down / ps / logs / migrate / seed / backup / drill / watchdog / bundle` cho bộ trial |

Các script `backup-db.sh`, `restore-drill.sh`, `watchdog.sh` nhận tham số qua biến môi trường. Giá trị mặc định vẫn là production; `trial-ctl.sh` truyền giá trị của trial. Watchdog trial:
- kiểm `10.88.0.2:1885` qua VPN;
- đọc `cl:ingest:mqtt` trong Redis trial;
- gửi cảnh báo `[TRIAL] CityLight` qua **bot và admin của production**.

## Siết thêm (S61)

- Ingest trial bật 4 chốt chặn: tổng frame/s, dòng `frames_raw`/phút, số tủ lạ, kích thước DB (giá trị trong `docker-compose.trial.yml`, đổi bằng biến cùng tên trong `.env.trial`). DB chạm `INGEST_MAX_DB_MB` → ngừng ghi lịch sử, watchdog báo. Thử: `npm run e2e:flood` với cùng giá trị `INGEST_MAX_*`.
- Caddy ↔ `trial-api` qua mạng riêng `citylight-edge`. Thứ tự lần đầu: `dc up -d caddy` (tạo mạng) rồi mới `trial-ctl.sh up`.
- Backup trial được mã hóa `age` như production và kéo về `D:CityLightBackupsps-trial`.

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

## Máy khách (bước 4)

1. Trên VPS chạy `sh infra/scripts/trial-ctl.sh bundle`.
2. Chép thư mục `infra/customer/out/` sang máy khách:
   ```bash
   scp -P 2246 -r infra/customer/out cstm@14.224.163.63:citylight-broker
   ```
3. Làm theo `README.md` trong thư mục đó. Các bước cần `sudo` do Bảo gõ mật khẩu.
4. Từ VPS: `sh infra/scripts/trial-ctl.sh watchdog --test`. Kết quả không còn dòng `MQTT 10.88.0.2:1885`, và `cl:ingest:mqtt` báo connected.

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
