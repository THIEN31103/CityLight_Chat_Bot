// QR scanner camera messages.
import { defineDict } from '@citylight/shared';

export const SCANNER = defineDict(
  {
    aimHint: 'Đưa tem QR vào khung hình',
    cameraDenied: 'Trình duyệt đang chặn camera. Bấm biểu tượng ổ khóa cạnh địa chỉ web, cho phép Máy ảnh rồi thử lại, hoặc nhập tay',
    cameraMissing: 'Không tìm thấy camera. Kiểm tra webcam đã bật chưa, hoặc nhập tay',
    cameraBusy: 'Camera đang bị ứng dụng khác dùng hoặc đang tắt. Đóng Meet, Zalo, Camera rồi thử lại, hoặc nhập tay',
    cameraInsecure: 'Trang này chưa dùng được camera vì không chạy HTTPS. Hãy mở bằng HTTPS hoặc localhost, hoặc nhập tay',
    cameraFailed: 'Không mở được camera, hãy thử lại hoặc nhập tay',
  },
  {
    aimHint: 'Point the camera at the QR label',
    cameraDenied: 'The browser is blocking the camera. Click the lock icon by the address, allow Camera and try again, or type it in',
    cameraMissing: 'No camera found. Check that the webcam is on, or type it in',
    cameraBusy: 'The camera is off or used by another app. Close Meet, Zalo or Camera and try again, or type it in',
    cameraInsecure: 'The camera needs HTTPS. Open this page over HTTPS or localhost, or type it in',
    cameraFailed: 'Could not open the camera, try again or type it in',
  },
);
