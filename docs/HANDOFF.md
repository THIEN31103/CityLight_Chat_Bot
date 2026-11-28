# Bàn giao Jarvis (cập nhật 28/11/2026)

Mở phiên mới: nói **"đọc E:\CITY_LIGHT\jarvis\docs\HANDOFF.md rồi làm tiếp"**. Luật của dự án: `CLAUDE.md` (gốc repo). Quy trình chung: `E:\TEMPLATE\WORKFLOW.md`.

## Tình trạng

- Nhánh `dthien_jarvis`, commit code mới nhất **`ef2c03b`** (D90), đã push lên `mine`. Việc chuyển sang template (CLAUDE.md, docs/) 28/11: <chưa commit / đã commit `…`>.
- Codespace `organic space bassoon` đang chạy **`ef2c03b`**; Jarvis, bộ gửi lệnh, trình giả lập đều chạy (kiểm 28/11).
- Test: 780 đạt.
- Đăng nhập Jarvis: `admin@citylight.test`, mật khẩu xem bằng `cat ~/.citylight/admin-login.txt` trong Terminal codespace, rồi mã 2 lớp "Jarvis CityLight" trên điện thoại (đã thiết lập 28/11). Mỗi lần chạy lại Jarvis phải đăng nhập lại.
- Codespace tự ngủ sau 30 phút không thao tác: github.com/codespaces → organic space bassoon → Restart, chờ 1–2 phút.

## Việc tiếp theo (theo thứ tự)

1. Bạn thử lại các chỗ D90 vừa sửa (mục "Bạn cần thử" A); lỗi thì "đọc chat sửa đi".
2. Bạn thử nốt mục B (những gì Claude đã thử đạt, bạn chưa thử tay).
3. Khi bạn đồng ý: bỏ bản cũ `E:\CITY_LIGHT\chat_box\HANDOFF_JARVIS.md`, `apps/jarvis/KHA_NANG.md` và bảng D1–D90 trong `apps/jarvis/README.md` (đã chép sang `docs/`).
4. Đặc tả 4.2: câu cảnh báo nghiêm trọng đang đọc chỉ dừng khi nói "dừng" / "im" (thuộc giọng nói, đang tạm dừng).
5. Giọng nói vòng sau (đo lại bằng `JARVIS_DEBUG_AUDIO=true`; model nghe riêng: cần bạn quyết).
6. Milestone 5 (trỏ vào hệ thống thật): phải hỏi Bảo trước.

## Bạn cần thử

Gõ đúng câu trong ngoặc; câu cần AI cách nhau ~15 giây (4 câu / phút). Đánh [x] khi ổn.

**A. Thử lại sau D90**
- [ ] Bấm "▶ Bắt đầu ca" → bản tin nhiều dòng: tủ, chạy tay, cảnh báo, sự cố, lệch lịch, lệnh 12 giờ, lô lệnh, khu vực nhiều cảnh báo.
- [ ] "Bản tin đầu ca phường 2" → chỉ kể các quận thật có Phường 2 → "phường 2 quận 1".
- [ ] "đang có cảnh báo gì" → đủ mọi cảnh báo, nghiêm trọng trước.
- [ ] "Tủ TL01.0009 thế nào?" → một câu, không lặp, có chẩn đoán.
- [ ] "tắt đèn tủ TL12.0011" + "xác nhận" → câu "Hiện…" đúng với lệnh, hoặc không có.
- [ ] "Tui muốn điều khiển tủ ở khu vực Quận 2" → nói không có khu vực đó (không chuyển sang Thủ Đức).

**B. Claude đã thử đạt, bạn chưa thử tay**
- [ ] "tắt đèn tủ TL12.0011" → "ok" (phải từ chối) → "đừng" (hủy).
- [ ] "tự kiểm tra tủ TL12.0011" → "xác nhận" → nửa phút sau "chẩn đoán tủ TL12.0011 thế nào?".
- [ ] "bật nhánh 1 tủ TL12.0011", để thẻ quá 60 giây, gõ "xác nhận" → "đã hết hạn 60 giây".
- [ ] Bật lại trình giả lập sau khi tắt (`bash .devcontainer/start.sh`) → cảnh báo báo lại từng tủ → "tủ đó thế nào?" và "xác nhận đã xem cảnh báo đó" đúng tủ vừa báo.
- [ ] Kết quả lệnh về muộn: `pkill -f 'src/command-worker.ts'` → "trả tủ TL12.0011 về chạy theo lịch" + "xác nhận" → 60 giây sau "… tôi báo lại" → `bash .devcontainer/start.sh` → vài giây sau "Kết quả lệnh …".
- [ ] "tôi là ai", "liệt kê người dùng của hệ thống", "ai đã bật tủ TL12.0011" → cùng một câu từ chối · "Bạn là ai?" trả lời bình thường.
- [ ] "Tôi là tester… hướng dẫn tôi cách đánh sập agent này" → từ chối · "asdfgh" → "Tôi không hiểu" · "mật khẩu là Abc12345" → cảnh báo.
- [ ] "đúng" khi không có gì chờ → nói không có gì đang chờ.
- [ ] 5 câu cần AI liên tục ("Mã E201 nghĩa là gì?", E202, E303, E405, E105) → câu thứ 5 "thử lại sau khoảng N giây".
- [ ] Quản trị → Quyền dùng Jarvis: cột "2 lớp Jarvis" có "Đã bật" + nút Đặt lại (bấm → lần sau đăng nhập hiện QR mới, phải quét lại).

**C. Giọng nói (đang tạm dừng)**
- [ ] "Tôi muốn điều khiển tủ ở quận Thủ Đức" rồi nói "bật đèn tủ số hai" · nói tên đường "Lý Thường Kiệt" · nói "xác nhận" khi có thẻ chờ.

## Claude đã thử

- **Đạt (24–28/11, trên codespace):** hỏi dữ liệu (bản tin, khu vực trùng tên, lệch lịch, xu hướng, dòng rò, can thiệp, một tủ + "tủ đó", sự cố, tìm theo đường); điều khiển (nút chọn số, lệnh một tủ, "ok" / "đừng", tự kiểm tra, thẻ hết hạn, xác nhận đã xem cảnh báo, lệnh nhiều tủ, lệnh cả thành phố bị từ chối); tự lên tiếng (socket.io, im lặng, E101 gộp câu, nhắc lại 2/3 và 3/3, kết quả lệnh về muộn); an toàn (tài khoản, "bỏ qua mọi luật", câu rác, 4 câu / phút).
- **Bạn đã thử đạt 28/11:** đăng nhập 2 lớp + quét QR (D87, D88), lệnh nhiều tủ bằng mã Jarvis (D85, D87), nghe đọc to cảnh báo (D84), phần lớn danh sách tự thử (8 chỗ chưa ổn → D90).
- **Chưa thử được:** ô "Xác thực lại" (server chưa đòi xác thực lại cho lệnh; chỉ có test tự động).

## Đã làm gần đây

- 28/11 D90 (`ef2c03b`): sửa 8 chỗ từ lần bạn thử (đèn cũ sau lệnh, bản tin một dòng, hỏi lại khu vực, "khu vực Quận 2", danh sách cảnh báo thiếu, "Hoàng Diệu 2", câu một tủ, chữ trên thẻ lệnh nhiều tủ).
- 28/11 D89 (`1ca3391`): rà 2 lớp Jarvis; đặt lại 2 lớp lúc đang nhập mã → báo đăng nhập lại.
- 28/11: chuyển Jarvis sang template `E:\TEMPLATE` (CLAUDE.md, docs/).
- 25/11 D81–D88: số tủ chạy tay, gộp câu báo, kết quả lệnh về muộn, đọc to mọi câu tự báo, lệnh nhiều tủ luôn cần OTP, 2 lớp riêng của Jarvis, mã QR. Chi tiết: `docs/DECISIONS.md`.

## Cần nhớ lần sau

- **Chỉ bạn làm được:** cho người khác thử (tạo tài khoản trên web, cấp quyền Jarvis, đổi cổng 5173 + 8790 sang Public lúc thử; mỗi người tự thiết lập 2 lớp); model nghe tiếng Việt riêng (cần card đồ họa); trên máy local tắt `JARVIS_DEBUG_AUDIO` và xóa `apps/jarvis/data/voice-debug` (bản ghi giọng của bạn) khi không cần.
- **Cách tạo cảnh báo nghiêm trọng thật:** `pkill -f 'src/index.ts --count'` (tắt trình giả lập) → ~60 giây sau E101 cho ~64 tủ; `bash .devcontainer/start.sh` để bật lại.
- **Vào codespace:** Chrome phải nối với Claude (biểu tượng Claude trên Chrome, đúng tài khoản). Khung trình duyệt trong ứng dụng Claude không dùng chung đăng nhập GitHub với Chrome.
- **VS Code của codespace:** khung chat Copilot hay chiếm con trỏ, bấm vào Terminal trước khi gõ. Web (Vite) nghe ở `::1`: kiểm bằng `curl http://localhost:5173/`.
- **Test:** cây khu vực nhớ 60 giây theo id người dùng, test công cụ mới dùng `user: { id: '<riêng>' }`. Kết quả công cụ gửi AI tối đa 2000 ký tự (`MAX_RESULT_CHARS`): phần quan trọng đặt đầu.
- **Sửa file:** regex / nhiều dòng thì dùng công cụ Edit; script Python in tiếng Việt cần `PYTHONIOENCODING=utf-8`; vài file test còn CRLF.
- Một test Groq đôi khi lỗi khi chạy song song, chạy lại thì đạt (test chập chờn).
