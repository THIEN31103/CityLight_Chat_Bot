// Help page (quick guide, error code table heading, about).
import { defineDict } from '@citylight/shared';

export const HELP = defineDict(
  {
    title: 'Trợ giúp',
    subtitle: 'Nội dung dạng markdown, quản trị viên chỉnh sửa được (M8)',
    quickGuide: 'Hướng dẫn nhanh',
    items: [
      { head: 'Bản đồ:', text: 'bấm thẻ trạng thái bên trái để lọc; bấm cụm để phóng to; bấm tủ để mở chi tiết. Trụ/tuyến hiện khi zoom ≥ 14.' },
      { head: 'Điều khiển:', text: 'tab Điều khiển trong chi tiết tủ. Mọi lệnh có hộp xác nhận; trạng thái lệnh: Đang chờ → Đã gửi → Tủ đã nhận → Đã xác nhận (khi trạng thái nhánh đổi đúng).' },
      { head: 'Lịch:', text: 'trang Lịch chiếu sáng đặt lịch theo vùng (giờ cố định hoặc lịch thiên văn) rồi Đồng bộ xuống tủ.' },
      { head: 'Cảnh báo:', text: 'chuông trên thanh điều hướng; trang Cảnh báo lỗi để lọc, xác nhận đã biết, xuất Excel.' },
      { head: 'Ô “—” / “Chờ firmware”:', text: 'thiết bị chưa gửi số liệu đó; sẽ tự hiện khi firmware cập nhật.' },
    ],
    errorCodes: 'Bảng mã lỗi',
    about: 'Giới thiệu',
    aboutText: 'CityLight — nền tảng giám sát & điều khiển chiếu sáng công cộng. Phiên bản 0.1 (M1-UI, dữ liệu giả lập).',
  },
  {
    title: 'Help',
    subtitle: 'Markdown content, editable by administrators (M8)',
    quickGuide: 'Quick guide',
    items: [
      { head: 'Map:', text: 'click a status card on the left to filter; click a cluster to zoom in; click a cabinet to open its details. Poles and routes show at zoom ≥ 14.' },
      { head: 'Control:', text: 'the Control tab in the cabinet details. Every command asks for confirmation; command status: Queued → Sent → Received by cabinet → Confirmed (once the branch state changes as expected).' },
      { head: 'Schedules:', text: 'the Lighting schedules page sets a schedule per zone (fixed times or astronomical), then Sync sends it to the cabinets.' },
      { head: 'Alarms:', text: 'the bell in the navigation bar; the Fault alarms page to filter, acknowledge and export to Excel.' },
      { head: '“—” / “Waiting for firmware” cells:', text: 'the device does not send that value yet; it shows up by itself after a firmware update.' },
    ],
    errorCodes: 'Error code table',
    about: 'About',
    aboutText: 'CityLight — public street-lighting monitoring & control platform. Version 0.1 (M1-UI, simulated data).',
  },
);
