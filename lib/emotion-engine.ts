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
import { loadCharacterEmotionState, applyCharacterEmotionResult, type EmotionEvalApplyPayload } from "./emotion-storage";
import type { EmotionBuff, EmotionStateValueKey } from "./emotion-types";
import { EMOTION_STATE_VALUE_KEYS, EMOTION_STATE_VALUE_HINTS } from "./emotion-types";
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
  stateValues?: unknown;
  coreThought?: string;
  darkSide?: string;
  snark?: string;
  withdrawnDraft?: string;
  nextAction?: string;
};

function buildEmotionTriggerInstruction(
  character: Character,
  currentBuffs: EmotionBuff[],
  currentStateValues: Partial<Record<EmotionStateValueKey, number>> | undefined,
): string {
  const buffsJson = JSON.stringify(
    currentBuffs.map(b => ({ id: b.id, label: b.label, intensity: b.intensity, emoji: b.emoji, color: b.color, description: b.description })),
  );
  const stateValueHints = EMOTION_STATE_VALUE_KEYS
    .map(key => `  - ${key}（${EMOTION_STATE_VALUE_HINTS[key]}）：当前 ${currentStateValues?.[key] ?? "未生成"}`)
    .join("\n");

  return [
    `请基于以上对话，评估并演化 ${character.name} 此刻的「情绪/心声」状态——这是角色自己才看得到的后台真心话，不是说给 user 听的台词。`,
    `这是"维护和演化"，不是从零创建——下面是 ${character.name} 当前已有的情绪标签（可能为空数组）：`,
    buffsJson,
    "",
    "状态栏六项数值当前值（0~100，评估后按对话走向自然增减，不要大起大落）：",
    stateValueHints,
    "",
    "请只输出严格的 JSON（不要任何多余文字、不要代码块围栏），格式：",
    '{"changed": true,',
    ' "buffs": [{"id": "唯一id，沿用旧的或新起一个", "label": "简短中文标签，如：脆弱的和好", "intensity": 1, "emoji": "可选一个emoji", "color": "可选十六进制颜色", "description": "给用户看的一句话说明"}],',
    ' "injection": "一段会被原样注入到之后系统提示词里的情绪底色描述，自己交代清楚上下文，不要写\\"见上文\\"这类指代，不是台词，不用直接说出口",',
    ' "stateValues": {"偏爱度": 0-100, "护短指数": 0-100, "操心覆载": 0-100, "好感度": 0-100, "占有欲": 0-100, "焦虑值": 0-100},',
    ' "coreThought": "150字以内、第一人称、此刻真实想法的核心心声",',
    ' "darkSide": "80字以上，最深层的欲望和意淫，允许直白、阴暗、激烈甚至色情的内容，不要自我阉割",',
    ' "snark": "80字以上，针对其他角色/当前局面的犀利毒舌吐槽、红旗排查或护短小算盘，一针见血不用顾忌",',
    ' "withdrawnDraft": "15字以上，刚才在输入框打好又默默删掉、没发出去的一句话",',
    ' "nextAction": "30字以上，接下来打算为 user 做的事、准备调取的权限或收拾烂摊子的计划"}',
    "",
    "要求：",
    "- buffs 是对旧标签的维护/演化/新增/移除，不是无脑重来；数量控制在 1-3 个，强度 1=轻微 2=中等 3=强烈",
    "- stateValues 是对旧数值的小幅调整，不是每次重新定值；六项都必须给出数字",
    "- coreThought/darkSide/snark/withdrawnDraft/nextAction 每次都要重新写，贴合最新这几轮对话，不要复述旧内容",
    "- darkSide 专门用来装角色不会说出口的真实欲望，尺度可以比其它字段更大胆，但仍然要是这个角色会想的东西，不要跑题",
    "- 如果情绪整体没有明显变化，changed 填 false，其余字段仍要给出合理的当前值，不能空着",
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

function salvageStringField(rawText: string, field: string): string | undefined {
  const match = rawText.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return match ? unescapeSalvaged(match[1]) : undefined;
}

function salvageFields(rawText: string): EmotionEvalResult | null {
  const injection = salvageStringField(rawText, "injection");
  const coreThought = salvageStringField(rawText, "coreThought");
  const darkSide = salvageStringField(rawText, "darkSide");
  const snark = salvageStringField(rawText, "snark");
  const withdrawnDraft = salvageStringField(rawText, "withdrawnDraft");
  const nextAction = salvageStringField(rawText, "nextAction");
  const changedMatch = rawText.match(/"changed"\s*:\s*(true|false)/);
  if (!injection && !coreThought && !darkSide && !snark && !withdrawnDraft && !nextAction) return null;
  return {
    changed: changedMatch ? changedMatch[1] === "true" : true,
    injection,
    coreThought,
    darkSide,
    snark,
    withdrawnDraft,
    nextAction,
    buffs: undefined,
    stateValues: undefined,
  };
}

export function parseEmotionEvalOutput(rawText: string): EmotionEvalResult | null {
  const { parsed } = parseJsonWithRepair(rawText, {
    textFieldKeys: ["injection", "coreThought", "darkSide", "snark", "withdrawnDraft", "nextAction"],
  });
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

function clampStateValue(n: unknown, fallback: number): number {
  const num = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(num)) return fallback;
  return Math.round(Math.min(100, Math.max(0, num)));
}

export function sanitizeStateValues(
  raw: unknown,
  fallback: Partial<Record<EmotionStateValueKey, number>> | undefined,
): Partial<Record<EmotionStateValueKey, number>> {
  const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Partial<Record<EmotionStateValueKey, number>> = {};
  for (const key of EMOTION_STATE_VALUE_KEYS) {
    if (key in rec) {
      out[key] = clampStateValue(rec[key], fallback?.[key] ?? 50);
    } else if (fallback?.[key] !== undefined) {
      out[key] = fallback[key];
    }
  }
  return out;
}

function sanitizeNarrative(value: unknown, fallback: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
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
 * 把 LLM 原始输出应用为完整的心声状态。
 * 解析彻底失败，或抢救模式下所有字段全缺，一律保留旧状态，绝不清空。
 * 逐字段合并：每个字段独立看有没有拿到有效值，拿不到就沿用旧值，不会因为某一个字段没解析出来就把其它字段也一起清空。
 */
export function applyEmotionEvalRaw(
  rawText: string,
  existing: EmotionEvalApplyPayload | null,
): EmotionEvalApplyPayload | null {
  const parsed = parseEmotionEvalOutput(rawText);
  if (!parsed) return null;

  const fallback: EmotionEvalApplyPayload = existing ?? { buffs: [], injection: "" };

  const hasBuffs = parsed.changed !== false && Array.isArray(parsed.buffs);
  const hasInjection = typeof parsed.injection === "string" && parsed.injection.trim().length > 0;
  const hasStateValues = parsed.stateValues !== undefined && parsed.stateValues !== null;
  const hasAnyNarrative = [parsed.coreThought, parsed.darkSide, parsed.snark, parsed.withdrawnDraft, parsed.nextAction]
    .some(v => typeof v === "string" && v.trim().length > 0);

  if (!hasBuffs && !hasInjection && !hasStateValues && !hasAnyNarrative) return fallback;

  return {
    buffs: hasBuffs ? sanitizeBuffs(parsed.buffs) : fallback.buffs,
    injection: hasInjection ? parsed.injection!.trim() : fallback.injection,
    stateValues: hasStateValues ? sanitizeStateValues(parsed.stateValues, fallback.stateValues) : fallback.stateValues,
    coreThought: sanitizeNarrative(parsed.coreThought, fallback.coreThought),
    darkSide: sanitizeNarrative(parsed.darkSide, fallback.darkSide),
    snark: sanitizeNarrative(parsed.snark, fallback.snark),
    withdrawnDraft: sanitizeNarrative(parsed.withdrawnDraft, fallback.withdrawnDraft),
    nextAction: sanitizeNarrative(parsed.nextAction, fallback.nextAction),
  };
}

/** 每轮 AI 回复后 fire-and-forget 调用；未开启/未绑定 API/生成失败都静默放弃，不影响主聊天。 */
export async function evaluateCharacterEmotion(sessionId: string, characterId: string): Promise<void> {
  const existingState = loadCharacterEmotionState(characterId);
  if (!existingState?.enabled) return;

  try {
    const resolved = await resolveEmotionAssemblerInput(characterId, sessionId);
    const triggerInstruction = buildEmotionTriggerInstruction(resolved.character, existingState.buffs, existingState.stateValues);
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

    const applied = applyEmotionEvalRaw(rawText, existingState);
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
  const triggerInstruction = buildEmotionTriggerInstruction(resolved.character, existingState?.buffs ?? [], existingState?.stateValues);

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
