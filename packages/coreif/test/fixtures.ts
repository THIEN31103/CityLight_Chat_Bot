// Frames built in the exact key order / number formats of BOARD_LTE_KEY publish_frame_all()
// (dev_key_uid_dgb). Replace / extend with frames captured from real cabinets (00 Notes/tools/mqtt_sniff.py).

export const TELE_OK =
  "*#LTID'CTY0005&LDOM'mqtt.example.com&LPOR'1883&LIME'861234567890123&LGPS'10.7769000'106.7009000'9&LTIM'X&LCLI'0" +
  "&LBAT'4012&LACI'X&LERR'0&CTVL'12&CTTE'34&MCON'1&MPU1'222.3&MPU2'223.1&MPU3'221.8&MPI1'18.2&MPI2'17.5&MPI3'19.0" +
  "&MCO1'95&MCO2'94&MCO3'96&MCOS'95&MPOW'11.2&PCON'1&PIN5'0&LINE1'1&LINE2'1&LQ2'1&LQ3'0&PMAN'0" +
  "&PTIM'2026-10-17T18:05:03.412+07:00$";

/** PLC_KEY lost: LQ2/LQ3/PMAN/PTIM = X, LCLI=1. */
export const TELE_PLC_LOST =
  "*#LTID'CTY0005&LDOM'mqtt.example.com&LPOR'1883&LIME'861234567890123&LGPS'X&LTIM'X&LCLI'1" +
  "&LBAT'4012&LACI'X&LERR'0&CTVL'12&CTTE'1000&MCON'1&MPU1'0.0&MPU2'0.0&MPU3'0.0&MPI1'0.0&MPI2'0.0&MPI3'0.0" +
  "&MCO1'0&MCO2'0&MCO3'0&MCOS'0&MPOW'0.0&PCON'0&PIN5'0&LINE1'0&LINE2'0&LQ2'X&LQ3'X&PMAN'X&PTIM'X$";

/** Old field firmware 1307ebc: no LQ2/LQ3/PMAN keys. */
export const TELE_OLD_FW =
  "*#LTID'CTY0003&LDOM'mqtt.example.com&LPOR'1883&LIME'861234567890999&LGPS'10.8000000'106.6500000'7&LTIM'X&LCLI'0" +
  "&LBAT'3990&LACI'X&LERR'0&CTVL'8&CTTE'31&MCON'1&MPU1'221.0&MPU2'220.0&MPU3'219.5&MPI1'0.2&MPI2'0.1&MPI3'0.2" +
  "&MCO1'0&MCO2'0&MCO3'0&MCOS'0&MPOW'0.1&PCON'1&PIN5'0&LINE1'0&LINE2'0&PTIM'2026-10-17T10:00:00.000+07:00$";

export const ACK_NEW = '{"id":"CTY0005","ack":[{"k":"PLN1","rc":0},{"k":"PMAN","rc":0}],"ts":123456}';
export const ACK_OLD = '{"ack":[{"k":"PI2O","rc":-2}],"ts":99}';
export const BOOT = '{"boot":"ok","imei":"861234567890123","tick":5123}';

export const LDIA_REPORT =
  '[RS485] id=CTY0005\r\n' +
  '[RS485] A DE=0 DI=1 RO=1 | D DE=0 DI=0 RO=1 | B DE=1 DI=1 RO=1 | C DE=1 DI=0 RO=1\r\n' +
  '[RS485] RX path : OK (RO driven, bus idle high)\r\n' +
  '[RS485] DE off  : OK (driver off when DE=0)\r\n' +
  '[RS485] TX path : INCONCLUSIVE: RO stays 1 with DE=1.\r\n' +
  '[RS485] RESULT: FAIL\r\n';

export const TIMESYNC = "*#LTID'CTY0005&LIME'861234567890123&TREF'SVR&TDEL'-3&TSYN'0&PTIM'2026-10-17T18:05:00.000+07:00$";
