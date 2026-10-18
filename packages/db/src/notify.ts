// Redis keys / channels shared by apps/api, the ingest worker, the command-worker and the notify-worker.

/** Thresholds or an applied schedule changed: the ingest worker reloads its alarm configuration. */
export const CONFIG_CHANNEL = 'cl:config';
/** Telegram link codes: `${TG_LINK_PREFIX}<code>` -> user id, 10 minutes. */
export const TG_LINK_PREFIX = 'cl:tglink:';
export const TG_LINK_TTL_S = 600;
/** Set by the notify-worker when a bot token works: {"username":"…"}; absent = Telegram not configured. */
export const TG_BOT_KEY = 'cl:notify:telegram';
/** A user's notification settings changed: the notify-worker reloads its recipient list. */
export const NOTIFY_CHANGED_CHANNEL = 'cl:notify:changed';
