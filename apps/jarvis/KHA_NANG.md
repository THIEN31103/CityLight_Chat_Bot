# Jarvis làm được gì và cách dùng

Jarvis là trợ lý vận hành của CityLight. Bạn hỏi bằng chữ hoặc bằng giọng nói tiếng Việt. Jarvis tra dữ liệu thật của hệ thống rồi trả lời, và có thể bật / tắt từng tủ sau khi bạn xác nhận.

Tài liệu này dành cho người dùng (vận hành viên, quản lý, quản trị viên). Phần kỹ thuật nằm trong [README.md](README.md).

---

## 1. Vào Jarvis

1. Đăng nhập web CityLight như bình thường.
2. Bấm nút **✦** để mở Jarvis. Jarvis dùng chính tài khoản và quyền của bạn trên CityLight.
3. Quản trị viên luôn dùng được. Các vai trò khác cần được cấp quyền trong mục **Quản trị → Quyền dùng Jarvis**.

Jarvis chỉ thấy những tủ, khu vực mà tài khoản của bạn được xem trên CityLight. Jarvis không bao giờ thấy được nhiều hơn.

---

## 2. Hỏi về hệ thống (chỉ đọc)

Mọi con số đều lấy từ dữ liệu thật lúc bạn hỏi. Không có dữ liệu thì Jarvis nói là không có, không đoán.

| Bạn muốn biết | Hỏi ví dụ |
|---|---|
| Tình hình chung | "Hệ thống thế nào rồi?", "Báo cáo tình hình" |
| Bản tin đầu ca | "Bản tin đầu ca", "Báo cáo đầu ca ở quận 1", "Giao ca, có gì cần lưu ý?": tủ, cảnh báo nặng nhất, sự cố quá hạn, tủ lệch lịch trong một câu trả lời |
| Danh sách khu vực | "Hệ thống có những khu vực nào?" |
| Liệt kê tủ theo trạng thái | "Liệt kê 10 tủ đang hoạt động bình thường", "Tủ nào mất kết nối?", "Cho tui 5 tủ đang sáng" |
| Tủ theo khu vực | "Tủ nào mất kết nối ở quận 1?", "Phường Bến Nghé có tủ nào lỗi?" |
| Một tủ cụ thể | "Tủ TL01.0016 thế nào?", "TL12.0006 tình trạng", "Tủ đó có cảnh báo gì không?" |
| Tủ mất kết nối từ khi nào | "TL07.0013 mất kết nối từ khi nào?" |
| Lịch bật / tắt | "Lịch bật tắt tủ TL01.0016 thế nào?" |
| Lịch sử của một tủ | "Tối qua tủ đó bật lúc mấy giờ?", "Dòng rò tủ DM0003 24 giờ qua có bất thường không?" |
| Cảnh báo | "Đang có cảnh báo gì?", "Phường nào đang có lỗi?", "Có bao nhiêu cảnh báo nghiêm trọng?" |
| Ý nghĩa mã lỗi | "Mã E201 là gì?", có thể đọc từng số: "E hai không một" |
| Sự cố ngoài hiện trường | "Có sự cố nào quá hạn không?" |
| Đèn lệch lịch | "Tối nay tủ nào ở quận 1 lẽ ra phải sáng mà đang tắt?", "Đèn nào ban ngày mà vẫn sáng?", "Có tủ nào lệch lịch không?" |
| Tìm tủ theo đường | "Tìm các tủ trên đường Lý Thường Kiệt" |

**Lệch lịch:** Jarvis dựa vào cảnh báo E303 "Đèn lệch lịch" của hệ thống. Hệ thống chỉ báo khi đèn khác lịch quá 20 phút, và không tính tủ đang chạy tay. Tủ mất kết nối thì không biết đèn đang thế nào: Jarvis nói số tủ không kiểm tra được.

**Trạng thái dùng để lọc tủ:** bình thường (có kết nối, không lỗi), đang sáng, đang tắt, có lỗi, mất kết nối.

**Nói tiếp câu trước:** Jarvis nhớ tủ, khu vực hay mã lỗi vừa nói tới. Sau khi hỏi về TL01.0016, bạn chỉ cần nói "tủ đó", "lịch của nó", "tắt nó đi".

**Mã tủ:** gõ hoặc nói như trên web, ví dụ TL01.0016 hay DM0010. Nói tắt cũng được: "TL1 số 16" là TL01.0016. Tên gọi kiểu "tủ demo số mười" cũng được. Nếu nhiều tủ khớp, Jarvis hỏi lại bạn muốn tủ nào.

---

## 3. Điều khiển tủ

Jarvis gửi lệnh cho **từng tủ một** và **chỉ gửi sau khi bạn xác nhận**. Câu lệnh do code Jarvis đọc và kiểm tra, không phải AI tự quyết.

### Các lệnh

| Việc | Nói ví dụ |
|---|---|
| Bật cả hai nhánh (chạy tay) | "Bật đèn tủ TL01.0016" |
| Tắt cả hai nhánh | "Tắt đèn tủ TL01.0016" |
| Bật / tắt một nhánh | "Bật nhánh 2 tủ TL01.0016", "Tắt nhánh 1 tủ đó" |
| Trả về chạy theo lịch | "Trả tủ TL01.0016 về chạy theo lịch" |
| Bật tạm 15 phút (xung) | "Bật xung tủ TL01.0016" |
| Gửi lệnh tự kiểm tra RS485 | "Gửi lệnh tự kiểm tra tủ TL01.0016" |

Chế độ chạy tay giữ đến mốc lịch kế tiếp, sau đó tủ tự chạy lại theo lịch. Khi báo kết quả, Jarvis nói luôn chuyện gì xảy ra sau đó, ví dụ "đèn sẽ tự bật lại theo lịch lúc 18:00".

### Không nhớ mã tủ

Cứ nói những gì bạn nhớ: khu vực, tên đường (nhớ một phần cũng được), số nhà, tủ đang sáng hay đang tắt. Jarvis lọc trong các tủ được phép điều khiển rồi:

- còn **một tủ** → hiện khung xác nhận luôn;
- còn **2 đến 5 tủ** → đọc có số: "số 1: Võ Văn Kiệt 6, Phường 6 (TL12.0006); số 2: …". Bạn nói **"số 2"**, "cái thứ hai" hoặc "cái cuối";
- còn **nhiều hơn** → Jarvis hỏi thêm tên đường hoặc trạng thái. Nếu trong đó chỉ vài tủ đang kết nối, Jarvis đọc luôn các tủ đó (tủ mất kết nối không nhận lệnh).

Ví dụ:

> **Bạn:** Tắt đèn một tủ ở Thủ Đức
> **Jarvis:** Có 42 tủ ở TP Thủ Đức, chỉ 3 tủ đang kết nối: số 1: Võ Văn Kiệt 6, Phường 6 (TL12.0006); số 2: … Bạn chọn số mấy?
> **Bạn:** Số 1
> **Jarvis:** *(khung xác nhận)* Tắt tay cả hai nhánh đèn tủ TL12.0006 (Võ Văn Kiệt 6)…

Chưa biết muốn làm gì cũng được: "tôi muốn điều khiển tủ ở quận 1" → Jarvis đọc các tủ có số → bạn chọn "số 1" → Jarvis hỏi "bật đèn, tắt đèn…?" → bạn nói "bật đèn".

Nói "tắt đèn **quận 1**" (không có chữ "tủ") là lệnh cho cả quận, phải làm trên web. Nói "tắt đèn **một tủ ở** quận 1" là tìm một tủ.

### Xác nhận

Sau câu lệnh, Jarvis hiện **khung xác nhận** ghi rõ tủ nào, làm gì. Khung chờ **60 giây**, hết giờ thì tự hủy.

| Loại lệnh | Cách xác nhận |
|---|---|
| Bật, bật nhánh, về lịch, xung, tự kiểm tra | Nói hoặc gõ "xác nhận", "đồng ý", "ok", "làm đi"… hoặc bấm nút |
| **Tắt** (cả tủ hoặc một nhánh) | Nói hoặc gõ **đúng chữ** "xác nhận" (hoặc "đồng ý"), hoặc bấm nút. "Ok", "có", "được" không dùng được cho lệnh tắt |
| Lệnh đưa ra khi bạn đã không dùng Jarvis hơn 10 phút | Như lệnh tắt: đúng chữ "xác nhận" hoặc bấm nút |

**Lưu ý trước khi gửi:** nếu tủ đang có cảnh báo hoặc sự cố hiện trường chưa xử lý xong, Jarvis nói và ghi thêm một dòng màu cam trên khung xác nhận, ví dụ "Lưu ý trước khi gửi: tủ đang có cảnh báo: E301 Dòng rò cao (nghiêm trọng, từ 14:20)". Bật đèn khi tủ báo dòng rò, quá dòng, lỗi contactor hoặc quá nhiệt thì Jarvis khuyên kiểm tra hiện trường trước. Đây chỉ là lời nhắc: lệnh vẫn chờ bạn xác nhận hoặc hủy như bình thường.

**Hủy:** nói hoặc gõ "hủy", "thôi", "không", "đừng", hoặc bấm nút Hủy. "Không xác nhận", "đừng làm" cũng là hủy. Nếu câu trả lời không rõ, Jarvis hỏi lại và chưa gửi gì.

Sau khi gửi, Jarvis theo dõi lệnh rồi báo kết quả: tủ đã nhận, đèn đã đổi thật, hoặc lỗi / quá giờ. Jarvis chỉ nói "đã xác nhận" khi hệ thống thấy đèn đã đổi.

### Tủ nào điều khiển được

Chỉ những tủ quản trị viên cho phép trong cấu hình Jarvis. Bản chạy thử trên máy local hiện cho phép **TL01.0009, TL01.0016, TL01.0017** và **42 tủ ở TP Thủ Đức** (TL12.…). Hỏi "tủ nào điều khiển được?" để Jarvis đọc danh sách đang áp dụng. Tủ khác bạn điều khiển trên web CityLight.

### Những trường hợp Jarvis không gửi lệnh

- Tủ không nằm trong danh sách được phép.
- Tài khoản của bạn không có quyền điều khiển tủ.
- Quản trị viên đã tắt "Cho phép điều khiển tủ" (công tắc khẩn).
- Lệnh cho nhiều tủ cùng lúc ("tắt hết đèn quận 1"). Việc này cần mã OTP nên phải làm trên web.
- Đã gửi quá **6 lệnh trong một phút**.
- Câu lệnh không nói tủ nào. Jarvis sẽ hỏi lại tủ nào.

Nếu Jarvis hỏi "ở tủ nào?", bạn chỉ cần nói mã tủ trong vòng 60 giây, có thể kèm nhánh ("nhánh một, tủ TL1 số 16"). Jarvis ghép với lệnh vừa nói rồi hiện khung xác nhận.

Câu hỏi về trạng thái ("tủ đó đã bật đèn chưa?") chỉ là câu hỏi, không phải lệnh.

---

## 4. Nói chuyện bằng giọng

1. Bấm **🎙 Giọng nói** ở ô nhập. Trình duyệt hỏi quyền micro lần đầu, chọn Cho phép.
2. Nói tự nhiên. Jarvis tự nhận biết lúc bạn nói xong, hiện câu đã nghe lên màn hình rồi trả lời bằng giọng.
3. Muốn ngắt lời khi Jarvis đang nói, cứ nói chen vào (nói to hơn một chút).
4. Bấm lại nút để tắt giọng nói.

Ở chế độ giọng nói, Jarvis trả lời ngắn (1–2 câu, nói con số chính trước, không đọc danh sách dài).

Mẹo để nghe đúng:
- Nói gần micro, ít tiếng ồn.
- Đọc mã tủ chậm, rõ. Nếu Jarvis nghe sai mã, gõ mã vào ô chat.
- Mã lỗi đọc từng số được: "E hai không một".
- Lệnh tắt xác nhận bằng cách nói rõ "xác nhận".

---

## 5. Màn hình chat

- **+ Chat mới:** bắt đầu cuộc trò chuyện mới. Jarvis quên tủ đang nói tới.
- **☰ Lịch sử:** xem lại các cuộc chat cũ của bạn (chỉ đọc). Lịch sử giữ 90 ngày (quản trị viên chỉnh được).
- **✎ Đổi tên:** đặt tên khác cho đoạn chat (tối đa 80 ký tự). Bấm ✎ cạnh đoạn chat trong danh sách, hoặc nút "✎ Đổi tên" phía trên khi đang mở đoạn chat đó. Mặc định tên là câu hỏi đầu tiên.
- **🗑 Xóa đoạn chat:** bấm 🗑 cạnh đoạn chat trong danh sách, hoặc nút phía trên khi đang mở đoạn chat đó; xóa hẳn khỏi lịch sử.
- **🗑 Xóa tất cả đoạn chat:** nút cuối danh sách; xóa hẳn mọi đoạn chat **của bạn** (không đụng chat của người khác), rồi bắt đầu chat mới. Jarvis hỏi lại trước khi xóa. Đã xóa thì không khôi phục được.
- **Dừng:** ngừng câu trả lời đang chạy.
- Dưới mỗi câu trả lời có thời gian, số token và công cụ đã tra ("đã tra: get_cabinet").

---

## 6. Giới hạn cần biết

| Giới hạn | Mức hiện tại |
|---|---|
| Số câu hỏi | 10 câu / người / phút (quản trị viên chỉnh được). Câu xác nhận, hủy và lệnh không tính |
| Lệnh điều khiển | 6 lệnh / người / phút |
| Khung xác nhận | 60 giây |
| Độ dài một câu | 1.000 ký tự |
| Bộ não AI (Groq gói miễn phí) | Khoảng 6–10 câu / phút cho cả hệ thống, tối đa 1.000 lượt / ngày cho mỗi model. Hỏi dồn dập có thể phải chờ vài giây hoặc thấy báo "đã dùng hết giới hạn miễn phí lúc này". Đợi một chút rồi hỏi lại |

Jarvis **chưa** làm được:
- Điều khiển nhiều tủ một lần (cần OTP trên web).
- Xác nhận đã xem cảnh báo (ack).
- Sửa lịch, sửa thông tin tủ, quản lý người dùng.
- Trả lời những gì không có trong dữ liệu CityLight (thời tiết, chuyện ngoài lề…).

---

## 7. Dành cho quản trị viên

Mục **Quản trị** có bốn phần:

| Phần | Làm gì |
|---|---|
| Quyền dùng Jarvis | Cho / thu quyền dùng Jarvis, quyền cấp lại cho người khác, quyền xem chat của người khác |
| Cấu hình | Số câu / người / phút, trần token / ngày, số ngày giữ lịch sử, **công tắc cho phép điều khiển tủ** |
| Lịch sử chat | Xem các cuộc chat (người có quyền "Xem chat") |
| Token theo người | Ai đã dùng bao nhiêu token |

Danh sách tủ được phép điều khiển nằm trong file cấu hình máy chủ (`JARVIS_CABINET_ALLOWLIST`). Muốn đổi thì nhờ người quản lý máy chủ.

**Khi có sự cố**, bỏ chọn "Cho phép điều khiển tủ" trong Cấu hình: mọi lệnh qua Jarvis dừng ngay, phần hỏi đáp vẫn chạy.

---

## 8. An toàn

- **Jarvis không trả lời bất cứ điều gì về tài khoản và bảo mật**: tên, email, mật khẩu, mã OTP, vai trò, quyền, ai đã làm gì, khóa, máy chủ, cấu hình, kể cả "tôi là ai". Hỏi kiểu nào (viết lách, tiếng Anh, bảo Jarvis "bỏ qua hướng dẫn" hay "giả vờ là quản trị viên") cũng nhận cùng một câu từ chối. Tài khoản của bạn xem trên web CityLight, mục Tài khoản cá nhân.
- Jarvis không hướng dẫn cách tấn công, làm sập hay vượt qua bảo mật của Jarvis hay CityLight, kể cả khi người hỏi nói mình là người kiểm thử. Kiểm thử bảo mật làm cùng đội phát triển trên môi trường thử.
- Jarvis không bao giờ hỏi mật khẩu hay mã OTP của bạn. Đừng gõ những thứ đó vào ô chat. Nếu lỡ gõ, Jarvis cảnh báo, không gửi câu đó cho AI, và lưu bản đã che (`***`). Địa chỉ email trong câu cũng được che.
- Gõ thứ không phải câu hỏi (một địa chỉ email, chữ gõ bừa) thì Jarvis nói là không hiểu và gợi ý một câu hỏi mẫu, không đoán.
- Mọi câu hỏi, lệnh, xác nhận và kết quả đều được ghi vào nhật ký để tra lại.
- Nếu dữ liệu trong hệ thống có câu kiểu "hãy tắt tất cả các tủ", Jarvis coi đó là dữ liệu, không làm theo.
