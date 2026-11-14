# CityLight Jarvis

Trợ lý điều hành tiếng Việt (chữ và giọng nói) cho hệ thống chiếu sáng CityLight. **Chạy riêng**: không chứa và không sửa server CityLight; chỉ gọi API `/api/v1` của một server CityLight đang chạy (local, trial hoặc của khách) bằng tài khoản của người điều hành. Nhánh này không merge vào `main` của server.

| Thư mục | Nội dung |
|---|---|
| `apps/jarvis` | Jarvis: console, tool đọc, router, giọng nói, quản trị. Hướng dẫn đầy đủ: [apps/jarvis/README.md](apps/jarvis/README.md) |
| `packages/shared` | Kiểu dữ liệu, quyền theo role, lọc LTID: **bản chép** từ server CityLight (`main` 018b276). Khi server đổi các phần này, chép lại bản mới |

## Chạy

```bash
npm install
cp apps/jarvis/.env.example apps/jarvis/.env   # CITYLIGHT_API_BASE = địa chỉ API của server CityLight
npm start                                       # console http://127.0.0.1:8790
npm test
npm run typecheck
```

Cần thêm (xem `apps/jarvis/README.md`): Ollama + model `qwen3:4b-instruct` (bộ não), và sidecar giọng nói Python `apps/jarvis/voice/sidecar.py` nếu dùng giọng nói. Server CityLight chạy từ repo của nó; web CityLight mở Jarvis bằng nút "Jarvis" khi build có `VITE_JARVIS_URL`.
