export type EmotionBuff = {
  id: string;
  label: string;
  intensity: 1 | 2 | 3;
  /** 单个 emoji，可选 */
  emoji?: string;
  /** 十六进制颜色，缺省时按 label 哈希取色 */
  color?: string;
  /** 展示给用户看的说明，不进 prompt */
  description?: string;
};

/** 心声·状态栏六项数值，都是 0~100 */
export type EmotionStateValueKey =
  | "偏爱度"
  | "护短指数"
  | "操心覆载"
  | "好感度"
  | "占有欲"
  | "焦虑值";

export const EMOTION_STATE_VALUE_KEYS: EmotionStateValueKey[] = [
  "偏爱度",
  "护短指数",
  "操心覆载",
  "好感度",
  "占有欲",
  "焦虑值",
];

/** 每项数值的口径说明，写进生成 prompt，避免模型自由发挥 */
export const EMOTION_STATE_VALUE_HINTS: Record<EmotionStateValueKey, string> = {
  偏爱度: "手足式偏爱、信任与默契，不是恋爱形式的喜欢",
  护短指数: "外界/他人欺负 user 时的警戒防御与撑腰欲",
  操心覆载: "看 user 处理感情或生活烂摊子时的 CPU 过载与操心程度",
  好感度: "恋爱类好感度",
  占有欲: "排他性占有欲",
  焦虑值: "恋爱类焦虑值",
};

/** 心声·四条叙述性内容，各自可独立显示/隐藏 */
export type EmotionNarrativeKey = "darkSide" | "snark" | "withdrawnDraft" | "nextAction";

export const EMOTION_NARRATIVE_LABELS: Record<EmotionNarrativeKey, string> = {
  darkSide: "阴暗面",
  snark: "毒蛇吐槽 & 排雷纪录",
  withdrawnDraft: "撤回的心声",
  nextAction: "待办行动",
};

export type EmotionVisibility = {
  stateValues: Record<EmotionStateValueKey, boolean>;
  darkSide: boolean;
  snark: boolean;
  withdrawnDraft: boolean;
  nextAction: boolean;
};

export const DEFAULT_EMOTION_VISIBILITY: EmotionVisibility = {
  stateValues: {
    偏爱度: true,
    护短指数: true,
    操心覆载: true,
    好感度: true,
    占有欲: true,
    焦虑值: true,
  },
  darkSide: true,
  snark: true,
  withdrawnDraft: true,
  nextAction: true,
};

export type CharacterEmotionState = {
  characterId: string;
  enabled: boolean;
  buffs: EmotionBuff[];
  /** 预渲染好的叙述文本，逐字注入 prompt（{{当前情绪}}） */
  injection: string;
  /** 状态栏六项数值，缺省项视为未生成 */
  stateValues?: Partial<Record<EmotionStateValueKey, number>>;
  /** 核心心声：真实内心想法，≤150 字，固定显示 */
  coreThought?: string;
  /** 阴暗面：深层欲望与意淫，可直白/可涉及性描写 */
  darkSide?: string;
  /** 毒蛇吐槽 & 排雷纪录 */
  snark?: string;
  /** 撤回的心声：打好又删掉的未发送草稿 */
  withdrawnDraft?: string;
  /** 待办行动：下一步打算做的事/调取的权限 */
  nextAction?: string;
  /** 四条叙述内容 + 六项数值的显示/隐藏偏好，纯 UI 设置，不进生成 prompt */
  visibility?: EmotionVisibility;
  updatedAt: string;
};
