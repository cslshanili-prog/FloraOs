import type { CharacterEmotionState, EmotionBuff } from "./emotion-types";
import { kvGet, kvSet, registerKvMigration } from "./kv-db";

const STORAGE_KEY = "ai_phone_emotion_v1";
registerKvMigration(STORAGE_KEY);

type PersistedEmotionStore = {
  states: Record<string, CharacterEmotionState>;
};

function loadStore(): PersistedEmotionStore {
  if (typeof window === "undefined") return { states: {} };
  try {
    const raw = kvGet(STORAGE_KEY);
    if (!raw) return { states: {} };
    const parsed = JSON.parse(raw) as Partial<PersistedEmotionStore>;
    return { states: parsed.states && typeof parsed.states === "object" ? parsed.states : {} };
  } catch {
    return { states: {} };
  }
}

function saveStore(store: PersistedEmotionStore): void {
  if (typeof window === "undefined") return;
  kvSet(STORAGE_KEY, JSON.stringify(store));
}

export function loadCharacterEmotionState(characterId: string): CharacterEmotionState | null {
  return loadStore().states[characterId] ?? null;
}

export function saveCharacterEmotionState(state: CharacterEmotionState): void {
  const store = loadStore();
  store.states[state.characterId] = state;
  saveStore(store);
}

export function setCharacterEmotionEnabled(characterId: string, enabled: boolean): CharacterEmotionState {
  const store = loadStore();
  const existing = store.states[characterId];
  const next: CharacterEmotionState = existing
    ? { ...existing, enabled }
    : { characterId, enabled, buffs: [], injection: "", updatedAt: new Date().toISOString() };
  store.states[characterId] = next;
  saveStore(store);
  return next;
}

export function clearCharacterEmotionBuffs(characterId: string): CharacterEmotionState | null {
  const store = loadStore();
  const existing = store.states[characterId];
  if (!existing) return null;
  const next: CharacterEmotionState = { ...existing, buffs: [], injection: "", updatedAt: new Date().toISOString() };
  store.states[characterId] = next;
  saveStore(store);
  return next;
}

export function applyCharacterEmotionResult(
  characterId: string,
  result: { buffs: EmotionBuff[]; injection: string },
): CharacterEmotionState {
  const store = loadStore();
  const existing = store.states[characterId];
  const next: CharacterEmotionState = {
    characterId,
    enabled: existing?.enabled ?? true,
    buffs: result.buffs,
    injection: result.injection,
    updatedAt: new Date().toISOString(),
  };
  store.states[characterId] = next;
  saveStore(store);
  return next;
}

/** 未启用或无数据时返回空串，直接喂给 {{当前情绪}} 宏 */
export function getEmotionInjectionForPrompt(characterId: string): string {
  const state = loadCharacterEmotionState(characterId);
  if (!state?.enabled) return "";
  return state.injection || "";
}
