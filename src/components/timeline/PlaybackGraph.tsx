import React from 'react';
import {
  ContainerNode,
  TransferLink,
  RouteCorridor,
  CalendarModel,
  CalendarEvent,
  CalendarTargetType,
  SimFrame,
  GRAPH_LINE_COLORS
} from '../../models/types';
import { CanvasViewModel } from '../../viewmodel/CanvasViewModel';
import { CalendarGantt, TIMELINE_THUMB_INSET } from './CalendarGantt';

interface PlaybackGraphProps {
  nodes: ContainerNode[];
  links: TransferLink[];
  corridors: RouteCorridor[];
  calendar: CalendarModel;
  frames: SimFrame[];
  currentDay: number;
  isPlayback: boolean;
  isGraphExpanded: boolean;
  setIsGraphExpanded: (val: boolean) => void;
  setCurrentDay: (day: number) => void;
  vm: CanvasViewModel;
  highlightedNodeIds?: string[];
  setHighlightedNodeIds?: React.Dispatch<React.SetStateAction<string[]>>;
  selectedCalendarEventId: string | null;
  selectedNodeIds: string[];
  selectedLinkIds: string[];
  selectedCorridorIds: string[];
  onSelectCalendarEvent: (eventId: string | null) => void;
  onSelectTargetElement: (targetType: CalendarTargetType, targetId: string) => void;
  onAddCalendarEvent: (event: Omit<CalendarEvent, 'calendarId'>) => CalendarEvent;
  onUpdateCalendarEvent: (eventId: string, updates: Partial<CalendarEvent>) => void;
}

export const PlaybackGraph: React.FC<PlaybackGraphProps> = ({
  nodes,
  links,
  corridors,
  calendar,
  frames,
  currentDay,
  isPlayback,
  isGraphExpanded,
  setIsGraphExpanded,
  setCurrentDay,
  vm,
  highlightedNodeIds = [],
  setHighlightedNodeIds,
  selectedCalendarEventId,
  selectedNodeIds,
  selectedLinkIds,
  selectedCorridorIds,
  onSelectCalendarEvent,
  onSelectTargetElement,
  onAddCalendarEvent,
  onUpdateCalendarEvent,
}) => {
  const [isTimeGraphOpen, setIsTimeGraphOpen] = React.useState<boolean>(true);
  const [isCalendarOpen, setIsCalendarOpen] = React.useState<boolean>(true);
  const [calendarScrollbarWidth, setCalendarScrollbarWidth] = React.useState<number>(0);

  const handleScrubDay = React.useCallback(
    (day: number) => {
      const clamped = Math.max(0, Math.min(Math.max(1, frames.length - 1), day));
      setCurrentDay(clamped);
      vm.setFrameIndex(clamped);
    },
    [frames.length, setCurrentDay, vm]
  );

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const day = parseInt(e.target.value, 10);
    handleScrubDay(day);
  };

  const currentFrame = frames[currentDay] || frames[0];
  const totalDays = Math.max(1, frames.length - 1);
  const colors = GRAPH_LINE_COLORS;

  // Dynamic plot container width tracking to perfectly align SVG coordinates with DOM slider thumb
  const plotContainerRef = React.useRef<HTMLDivElement>(null);
  const [plotWidth, setPlotWidth] = React.useState<number>(800);
  const [hiddenNodeIds, setHiddenNodeIds] = React.useState<Set<string>>(new Set());

  const toggleNodeVisibility = (nodeId: string) => {
    setHiddenNodeIds(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  };

  const handleLineClick = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const isCtrl = e.ctrlKey || e.metaKey;
    if (!setHighlightedNodeIds) return;

    setHighlightedNodeIds(prev => {
      if (isCtrl) {
        if (prev.includes(nodeId)) {
          return prev.filter(id => id !== nodeId);
        } else {
          return [...prev, nodeId];
        }
      } else {
        if (prev.length === 1 && prev[0] === nodeId) {
          return [];
        }
        return [nodeId];
      }
    });
  };

  React.useLayoutEffect(() => {
    if (!plotContainerRef.current) return;
    const updateWidth = () => {
      if (plotContainerRef.current) {
        const clientW = plotContainerRef.current.clientWidth;
        if (clientW > 0) {
          setPlotWidth(clientW);
        }
      }
    };
    updateWidth();
    const ro = new ResizeObserver(updateWidth);
    ro.observe(plotContainerRef.current);
    return () => ro.disconnect();
  }, [isGraphExpanded, isTimeGraphOpen, isCalendarOpen, calendarScrollbarWidth]);

  // Compute exact X coordinate for currentDay to match slider drag button center (8.5px inset)
  const THUMB_INSET = TIMELINE_THUMB_INSET;
  const currentX = THUMB_INSET + (totalDays > 0 ? (currentDay / totalDays) * Math.max(0, plotWidth - THUMB_INSET * 2) : 0);

  // Dynamic Volume Grid Scaling Calculation
  const recordedVolumes: number[] = [];
  frames.forEach(frame => {
    nodes.forEach(node => {
      const vol = frame.nodeVolumes?.[node.id];
      if (typeof vol === 'number' && !isNaN(vol)) {
        recordedVolumes.push(vol);
      }
    });
  });
  const maxRecorded = recordedVolumes.length > 0 ? Math.max(...recordedVolumes) : 0;
  const peakVolume = maxRecorded > 0 ? maxRecorded : Math.max(...nodes.map(n => n.currentVolume), 50000);

  const CANDIDATE_STEPS = [
    1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000,
    100000, 200000, 250000, 500000, 1000000
  ];

  const safePeak = Math.max(1000, peakVolume);
  let bestStep = CANDIDATE_STEPS[0];
  let bestDiff = Infinity;

  for (const step of CANDIDATE_STEPS) {
    const count = Math.ceil(safePeak / step);
    const diff = Math.abs(count - 4);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestStep = step;
    }
  }

  const stepCount = Math.max(2, Math.ceil(safePeak / bestStep));
  const dynamicCeiling = stepCount * bestStep;

  const ticks: number[] = [];
  for (let i = 0; i <= stepCount; i++) {
    ticks.push(i * bestStep);
  }

  const formatVolumeLabel = (val: number): string => {
    if (val === 0) return '0k';
    const kVal = val / 1000;
    return `${Number(kVal.toFixed(1))}k`;
  };

  const activeEventsToday = calendar.events.filter(
    evt => currentDay >= 1 && currentDay >= evt.startDay && currentDay <= evt.endDay
  ).length;

  const rightCompensation = isCalendarOpen ? calendarScrollbarWidth : 0;

  if (!isGraphExpanded) {
    return (
      <div
        onClick={() => setIsGraphExpanded(true)}
        style={{
          height: '46px',
          minHeight: '46px',
          backgroundColor: '#1e293b',
          borderTop: '2px solid #38bdf8',
          borderTopLeftRadius: '12px',
          borderTopRightRadius: '12px',
          boxShadow: '0 -4px 15px rgba(0, 0, 0, 0.4)',
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          padding: '0 20px',
          boxSizing: 'border-box',
          flexShrink: 0,
          zIndex: 30,
          cursor: 'pointer',
          userSelect: 'none'
        }}
        title="Click bar to expand Timeline & Calendar tray"
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsGraphExpanded(true);
          }}
          style={{
            background: 'none',
            border: 'none',
            color: '#f8fafc',
            fontSize: '12px',
            cursor: 'pointer',
            padding: '4px 8px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            lineHeight: 1
          }}
          title="Open Timeline & Calendar tray"
        >
          ▲
        </button>
        <span style={{ fontSize: '12px', fontWeight: 600, color: '#f8fafc', minWidth: '60px', fontVariantNumeric: 'tabular-nums' }}>
          Day {currentDay}
        </span>
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          style={{ flex: 1, display: 'flex', alignItems: 'center', cursor: 'default' }}
        >
          <input
            type="range"
            min="0"
            max={totalDays}
            value={currentDay}
            onChange={handleSliderChange}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            style={{ flex: 1, accentColor: '#22c55e', cursor: 'pointer', height: '6px' }}
          />
        </div>
        <span style={{ fontSize: '11px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
          Day {totalDays}
        </span>
        {calendar.events.length > 0 && (
          <span
            style={{
              fontSize: '10px',
              fontWeight: 600,
              color: '#38bdf8',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontVariantNumeric: 'tabular-nums'
            }}
          >
            {calendar.events.length} scheduled
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      style={{
        backgroundColor: '#1e293b',
        borderTop: '2px solid #38bdf8',
        borderTopLeftRadius: '12px',
        borderTopRightRadius: '12px',
        boxShadow: '0 -4px 15px rgba(0, 0, 0, 0.4)',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        maxHeight: '56vh',
        padding: '0 20px 10px 20px',
        boxSizing: 'border-box',
        zIndex: 30
      }}
    >
      {/* Top Outer Tray Bar */}
      <div
        onClick={() => setIsGraphExpanded(false)}
        style={{
          height: '38px',
          minHeight: '38px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          boxSizing: 'border-box',
          cursor: 'pointer',
          userSelect: 'none'
        }}
        title="Click header to collapse Timeline tray"
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsGraphExpanded(false);
            }}
            style={{
              background: 'none',
              border: 'none',
              color: '#f8fafc',
              fontSize: '12px',
              cursor: 'pointer',
              padding: '4px 6px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              lineHeight: 1
            }}
            title="Collapse Timeline tray"
          >
            ▼
          </button>
          <span style={{ fontSize: '11px', fontWeight: 700, color: '#38bdf8', textTransform: 'uppercase', letterSpacing: '0.9px' }}>
            TIMELINE WORKSPACE
          </span>

          {/* Quick Sub-Drawer Toggles */}
          <div
            onClick={e => e.stopPropagation()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', marginLeft: '8px' }}
          >
            <button
              type="button"
              onClick={() => setIsTimeGraphOpen(v => !v)}
              style={{
                height: '22px',
                padding: '0 8px',
                borderRadius: '4px',
                border: isTimeGraphOpen ? '1px solid #38bdf8' : '1px solid #334155',
                backgroundColor: isTimeGraphOpen ? 'rgba(56, 189, 248, 0.14)' : '#0f172a',
                color: isTimeGraphOpen ? '#38bdf8' : '#94a3b8',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.4px',
                textTransform: 'uppercase',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <span>{isTimeGraphOpen ? '▾' : '▸'}</span>
              <span>Time Graph</span>
            </button>
            <button
              type="button"
              onClick={() => setIsCalendarOpen(v => !v)}
              style={{
                height: '22px',
                padding: '0 8px',
                borderRadius: '4px',
                border: isCalendarOpen ? '1px solid #38bdf8' : '1px solid #334155',
                backgroundColor: isCalendarOpen ? 'rgba(56, 189, 248, 0.14)' : '#0f172a',
                color: isCalendarOpen ? '#38bdf8' : '#94a3b8',
                fontSize: '10px',
                fontWeight: 700,
                letterSpacing: '0.4px',
                textTransform: 'uppercase',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px'
              }}
            >
              <span>{isCalendarOpen ? '▾' : '▸'}</span>
              <span>Calendar</span>
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '11px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
          {currentDay >= 1 && activeEventsToday > 0 && (
            <span style={{ color: '#f59e0b', fontWeight: 600 }}>
              {activeEventsToday} active override{activeEventsToday > 1 ? 's' : ''}
            </span>
          )}
          <span>
            Active Day: <strong style={{ color: '#f8fafc' }}>Day {currentDay}</strong> / {totalDays}
          </span>
        </div>
      </div>

      {/* Stacked Collapsible Sub-Drawers */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* Sub-Drawer 1: Time Graph (Container Volume Telemetry) */}
        <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
          <div
            onClick={() => setIsTimeGraphOpen(v => !v)}
            style={{
              height: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 2px',
              cursor: 'pointer',
              userSelect: 'none',
              borderTop: '1px solid #334155'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '10px', color: '#94a3b8' }}>{isTimeGraphOpen ? '▾' : '▸'}</span>
              <span style={{ fontSize: '10px', fontWeight: 700, color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: '0.7px' }}>
                Time Graph — Container Volume Telemetry
              </span>
            </div>
            <span style={{ fontSize: '10px', color: '#64748b' }}>
              {isTimeGraphOpen ? 'Click to collapse' : 'Collapsed'}
            </span>
          </div>

          {isTimeGraphOpen && (
            <div
              style={{
                display: 'flex',
                height: isCalendarOpen ? '156px' : '190px',
                minHeight: isCalendarOpen ? '156px' : '190px',
                gap: '16px',
                paddingRight: `${rightCompensation}px`,
                boxSizing: 'border-box'
              }}
            >
              {/* Left Legend / Series Info (220px) */}
              <div style={{ width: '220px', minWidth: '220px', backgroundColor: '#0f172a', borderRadius: '4px', padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: '4px', overflowY: 'auto', border: '1px solid #334155', boxSizing: 'border-box' }}>
                <div style={{ fontSize: '10px', fontWeight: 'bold', color: '#94a3b8', textTransform: 'uppercase', borderBottom: '1px solid #1e293b', paddingBottom: '3px' }}>
                  Series Legend & Volumes
                </div>
                {nodes.map((node, idx) => {
                  const color = colors[idx % colors.length];
                  const liveVol = currentFrame ? Math.round(currentFrame.nodeVolumes[node.id] ?? node.currentVolume) : node.currentVolume;
                  const isVisible = !hiddenNodeIds.has(node.id);
                  const isHighlighted = highlightedNodeIds.includes(node.id);
                  return (
                    <div
                      key={node.id}
                      onClick={(e) => {
                        if (e.ctrlKey || e.metaKey) {
                          handleLineClick(node.id, e);
                        } else {
                          toggleNodeVisibility(node.id);
                        }
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        fontSize: '11px',
                        cursor: 'pointer',
                        userSelect: 'none',
                        padding: '2px 5px',
                        borderRadius: '4px',
                        transition: 'background-color 0.15s ease, opacity 0.15s ease',
                        backgroundColor: isHighlighted ? 'rgba(56, 189, 248, 0.15)' : 'transparent',
                        border: isHighlighted ? '1px solid rgba(56, 189, 248, 0.35)' : '1px solid transparent'
                      }}
                      onMouseEnter={(e) => {
                        if (!isHighlighted) e.currentTarget.style.backgroundColor = '#1e293b';
                      }}
                      onMouseLeave={(e) => {
                        if (!isHighlighted) e.currentTarget.style.backgroundColor = 'transparent';
                      }}
                      title={`Click to toggle ${node.name} on graph, Ctrl+Click to highlight`}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
                        <span
                          style={{
                            width: '8px',
                            height: '8px',
                            backgroundColor: isVisible ? color : '#475569',
                            borderRadius: '2px',
                            flexShrink: 0,
                            boxShadow: isHighlighted ? `0 0 0 2px ${color}` : 'none',
                            transition: 'background-color 0.15s ease'
                          }}
                        />
                        <span
                          style={{
                            color: isVisible ? (isHighlighted ? '#38bdf8' : '#f8fafc') : '#64748b',
                            fontWeight: isHighlighted ? 700 : 400,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: '100px',
                            transition: 'color 0.15s ease'
                          }}
                          title={node.name}
                        >
                          {node.name}
                        </span>
                      </div>
                      <span
                        style={{
                          color: isVisible ? '#38bdf8' : '#475569',
                          fontWeight: isHighlighted ? 800 : 'bold',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontVariantNumeric: 'tabular-nums',
                          transition: 'color 0.15s ease'
                        }}
                      >
                        {liveVol.toLocaleString()} m³
                      </span>
                    </div>
                  );
                })}
              </div>

              {/* Right SVG Plot Area */}
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 0,
                  position: 'relative',
                  backgroundColor: '#0f172a',
                  borderRadius: '4px',
                  padding: '6px 12px 6px 4px',
                  boxSizing: 'border-box',
                  border: '1px solid #334155',
                  display: 'flex'
                }}
              >
                {/* Left Volume Labels Column (48px wide) */}
                <div style={{ width: '48px', minWidth: '48px', maxWidth: '48px', flexShrink: 0, position: 'relative', height: '100%', userSelect: 'none' }}>
                  {ticks.map(tickVal => {
                    const yFrac = (dynamicCeiling - tickVal) / dynamicCeiling;
                    const svgY = 10 + yFrac * 140;
                    const topPct = (svgY / 160) * 100;
                    return (
                      <div
                        key={tickVal}
                        style={{
                          position: 'absolute',
                          top: `${topPct}%`,
                          right: '8px',
                          transform: 'translateY(-50%)',
                          fontSize: '10px',
                          color: tickVal === 0 ? '#64748b' : '#94a3b8',
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: 600,
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {formatVolumeLabel(tickVal)}
                      </div>
                    );
                  })}
                </div>

                {/* SVG Plot */}
                <div ref={plotContainerRef} style={{ flex: 1, minHeight: 0, position: 'relative', height: '100%', overflow: 'hidden' }}>
                  <svg
                    width="100%"
                    height="100%"
                    viewBox={`0 0 ${plotWidth} 160`}
                    preserveAspectRatio="none"
                    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'block' }}
                    onClick={() => {
                      if (setHighlightedNodeIds) {
                        setHighlightedNodeIds([]);
                      }
                    }}
                  >
                    {ticks.map(tickVal => {
                      const yFrac = (dynamicCeiling - tickVal) / dynamicCeiling;
                      const svgY = 10 + yFrac * 140;
                      return (
                        <line
                          key={tickVal}
                          x1="0"
                          y1={svgY}
                          x2={plotWidth}
                          y2={svgY}
                          stroke={tickVal === 0 ? '#475569' : '#334155'}
                          strokeWidth={tickVal === 0 ? '1.2' : '1'}
                          strokeOpacity={tickVal === 0 ? '0.9' : '0.7'}
                          vectorEffect="non-scaling-stroke"
                        />
                      );
                    })}

                    {nodes.map((node, idx) => {
                      if (hiddenNodeIds.has(node.id)) return null;
                      const color = colors[idx % colors.length];
                      const isHighlighted = highlightedNodeIds.includes(node.id);

                      const points = frames.map((frame, fIdx) => {
                        const x = THUMB_INSET + (totalDays > 0 ? (fIdx / totalDays) * Math.max(0, plotWidth - THUMB_INSET * 2) : 0);
                        const vol = frame.nodeVolumes?.[node.id] ?? 0;
                        const clampedVol = Math.max(0, vol);
                        const y = 150 - (clampedVol / dynamicCeiling) * 140;
                        return `${x.toFixed(1)},${y.toFixed(1)}`;
                      }).join(' ');

                      return (
                        <g key={node.id}>
                          {isHighlighted && (
                            <polyline
                              fill="none"
                              stroke={color}
                              strokeWidth="13"
                              strokeOpacity="0.42"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              vectorEffect="non-scaling-stroke"
                              points={points}
                            />
                          )}
                          <polyline
                            fill="none"
                            stroke={color}
                            strokeWidth={isHighlighted ? '3' : '2.5'}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                            points={points}
                            style={{ transition: 'stroke-width 0.15s ease' }}
                          />
                          <polyline
                            fill="none"
                            stroke="transparent"
                            strokeWidth="18"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                            points={points}
                            style={{ cursor: 'pointer' }}
                            onClick={(e) => handleLineClick(node.id, e)}
                          >
                            <title>{`${node.name} (Click to highlight, Ctrl+Click to toggle multiple)`}</title>
                          </polyline>
                        </g>
                      );
                    })}

                    <line
                      x1={currentX}
                      y1="0"
                      x2={currentX}
                      y2="160"
                      stroke="#22c55e"
                      strokeWidth="1"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Sub-Drawer 2: Calendar (Gantt Event Schedule) */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: isCalendarOpen ? 1 : '0 0 auto',
            minHeight: 0,
            overflow: 'hidden'
          }}
        >
          <div
            onClick={() => setIsCalendarOpen(v => !v)}
            style={{
              height: '24px',
              minHeight: '24px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 2px',
              cursor: 'pointer',
              userSelect: 'none',
              borderTop: '1px solid #334155'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '10px', color: '#94a3b8' }}>{isCalendarOpen ? '▾' : '▸'}</span>
              <span style={{ fontSize: '10px', fontWeight: 700, color: '#cbd5e1', textTransform: 'uppercase', letterSpacing: '0.7px' }}>
                Calendar — Event Schedule Gantt
              </span>
              {isCalendarOpen && !isPlayback && (
                <span style={{ fontSize: '10px', color: '#64748b' }}>
                  Drag on day cells to draw · Click bar to edit in inspector
                </span>
              )}
              {isCalendarOpen && isPlayback && (
                <span style={{ fontSize: '10px', color: '#64748b' }}>
                  Read-only in Playback · Click bar to inspect
                </span>
              )}
            </div>
            <span style={{ fontSize: '10px', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
              {isCalendarOpen ? `${calendar.events.length} event${calendar.events.length === 1 ? '' : 's'}` : 'Collapsed'}
            </span>
          </div>

          {isCalendarOpen && (
            <div
              style={{
                flex: 1,
                minHeight: '140px',
                maxHeight: isTimeGraphOpen ? '220px' : '310px',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden'
              }}
            >
              <CalendarGantt
                nodes={nodes}
                links={links}
                corridors={corridors}
                calendar={calendar}
                totalDays={totalDays}
                currentDay={currentDay}
                isPlayback={isPlayback}
                selectedCalendarEventId={selectedCalendarEventId}
                selectedNodeIds={selectedNodeIds}
                selectedLinkIds={selectedLinkIds}
                selectedCorridorIds={selectedCorridorIds}
                onSelectCalendarEvent={onSelectCalendarEvent}
                onSelectTargetElement={onSelectTargetElement}
                onAddCalendarEvent={onAddCalendarEvent}
                onUpdateCalendarEvent={onUpdateCalendarEvent}
                onScrubDay={handleScrubDay}
                onScrollbarWidthChange={setCalendarScrollbarWidth}
              />
            </div>
          )}
        </div>
      </div>

      {/* Shared Common Bottom Time-Dragger (Scrubber) Aligned Pixel-for-Pixel with Both Sub-Drawers */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '16px',
          marginTop: '8px',
          paddingTop: '6px',
          borderTop: '1px solid #334155',
          paddingRight: `${rightCompensation}px`,
          boxSizing: 'border-box',
          flexShrink: 0
        }}
      >
        {/* Left 220px active day readout */}
        <div
          style={{
            width: '220px',
            minWidth: '220px',
            maxWidth: '220px',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 4px',
            boxSizing: 'border-box',
            fontSize: '11px',
            color: '#94a3b8'
          }}
        >
          <span style={{ fontWeight: 600, color: '#cbd5e1' }}>Simulation Day</span>
          <span
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontVariantNumeric: 'tabular-nums',
              fontWeight: 700,
              color: '#22c55e'
            }}
          >
            Day {currentDay} / {totalDays}
          </span>
        </div>

        {/* Right scrubber aligned to exact border + padding + 48px gutter of both plots */}
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            padding: '0 13px 0 5px', // 12px/4px padding + 1px border compensation
            boxSizing: 'border-box'
          }}
        >
          <div style={{ width: '48px', minWidth: '48px', maxWidth: '48px', flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <input
              type="range"
              min="0"
              max={totalDays}
              value={currentDay}
              onChange={handleSliderChange}
              style={{
                width: '100%',
                accentColor: '#22c55e',
                cursor: 'pointer',
                height: '6px',
                margin: 0,
                padding: 0,
                display: 'block',
                boxSizing: 'border-box'
              }}
            />
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '9px',
                color: '#94a3b8',
                padding: '0 4px',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontVariantNumeric: 'tabular-nums',
                boxSizing: 'border-box'
              }}
            >
              <span>Day 0</span>
              <span>Day {Math.round(totalDays / 2)}</span>
              <span>Day {totalDays}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};