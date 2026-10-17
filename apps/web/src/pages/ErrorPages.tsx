import { Link } from 'react-router-dom';
import { ShieldX, MapPinOff } from 'lucide-react';
import { Button } from '@/components/ui';

export function ForbiddenPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <ShieldX className="h-12 w-12 text-st-offline" />
      <h1 className="text-xl font-semibold">403 — Không đủ quyền</h1>
      <p className="max-w-md text-sm text-subtle">Tài khoản của bạn không có quyền truy cập trang này. Liên hệ quản trị viên nếu bạn cần quyền.</p>
      <Link to="/">
        <Button variant="outline">Về trang chính</Button>
      </Link>
    </div>
  );
}

export function NotFoundPage() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <MapPinOff className="h-12 w-12 text-subtle" />
      <h1 className="text-xl font-semibold">404 — Không tìm thấy trang</h1>
      <Link to="/">
        <Button variant="outline">Về trang chính</Button>
      </Link>
    </div>
  );
}
