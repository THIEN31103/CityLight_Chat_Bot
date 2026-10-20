// Dimming profiles page (DimmingPage); lamp group names are also used by the map editor.
import { LAMP_GROUP_LABELS, LAMP_GROUP_LABELS_EN, defineDict } from '@citylight/shared';

export const DIMMING = defineDict(
  {
    /** LampGroup -> name (shared defaults) */
    lampGroup: LAMP_GROUP_LABELS,
    /** DimmingProfile['source'] */
    source: {
      cabinet: 'hồ sơ riêng của tủ',
      zone: 'hồ sơ riêng của vùng',
      system: 'hồ sơ toàn hệ thống',
      default: 'mặc định có sẵn (chưa lưu)',
    },
    saved: 'Đã lưu hồ sơ tiết giảm',
    dropped: 'Vùng đã quay về hồ sơ toàn hệ thống',
    batchCreated: 'Đã tạo lệnh hàng loạt',
    title: 'Đồng bộ cấu hình tiết giảm năng lượng',
    save: 'Lưu cấu hình',
    sync: 'Đồng bộ thông số',
    unsupported: 'Tủ hiện tại chưa có phần cứng dim. Hồ sơ được lưu ở máy chủ; đồng bộ xuống tủ sẽ chạy khi firmware hỗ trợ (capability “dimming”).',
    scope: 'Phạm vi hồ sơ',
    system: 'Toàn hệ thống',
    zone: 'Vùng {name}',
    using: 'Đang dùng {source}{hint}. Tủ không có hồ sơ riêng sẽ theo hồ sơ này.',
    saveForZone: ' — lưu để tạo hồ sơ riêng cho vùng',
    segmentsHint: 'Thời đoạn sau luôn bắt đầu đúng chỗ thời đoạn trước kết thúc',
    drop: 'Bỏ hồ sơ riêng',
  },
  {
    lampGroup: LAMP_GROUP_LABELS_EN,
    source: {
      cabinet: 'the cabinet’s own profile',
      zone: 'the zone’s own profile',
      system: 'the system-wide profile',
      default: 'the built-in default (not saved)',
    },
    saved: 'Dimming profile saved',
    dropped: 'The zone is back on the system-wide profile',
    batchCreated: 'Bulk command created',
    title: 'Energy dimming configuration sync',
    save: 'Save configuration',
    sync: 'Sync settings',
    unsupported: 'Current cabinets have no dimming hardware. Profiles are stored on the server; syncing to cabinets will run once the firmware supports it (capability “dimming”).',
    scope: 'Profile scope',
    system: 'Whole system',
    zone: 'Zone {name}',
    using: 'Using {source}{hint}. Cabinets without their own profile follow this one.',
    saveForZone: ' — save to create a profile for this zone',
    segmentsHint: 'Each period starts exactly where the previous one ends',
    drop: 'Remove own profile',
  },
);
