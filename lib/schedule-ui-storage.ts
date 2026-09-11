import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const STORAGE_KEY = "ai_phone_schedule_ui_v1";
registerKvMigration(STORAGE_KEY);

type PersistedScheduleUiStore = {
  /** characterId -> 是否启用「日程/情绪」弹窗里的日程功能（默认 true，跟历史行为一致） */
  enabled: Record<string, boolean>;
};

function loadStore(): PersistedScheduleUiStore {
  if (typeof window === "undefined") return { enabled: {} };
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return { enabled: {} };
    const parsed = JSON.parse(raw) as Partial<PersistedScheduleUiStore>;
    return { enabled: parsed.enabled && typeof parsed.enabled === "object" ? parsed.enabled : {} };
  } catch {
    return { enabled: {} };
  }
}

function saveStore(store: PersistedScheduleUiStore): void {
  if (typeof window === "undefined") return;
  kvSet(STORAGE_KEY, JSON.stringify(store));
}

export function isScheduleUiEnabled(characterId: string): boolean {
  const store = loadStore();
  return store.enabled[characterId] ?? true;
}

export function setScheduleUiEnabled(characterId: string, enabled: boolean): void {
  const store = loadStore();
  store.enabled[characterId] = enabled;
  saveStore(store);
}
