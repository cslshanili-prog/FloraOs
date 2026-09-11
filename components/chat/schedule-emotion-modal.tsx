"use client";

import { useEffect, useMemo, useState } from "react";
import type { CalendarScheduleItem } from "@/lib/calendar-types";
import { loadCalendarWeekPlan } from "@/lib/calendar-storage";
import { generateWeeklyCalendarSchedule } from "@/lib/calendar-engine";
import { getWeekStartIso, formatIsoDate, getWeekdayLabel, timeToMinutes } from "@/lib/calendar-utils";
import {
    loadCharacterEmotionState,
    setCharacterEmotionEnabled,
    clearCharacterEmotionBuffs,
    getEmotionVisibility,
    setEmotionVisibility,
} from "@/lib/emotion-storage";
import type { CharacterEmotionState, EmotionNarrativeKey, EmotionStateValueKey, EmotionVisibility } from "@/lib/emotion-types";
import { EMOTION_STATE_VALUE_KEYS, EMOTION_NARRATIVE_LABELS } from "@/lib/emotion-types";
import { isScheduleUiEnabled, setScheduleUiEnabled } from "@/lib/schedule-ui-storage";
import { loadBindingConfig, resolveBinding } from "@/lib/settings-storage";
import { Toggle } from "@/components/ui/form";
import { hashColor, buffPillStyle, getStateColor } from "./state-values-panel";

type ScheduleEmotionModalProps = {
    characterId: string;
    characterName: string;
    characterAvatar?: string | null;
    onClose: () => void;
};

const NARRATIVE_ICONS: Record<EmotionNarrativeKey, string> = {
    darkSide: "🌑",
    snark: "🚩",
    withdrawnDraft: "📝",
    nextAction: "✅",
};

// 状态栏六项数值内部仍以简体存 key（跟 LLM JSON 契约、kv 存储绑定），仅在这里做繁体显示映射
const STATE_VALUE_DISPLAY_LABELS: Record<EmotionStateValueKey, string> = {
    偏爱度: "偏愛度",
    护短指数: "護短指數",
    操心覆载: "操心覆載",
    好感度: "好感度",
    占有欲: "佔有慾",
    焦虑值: "焦慮值",
};

export function ScheduleEmotionModal({ characterId, characterName, characterAvatar, onClose }: ScheduleEmotionModalProps) {
    const weekStart = useMemo(() => getWeekStartIso(new Date()), []);
    const today = useMemo(() => formatIsoDate(new Date()), []);

    // 时间轴需要实时感——每 30s 刷新一次，NOW 高亮和时钟才不会开着弹窗不动
    const [nowTick, setNowTick] = useState(() => new Date());
    useEffect(() => {
        const timer = window.setInterval(() => setNowTick(new Date()), 30000);
        return () => window.clearInterval(timer);
    }, []);
    const nowMinutes = nowTick.getHours() * 60 + nowTick.getMinutes();
    const clockLabel = `${String(nowTick.getHours()).padStart(2, "0")}:${String(nowTick.getMinutes()).padStart(2, "0")}`;
    const dateLabel = `${nowTick.getMonth() + 1}月${nowTick.getDate()}日 ${getWeekdayLabel(nowTick)}`;

    const [todayItems, setTodayItems] = useState<CalendarScheduleItem[]>([]);
    const [hasWeekPlan, setHasWeekPlan] = useState(false);
    const [generating, setGenerating] = useState(false);
    const [scheduleError, setScheduleError] = useState("");
    const [scheduleEnabled, setScheduleEnabled] = useState(() => isScheduleUiEnabled(characterId));

    const [emotionState, setEmotionState] = useState<CharacterEmotionState | null>(null);
    const [emotionBound, setEmotionBound] = useState(true);
    const [visibility, setVisibility] = useState<EmotionVisibility>(() => getEmotionVisibility(characterId));
    const [showVisibilitySettings, setShowVisibilitySettings] = useState(false);

    const refreshSchedule = () => {
        const plan = loadCalendarWeekPlan("character", characterId, weekStart);
        setHasWeekPlan(!!plan);
        setTodayItems((plan?.items ?? []).filter(item => item.date === today));
    };

    const refreshEmotion = () => {
        setEmotionState(loadCharacterEmotionState(characterId));
        setVisibility(getEmotionVisibility(characterId));
        const slot = resolveBinding(loadBindingConfig(), characterId, "emotion");
        setEmotionBound(!!slot.apiConfigId);
    };

    useEffect(() => {
        refreshSchedule();
        refreshEmotion();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [characterId]);

    useEffect(() => {
        const handler = (e: Event) => {
            const detail = (e as CustomEvent<{ characterId?: string }>).detail;
            if (!detail || detail.characterId === characterId) refreshEmotion();
        };
        window.addEventListener("emotion-updated", handler);
        return () => window.removeEventListener("emotion-updated", handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [characterId]);

    useEffect(() => {
        if (!showVisibilitySettings) return;
        const closeOnOutsideClick = () => setShowVisibilitySettings(false);
        window.addEventListener("click", closeOnOutsideClick);
        return () => window.removeEventListener("click", closeOnOutsideClick);
    }, [showVisibilitySettings]);

    const handleGenerate = async () => {
        setGenerating(true);
        setScheduleError("");
        const result = await generateWeeklyCalendarSchedule("character", characterId, weekStart);
        setGenerating(false);
        if (!result.success) {
            setScheduleError(result.error || "生成失败");
            return;
        }
        refreshSchedule();
    };

    const handleToggleSchedule = (next: boolean) => {
        setScheduleUiEnabled(characterId, next);
        setScheduleEnabled(next);
    };

    const handleToggleEmotion = (next: boolean) => {
        setEmotionState(setCharacterEmotionEnabled(characterId, next));
    };

    const handleClearBuffs = () => {
        setEmotionState(clearCharacterEmotionBuffs(characterId));
    };

    const handleToggleStateValueVisibility = (key: (typeof EMOTION_STATE_VALUE_KEYS)[number]) => {
        const next: EmotionVisibility = { ...visibility, stateValues: { ...visibility.stateValues, [key]: !visibility.stateValues[key] } };
        setVisibility(next);
        setEmotionVisibility(characterId, next);
    };

    const handleToggleNarrativeVisibility = (key: EmotionNarrativeKey) => {
        const next: EmotionVisibility = { ...visibility, [key]: !visibility[key] };
        setVisibility(next);
        setEmotionVisibility(characterId, next);
    };

    const buffs = emotionState?.buffs ?? [];
    const enabled = emotionState?.enabled ?? false;

    const visibleStateValues = EMOTION_STATE_VALUE_KEYS
        .filter(key => visibility.stateValues[key] && emotionState?.stateValues?.[key] !== undefined)
        .map(key => ({ key, value: emotionState!.stateValues![key]! }));

    const narrativeBlocks = (Object.keys(EMOTION_NARRATIVE_LABELS) as EmotionNarrativeKey[])
        .filter(key => visibility[key] && emotionState?.[key])
        .map(key => ({ key, label: EMOTION_NARRATIVE_LABELS[key], icon: NARRATIVE_ICONS[key], value: emotionState![key]! }));

    const hasMindContent = buffs.length > 0 || !!emotionState?.coreThought || visibleStateValues.length > 0 || narrativeBlocks.length > 0;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog schedule-emotion-modal">
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">{characterName}的日程/情緒</div>

                <div className="schedule-emotion-section">
                    <div className="schedule-emotion-section-head">
                        <span className="ts-13 font-semibold text-[var(--c-text)]">日程</span>
                        <Toggle checked={scheduleEnabled} onChange={handleToggleSchedule} />
                    </div>

                    {scheduleEnabled ? (
                        <div className="schedule-emotion-darkcard">
                            <div className="schedule-emotion-banner">
                                <div
                                    className="schedule-emotion-banner-bg"
                                    style={characterAvatar ? { backgroundImage: `url(${characterAvatar})` } : undefined}
                                />
                                <div className="schedule-emotion-banner-overlay" />
                                <div className="schedule-emotion-banner-content">
                                    <div className="schedule-emotion-banner-top">
                                        <span className="schedule-emotion-banner-label">TODAY'S SCHEDULE</span>
                                        <button
                                            type="button"
                                            className="schedule-emotion-banner-btn"
                                            disabled={generating}
                                            onClick={handleGenerate}
                                        >
                                            {generating ? "生成中…" : "🔄 重新生成"}
                                        </button>
                                    </div>
                                    <div className="schedule-emotion-banner-bottom">
                                        <span className="schedule-emotion-banner-clock">{clockLabel}</span>
                                        <span className="schedule-emotion-banner-date">{dateLabel}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="schedule-emotion-timeline-wrap">
                                {scheduleError && <div className="ts-12 schedule-emotion-error">{scheduleError}</div>}

                                {todayItems.length > 0 ? (
                                    <div className="schedule-emotion-timeline">
                                        {todayItems.map(item => {
                                            const start = timeToMinutes(item.startTime);
                                            const end = timeToMinutes(item.endTime);
                                            const isNow = Number.isFinite(start) && Number.isFinite(end) && start <= nowMinutes && nowMinutes < end;
                                            const isPast = Number.isFinite(end) && nowMinutes >= end;
                                            return (
                                                <div
                                                    key={item.id}
                                                    className={`schedule-emotion-timeline-row${isNow ? " is-now" : ""}${isPast ? " is-past" : ""}`}
                                                >
                                                    <div className="schedule-emotion-timeline-time">
                                                        {item.startTime}
                                                        {isNow && <span className="schedule-emotion-now-badge">NOW</span>}
                                                    </div>
                                                    <div className="schedule-emotion-timeline-rail">
                                                        <span className="schedule-emotion-timeline-dot" />
                                                    </div>
                                                    <div className="schedule-emotion-timeline-body">
                                                        <span>{item.emoji ? `${item.emoji} ` : ""}{item.title}</span>
                                                        {item.location && <span className="schedule-emotion-timeline-location"> · {item.location}</span>}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div className="ts-12 schedule-emotion-empty text-center py-3">
                                        {hasWeekPlan ? "今天沒有安排" : "本週還沒有日程，點一下上面生成"}
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="ts-12 text-[var(--c-icon)] text-center py-3">
                            日程功能已關閉
                        </div>
                    )}
                </div>

                <div className="schedule-emotion-section">
                    <div className="schedule-emotion-section-head" style={{ position: "relative" }}>
                        <span className="ts-13 font-semibold text-[var(--c-text)]">情緒/心聲</span>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                className="schedule-emotion-gear-btn"
                                onClick={(e) => { e.stopPropagation(); setShowVisibilitySettings(v => !v); }}
                                aria-label="顯示設定"
                            >
                                ⚙️
                            </button>
                            <Toggle checked={enabled} onChange={handleToggleEmotion} />
                        </div>

                        {showVisibilitySettings && (
                            <div className="schedule-emotion-visibility-panel" onClick={e => e.stopPropagation()}>
                                <div className="schedule-emotion-visibility-group-title">狀態欄顯示</div>
                                {EMOTION_STATE_VALUE_KEYS.map(key => (
                                    <div key={key} className="schedule-emotion-visibility-row">
                                        <span>{STATE_VALUE_DISPLAY_LABELS[key]}</span>
                                        <Toggle checked={visibility.stateValues[key]} onChange={() => handleToggleStateValueVisibility(key)} />
                                    </div>
                                ))}
                                <div className="schedule-emotion-visibility-group-title">心聲內容顯示</div>
                                {(Object.keys(EMOTION_NARRATIVE_LABELS) as EmotionNarrativeKey[]).map(key => (
                                    <div key={key} className="schedule-emotion-visibility-row">
                                        <span>{EMOTION_NARRATIVE_LABELS[key]}</span>
                                        <Toggle checked={visibility[key]} onChange={() => handleToggleNarrativeVisibility(key)} />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    {enabled && !emotionBound && (
                        <div className="ts-12 text-[var(--c-icon)]">
                            還沒有綁定情緒 API，去「設定 → 配置綁定 → 情緒」裡配一個吧。
                        </div>
                    )}

                    {enabled && (
                        hasMindContent ? (
                            <div className="flex flex-col gap-2.5">
                                {visibleStateValues.length > 0 && (
                                    <div className="schedule-emotion-statebar">
                                        {visibleStateValues.map(({ key, value }) => {
                                            const color = getStateColor(key);
                                            return (
                                                <div key={key} className="schedule-emotion-statebar-row">
                                                    <span className="schedule-emotion-statebar-label">{STATE_VALUE_DISPLAY_LABELS[key]}</span>
                                                    <div className="state-bar-track">
                                                        <div
                                                            className="state-bar-fill"
                                                            style={{
                                                                width: `${value}%`,
                                                                background: `linear-gradient(90deg, color-mix(in srgb, ${color} 40%, transparent), color-mix(in srgb, ${color} 80%, transparent))`,
                                                            }}
                                                            {...(value > 80 ? { "data-high": "" } : {})}
                                                        />
                                                    </div>
                                                    <span className="schedule-emotion-statebar-value">{value}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                {buffs.length > 0 && (
                                    <div className="schedule-emotion-buffs">
                                        {buffs.map(buff => (
                                            <span
                                                key={buff.id}
                                                className="emotion-buff-pill"
                                                style={buffPillStyle(buff.color || hashColor(buff.label))}
                                                title={buff.description || ""}
                                            >
                                                {buff.emoji ? `${buff.emoji} ` : ""}{buff.label}
                                            </span>
                                        ))}
                                    </div>
                                )}

                                {emotionState?.coreThought && (
                                    <div className="schedule-emotion-block">
                                        <div className="schedule-emotion-block-title">💭 核心心聲</div>
                                        <div className="schedule-emotion-block-body">{emotionState.coreThought}</div>
                                    </div>
                                )}

                                {narrativeBlocks.map(block => (
                                    <div key={block.key} className={`schedule-emotion-block schedule-emotion-block--${block.key}`}>
                                        <div className="schedule-emotion-block-title">{block.icon} {block.label}</div>
                                        <div className="schedule-emotion-block-body">{block.value}</div>
                                    </div>
                                ))}

                                <button
                                    type="button"
                                    className="ui-btn ui-btn-ghost ui-btn-bordered-ghost schedule-emotion-mini-btn"
                                    onClick={handleClearBuffs}
                                >
                                    清除
                                </button>
                            </div>
                        ) : (
                            <div className="ts-12 text-[var(--c-icon)] text-center py-3">
                                暫無情緒/心聲內容，發幾則訊息後會自動生成
                            </div>
                        )
                    )}
                </div>

                <button onClick={onClose} className="ui-btn ui-btn-ghost ui-btn-bordered-ghost w-full">關閉</button>
            </div>
        </div>
    );
}
