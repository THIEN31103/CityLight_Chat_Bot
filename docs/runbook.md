# Runbook vận hành (VPS production)

Cập nhật 2026-10-19 (M11). Máy: AWS Lightsail `citylight-prod`, Sydney, Ubuntu 24.04, IP tĩnh `13.55.91.187`.
Web `https://13-55-91-187.sslip.io`, MQTT `13.55.91.187:1883`. Code ở `/opt/citylight` (bản `git archive`, không phải clone).

## 1. Truy cập

| Việc | Lệnh |
|---|---|
| SSH | `ssh -i ~/.ssh/citylight_aws ubuntu@13.55.91.187` |
| Compose (trên VPS) | `cd /opt/citylight && alias dc='docker compose -f infra/docker-compose.yml -f infra/docker-compose.prod.yml --env-file infra/.env --profile app'` |
| DB bằng psql | `docker exec -it citylight-db psql -U citylight -d citylight` |
| DB bằng DBeaver | tunnel `ssh -i ~/.ssh/citylight_aws -N -L 15432:127.0.0.1:5432 ubuntu@13.55.91.187`, nối `localhost:15432`, DB/user `citylight`, mật khẩu `POSTGRES_PASSWORD` trong `/opt/citylight/infra/.env` |
| EMQX | `docker exec citylight-emqx emqx ctl clients list` (dashboard không mở ra ngoài; log level `warning` nên không có dòng connect/disconnect) |

Firewall Lightsail chỉ mở 22, 80, 443, 1883. DB chỉ bind `127.0.0.1:5432`, Redis / API / EMQX dashboard chỉ trong mạng Docker.
Bí mật nằm trong `/opt/citylight/infra/.env` (sinh trên VPS, `chmod 600`). Bản sao trước khi sửa: `infra/.env.bak-YYYYMMDD`.

## 2. Kiểm nhanh "server có ổn không"

```sh
docker ps --format '{{.Names}}\t{{.Status}}'          # 9 container citylight-*, db/redis/emqx/api "healthy"
curl -s https://13-55-91-187.sslip.io/api/v1/health    # {"status":"ok","db":"ok","redis":"ok"}
/opt/citylight/infra/scripts/watchdog.sh --test        # chạy mọi kiểm tra + gửi tin thử Telegram
tail -5 /opt/citylight/backups/{backup,watchdog}.log
```

Web: menu **Giám sát hệ thống** (`/system`): tủ online, telemetry/giây, độ trễ ingest, hàng đợi lệnh, lệnh lỗi 24 h, dung lượng DB.
Từ laptop: `npm run e2e:vps` (Playwright, 6 kiểm tra không cần đăng nhập).

## 3. Giám sát và cảnh báo

- **Watchdog trên VPS** (`infra/scripts/watchdog.sh`, cron mỗi 5 phút, log `backups/watchdog.log`): container chết / unhealthy, API health, cổng 1883, đĩa ≥ 85 %, backup mới nhất > 26 h, có tủ đăng ký mà 15 phút không có frame MQTT nào, chứng chỉ HTTPS < 14 ngày.
  Gửi Telegram tới **admin đã liên kết bot** (Tài khoản → Telegram), lặp lại mỗi 60 phút khi lỗi còn, báo một lần khi hết. Danh sách chat được lưu tạm `infra/.watchdog-chats` để vẫn gửi được khi DB chết.
- **Không tự báo được khi cả VPS chết.** Cần monitor bên ngoài (chưa có, cần tài khoản của Bảo):
  - UptimeRobot (miễn phí, 5 phút): monitor *Keyword* `https://13-55-91-187.sslip.io/api/v1/health` chứa `"status":"ok"`, + monitor *Port* `13.55.91.187:1883`; báo qua email / Telegram.
  - Lightsail console → instance → Metrics → thêm alarm "Status check failed" + "CPU" gửi email.
- Cảnh báo nghiệp vụ (tủ mất kết nối, quá áp, lệch lịch…) do `notify-worker` gửi qua bot `@Citylight_Team_Bot`. Bot chỉ chạy **một nơi** (Telegram chỉ cho một `getUpdates`): hiện là VPS; token trong `.env` local đã để trống.

## 4. Backup và khôi phục

- Hằng ngày 02:15 (cron user `ubuntu`): `infra/scripts/backup-db.sh` → `/opt/citylight/backups/db-*.sql.gz` + `uploads-*.tar.gz`, giữ 14 ngày. Kiểm: `crontab -l`, `tail backups/backup.log`. Cron gọi script qua `sh …` (2026-10-20: deploy bằng `git archive` từng làm mất quyền thực thi → backup 02:15 và watchdog lỗi "Permission denied" suốt 17 h; script giờ lưu mode 755 trong git).
- Bản ngoài VPS: Task Scheduler laptop **"CityLight backup pull"** (08:30 hằng ngày + khi đăng nhập, chạy bù) → `D:\CityLightBackups\vps`, giữ 60 ngày, log `pull.log`. Chạy tay: `powershell -ExecutionPolicy Bypass -File infra\scripts\pull-backups.ps1`.
- Không chép `.env`: mất VPS thì khôi phục được dữ liệu, nhưng `TOTP_ENC_KEY` mới làm mọi user phải cài lại 2FA, và phải đặt lại mật khẩu DB/Redis/EMQX mới.
- **Diễn tập** (không đụng DB thật): `infra/scripts/restore-drill.sh [file]` dựng container Timescale tạm, nạp dump, so số dòng 34 bảng với DB đang chạy. Lần đầu 2026-10-19: 0 lệch, 2 hypertable, 2 s. Nên chạy lại mỗi tháng.
- **Khôi phục thật** (DB hỏng / VPS mới), dừng các service ghi trước:

```sh
dc stop ingest command-worker scheduler notify-worker api
docker exec citylight-db psql -U citylight -d postgres -c 'DROP DATABASE citylight' -c 'CREATE DATABASE citylight'
docker exec citylight-db psql -U citylight -d citylight -c 'CREATE EXTENSION timescaledb' -c 'SELECT timescaledb_pre_restore()'
gunzip -c backups/db-<ts>.sql.gz | docker exec -i citylight-db psql -U citylight -d citylight -v ON_ERROR_STOP=1 -q
docker exec citylight-db psql -U citylight -d citylight -c 'SELECT timescaledb_post_restore()'
docker run --rm -v infra_uploads:/u -v /opt/citylight/backups:/b alpine:3.20 tar xzf /b/uploads-<ts>.tar.gz -C /u
dc up -d
```

`pg_dump` in cảnh báo "circular foreign-key constraints … continuous_agg": bình thường với TimescaleDB, đã xử lý bằng `timescaledb_pre_restore()`.

## 5. Cập nhật phiên bản

Từ laptop (repo Server, đã commit):

```sh
git archive HEAD | ssh -i ~/.ssh/citylight_aws ubuntu@13.55.91.187 'tar -x -C /opt/citylight'
cd apps/web && VITE_API_MODE=real npx vite build && scp -r -i ~/.ssh/citylight_aws dist/* ubuntu@13.55.91.187:/opt/citylight/web-dist/
```

Trên VPS: chạy migration nếu có file mới trong `packages/db/migrations`, rồi `dc up -d --build`:

```sh
dc run --rm --no-deps -w /app/packages/db api node --import tsx src/migrate.ts
dc up -d --build
```

Sau đó: mục 2 + `npm run e2e:vps`. Chỉ đổi một file cấu hình: chép riêng file đó, `dc config` để kiểm, rồi `dc up -d --no-deps <service>`.
**Đổi `infra/Caddyfile`** (hoặc file nào được mount từng file vào container): `docker restart citylight-caddy`. `caddy reload` không đủ, vì `tar` thay file bằng file mới nên container vẫn đọc bản cũ (gặp 2026-10-20 khi thêm CSP).
Tạo lại `db` làm DB gián đoạn ~7 s; ingest giữ frame trong bộ đệm nên không mất (đã thử 2026-10-19).

## 6. Sự cố thường gặp

| Triệu chứng | Kiểm | Xử lý |
|---|---|---|
| Watchdog báo container X | `docker logs --since 10m citylight-X` | `dc up -d <service>` (service: `db redis emqx api ingest command-worker notify-worker scheduler caddy`); lặp lại thì xem log trước khi restart |
| Tủ không lên web | `emqx ctl clients list` có client `ec25_*`? `frames_raw` có `ltid` đó? `unknown_devices`? | Chưa đăng ký → Quản trị → Thiết bị chưa đăng ký. Không có client → phía tủ (4G, LDOM/LPOR) |
| Lệnh `timeout` | `commands` (status, ack_rc, error), tủ có subscribe `stm32/ec25/cmd` không | Firmware cũ `1307ebc` bị chặn điều khiển có chủ đích |
| `rc:0` nhưng đèn không đổi (`acked_unconfirmed`) | `PCON`, `PTIM` trong telemetry | LTE đã ghi PLC_KEY nhưng PLC↔LOGO (ETH) mất: xem LED PB5 trên PLC_KEY |
| Telegram không gửi | `docker logs citylight-notify` | "fetch failed / ETIMEDOUT": thiếu `NODE_OPTIONS=--network-family-autoselection-attempt-timeout=2000` (VPS không có IPv6, Telegram ở châu Âu). "409 Conflict": có nơi khác đang chạy bot cùng token |
| Đĩa đầy | `df -h /`, `docker system df` | `docker builder prune -af`, `docker image prune -a`; dữ liệu telemetry nén sau 2 ngày |
| HTTPS hỏng | `docker logs citylight-caddy` | sslip.io + Let's Encrypt tự gia hạn; cần cổng 80 mở |

## 7. Bảo mật còn mở

- Broker anonymous, mở Internet: ai cũng gửi được telemetry giả đúng LTID (lệnh thì ACL chặn). Đã thấy máy quét lạ kết nối. Hướng: firmware gửi user/pass ở `AT+QMTCONN` + EMQX bật authenticator (**chặn mọi tủ chưa có user/pass**, nên đổi cùng lúc với đợt nạp firmware) + ACL theo username.
- Chưa có domain: dùng `sslip.io`. Có domain thì đổi `SITE_HOST`, `dc up -d caddy`.
- **Lớp chống giả mạo đang chạy (S42)**, trong lúc broker còn ẩn danh:
  - Khóa IMEI theo tủ. Frame IMEI lạ bị bỏ qua, mở **E805 "Nghi giả mạo tủ"**. Xử lý trong cảnh báo hoặc tab Thông tin → "IMEI…": *không ai thay modem* = giữ nguyên, không bấm gì; *vừa thay modem* = "Chấp nhận (đã thay modem)"; đứng ở tủ và không rõ IMEI = "Học lại IMEI".
  - Giá trị vô lý → null; quá 1 frame/s cho một LTID → bỏ. Đếm trong log ingest: `throttled · sanitized · foreign IMEI`.
  - EMQX: 500 kết nối/s, gói ≤ 8 KB, flapping → cấm 5 phút. Xem cấm: `docker exec citylight-emqx emqx ctl banned list`, gỡ: `emqx ctl banned delete clientid <id>`.
  - Vẫn giả được: ack lệnh trên `stm32/ec25/echo` (không có IMEI). Hết hẳn khi có user/pass.
