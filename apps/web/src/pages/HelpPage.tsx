import { Card, CardHeader, PageHeader } from '@/components/ui';
import { ErrorCatalogTable } from '@/components/ErrorHelp';

export function HelpPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <PageHeader title="Trợ giúp" subtitle="Nội dung dạng markdown, quản trị viên chỉnh sửa được (M8)" />
      <Card>
        <CardHeader title="Hướng dẫn nhanh" />
        <div className="space-y-2 p-4 text-sm leading-relaxed">
          <p><b>Bản đồ:</b> bấm thẻ trạng thái bên trái để lọc; bấm cụm để phóng to; bấm tủ để mở chi tiết. Trụ/tuyến hiện khi zoom ≥ 14.</p>
          <p><b>Điều khiển:</b> tab Điều khiển trong chi tiết tủ. Mọi lệnh có hộp xác nhận; trạng thái lệnh: Đang chờ → Đã gửi → Tủ đã nhận → Đã xác nhận (khi trạng thái nhánh đổi đúng).</p>
          <p><b>Lịch:</b> trang Lịch chiếu sáng đặt lịch theo vùng (giờ cố định hoặc lịch thiên văn) rồi Đồng bộ xuống tủ.</p>
          <p><b>Cảnh báo:</b> chuông trên thanh điều hướng; trang Cảnh báo lỗi để lọc, xác nhận đã biết, xuất Excel.</p>
          <p><b>Ô “—” / “Chờ firmware”:</b> thiết bị chưa gửi số liệu đó; sẽ tự hiện khi firmware cập nhật.</p>
        </div>
      </Card>
      <div id="errors">
        <h2 className="mb-2 text-lg font-semibold">Bảng mã lỗi</h2>
        <ErrorCatalogTable />
      </div>
      <Card id="about">
        <CardHeader title="Giới thiệu" />
        <div className="p-4 text-sm">CityLight — nền tảng giám sát & điều khiển chiếu sáng công cộng. Phiên bản 0.1 (M1-UI, dữ liệu giả lập).</div>
      </Card>
    </div>
  );
}
