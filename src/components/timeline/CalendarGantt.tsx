import React, { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import {
  ContainerNode,
  TransferLink,
  RouteCorridor,
  CalendarModel,
  CalendarEvent,
  CalendarTargetType,
  GRAPH_LINE_COLORS,
  getLinkCorridorIds
} from '../../models/types';

export const TIMELINE_THUMB_INSET = 8.5;

interface CalendarGanttProps {
  nodes: ContainerNode[];
  links: TransferLink[];
  corridors: RouteCorridor[];
  calendar: CalendarModel;
  totalDays: number;
  currentDay: number;
  isPlayback: boolean;
  selectedCalendarEventId: string | null;
  selectedNodeIds: string[];
  selectedLinkIds: string[];
  selectedCorridorIds: string[];
  onSelectCalendarEvent: (eventId: string | null) => void;
  onSelectTargetElement: (targetType: CalendarTargetType, targetId: string) => void;
  onAddCalendarEvent: (event: Omit<CalendarEvent, 'calendarId'>) => CalendarEvent;
  onUpdateCalendarEvent: (eventId: string, updates: Partial<CalendarEvent>) => void;
  onScrubDay: (day: number) => void;
  onScrollbarWidthChange?: (width: number) => void;
}

type DragInteraction =
  | {
      mode: 'draw';
      targetType: CalendarTargetType;
      targetId: string;
      anchorDay: number;
      startDay: number;
      endDay: number;
      trackRect: DOMRect;
    }
  | {
      mode: 'move';
      eventId: string;
      targetType: CalendarTargetType;
      targetId: string;
      pointerOriginDay: number;
      origStartDay: number;
      origEndDay: number;
      currentStartDay: number;
      currentEndDay: number;
      moved: boolean;
      trackRect: DOMRect;
    }
  | {
      mode: 'resize-left';
      eventId: string;
      targetType: CalendarTargetType;
      targetId: string;
      origStartDay: number;
      origEndDay: number;
      currentStartDay: number;
      currentEndDay: number;
      trackRect: DOMRect;
    }
  | {
      mode: 'resize-right';
      eventId: string;
      targetType: CalendarTargetType;
      targetId: string;
      origStartDay: number;
      origEndDay: number;
      currentStartDay: number;
      currentEndDay: number;
      trackRect: DOMRect;
    };

export const formatCompactRate = (val: number | undefined): string => {
  const n = Number.isFinite(val) ? Math.max(0, val as number) : 0;
  if (n >= 1000) {
    const k = n / 1000;
    return `${Number(k.toFixed(1))}k`;
  }
  return `${Math.round(n)}`;
};

export const getCalendarEventVisual = (
  evt: CalendarEvent,
  link?: TransferLink
): {
  bg: string;
  border: string;
  text: string;
  label: string;
  semantic: 'red' | 'amber' | 'green';
} => {
  if (evt.targetType === 'container') {
    if (evt.state === 'blocked') {
      return {
        bg: 'rgba(239, 68, 68, 0.24)',
        border: '#ef4444',
        text: '#fecaca',
        label: evt.label?.trim() || 'BLOCKED',
        semantic: 'red'
      };
    }
    return {
      bg: 'rgba(34, 197, 94, 0.22)',
      border: '#22c55e',
      text: '#bbf7d0',
      label: evt.label?.trim() || 'OPEN',
      semantic: 'green'
    };
  }

  if (evt.targetType === 'transfer') {
    if (evt.state === 'stopped') {
      return {
        bg: 'rgba(239, 68, 68, 0.24)',
        border: '#ef4444',
        text: '#fecaca',
        label: evt.label?.trim() || 'STOPPED',
        semantic: 'red'
      };
    }
    if (evt.state === 'variable') {
      const rate = evt.rateValue ?? link?.dailyRate ?? 0;
      const baseRate = link?.dailyRate ?? rate;
      const isBoosted = rate >= baseRate && rate > 0;
      if (rate <= 0) {
        return {
          bg: 'rgba(239, 68, 68, 0.24)',
          border: '#ef4444',
          text: '#fecaca',
          label: evt.label?.trim() || '0 m³/d',
          semantic: 'red'
        };
      }
      return isBoosted
        ? {
            bg: 'rgba(34, 197, 94, 0.22)',
            border: '#22c55e',
            text: '#bbf7d0',
            label: evt.label?.trim() || `${formatCompactRate(rate)} m³/d`,
            semantic: 'green'
          }
        : {
            bg: 'rgba(245, 158, 11, 0.24)',
            border: '#f59e0b',
            text: '#fde68a',
            label: evt.label?.trim() || `${formatCompactRate(rate)} m³/d`,
            semantic: 'amber'
          };
    }
    return {
      bg: 'rgba(34, 197, 94, 0.22)',
      border: '#22c55e',
      text: '#bbf7d0',
      label: evt.label?.trim() || 'MAX',
      semantic: 'green'
    };
  }

  // Route corridor
  if (evt.state === 'blocked') {
    return {
      bg: 'rgba(239, 68, 68, 0.24)',
      border: '#ef4444',
      text: '#fecaca',
      label: evt.label?.trim() || 'BLOCKED',
      semantic: 'red'
    };
  }
  if (evt.state === 'restricted') {
    return {
      bg: 'rgba(245, 158, 11, 0.24)',
      border: '#f59e0b',
      text: '#fde68a',
      label: evt.label?.trim() || `CAP ${formatCompactRate(evt.rateValue)}`,
      semantic: 'amber'
    };
  }
  return {
    bg: 'rgba(34, 197, 94, 0.22)',
    border: '#22c55e',
    text: '#bbf7d0',
    label: evt.label?.trim() || 'OPEN',
    semantic: 'green'
  };
};

export const CalendarGantt: React.FC<CalendarGanttProps> = ({
  nodes,
  links,
  corridors,
  calendar,
  totalDays,
  currentDay,
  isPlayback,
  selectedCalendarEventId,
  selectedNodeIds,
  selectedLinkIds,
  selectedCorridorIds,
  onSelectCalendarEvent,
  onSelectTargetElement,
  onAddCalendarEvent,
  onUpdateCalendarEvent,
  onScrubDay,
  onScrollbarWidthChange
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const headerTrackRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState<number>(800);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<CalendarTargetType, boolean>>({
    container: false,
    transfer: false,
    route: false
  });
  const [drag, setDrag] = useState<DragInteraction | null>(null);
  const dragRef = useRef<DragInteraction | null>(null);
  dragRef.current = drag;

  const nodeMap = useMemo(() => new Map(nodes.map((n, idx) => [n.id, { node: n, idx }])), [nodes]);
  const linkMap = useMemo(() => new Map(links.map(l => [l.id, l])), [links]);

  const eventsByRow = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const evt of calendar.events) {
      const key = `${evt.targetType}:${evt.targetId}`;
      const list = map.get(key) || [];
      list.push(evt);
      map.set(key, list);
    }
    map.forEach(list => list.sort((a, b) => a.startDay - b.startDay));
    return map;
  }, [calendar.events]);

  useEffect(() => {
    const measure = () => {
      if (headerTrackRef.current) {
        const w = headerTrackRef.current.clientWidth;
        if (w > 0) setTrackWidth(w);
      }
      if (scrollContainerRef.current && onScrollbarWidthChange) {
        const sb = Math.max(0, scrollContainerRef.current.offsetWidth - scrollContainerRef.current.clientWidth);
        onScrollbarWidthChange(sb);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (headerTrackRef.current) ro.observe(headerTrackRef.current);
    if (scrollContainerRef.current) ro.observe(scrollContainerRef.current);
    return () => {
      ro.disconnect();
      if (onScrollbarWidthChange) onScrollbarWidthChange(0);
    };
  }, [nodes.length, links.length, corridors.length, collapsedGroups, onScrollbarWidthChange]);

  const usableWidth = Math.max(0, trackWidth - TIMELINE_THUMB_INSET * 2);
  const dayStep = totalDays > 0 ? usableWidth / totalDays : 0;

  const dayToCenterX = useCallback(
    (day: number) => TIMELINE_THUMB_INSET + (totalDays > 0 ? (day / totalDays) * usableWidth : 0),
    [totalDays, usableWidth]
  );

  const clientXToDay = useCallback(
    (clientX: number, rect: DOMRect, allowDayZero = false): number => {
      const relX = clientX - rect.left;
      const w = Math.max(1, rect.width - TIMELINE_THUMB_INSET * 2);
      const raw = Math.round(((relX - TIMELINE_THUMB_INSET) / w) * totalDays);
      return Math.max(allowDayZero ? 0 : 1, Math.min(totalDays, raw));
    },
    [totalDays]
  );

  const getBarPixelBounds = useCallback(
    (startDay: number, endDay: number) => {
      const half = dayStep * 0.46;
      const left = Math.max(0, dayToCenterX(startDay) - half);
      const right = Math.min(trackWidth, dayToCenterX(endDay) + half);
      return { left, width: Math.max(8, right - left) };
    },
    [dayStep, dayToCenterX, trackWidth]
  );

  const getRowOtherEvents = useCallback(
    (targetType: CalendarTargetType, targetId: string, ignoreEventId?: string) => {
      const rowEvents = eventsByRow.get(`${targetType}:${targetId}`) || [];
      return ignoreEventId ? rowEvents.filter(e => e.id !== ignoreEventId) : rowEvents;
    },
    [eventsByRow]
  );

  // Global pointer listeners while dragging/drawing/resizing
  useEffect(() => {
    if (!drag) return;

    const handlePointerMove = (e: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;

      const day = clientXToDay(e.clientX, cur.trackRect, false);
      const others = getRowOtherEvents(
        cur.targetType,
        cur.targetId,
        cur.mode === 'draw' ? undefined : cur.eventId
      );

      if (cur.mode === 'draw') {
        const prevEnd = others.reduce(
          (maxEnd, o) => (o.endDay < cur.anchorDay ? Math.max(maxEnd, o.endDay) : maxEnd),
          0
        );
        const nextStart = others.reduce(
          (minStart, o) => (o.startDay > cur.anchorDay ? Math.min(minStart, o.startDay) : minStart),
          totalDays + 1
        );
        const nextStartDay = Math.max(prevEnd + 1, Math.min(cur.anchorDay, day));
        const nextEndDay = Math.min(nextStart - 1, Math.max(cur.anchorDay, day));
        if (nextStartDay !== cur.startDay || nextEndDay !== cur.endDay) {
          setDrag({ ...cur, startDay: nextStartDay, endDay: nextEndDay });
        }
      } else if (cur.mode === 'resize-left') {
        const prevEnd = others.reduce(
          (maxEnd, o) => (o.endDay < cur.origStartDay ? Math.max(maxEnd, o.endDay) : maxEnd),
          0
        );
        const nextStart = Math.max(prevEnd + 1, Math.min(cur.origEndDay, day));
        if (nextStart !== cur.currentStartDay) {
          setDrag({ ...cur, currentStartDay: nextStart });
        }
      } else if (cur.mode === 'resize-right') {
        const nextStart = others.reduce(
          (minStart, o) => (o.startDay > cur.origEndDay ? Math.min(minStart, o.startDay) : minStart),
          totalDays + 1
        );
        const nextEnd = Math.min(nextStart - 1, Math.max(cur.origStartDay, day));
        if (nextEnd !== cur.currentEndDay) {
          setDrag({ ...cur, currentEndDay: nextEnd });
        }
      } else if (cur.mode === 'move') {
        const delta = day - cur.pointerOriginDay;
        const span = cur.origEndDay - cur.origStartDay;
        const candidateStart = Math.max(1, Math.min(totalDays - span, cur.origStartDay + delta));
        const candidateEnd = candidateStart + span;
        const overlaps = others.some(o => o.startDay <= candidateEnd && o.endDay >= candidateStart);
        if (!overlaps) {
          if (candidateStart !== cur.currentStartDay || candidateEnd !== cur.currentEndDay) {
            setDrag({
              ...cur,
              currentStartDay: candidateStart,
              currentEndDay: candidateEnd,
              moved: true
            });
          }
        }
      }
    };

    const handlePointerUp = () => {
      const cur = dragRef.current;
      setDrag(null);
      if (!cur) return;

      if (cur.mode === 'draw') {
        const id = `cal-evt-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        let newEventInput: Omit<CalendarEvent, 'calendarId'>;
        if (cur.targetType === 'container') {
          newEventInput = {
            id,
            targetType: 'container',
            targetId: cur.targetId,
            startDay: cur.startDay,
            endDay: cur.endDay,
            state: 'blocked'
          };
        } else if (cur.targetType === 'transfer') {
          const link = linkMap.get(cur.targetId);
          const defaultRate = link ? Math.max(0, Math.round((link.dailyRate * 0.5) / 50) * 50) : 500;
          newEventInput = {
            id,
            targetType: 'transfer',
            targetId: cur.targetId,
            startDay: cur.startDay,
            endDay: cur.endDay,
            state: 'variable',
            rateValue: defaultRate
          };
        } else {
          const assignedLinks = links.filter(l => getLinkCorridorIds(l).includes(cur.targetId));
          const combinedRate = assignedLinks.reduce((sum, l) => sum + (l.dailyRate || 0), 0);
          const defaultCap = combinedRate > 0 ? Math.max(50, Math.round((combinedRate * 0.5) / 50) * 50) : 1000;
          newEventInput = {
            id,
            targetType: 'route',
            targetId: cur.targetId,
            startDay: cur.startDay,
            endDay: cur.endDay,
            state: 'restricted',
            rateValue: defaultCap
          };
        }
        const created = onAddCalendarEvent(newEventInput);
        onSelectCalendarEvent(created.id);
      } else if (cur.mode === 'move') {
        if (cur.currentStartDay !== cur.origStartDay || cur.currentEndDay !== cur.origEndDay) {
          onUpdateCalendarEvent(cur.eventId, {
            startDay: cur.currentStartDay,
            endDay: cur.currentEndDay
          });
        }
        onSelectCalendarEvent(cur.eventId);
      } else if (cur.mode === 'resize-left' || cur.mode === 'resize-right') {
        if (cur.currentStartDay !== cur.origStartDay || cur.currentEndDay !== cur.origEndDay) {
          onUpdateCalendarEvent(cur.eventId, {
            startDay: cur.currentStartDay,
            endDay: cur.currentEndDay
          });
        }
        onSelectCalendarEvent(cur.eventId);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [drag !== null, clientXToDay, getRowOtherEvents, totalDays, linkMap, links, onAddCalendarEvent, onUpdateCalendarEvent, onSelectCalendarEvent]);

  const handleTrackPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    targetType: CalendarTargetType,
    targetId: string
  ) => {
    if (e.button !== 0) return;
    if (isPlayback) {
      // Allow clicking track in playback mode to scrub to that day
      const rect = e.currentTarget.getBoundingClientRect();
      onScrubDay(clientXToDay(e.clientX, rect, true));
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const clickedDay = clientXToDay(e.clientX, rect, true);
    if (clickedDay < 1) return; // Day 0 is frozen baseline

    const rowEvents = eventsByRow.get(`${targetType}:${targetId}`) || [];
    const existing = rowEvents.find(ev => clickedDay >= ev.startDay && clickedDay <= ev.endDay);
    if (existing) return;

    e.preventDefault();
    setDrag({
      mode: 'draw',
      targetType,
      targetId,
      anchorDay: clickedDay,
      startDay: clickedDay,
      endDay: clickedDay,
      trackRect: rect
    });
  };

  const handleBarPointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    evt: CalendarEvent,
    mode: 'move' | 'resize-left' | 'resize-right'
  ) => {
    e.stopPropagation();
    if (e.button !== 0) return;

    onSelectCalendarEvent(evt.id);
    if (isPlayback) return;

    const trackEl = e.currentTarget.closest('[data-gantt-track="true"]') as HTMLElement | null;
    if (!trackEl) return;
    const rect = trackEl.getBoundingClientRect();
    const pointerOriginDay = clientXToDay(e.clientX, rect, false);

    e.preventDefault();
    if (mode === 'move') {
      setDrag({
        mode: 'move',
        eventId: evt.id,
        targetType: evt.targetType,
        targetId: evt.targetId,
        pointerOriginDay,
        origStartDay: evt.startDay,
        origEndDay: evt.endDay,
        currentStartDay: evt.startDay,
        currentEndDay: evt.endDay,
        moved: false,
        trackRect: rect
      });
    } else {
      setDrag({
        mode,
        eventId: evt.id,
        targetType: evt.targetType,
        targetId: evt.targetId,
        origStartDay: evt.startDay,
        origEndDay: evt.endDay,
        currentStartDay: evt.startDay,
        currentEndDay: evt.endDay,
        trackRect: rect
      });
    }
  };

  const toggleGroup = (group: CalendarTargetType) => {
    setCollapsedGroups(prev => ({ ...prev, [group]: !prev[group] }));
  };

  const currentX = dayToCenterX(currentDay);
  const day0BandWidth = Math.max(0, dayToCenterX(0) + dayStep * 0.48);

  const majorTicks = useMemo(() => {
    const arr: number[] = [];
    for (let d = 0; d <= totalDays; d += 5) arr.push(d);
    if (arr[arr.length - 1] !== totalDays) arr.push(totalDays);
    return arr;
  }, [totalDays]);

  const allDayTicks = useMemo(() => {
    const arr: number[] = [];
    for (let d = 0; d <= totalDays; d++) arr.push(d);
    return arr;
  }, [totalDays]);

  const renderTrackGridLines = () => (
    <>
      {/* Day 0 frozen zone shading */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: `${day0BandWidth}px`,
          backgroundColor: 'rgba(15, 23, 42, 0.55)',
          borderRight: '1px dashed rgba(71, 85, 105, 0.55)',
          pointerEvents: 'none'
        }}
      />
      {/* Vertical day gridlines */}
      {allDayTicks.map(d => {
        if (d === 0) return null;
        const x = dayToCenterX(d) - dayStep * 0.5;
        const isMajor = d % 5 === 0;
        return (
          <div
            key={d}
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${x}px`,
              width: '1px',
              backgroundColor: isMajor ? 'rgba(51, 65, 85, 0.72)' : 'rgba(30, 41, 59, 0.75)',
              pointerEvents: 'none'
            }}
          />
        );
      })}
      {/* Active Day green vertical cursor */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${currentX}px`,
          width: '1px',
          backgroundColor: '#22c55e',
          pointerEvents: 'none',
          zIndex: 6
        }}
      />
    </>
  );

  const renderRow = (
    targetType: CalendarTargetType,
    targetId: string,
    title: string,
    baselineLabel: string,
    accentColor: string,
    isTargetSelected: boolean
  ) => {
    const rowEvents = eventsByRow.get(`${targetType}:${targetId}`) || [];
    const link = targetType === 'transfer' ? linkMap.get(targetId) : undefined;
    const isDrawingOnRow = drag?.mode === 'draw' && drag.targetType === targetType && drag.targetId === targetId;

    return (
      <div
        key={`${targetType}:${targetId}`}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          height: '28px',
          minHeight: '28px',
          gap: '16px',
          boxSizing: 'border-box'
        }}
      >
        {/* Left Element Label (220px, matches Time Graph legend column) */}
        <div
          onClick={() => onSelectTargetElement(targetType, targetId)}
          style={{
            width: '220px',
            minWidth: '220px',
            maxWidth: '220px',
            flexShrink: 0,
            backgroundColor: isTargetSelected ? 'rgba(56, 189, 248, 0.14)' : '#0f172a',
            borderLeft: '1px solid #334155',
            borderRight: '1px solid #334155',
            borderBottom: '1px solid #1e293b',
            padding: '0 10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '6px',
            cursor: 'pointer',
            userSelect: 'none',
            boxSizing: 'border-box'
          }}
          title={`${title} — Click to select on canvas`}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
            <span
              style={{
                width: '7px',
                height: '7px',
                borderRadius: targetType === 'route' ? '50%' : '2px',
                backgroundColor: accentColor,
                flexShrink: 0
              }}
            />
            <span
              style={{
                fontSize: '11px',
                color: isTargetSelected ? '#38bdf8' : '#e2e8f0',
                fontWeight: isTargetSelected ? 600 : 400,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {title}
            </span>
          </div>
          {rowEvents.length > 0 && (
            <span
              style={{
                fontSize: '10px',
                color: '#64748b',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontVariantNumeric: 'tabular-nums',
                flexShrink: 0
              }}
            >
              {rowEvents.length}
            </span>
          )}
        </div>

        {/* Right Panel: 48px baseline gutter + Gantt Track (matches Time Graph right panel geometry) */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'stretch',
            backgroundColor: '#0f172a',
            borderLeft: '1px solid #334155',
            borderRight: '1px solid #334155',
            borderBottom: '1px solid #1e293b',
            padding: '0 12px 0 4px',
            boxSizing: 'border-box'
          }}
        >
          {/* 48px Baseline column */}
          <div
            style={{
              width: '48px',
              minWidth: '48px',
              maxWidth: '48px',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: '8px',
              fontSize: '10px',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontVariantNumeric: 'tabular-nums',
              color: '#64748b',
              userSelect: 'none',
              boxSizing: 'border-box'
            }}
            title="Default baseline state when no event bar is active"
          >
            {baselineLabel}
          </div>

          {/* Gantt Track (width matches Time Graph SVG plotWidth) */}
          <div
            data-gantt-track="true"
            onPointerDown={e => handleTrackPointerDown(e, targetType, targetId)}
            style={{
              flex: 1,
              minWidth: 0,
              position: 'relative',
              cursor: isPlayback ? 'pointer' : 'crosshair',
              userSelect: 'none',
              overflow: 'hidden'
            }}
          >
            {renderTrackGridLines()}

            {/* Existing Event Bars */}
            {rowEvents.map(evt => {
              const isDraggedEvt =
                drag &&
                drag.mode !== 'draw' &&
                drag.eventId === evt.id;
              const displayStart = isDraggedEvt ? drag.currentStartDay : evt.startDay;
              const displayEnd = isDraggedEvt ? drag.currentEndDay : evt.endDay;
              const { left, width } = getBarPixelBounds(displayStart, displayEnd);
              const vis = getCalendarEventVisual(evt, link);
              const isSelected = selectedCalendarEventId === evt.id;
              const dayRangeText =
                displayStart === displayEnd ? `D${displayStart}` : `D${displayStart}–D${displayEnd}`;

              return (
                <div
                  key={evt.id}
                  onPointerDown={e => handleBarPointerDown(e, evt, 'move')}
                  style={{
                    position: 'absolute',
                    top: '4px',
                    bottom: '4px',
                    left: `${left}px`,
                    width: `${width}px`,
                    backgroundColor: vis.bg,
                    border: `1px solid ${isSelected ? '#38bdf8' : vis.border}`,
                    boxShadow: isSelected ? '0 0 0 1px #38bdf8' : 'none',
                    borderRadius: '3px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '0 6px',
                    boxSizing: 'border-box',
                    cursor: isPlayback ? 'pointer' : 'grab',
                    zIndex: isSelected ? 5 : 4,
                    overflow: 'hidden'
                  }}
                  title={`${title} · ${vis.label} (${dayRangeText})${isPlayback ? '' : ' — Drag to move, drag edges to resize, click to edit in inspector'}`}
                >
                  {/* Left resize handle */}
                  {!isPlayback && (
                    <div
                      onPointerDown={e => handleBarPointerDown(e, evt, 'resize-left')}
                      style={{
                        position: 'absolute',
                        left: 0,
                        top: 0,
                        bottom: 0,
                        width: '6px',
                        cursor: 'ew-resize',
                        zIndex: 2
                      }}
                    />
                  )}
                  <span
                    style={{
                      fontSize: '9px',
                      fontWeight: 700,
                      letterSpacing: '0.2px',
                      color: vis.text,
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontVariantNumeric: 'tabular-nums',
                      pointerEvents: 'none'
                    }}
                  >
                    {width >= 36 ? vis.label : ''}
                  </span>
                  {/* Right resize handle */}
                  {!isPlayback && (
                    <div
                      onPointerDown={e => handleBarPointerDown(e, evt, 'resize-right')}
                      style={{
                        position: 'absolute',
                        right: 0,
                        top: 0,
                        bottom: 0,
                        width: '6px',
                        cursor: 'ew-resize',
                        zIndex: 2
                      }}
                    />
                  )}
                </div>
              );
            })}

            {/* Ghost bar while drawing a new event */}
            {isDrawingOnRow && (() => {
              const { left, width } = getBarPixelBounds(drag.startDay, drag.endDay);
              const previewLabel =
                drag.startDay === drag.endDay
                  ? `D${drag.startDay}`
                  : `D${drag.startDay}–D${drag.endDay}`;
              return (
                <div
                  style={{
                    position: 'absolute',
                    top: '4px',
                    bottom: '4px',
                    left: `${left}px`,
                    width: `${width}px`,
                    backgroundColor: 'rgba(56, 189, 248, 0.25)',
                    border: '1px dashed #38bdf8',
                    borderRadius: '3px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '9px',
                    fontWeight: 700,
                    color: '#e0f2fe',
                    fontVariantNumeric: 'tabular-nums',
                    pointerEvents: 'none',
                    zIndex: 7
                  }}
                >
                  {width >= 26 ? previewLabel : ''}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    );
  };

  const renderGroupHeader = (
    group: CalendarTargetType,
    label: string,
    count: number
  ) => {
    const isCollapsed = collapsedGroups[group];
    return (
      <div
        key={`group:${group}`}
        style={{
          display: 'flex',
          alignItems: 'stretch',
          height: '24px',
          minHeight: '24px',
          gap: '16px',
          boxSizing: 'border-box'
        }}
      >
        <button
          type="button"
          onClick={() => toggleGroup(group)}
          style={{
            width: '220px',
            minWidth: '220px',
            maxWidth: '220px',
            flexShrink: 0,
            backgroundColor: '#162032',
            border: 'none',
            borderLeft: '1px solid #334155',
            borderRight: '1px solid #334155',
            borderBottom: '1px solid #334155',
            padding: '0 10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: 'pointer',
            color: '#94a3b8',
            fontSize: '10px',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.6px',
            boxSizing: 'border-box'
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '9px', color: '#64748b' }}>{isCollapsed ? '▸' : '▾'}</span>
            <span>{label}</span>
          </span>
          <span style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums', color: '#64748b' }}>
            {count}
          </span>
        </button>

        {/* Right group band */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'stretch',
            backgroundColor: '#131d30',
            borderLeft: '1px solid #334155',
            borderRight: '1px solid #334155',
            borderBottom: '1px solid #334155',
            padding: '0 12px 0 4px',
            boxSizing: 'border-box'
          }}
        >
          <div style={{ width: '48px', minWidth: '48px', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' }}>
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${currentX}px`,
                width: '1px',
                backgroundColor: '#22c55e',
                opacity: 0.7,
                pointerEvents: 'none'
              }}
            />
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={scrollContainerRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box'
      }}
    >
      {/* Sticky Day Axis Header */}
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 10,
          display: 'flex',
          alignItems: 'stretch',
          height: '24px',
          minHeight: '24px',
          gap: '16px',
          backgroundColor: '#1e293b',
          boxSizing: 'border-box'
        }}
      >
        {/* Left header cell */}
        <div
          style={{
            width: '220px',
            minWidth: '220px',
            maxWidth: '220px',
            flexShrink: 0,
            backgroundColor: '#0f172a',
            border: '1px solid #334155',
            borderTopLeftRadius: '4px',
            borderTopRightRadius: '4px',
            padding: '0 10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: '10px',
            fontWeight: 700,
            color: '#94a3b8',
            textTransform: 'uppercase',
            letterSpacing: '0.5px',
            boxSizing: 'border-box'
          }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {calendar.name || 'Project Schedule'}
          </span>
          <span
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontVariantNumeric: 'tabular-nums',
              color: '#38bdf8',
              flexShrink: 0
            }}
          >
            {calendar.events.length} ev
          </span>
        </div>

        {/* Right Day Ruler */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'stretch',
            backgroundColor: '#0f172a',
            border: '1px solid #334155',
            borderTopLeftRadius: '4px',
            borderTopRightRadius: '4px',
            padding: '0 12px 0 4px',
            boxSizing: 'border-box'
          }}
        >
          <div
            style={{
              width: '48px',
              minWidth: '48px',
              maxWidth: '48px',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingRight: '8px',
              fontSize: '9px',
              fontWeight: 700,
              color: '#64748b',
              letterSpacing: '0.4px',
              textTransform: 'uppercase',
              userSelect: 'none',
              boxSizing: 'border-box'
            }}
          >
            BASE
          </div>
          <div
            ref={headerTrackRef}
            onClick={e => {
              const rect = e.currentTarget.getBoundingClientRect();
              onScrubDay(clientXToDay(e.clientX, rect, true));
            }}
            style={{
              flex: 1,
              minWidth: 0,
              position: 'relative',
              cursor: 'pointer',
              userSelect: 'none',
              overflow: 'hidden'
            }}
            title="Click timeline ruler to jump to day"
          >
            {majorTicks.map(d => {
              const x = dayToCenterX(d);
              const translate = d === 0 ? '0%' : d === totalDays ? '-100%' : '-50%';
              return (
                <span
                  key={d}
                  style={{
                    position: 'absolute',
                    left: `${x}px`,
                    top: '50%',
                    transform: `translate(${translate}, -50%)`,
                    fontSize: '9px',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: d === currentDay ? 700 : 600,
                    color: d === currentDay ? '#22c55e' : '#94a3b8',
                    whiteSpace: 'nowrap'
                  }}
                >
                  D{d}
                </span>
              );
            })}
            <div
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${currentX}px`,
                width: '1px',
                backgroundColor: '#22c55e',
                pointerEvents: 'none'
              }}
            />
          </div>
        </div>
      </div>

      {/* Group 1: Containers */}
      {renderGroupHeader('container', 'Containers', nodes.length)}
      {!collapsedGroups.container &&
        nodes.map((node, idx) => {
          const color = GRAPH_LINE_COLORS[idx % GRAPH_LINE_COLORS.length];
          const baseLabel =
            node.status === 'blocked' ? 'BLKD' : node.status === 'maintenance' ? 'MAINT' : 'OPEN';
          return renderRow(
            'container',
            node.id,
            node.name,
            baseLabel,
            color,
            selectedNodeIds.includes(node.id)
          );
        })}

      {/* Group 2: Transfers */}
      {renderGroupHeader('transfer', 'Transfers', links.length)}
      {!collapsedGroups.transfer &&
        links.map(link => {
          const srcName = nodeMap.get(link.sourceId)?.node.name || link.sourceId;
          const tgtName = nodeMap.get(link.targetId)?.node.name || link.targetId;
          const label = `${srcName} → ${tgtName}`;
          return renderRow(
            'transfer',
            link.id,
            label,
            formatCompactRate(link.dailyRate),
            '#38bdf8',
            selectedLinkIds.includes(link.id)
          );
        })}

      {/* Group 3: Routes */}
      {renderGroupHeader('route', 'Routes', corridors.length)}
      {!collapsedGroups.route &&
        (corridors.length === 0 ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'stretch',
              height: '26px',
              minHeight: '26px',
              gap: '16px',
              boxSizing: 'border-box'
            }}
          >
            <div
              style={{
                width: '220px',
                minWidth: '220px',
                backgroundColor: '#0f172a',
                borderLeft: '1px solid #334155',
                borderRight: '1px solid #334155',
                borderBottom: '1px solid #334155',
                padding: '0 10px',
                display: 'flex',
                alignItems: 'center',
                fontSize: '10px',
                color: '#64748b',
                fontStyle: 'italic',
                boxSizing: 'border-box'
              }}
            >
              No routes defined
            </div>
            <div
              style={{
                flex: 1,
                minWidth: 0,
                backgroundColor: '#0f172a',
                borderLeft: '1px solid #334155',
                borderRight: '1px solid #334155',
                borderBottom: '1px solid #334155',
                display: 'flex',
                alignItems: 'center',
                paddingLeft: '56px',
                fontSize: '10px',
                color: '#475569',
                boxSizing: 'border-box'
              }}
            >
              Use + route on canvas to create a route corridor
            </div>
          </div>
        ) : (
          corridors.map(corridor =>
            renderRow(
              'route',
              corridor.id,
              corridor.name,
              'OPEN',
              '#a855f7',
              selectedCorridorIds.includes(corridor.id)
            )
          )
        ))}
    </div>
  );
};
