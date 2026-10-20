// Error code guide (components/ErrorHelp.tsx). The catalog text itself comes from errorCatalog(lang) in @citylight/shared.
import { defineDict } from '@citylight/shared';

export const ERROR_HELP = defineDict(
  {
    awaitingFirmware: 'Chờ firmware',
    evidence: 'Dấu hiệu: ',
    cause: 'Nguyên nhân: ',
    checks: 'Kiểm tra / xử lý:',
    guideFor: 'Hướng dẫn mã lỗi {code}',
    colCode: 'Mã',
    colError: 'Lỗi',
    colSeverity: 'Mức',
    colEvidence: 'Dấu hiệu',
    colCause: 'Nguyên nhân & xử lý',
  },
  {
    awaitingFirmware: 'Awaiting firmware',
    evidence: 'Evidence: ',
    cause: 'Cause: ',
    checks: 'Checks / fix:',
    guideFor: 'Guide for error code {code}',
    colCode: 'Code',
    colError: 'Fault',
    colSeverity: 'Severity',
    colEvidence: 'Evidence',
    colCause: 'Cause & fix',
  },
);
