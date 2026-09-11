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

export type CharacterEmotionState = {
  characterId: string;
  enabled: boolean;
  buffs: EmotionBuff[];
  /** 预渲染好的叙述文本，逐字注入 prompt（{{当前情绪}}） */
  injection: string;
  updatedAt: string;
};
