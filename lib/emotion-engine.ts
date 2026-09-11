import type { Character } from "./character-types";
import type { ApiConfig, PresetConfig, RegexConfig, WorldBookConfig } from "./settings-types";
import type { AssemblerInput, LLMMessage } from "./llm-prompt-assembler";
import { assemblePromptPayload } from "./llm-prompt-assembler";
import { loadCharacters } from "./character-storage";
import {
  loadBindingConfig,
  loadApiConfigs,
  loadPresets,
  loadWorldBooks,
  loadRegexes,
  resolveBinding,
  resolveUserIdentity,
} from "./settings-storage";
import { loadMemoryConfig } from "./memory-storage";
import { retrieveCoreMemoriesForPrompt, retrieveMemoriesForPrompt } from "./memory-service";
import { formatCoreMemories, formatLongTermMemories } from "./memory-injector";
import { prepareShortTermContext } from "./short-term-assembler";
import { getCustomStickerExample, getCustomStickerNames } from "./custom-sticker-storage";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import { loadChatMessages } from "./chat-storage";
import { loadCharacterEmotionState, applyCharacterEmotionResult } from "./emotion-storage";
import type { EmotionBuff } from "./emotion-types";
import { parseJsonWithRepair } from "./checkphone-json-repair";

const MAX_HISTORY_MESSAGES = 20;

type EmotionAssemblerResolved = {
  apiConfig: ApiConfig;
  preset: PresetConfig | null;
  regexes: RegexConfig[];
  llmMessages: LLMMessage[];
  character: Character;
};

type EmotionEvalResult = {
  changed?: boolean;
  buffs?: unknown;
  injection?: string;
  innerState?: string;
};

function buildEmotionTriggerInstruction(character: Character, currentBuffs: EmotionBuff[]): string {
  const buffsJson = JSON.stringify(
    currentBuffs.map(b => ({ id: b.id, label: b.label, intensity: b.intensity, emoji: b.emoji, color: b.color, description: b.description })),
  );
  return [
    `请基于以上对话，评估并演化 ${character.name} 此刻的情绪状态。`,
    `这是"维护和演化"，不是从零创建——下面是 ${character.name} 当前已有的情绪标签（可能为空数组）：`,
    buffsJson,
    "",
    "请只输出严格的 JSON（不要任何多余文字、不要代码块围栏），格式：",
    '{"changed": true, "buffs": [{"id": "唯一id，沿用旧的或新起一个", "label": "简短中文标签，如：脆弱的和好", "intensity": 1, "emoji": "可选一个emoji", "color": "可选十六进制颜色", "description": "给用户看的一句话说明"}], "injection": "一段会被原样注入到之后系统提示词里的情绪底色描述，自己交代清楚上下文，不要写"见上文"这类指代，不是台词，不用直接说出口", "innerState": "一段50-150字、第一人称、此刻真实想法的内心独白"}',
    "",
    "要求：",
    "- buffs 是对旧标签的维护/演化/新增/移除，不是无脑重来；数量控制在 1-3 个，强度 1=轻微 2=中等 3=强烈",
    "- 如果情绪没有明显变化，changed 填 false，buffs 保持原样即可",
    "- 只输出 JSON 本体，不要解释、不要前后缀",
  ].join("\n");
}

async function resolveEmotionAssemblerInput(characterId: string, sessionId: string): Promise<EmotionAssemblerResolved> {
  const bindings = loadBindingConfig();
  const activeSlot = resolveBinding(bindings, characterId, "emotion");

  if (!activeSlot.apiConfigId) {
    throw new Error("未绑定情绪 API，请先在配置绑定中为情绪设置 API。");
  }

  const apiConfigs = loadApiConfigs();
  const apiConfig = apiConfigs.find(entry => entry.id === activeSlot.apiConfigId);
  if (!apiConfig) {
    throw new Error("情绪 API 配置不存在。");
  }

  const presets = loadPresets();
  let preset = activeSlot.presetId ? presets.find(entry => entry.id === activeSlot.presetId) ?? null : null;
  if (!preset) preset = presets.find(entry => entry.builtIn) ?? null;

  const allWorldBooks = loadWorldBooks();
  const worldBooks = (activeSlot.worldBookIds || [])
    .map(id => allWorldBooks.find(entry => entry.id === id))
    .filter(Boolean) as WorldBookConfig[];

  const allRegexes = loadRegexes();
  const regexes = (activeSlot.regexIds || [])
    .map(id => allRegexes.find(entry => entry.id === id))
    .filter(Boolean) as RegexConfig[];

  const userIdentity = resolveUserIdentity(characterId, "emotion");
  const character = loadCharacters().find(entry => entry.id === characterId);
  if (!character) {
    throw new Error("情绪评估目标角色不存在。");
  }

  const memConfig = loadMemoryConfig();
  const prepared = prepareShortTermContext(characterId, "emotion", { history: [] });
  const [coreResults, longResults] = await Promise.all([
    retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => []),
    retrieveMemoriesForPrompt(characterId, prepared.wbActivationContext, memConfig).catch(() => []),
  ]);
  const coreMemories = formatCoreMemories(coreResults);
  const longTermMemories = formatLongTermMemories(longResults);

  const recentHistory = loadChatMessages(sessionId, MAX_HISTORY_MESSAGES);

  const llmMessages = assemblePromptPayload({
    character,
    history: recentHistory,
    preset,
    worldBooks,
    regexes,
    userIdentity,
    appId: "emotion",
    coreMemories,
    longTermMemories,
    worldBookActivationContext: prepared.wbActivationContext || undefined,
    recentBlocks: prepared.recentBlocks,
    unifiedRecentItems: prepared.unifiedRecentItems,
    customStickerNames: getCustomStickerNames(characterId),
    customStickerExample: getCustomStickerExample(characterId),
  } as AssemblerInput);

  return { apiConfig, preset, regexes, llmMessages, character };
}

// ── 防御性 JSON 解析：情绪评估是纯文本 completion，格式经常会崩 ──
// 提取/修复直接复用仓库里已有的 jsonrepair 封装（checkphone/手记/在场等已在用），
// 只在它也救不回来时，再落到字段级正则抢救（宁可只捞到 injection/innerState 也不整段丢弃）。

function unescapeSalvaged(s: string): string {
  return s.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function salvageFields(rawText: string): EmotionEvalResult | null {
  const injectionMatch = rawText.match(/"injection"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const innerStateMatch = rawText.match(/"innerState"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const changedMatch = rawText.match(/"changed"\s*:\s*(true|false)/);
  if (!injectionMatch && !innerStateMatch) return null;
  return {
    changed: changedMatch ? changedMatch[1] === "true" : true,
    injection: injectionMatch ? unescapeSalvaged(injectionMatch[1]) : undefined,
    innerState: innerStateMatch ? unescapeSalvaged(innerStateMatch[1]) : undefined,
    buffs: undefined,
  };
}

export function parseEmotionEvalOutput(rawText: string): EmotionEvalResult | null {
  const { parsed } = parseJsonWithRepair(rawText, { textFieldKeys: ["injection", "innerState"] });
  if (parsed && typeof parsed === "object") return parsed as EmotionEvalResult;
  return salvageFields(rawText);
}

function normalizeIntensity(n: unknown): 1 | 2 | 3 {
  const num = typeof n === "number" ? Math.round(n) : Number(n);
  if (!Number.isFinite(num)) return 2;
  if (num <= 1) return 1;
  if (num >= 3) return 3;
  return 2;
}

export function sanitizeBuffs(raw: unknown): EmotionBuff[] {
  if (!Array.isArray(raw)) return [];
  const out: EmotionBuff[] = [];
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const rec = item as Record<string, unknown>;
    const label = typeof rec.label === "string" && rec.label.trim()
      ? rec.label.trim()
      : typeof rec.name === "string" && rec.name.trim()
        ? rec.name.trim()
        : "";
    if (!label) return;
    out.push({
      id: typeof rec.id === "string" && rec.id.trim() ? rec.id.trim() : `emotion_buff_${Date.now()}_${index}`,
      label,
      intensity: normalizeIntensity(rec.intensity),
      emoji: typeof rec.emoji === "string" ? rec.emoji : undefined,
      color: typeof rec.color === "string" ? rec.color : undefined,
      description: typeof rec.description === "string" ? rec.description : undefined,
    });
  });
  return out;
}

/**
 * 把 LLM 原始输出应用为 { buffs, injection }。
 * 解析彻底失败，或 changed=true 但 buffs/injection 全缺（抢救模式下的坏输出），一律保留旧状态，绝不清空。
 */
export function applyEmotionEvalRaw(
  rawText: string,
  existing: { buffs: EmotionBuff[]; injection: string } | null,
): { buffs: EmotionBuff[]; injection: string } | null {
  const parsed = parseEmotionEvalOutput(rawText);
  if (!parsed) return null;

  const fallback = existing ?? { buffs: [], injection: "" };
  if (parsed.changed === false) return fallback;

  const hasBuffs = Array.isArray(parsed.buffs);
  const hasInjection = typeof parsed.injection === "string" && parsed.injection.trim().length > 0;
  if (!hasBuffs && !hasInjection) return fallback;

  return {
    buffs: hasBuffs ? sanitizeBuffs(parsed.buffs) : fallback.buffs,
    injection: hasInjection ? parsed.injection!.trim() : fallback.injection,
  };
}

/** 每轮 AI 回复后 fire-and-forget 调用；未开启/未绑定 API/生成失败都静默放弃，不影响主聊天。 */
export async function evaluateCharacterEmotion(sessionId: string, characterId: string): Promise<void> {
  const existingState = loadCharacterEmotionState(characterId);
  if (!existingState?.enabled) return;

  try {
    const resolved = await resolveEmotionAssemblerInput(characterId, sessionId);
    const triggerInstruction = buildEmotionTriggerInstruction(resolved.character, existingState.buffs);
    const messages: LLMMessage[] = [
      ...resolved.llmMessages,
      { role: "user", content: triggerInstruction, _debugMeta: { marker: "emotion_trigger" } },
    ];

    const rawText = await sendLLMRequest(
      resolved.apiConfig,
      resolved.preset,
      messages,
      resolved.regexes,
      { characterName: `情绪:${resolved.character.name}` },
      { appId: "emotion", appTags: ["emotion"] },
    );

    const applied = applyEmotionEvalRaw(rawText, { buffs: existingState.buffs, injection: existingState.injection });
    if (!applied) return;

    applyCharacterEmotionResult(characterId, applied);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("emotion-updated", { detail: { characterId } }));
    }
  } catch {
    // 未绑定 API / 网络失败 / 目标不存在：静默放弃
  }
}

export async function previewEmotionPromptPayload(
  characterId: string,
  sessionId: string,
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const existingState = loadCharacterEmotionState(characterId);
  const resolved = await resolveEmotionAssemblerInput(characterId, sessionId);
  const triggerInstruction = buildEmotionTriggerInstruction(resolved.character, existingState?.buffs ?? []);

  const messages: LLMMessage[] = [
    ...resolved.llmMessages,
    { role: "user", content: triggerInstruction, _debugMeta: { marker: "emotion_trigger" } },
  ];

  const apiMessages = previewMessagesForApi(resolved.apiConfig, resolved.preset, messages);
  return {
    messages: apiMessages,
    characterName: `情绪:${resolved.character.name}`,
    model: resolved.apiConfig.defaultModel,
    presetName: resolved.preset?.name ?? "(无预设)",
  };
}
