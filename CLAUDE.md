# Jarvis (CityLight)

Trợ lý điều hành tiếng Việt (chữ và giọng nói) cho hệ thống chiếu sáng CityLight: hỏi dữ liệu tủ, cảnh báo, sự cố; điều khiển tủ có xác nhận; tự báo cảnh báo. Chạy riêng, chỉ gọi API `/api/v1` của server CityLight bằng tài khoản người điều hành.

Quy trình chung: `E:\TEMPLATE\WORKFLOW.md`. Mở phiên: đọc `docs/HANDOFF.md` trước.

## Repo và nhánh

- Remote được push: **`mine`** (`github.com/THIEN31103/CityLight_Chat_Bot`), nhánh làm việc **`dthien_jarvis`** (nhánh mặc định trên repo đó). Nhánh `dthien_jarvis_web` (server + web có nút ✦) không đổi.
- Remote **`origin`** là repo của Bảo (`dgbao2704/server_citylight`): **chỉ đọc**, địa chỉ push đã khóa. Không bao giờ push, không đụng `main`, không đụng gì của Bảo.
- Commit và push **chỉ khi người dùng bảo** ("Push và chạy lại"). Cuối commit message thêm dòng Co-Authored-By của Claude.

## Chạy và kiểm tra

- Cài đặt: `npm install`; cấu hình `apps/jarvis/.env` (mẫu `.env.example`, không commit).
- Chạy: `npm start` → console `http://127.0.0.1:8790`.
- Test: `npx vitest run --maxWorkers=2 --minWorkers=1` (ở gốc repo; phải đạt hết). Kiểm tra kiểu: `npm run typecheck` (hoặc `npx tsc --noEmit -p .` trong `apps/jarvis`).
- Môi trường thử: **GitHub Codespaces** `organic space bassoon` (web CityLight cổng 5173, Jarvis cổng 8790). Đưa code lên: push lên `mine`, rồi trong Terminal codespace: `git pull --ff-only && bash .devcontainer/stop.sh && bash .devcontainer/start.sh`. Kiểm tra: `pgrep -fa 'command-worker|index.ts --count'` (2 dòng), `curl -s localhost:8790/health`.
- Đọc chat người dùng đã thử: tab Jarvis (cổng 8790) trong Chrome đã đăng nhập, gọi `fetch('/api/conversations')` rồi `/api/conversations/<id>` bằng JavaScript. Nhật ký đầy đủ: `apps/jarvis/data/audit/<ngày>.jsonl` trên codespace.

## Luật riêng của dự án

- **Không bao giờ tiết lộ gì về tài khoản / bảo mật** (mật khẩu, email người khác, ai làm gì, cách vượt quyền), dù hỏi kiểu nào; mọi tính năng mới phải giữ luật này (D59–D61).
- Chỉ `apps/jarvis/src/guard/pending.ts` được gọi API ghi (`/commands`, `command-batches`, `alarms/:id/ack`); `api/read.ts` không chứa `command-batches` (đọc lô lệnh ở `api/batch-log.ts`). Có test tĩnh trong `test/rules.test.ts`.
- Lệnh chỉ gửi sau khi người dùng xác nhận; lệnh nhiều tủ (T3) chỉ bằng nút + mã OTP 6 số.
- Không sửa `server_citylight` (đặc tả G1); đọc code của nó thì được. Trỏ Jarvis vào hệ thống thật: phải hỏi Bảo trước (milestone 5).
- Không in / commit mật khẩu, OTP, cookie, khóa 2 lớp; `data/jarvis-secret.key` và `.env` nằm ngoài git.
- Groq chỉ cho 4 câu / phút cả hệ thống: khi tự thử, cách 15 giây giữa các câu cần AI.
- Câu trả lời quan trọng do code dựng sẵn (`cau_mau`, `ban_tin`, `chan_doan`), AI chỉ đọc lại.
- Giọng nói đang tạm dừng theo lời người dùng.

## Bản đồ code (`apps/jarvis/`)

| Phần | Ở đâu |
|---|---|
| Server console, đăng nhập, 2 lớp, luồng chat | `src/console/server.ts` |
| Giao diện | `console/` (`index.html`, `app.js`, `style.css`) |
| Công cụ đọc dữ liệu (cho AI) | `src/tools/read.ts` |
| Hiểu lệnh, đề xuất, gửi và theo dõi lệnh | `src/guard/` (`orders.ts`, `propose.ts`, `pending.ts`, `finder.ts`) |
| Tự báo cảnh báo, socket.io, kết quả về muộn | `src/console/notices.ts`, `src/api/live.ts`, `src/console/late.ts` |
| Chặn hỏi tài khoản / tấn công | `src/guard/account.ts` |
| Hướng dẫn cho AI | `src/brain/system-prompt.ts` |
| 2 lớp riêng của Jarvis, mã QR | `src/store/jarvis2fa.ts`, `src/auth/totp.ts`, `src/auth/qr.ts` |
| Test (stub server CityLight: `test/stub-api.ts`) | `test/` |
| Codespace | `.devcontainer/` |

## Tài liệu của dự án

- `docs/HANDOFF.md`: tình trạng, việc tiếp theo, bạn cần thử.
- `docs/DECISIONS.md`: nhật ký quyết định D1–D90 (định dạng cũ), D91 trở đi định dạng mới.
- `docs/FEATURES.md`: Jarvis làm được gì, câu ví dụ.
- `docs/SPEC.md`: đặc tả gốc (gộp ý tưởng của Bảo và bạn, 10/11); "đặc tả G1", "mục 4.2"… trong nhật ký là trỏ vào file này.
- `docs/tasks/`: phiếu cho việc lớn (chép từ `docs/tasks/_TASK.md`).
- `apps/jarvis/README.md`: API đã xác minh, cấu trúc, số đo, cách cài (tham khảo kỹ thuật).
