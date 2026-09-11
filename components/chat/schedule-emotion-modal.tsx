"use client";

import { useEffect, useMemo, useState } from "react";
import type { CalendarScheduleItem } from "@/lib/calendar-types";
import { loadCalendarWeekPlan } from "@/lib/calendar-storage";
import { generateWeeklyCalendarSchedule } from "@/lib/calendar-engine";
import { getWeekStartIso, formatIsoDate, getWeekdayLabel, timeToMinutes } from "@/lib/calendar-utils";
import { loadCharacterEmotionState, setCharacterEmotionEnabled, clearCharacterEmotionBuffs } from "@/lib/emotion-storage";
import type { CharacterEmotionState } from "@/lib/emotion-types";
import { isScheduleUiEnabled, setScheduleUiEnabled } from "@/lib/schedule-ui-storage";
import { loadBindingConfig, resolveBinding } from "@/lib/settings-storage";
import { Toggle } from "@/components/ui/form";
import { hashColor, buffPillStyle } from "./state-values-panel";

type ScheduleEmotionModalProps = {
    characterId: string;
    characterName: string;
    characterAvatar?: string | null;
    onClose: () => void;
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

    const refreshSchedule = () => {
        const plan = loadCalendarWeekPlan("character", characterId, weekStart);
        setHasWeekPlan(!!plan);
        setTodayItems((plan?.items ?? []).filter(item => item.date === today));
    };

    const refreshEmotion = () => {
        setEmotionState(loadCharacterEmotionState(characterId));
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

    const buffs = emotionState?.buffs ?? [];
    const enabled = emotionState?.enabled ?? false;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div onClick={e => e.stopPropagation()} className="modal-dialog schedule-emotion-modal">
                <div className="ts-16 font-semibold text-center text-[var(--c-text)]">{characterName}的日程/情绪</div>

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
                                        {hasWeekPlan ? "今天没有安排" : "本周还没有日程，点一下上面生成"}
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="ts-12 text-[var(--c-icon)] text-center py-3">
                            日程功能已关闭
                        </div>
                    )}
                </div>

                <div className="schedule-emotion-section">
                    <div className="schedule-emotion-section-head">
                        <span className="ts-13 font-semibold text-[var(--c-text)]">情绪状态</span>
                        <Toggle checked={enabled} onChange={handleToggleEmotion} />
                    </div>

                    {enabled && !emotionBound && (
                        <div className="ts-12 text-[var(--c-icon)]">
                            还没有绑定情绪 API，去「设置 → 配置绑定 → 情绪」里配一个吧。
                        </div>
                    )}

                    {enabled && (
                        buffs.length > 0 ? (
                            <>
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
                                <button
                                    type="button"
                                    className="ui-btn ui-btn-ghost ui-btn-bordered-ghost schedule-emotion-mini-btn"
                                    onClick={handleClearBuffs}
                                >
                                    清除
                                </button>
                            </>
                        ) : (
                            <div className="ts-12 text-[var(--c-icon)] text-center py-3">
                                暂无情绪状态，发几条消息后会自动生成
                            </div>
                        )
                    )}
                </div>

                <button onClick={onClose} className="ui-btn ui-btn-ghost ui-btn-bordered-ghost w-full">关闭</button>
            </div>
        </div>
    );
}
