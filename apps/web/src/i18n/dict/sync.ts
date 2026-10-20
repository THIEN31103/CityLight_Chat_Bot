// Zone sync dialog (components/SyncDialog.tsx): pick zones, confirm with 2FA, start a batch.
import { defineDict, plural } from '@citylight/shared';

export const SYNC = defineDict(
  {
    started: (n: number) => `Đã bắt đầu đồng bộ ${n} tủ`,
    failed: 'Không tạo được lô lệnh',
    run: (n: number | undefined) => `Đồng bộ ${n ?? ''} tủ`,
    next: 'Tiếp tục',
    pickZones: 'Chọn vùng cần đồng bộ:',
    zone: (name: string, n: number) => `${name} (${n} tủ)`,
    summary: 'Lệnh sẽ gửi tới {total} tủ, trong đó {offline} tủ đang mất kết nối (ghi nhận offline; lịch sẽ tự gửi khi tủ có kết nối lại).',
    blocked: (n: number) => `${n} tủ chạy firmware cũ 1307ebc sẽ bị bỏ qua.`,
    queued: 'Lệnh được đưa vào hàng đợi, gửi có giới hạn tốc độ; tiến độ hiển thị realtime.',
    otp: 'Mã xác thực 2 lớp (6 số) để xác nhận',
  },
  {
    started: (n: number) => `Sync started for ${plural(n, 'cabinet', 'cabinets')}`,
    failed: 'Could not create the batch',
    run: (n: number | undefined) => (n === undefined ? 'Sync cabinets' : `Sync ${plural(n, 'cabinet', 'cabinets')}`),
    next: 'Continue',
    pickZones: 'Choose the zones to sync:',
    zone: (name: string, n: number) => `${name} (${plural(n, 'cabinet', 'cabinets')})`,
    summary: 'The command goes to {total} cabinets, {offline} of them offline (recorded as offline; the schedule is sent automatically when they reconnect).',
    blocked: (n: number) => `${plural(n, 'cabinet', 'cabinets')} on old firmware 1307ebc will be skipped.`,
    queued: 'Commands are queued and sent at a limited rate; progress is shown live.',
    otp: 'Two-factor code (6 digits) to confirm',
  },
);
