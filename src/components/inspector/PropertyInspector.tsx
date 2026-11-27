import React from 'react';
import {
  ContainerNode,
  TransferLink,
  RouteCorridor,
  CalendarModel,
  CalendarEvent,
  CalendarEventState,
  CalendarTargetType,
  SimFrame,
  MaterialDefinition,
  OverflowMode,
  StrictSubRule,
  LinkRole,
  DiversionTrigger,
  ClipboardData,
  ProjectSettings,
  SimSettings,
  getLinkCorridorIds,
  getLinkBackupCorridorIds,
  getLinkRole
} from '../../models/types';
import {
  dateISOToDayIndex,
  dayIndexToDateISO,
  formatFullDateWithWeekday,
  formatShortDate
} from '../../utils/dateUtils';
import { CanvasViewModel } from '../../viewmodel/CanvasViewModel';
import { resolveOrderedCorridorChain } from '../canvas/pipeRouter';
import { MaterialDrawer } from './MaterialDrawer';

interface PropertyInspectorProps {
  vm: CanvasViewModel;
  isPlayback: boolean;
  currentDay: number;
  totalDays: number;
  projectSettings: ProjectSettings;
  simSettings: SimSettings;
  currentFrame: SimFrame;
  selectedNodeIds: string[];
  selectedLinkIds: string[];
  selectedCorridorIds: string[];
  singleSelectedNode: ContainerNode | undefined;
  selectedLink: TransferLink | undefined;
  selectedCorridor: RouteCorridor | undefined;
  calendar: CalendarModel;
  selectedCalendarEvent: CalendarEvent | undefined;
  corridors: RouteCorridor[];
  links: TransferLink[];
  nodes: ContainerNode[];
  hasSelection: boolean;
  canSetLanes: boolean;
  canUnlinkLanes: boolean;
  materials: MaterialDefinition[];
  clipboard: ClipboardData | null;
  onCopy: () => void;
  onPaste: () => void;
  onClearClipboard: () => void;
  onUpdateSingleNode: (field: keyof ContainerNode, val: any) => void;
  onUpdateNodeById?: (nodeId: string, updates: Partial<ContainerNode>) => void;
  onUpdateLink: (field: keyof TransferLink, val: any) => void;
  onUpdateLinkFields?: (linkId: string, updates: Partial<TransferLink>) => void;
  onUpdateCorridor: (field: keyof RouteCorridor, val: any) => void;
  onUpdateCalendarEvent: (eventId: string, updates: Partial<CalendarEvent>) => void;
  onDeleteCalendarEvent: (eventId: string) => void;
  onSelectTargetElement: (targetType: CalendarTargetType, targetId: string) => void;
  onToggleLinkCorridor: (linkId: string, corridorId: string, assign: boolean) => void;
  onToggleLinkBackupCorridor: (linkId: string, corridorId: string, assign: boolean) => void;
  onSetRouteLanes: () => void;
  onUnlinkLanes: () => void;
  onDeleteSelected: () => void;
  onClearSelection: () => void;
  onMaterialsUpdated: () => void;
  onOpenExportModal?: () => void;
}

export const PropertyInspector: React.FC<PropertyInspectorProps> = ({
  vm,
  isPlayback,
  currentDay,
  totalDays,
  projectSettings,
  simSettings,
  currentFrame,
  selectedNodeIds,
  selectedLinkIds,
  selectedCorridorIds,
  singleSelectedNode,
  selectedLink,
  selectedCorridor,
  calendar,
  selectedCalendarEvent,
  corridors,
  links,
  nodes,
  hasSelection,
  canSetLanes,
  canUnlinkLanes,
  materials,
  clipboard,
  onCopy,
  onPaste,
  onClearClipboard,
  onUpdateSingleNode,
  onUpdateNodeById,
  onUpdateLink,
  onUpdateLinkFields,
  onUpdateCorridor,
  onUpdateCalendarEvent,
  onDeleteCalendarEvent,
  onSelectTargetElement,
  onToggleLinkCorridor,
  onToggleLinkBackupCorridor,
  onSetRouteLanes,
  onUnlinkLanes,
  onDeleteSelected,
  onClearSelection,
  onMaterialsUpdated,
}) => {
  const [showSiteAudit, setShowSiteAudit] = React.useState(false);
  const [showContainerAudit, setShowContainerAudit] = React.useState(true);
  const [showLinkAudit, setShowLinkAudit] = React.useState(true);

  const isCalendarEventSelected = Boolean(selectedCalendarEvent);
  const isPureNode = !isCalendarEventSelected && selectedNodeIds.length > 0 && selectedLinkIds.length === 0 && selectedCorridorIds.length === 0;
  const isPureSingleLink = !isCalendarEventSelected && selectedNodeIds.length === 0 && selectedLinkIds.length === 1 && selectedCorridorIds.length === 0;
  const isPureSingleCorridor = !isCalendarEventSelected && selectedNodeIds.length === 0 && selectedLinkIds.length === 0 && selectedCorridorIds.length === 1;
  const isMixedOrMultiOther = !isCalendarEventSelected && hasSelection && !isPureNode && !isPureSingleLink && !isPureSingleCorridor;

  const getCalendarTargetInfo = (evt: CalendarEvent): { typeLabel: string; name: string; baseSummary: string } => {
    if (evt.targetType === 'global') {
      return {
        typeLabel: 'Global / Site',
        name: 'Site-Wide Schedule & Weather',
        baseSummary: 'Applies across all site containers and transfers'
      };
    }
    if (evt.targetType === 'container') {
      const node = nodes.find(n => n.id === evt.targetId);
      const baseStatus = node?.status || 'active';
      return {
        typeLabel: 'Container',
        name: node?.name || evt.targetId,
        baseSummary: `Default: ${baseStatus === 'active' ? 'Open' : baseStatus}`
      };
    }
    if (evt.targetType === 'transfer') {
      const link = links.find(l => l.id === evt.targetId);
      const src = link ? nodes.find(n => n.id === link.sourceId) : undefined;
      const tgt = link ? nodes.find(n => n.id === link.targetId) : undefined;
      return {
        typeLabel: 'Transfer',
        name: link ? `${src?.name || link.sourceId} → ${tgt?.name || link.targetId}` : evt.targetId,
        baseSummary: link ? `Stated rate: ${Math.round(link.dailyRate).toLocaleString()} m³/d` : ''
      };
    }
    const corridor = corridors.find(c => c.id === evt.targetId);
    const assignedLinks = links.filter(l => getLinkCorridorIds(l).includes(evt.targetId));
    const combinedRate = assignedLinks.reduce((sum, l) => sum + (l.dailyRate || 0), 0);
    const baseCapNote =
      corridor?.maxDailyRate !== undefined && Number.isFinite(corridor.maxDailyRate)
        ? ` · Base cap ${Math.round(corridor.maxDailyRate).toLocaleString()} m³/d`
        : '';
    return {
      typeLabel: 'Route Corridor',
      name: corridor?.name || evt.targetId,
      baseSummary: `${assignedLinks.length} transfer${assignedLinks.length === 1 ? '' : 's'} · ${Math.round(combinedRate).toLocaleString()} m³/d combined${baseCapNote}`
    };
  };

  const getActiveCalendarEventForTarget = (targetType: CalendarTargetType, targetId: string): CalendarEvent | undefined => {
    if (currentDay < 1) return undefined;
    return calendar.events.find(
      e => e.targetType === targetType && e.targetId === targetId && currentDay >= e.startDay && currentDay <= e.endDay
    );
  };

  const getClampedDayRange = (evt: CalendarEvent, desiredStart: number, desiredEnd: number): { startDay: number; endDay: number } => {
    const others = calendar.events.filter(
      e => e.id !== evt.id && e.targetType === evt.targetType && e.targetId === evt.targetId
    );
    const prevEnd = others.reduce(
      (maxEnd, o) => (o.endDay < evt.startDay ? Math.max(maxEnd, o.endDay) : maxEnd),
      0
    );
    const nextStart = others.reduce(
      (minStart, o) => (o.startDay > evt.endDay ? Math.min(minStart, o.startDay) : minStart),
      totalDays + 1
    );
    const minAllowed = prevEnd + 1;
    const maxAllowed = Math.min(totalDays, nextStart - 1);
    const s = Math.max(minAllowed, Math.min(maxAllowed, Math.round(desiredStart)));
    const e = Math.max(s, Math.min(maxAllowed, Math.round(desiredEnd)));
    return { startDay: s, endDay: e };
  };

  const selectedKind: 'container' | 'link' | 'none' = 
    isPureNode ? 'container' :
    isPureSingleLink ? 'link' :
    'none';

  const isClipboardInUse = clipboard !== null;
  const isWrongKind = isClipboardInUse && selectedKind !== 'none' && selectedKind !== clipboard.type;

  const canCopy = !isPlayback && selectedKind !== 'none' && (!isClipboardInUse || !isWrongKind);
  const canPaste = !isPlayback && isClipboardInUse && selectedKind === clipboard.type;

  const copyTooltip = isPlayback
    ? 'Copy is disabled during playback'
    : selectedKind === 'none'
    ? 'Select a container or transfer link to copy properties (Ctrl+C)'
    : isClipboardInUse && isWrongKind
    ? `Copy disabled: Clipboard contains ${clipboard.type === 'container' ? 'Container' : 'Transfer Link'} properties. Clear clipboard or select a matching element.`
    : `Copy properties of selected ${selectedKind === 'container' ? 'container' : 'transfer link'} (Ctrl+C)`;

  const pasteTooltip = isPlayback
    ? 'Paste is disabled during playback'
    : !isClipboardInUse
    ? 'Clipboard is empty. Copy properties first (Ctrl+C)'
    : selectedKind === 'none'
    ? `Select target ${clipboard.type === 'container' ? 'container(s)' : 'transfer link'} to paste properties (Ctrl+V)`
    : isWrongKind
    ? `Paste disabled: Clipboard contains ${clipboard.type === 'container' ? 'Container' : 'Transfer Link'} properties, but selected element is a ${selectedKind === 'container' ? 'Container' : 'Transfer Link'}.`
    : `Paste copied ${clipboard.type === 'container' ? 'container' : 'transfer link'} properties into selected element(s) (Ctrl+V)`;

  return (
    <div style={{ flex: 1, backgroundColor: '#1e293b', borderLeft: '1px solid #334155', display: 'flex', flexDirection: 'column', color: '#f8fafc', boxSizing: 'border-box', overflow: 'hidden', minWidth: '320px', height: '100%', minHeight: 0, position: 'relative' }}>
      
      {/* Header with Title and Copy/Paste Actions */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        padding: '20px 20px 12px 20px',
        borderBottom: '1px solid #334155',
        minHeight: '36px',
        flexShrink: 0,
        boxSizing: 'border-box'
      }}>
        <div style={{
          fontSize: '13px',
          fontWeight: 700,
          letterSpacing: '0.8px',
          color: '#38bdf8',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis'
        }}>
          {isPlayback ? `Telemetry (Day ${currentDay})` : 'Property Inspector'}
        </div>

        {!isPlayback && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            {/* Clipboard Status Indicator */}
            {clipboard && (
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px',
                  backgroundColor: '#0f172a',
                  border: '1px solid #334155',
                  borderRadius: '4px',
                  padding: '3px 6px',
                  fontSize: '10px',
                  color: '#94a3b8'
                }}
                title={`Clipboard: ${clipboard.type === 'container' ? 'Container' : 'Link'} properties from "${clipboard.sourceName}"`}
              >
                <span style={{ color: '#38bdf8', fontWeight: 600 }}>
                  {clipboard.type === 'container' ? 'Container' : 'Link'}
                </span>
                <button
                  type="button"
                  onClick={onClearClipboard}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: '#64748b',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: '11px',
                    lineHeight: 1,
                    display: 'flex',
                    alignItems: 'center'
                  }}
                  title="Clear clipboard"
                  onMouseEnter={e => (e.currentTarget.style.color = '#ef4444')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#64748b')}
                >
                  ✕
                </button>
              </div>
            )}

            {/* Copy Button */}
            <button
              type="button"
              onClick={onCopy}
              disabled={!canCopy}
              title={copyTooltip}
              style={{
                height: '28px',
                padding: '0 8px',
                backgroundColor: canCopy ? '#334155' : 'rgba(15, 23, 42, 0.6)',
                border: canCopy ? '1px solid #475569' : '1px solid rgba(51, 65, 85, 0.4)',
                borderRadius: '5px',
                color: canCopy ? '#f8fafc' : '#64748b',
                fontSize: '11px',
                fontWeight: 600,
                cursor: canCopy ? 'pointer' : 'not-allowed',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                transition: 'all 0.15s ease',
                opacity: canCopy ? 1 : 0.45
              }}
              onMouseEnter={e => {
                if (canCopy) {
                  e.currentTarget.style.borderColor = '#38bdf8';
                  e.currentTarget.style.color = '#38bdf8';
                  e.currentTarget.style.backgroundColor = '#1e293b';
                }
              }}
              onMouseLeave={e => {
                if (canCopy) {
                  e.currentTarget.style.borderColor = '#475569';
                  e.currentTarget.style.color = '#f8fafc';
                  e.currentTarget.style.backgroundColor = '#334155';
                }
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <span>Copy</span>
              <span style={{ fontSize: '9px', opacity: 0.7, padding: '1px 3px', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: '3px' }}>^C</span>
            </button>

            {/* Paste Button */}
            <button
              type="button"
              onClick={onPaste}
              disabled={!canPaste}
              title={pasteTooltip}
              style={{
                height: '28px',
                padding: '0 8px',
                backgroundColor: canPaste ? '#334155' : 'rgba(15, 23, 42, 0.6)',
                border: canPaste ? '1px solid #475569' : '1px solid rgba(51, 65, 85, 0.4)',
                borderRadius: '5px',
                color: canPaste ? '#f8fafc' : '#64748b',
                fontSize: '11px',
                fontWeight: 600,
                cursor: canPaste ? 'pointer' : 'not-allowed',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                transition: 'all 0.15s ease',
                opacity: canPaste ? 1 : 0.45
              }}
              onMouseEnter={e => {
                if (canPaste) {
                  e.currentTarget.style.borderColor = '#22c55e';
                  e.currentTarget.style.color = '#22c55e';
                  e.currentTarget.style.backgroundColor = '#1e293b';
                }
              }}
              onMouseLeave={e => {
                if (canPaste) {
                  e.currentTarget.style.borderColor = '#475569';
                  e.currentTarget.style.color = '#f8fafc';
                  e.currentTarget.style.backgroundColor = '#334155';
                }
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
              </svg>
              <span>Paste</span>
              <span style={{ fontSize: '9px', opacity: 0.7, padding: '1px 3px', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: '3px' }}>^V</span>
            </button>
          </div>
        )}
      </div>

      {/* Scrollable Inspector Body (stays strictly above the anchored MaterialDrawer) */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '16px 20px 20px 20px', boxSizing: 'border-box' }}>
      {isPlayback ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {(() => {
            const currentDateISO =
              currentFrame?.dateISO ||
              (currentDay >= 1 ? dayIndexToDateISO(projectSettings.startDate, currentDay) : projectSettings.startDate);
            const dateLabel =
              currentDay === 0
                ? `Baseline (${formatShortDate(projectSettings.startDate)})`
                : formatFullDateWithWeekday(currentDateISO);
            const audit = currentFrame?.dayAudit;
            const totalMovedToday = Object.values(currentFrame?.linkFlows || {}).reduce((s, v) => s + v, 0);
            const haulPct = Math.round((currentFrame?.globalHaulMultiplier ?? 1) * 100);
            return (
              <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>TIMELINE STATUS</span>
                  {currentDay >= 1 && (
                    <span style={{ fontSize: '10px', fontWeight: 700, color: currentFrame?.isWorkingDay === false ? '#ef4444' : '#22c55e' }}>
                      {currentFrame?.isWorkingDay === false ? 'NON-WORKING' : 'WORKING DAY'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#22c55e', fontVariantNumeric: 'tabular-nums' }}>
                  Day {currentDay} of {totalDays}
                </div>
                <div style={{ fontSize: '11px', color: '#cbd5e1', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums' }}>
                  {dateLabel}
                </div>
                {currentDay >= 1 && currentFrame?.nonWorkingReason && (
                  <div style={{ fontSize: '11px', color: '#fca5a5' }}>
                    Reason: {currentFrame.nonWorkingReason}
                  </div>
                )}
                {currentDay >= 1 && haulPct !== 100 && (
                  <div style={{ fontSize: '11px', color: '#fde68a', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    Global Haul Modifier: {haulPct}%
                  </div>
                )}
                {audit && audit.activeGlobalLabels.length > 0 && (
                  <div style={{ fontSize: '11px', color: '#38bdf8' }}>
                    Global: {audit.activeGlobalLabels.join(' · ')}
                  </div>
                )}
                {audit && audit.activeBulkingSummary.length > 0 && (
                  <div style={{ fontSize: '10px', color: '#c7d2fe', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    Bulking: {audit.activeBulkingSummary.join(' · ')}
                  </div>
                )}

                {/* Collapsible Site Day Math Audit */}
                <button
                  type="button"
                  onClick={() => setShowSiteAudit(v => !v)}
                  style={{
                    marginTop: '4px',
                    alignSelf: 'flex-start',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    color: '#38bdf8',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  {showSiteAudit ? '▾ Hide Day Math Summary' : '▸ Show Day Math Summary'}
                </button>
                {showSiteAudit && (
                  <div style={{ backgroundColor: '#0b1120', border: '1px solid #1e293b', borderRadius: '4px', padding: '8px 9px', fontSize: '10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums', color: '#cbd5e1', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#94a3b8' }}>Total Site Flow:</span>
                      <span style={{ color: '#22c55e', fontWeight: 700 }}>{Math.round(totalMovedToday).toLocaleString()} m³</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#94a3b8' }}>Allocation:</span>
                      <span>{simSettings.allocationPolicy}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#94a3b8' }}>Partial Delivery:</span>
                      <span>
                        {simSettings.partialDeliveryPolicy === 'discrete_loads'
                          ? `discrete (${simSettings.truckPayloadM3} m³)`
                          : simSettings.partialDeliveryPolicy === 'min_batch'
                          ? `min batch (${simSettings.minBatchPct}%)`
                          : 'continuous'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#94a3b8' }}>Same-Day Drainage:</span>
                      <span>{simSettings.sameDayDrainageCredit ? 'credited' : 'conservative'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#94a3b8' }}>Bulking Mode:</span>
                      <span>{simSettings.bulkingMode === 'bank_volume_only' ? '1.0 neutral' : 'strict IN/OUT'}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ color: '#94a3b8' }}>Diversion Order:</span>
                      <span>{simSettings.diversionOrder === 'standby_link_first' ? 'standby first' : 'backup route first'}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Selected Calendar Event Read-Only Inspection in Playback */}
          {selectedCalendarEvent && (() => {
            const info = getCalendarTargetInfo(selectedCalendarEvent);
            const isActiveToday =
              currentDay >= 1 &&
              currentDay >= selectedCalendarEvent.startDay &&
              currentDay <= selectedCalendarEvent.endDay;
            const startIso = dayIndexToDateISO(projectSettings.startDate, selectedCalendarEvent.startDay);
            const endIso = dayIndexToDateISO(projectSettings.startDate, selectedCalendarEvent.endDay);
            return (
              <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: '#38bdf8', fontWeight: 700, textTransform: 'uppercase' }}>
                    CALENDAR EVENT ({info.typeLabel})
                  </span>
                  <span style={{ fontSize: '10px', fontWeight: 700, color: isActiveToday ? '#22c55e' : '#64748b' }}>
                    {isActiveToday ? 'ACTIVE TODAY' : 'INACTIVE'}
                  </span>
                </div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#f8fafc' }}>{selectedCalendarEvent.label || info.name}</div>
                {selectedCalendarEvent.notes && (
                  <div style={{ padding: '8px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid #334155', fontSize: '11px', color: '#cbd5e1' }}>
                    <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>DESCRIPTION</div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{selectedCalendarEvent.notes}</div>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                  <span>Schedule Window:</span>
                  <span style={{ fontWeight: 600 }}>D{selectedCalendarEvent.startDay}–D{selectedCalendarEvent.endDay} ({formatShortDate(startIso)}–{formatShortDate(endIso)})</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1' }}>
                  <span>State Override:</span>
                  <span style={{ fontWeight: 700, textTransform: 'uppercase', color: selectedCalendarEvent.state === 'blocked' || selectedCalendarEvent.state === 'stopped' || selectedCalendarEvent.state === 'site_shutdown' ? '#ef4444' : selectedCalendarEvent.state === 'restricted' || selectedCalendarEvent.state === 'variable' || selectedCalendarEvent.state === 'weather_haul' || selectedCalendarEvent.state === 'combined_weather' ? '#f59e0b' : selectedCalendarEvent.state === 'weather_bulking' ? '#818cf8' : '#22c55e' }}>
                    {selectedCalendarEvent.state.replace(/_/g, ' ')}
                  </span>
                </div>
                {(selectedCalendarEvent.state === 'variable' || selectedCalendarEvent.state === 'restricted') && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                    <span>{selectedCalendarEvent.state === 'restricted' ? 'Combined Cap:' : 'Target Rate:'}</span>
                    <span style={{ fontWeight: 600 }}>{Math.round(selectedCalendarEvent.rateValue ?? 0).toLocaleString()} m³/d</span>
                  </div>
                )}
                {(selectedCalendarEvent.state === 'weather_haul' || selectedCalendarEvent.state === 'combined_weather') && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                    <span>Haul Rate Modifier:</span>
                    <span style={{ fontWeight: 600 }}>{Math.round(selectedCalendarEvent.haulRatePct ?? 50)}%</span>
                  </div>
                )}
                {(selectedCalendarEvent.state === 'weather_bulking' || selectedCalendarEvent.state === 'combined_weather') && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                    <span>Bulking Multipliers:</span>
                    <span style={{ fontWeight: 600 }}>IN ×{(selectedCalendarEvent.bulkInMultiplier ?? 1).toFixed(2)} · OUT ×{(selectedCalendarEvent.bulkOutMultiplier ?? 1).toFixed(2)}</span>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Selected Container Live Telemetry */}
          {selectedNodeIds.length === 1 && singleSelectedNode && (() => {
            const liveVol = currentFrame ? (currentFrame.nodeVolumes[singleSelectedNode.id] ?? singleSelectedNode.currentVolume) : singleSelectedNode.currentVolume;
            const nodeStatus = currentFrame?.nodeStatuses?.[singleSelectedNode.id] ?? 'frozen';
            const activeCalEvt = getActiveCalendarEventForTarget('container', singleSelectedNode.id);
            const isOverfilled =
              singleSelectedNode.type !== 'external' &&
              singleSelectedNode.type !== 'null' &&
              liveVol > singleSelectedNode.capacity + 1e-6;
            const blockedLabel = isOverfilled
              ? 'Overfill Exceeded Capacity'
              : activeCalEvt?.state === 'blocked' || (activeCalEvt?.state === 'restricted' && (activeCalEvt.rateValue ?? 0) <= 0)
              ? 'Blocked (Calendar Event)'
              : singleSelectedNode.status === 'blocked' || singleSelectedNode.status === 'maintenance'
              ? `Blocked (${singleSelectedNode.status === 'maintenance' ? 'Maintenance' : 'Static Status'})`
              : 'Blocked (Capacity Constraint)';
            const overflowOut = currentFrame?.overflowActiveNodes?.[singleSelectedNode.id] ?? 0;
            const statusConfig = {
              full: { label: 'Flowing at Full Rate', color: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)', border: '#22c55e' },
              diverted: { label: overflowOut > 0 ? 'Transfer-Through Active' : 'Diverted / Detour Active', color: '#a855f7', bg: 'rgba(168, 85, 247, 0.15)', border: '#a855f7' },
              restricted: { label: activeCalEvt?.state === 'restricted' ? 'Restricted (Calendar Throughput Cap)' : 'Flowing at Restricted Rate', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', border: '#f59e0b' },
              blocked: { label: blockedLabel, color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', border: '#ef4444' },
              starved: { label: 'Cannot Deliver (Lack of Material)', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              frozen: { label: currentDay === 0 ? 'Day 0 (Frozen)' : 'Inactive / Idle', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              idle: { label: 'Idle (Dormant)', color: '#94a3b8', bg: 'rgba(100, 116, 139, 0.15)', border: '#64748b' }
            }[nodeStatus] || { label: 'Frozen', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' };

            const fillPct = singleSelectedNode.capacity > 0
              ? Math.round((liveVol / singleSelectedNode.capacity) * 100)
              : 0;

            return (
              <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>CONTAINER TELEMETRY</div>
                <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#f8fafc' }}>{singleSelectedNode.name}</div>
                {singleSelectedNode.notes && (
                  <div style={{ padding: '8px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid #334155', fontSize: '11px', color: '#cbd5e1' }}>
                    <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>DESCRIPTION</div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{singleSelectedNode.notes}</div>
                  </div>
                )}
                
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderRadius: '4px', backgroundColor: statusConfig.bg, border: `1px solid ${statusConfig.border}`, color: statusConfig.color, fontSize: '11px', fontWeight: 600, width: 'fit-content' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: statusConfig.color }} />
                  {statusConfig.label}
                </div>

                {activeCalEvt && (
                  <div style={{ fontSize: '11px', color: '#fde68a', backgroundColor: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)', borderRadius: '4px', padding: '5px 8px', fontVariantNumeric: 'tabular-nums' }}>
                    Calendar override: <strong style={{ textTransform: 'uppercase' }}>{activeCalEvt.state}</strong>
                    {activeCalEvt.state === 'restricted' ? ` (Cap ${Math.round(activeCalEvt.rateValue ?? 0).toLocaleString()} m³/d)` : ''} (D{activeCalEvt.startDay}–D{activeCalEvt.endDay})
                  </div>
                )}

                {overflowOut > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#e9d5ff', backgroundColor: 'rgba(168, 85, 247, 0.12)', border: '1px solid rgba(168, 85, 247, 0.35)', borderRadius: '4px', padding: '5px 8px', fontVariantNumeric: 'tabular-nums' }}>
                    <span>Transferred Through:</span>
                    <span style={{ fontWeight: 700 }}>{Math.round(overflowOut).toLocaleString()} m³/d</span>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                  <span>{singleSelectedNode.type === 'null' ? 'Pass-Through Storage:' : singleSelectedNode.type === 'external' ? 'Cumulative Volume:' : 'Live Volume:'}</span>
                  <span style={{ fontWeight: 600 }}>
                    {singleSelectedNode.type === 'null'
                      ? '0 m³ (Null Junction)'
                      : singleSelectedNode.type === 'external'
                      ? `${Math.round(liveVol).toLocaleString()} m³ (Unbounded)`
                      : `${Math.round(liveVol).toLocaleString()} / ${Math.round(singleSelectedNode.capacity).toLocaleString()} m³ (${fillPct}%)`}
                  </span>
                </div>
                {singleSelectedNode.type !== 'null' && (
                  <div style={{ width: '100%', height: '8px', backgroundColor: '#334155', borderRadius: '4px', overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, Math.max(0, fillPct))}%`, height: '100%', backgroundColor: isOverfilled ? '#ef4444' : (singleSelectedNode.type === 'excavation' ? '#0d9488' : singleSelectedNode.type === 'stockpile' ? '#b45309' : '#475569') }} />
                  </div>
                )}

                {/* Per-Day Container Math Audit */}
                {currentFrame?.dayAudit?.containers?.[singleSelectedNode.id] && (() => {
                  const ca = currentFrame.dayAudit.containers[singleSelectedNode.id];
                  return (
                    <div style={{ borderTop: '1px solid #1e293b', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => setShowContainerAudit(v => !v)}
                        style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: '#38bdf8', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                      >
                        {showContainerAudit ? '▾ Hide Day Math Audit' : '▸ Show Day Math Audit'}
                      </button>
                      {showContainerAudit && (
                        <div style={{ backgroundColor: '#0b1120', border: '1px solid #1e293b', borderRadius: '4px', padding: '8px 9px', fontSize: '10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums', color: '#cbd5e1', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#94a3b8' }}>Start Vol:</span>
                            <span>{Math.round(ca.startVol).toLocaleString()} m³</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#94a3b8' }}>− Outbound (bank):</span>
                            <span style={{ color: '#f59e0b' }}>−{Math.round(ca.outboundRemovedM3).toLocaleString()} m³</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#94a3b8' }}>+ Inbound (bulked):</span>
                            <span style={{ color: '#22c55e' }}>+{Math.round(ca.inboundDepositedM3).toLocaleString()} m³</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #1e293b', paddingTop: '3px', fontWeight: 700, color: '#f8fafc' }}>
                            <span>= End Vol:</span>
                            <span>{Math.round(ca.endVol).toLocaleString()} m³</span>
                          </div>
                          {singleSelectedNode.type !== 'external' && singleSelectedNode.type !== 'null' && (
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                              <span style={{ color: '#94a3b8' }}>Headroom ({ca.sameDayCreditApplied ? 'incl. drain' : 'start-only'}):</span>
                              <span>{Math.round(ca.effectiveHeadroomM3).toLocaleString()} m³</span>
                            </div>
                          )}
                          {ca.overflowTransferredOutM3 > 0 && (
                            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                              <span style={{ color: '#94a3b8' }}>Overflow Out:</span>
                              <span style={{ color: '#c084fc' }}>{Math.round(ca.overflowTransferredOutM3).toLocaleString()} m³</span>
                            </div>
                          )}
                          {ca.headroomHoldLatched && (
                            <div style={{ color: '#fde68a', marginTop: '2px' }}>
                              Headroom Hold Latched
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* Selected Transfer Link Live Telemetry */}
          {selectedLink && (() => {
            const linkFlow = currentFrame ? (currentFrame.linkFlows[selectedLink.id] ?? 0) : 0;
            const linkStatus = currentFrame?.linkStatuses?.[selectedLink.id] ?? 'frozen';
            const linkRole = getLinkRole(selectedLink);
            const routeSplit = currentFrame?.linkRouteSplits?.[selectedLink.id];
            const standbyInfo = currentFrame?.standbyActivatedFrom?.[selectedLink.id];
            const standbyFromLink = standbyInfo ? links.find(l => l.id === standbyInfo.primaryLinkId) : undefined;
            const standbyFromSrc = standbyFromLink ? nodes.find(n => n.id === standbyFromLink.sourceId) : undefined;
            const standbyFromTgt = standbyFromLink ? nodes.find(n => n.id === standbyFromLink.targetId) : undefined;
            const source = vm.getNodes().find(n => n.id === selectedLink.sourceId);
            const target = vm.getNodes().find(n => n.id === selectedLink.targetId);
            const activeCalEvt = getActiveCalendarEventForTarget('transfer', selectedLink.id);

            const divertedLabel =
              linkRole === 'overflow'
                ? 'Active Transfer-Through Overflow'
                : linkRole === 'standby'
                ? 'Active Standby Diversion'
                : 'Active Backup Route Detour';

            const statusConfig = {
              full: { label: 'Flowing at Full Rate', color: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)', border: '#22c55e' },
              diverted: { label: divertedLabel, color: '#a855f7', bg: 'rgba(168, 85, 247, 0.15)', border: '#a855f7' },
              restricted: { label: 'Flowing at Restricted Rate', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', border: '#f59e0b' },
              blocked: { label: activeCalEvt?.state === 'stopped' ? 'Stopped (Calendar Event)' : 'Blocked (Capacity / Schedule)', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', border: '#ef4444' },
              starved: { label: 'Cannot Deliver (Lack of Material)', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              frozen: { label: currentDay === 0 ? 'Day 0 (Frozen)' : 'Inactive / Idle', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              idle: { label: linkRole === 'standby' ? 'Standby (Dormant)' : linkRole === 'overflow' ? 'Overflow (Dormant)' : 'Idle', color: '#94a3b8', bg: 'rgba(100, 116, 139, 0.15)', border: '#64748b' }
            }[linkStatus] || { label: 'Frozen', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' };

            return (
              <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>TRANSFER LINK TELEMETRY</span>
                  {linkRole !== 'primary' && (
                    <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: '#c084fc', backgroundColor: 'rgba(168, 85, 247, 0.16)', border: '1px solid rgba(168, 85, 247, 0.45)', borderRadius: '3px', padding: '1px 6px' }}>
                      {linkRole === 'standby' ? 'STBY' : 'OVF'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#f8fafc' }}>{source?.name ?? 'Source'} → {target?.name ?? 'Target'}</div>
                {selectedLink.notes && (
                  <div style={{ padding: '8px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid #334155', fontSize: '11px', color: '#cbd5e1' }}>
                    <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>DESCRIPTION</div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{selectedLink.notes}</div>
                  </div>
                )}

                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderRadius: '4px', backgroundColor: statusConfig.bg, border: `1px solid ${statusConfig.border}`, color: statusConfig.color, fontSize: '11px', fontWeight: 600, width: 'fit-content' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: statusConfig.color }} />
                  {statusConfig.label}
                </div>

                {activeCalEvt && (
                  <div style={{ fontSize: '11px', color: '#fde68a', backgroundColor: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)', borderRadius: '4px', padding: '5px 8px', fontVariantNumeric: 'tabular-nums' }}>
                    Calendar override: <strong style={{ textTransform: 'uppercase' }}>{activeCalEvt.state}</strong>
                    {activeCalEvt.state === 'variable' ? ` (${Math.round(activeCalEvt.rateValue ?? 0).toLocaleString()} m³/d)` : ''} · D{activeCalEvt.startDay}–D{activeCalEvt.endDay}
                  </div>
                )}

                {routeSplit && routeSplit.backupFlow > 0 && (
                  <div style={{ backgroundColor: 'rgba(168, 85, 247, 0.12)', border: '1px solid rgba(168, 85, 247, 0.35)', borderRadius: '4px', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '11px', color: '#e9d5ff', fontVariantNumeric: 'tabular-nums' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Primary Route:</span>
                      <span style={{ fontWeight: 600 }}>{Math.round(routeSplit.primaryFlow).toLocaleString()} m³/d</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span>Backup Detour:</span>
                      <span style={{ fontWeight: 700, color: '#d8b4fe' }}>{Math.round(routeSplit.backupFlow).toLocaleString()} m³/d</span>
                    </div>
                  </div>
                )}

                {standbyFromLink && (
                  <div style={{ fontSize: '11px', color: '#e9d5ff', backgroundColor: 'rgba(168, 85, 247, 0.12)', border: '1px solid rgba(168, 85, 247, 0.35)', borderRadius: '4px', padding: '5px 8px' }}>
                    Spillover from: <strong>{standbyFromSrc?.name ?? standbyFromLink.sourceId} → {standbyFromTgt?.name ?? standbyFromLink.targetId}</strong>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                  <span>Transfer Rate:</span>
                  <span style={{ fontWeight: 600 }}>{Math.round(linkFlow).toLocaleString()} / {Math.round(selectedLink.dailyRate).toLocaleString()} m³/d</span>
                </div>

                {/* Per-Day Link 6-Stage Math Audit */}
                {currentFrame?.dayAudit?.links?.[selectedLink.id] && (() => {
                  const la = currentFrame.dayAudit.links[selectedLink.id];
                  return (
                    <div style={{ borderTop: '1px solid #1e293b', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => setShowLinkAudit(v => !v)}
                        style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: '#38bdf8', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}
                      >
                        {showLinkAudit ? '▾ Hide Day Math Audit' : '▸ Show Day Math Audit'}
                      </button>
                      {showLinkAudit && (
                        <div style={{ backgroundColor: '#0b1120', border: '1px solid #1e293b', borderRadius: '4px', padding: '8px 9px', fontSize: '10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums', color: '#cbd5e1', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#94a3b8' }}>Stated Rate:</span>
                            <span>{Math.round(la.statedRate).toLocaleString()} m³/d</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#94a3b8' }}>After Calendar:</span>
                            <span>{Math.round(la.afterCalendar).toLocaleString()} m³/d</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#94a3b8' }}>After Global Weather:</span>
                            <span>{Math.round(la.afterGlobalWeather).toLocaleString()} m³/d</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#94a3b8' }}>Stage 1 (Source):</span>
                            <span>{Math.round(la.afterSourceStock).toLocaleString()} m³</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#94a3b8' }}>Stage 1.5 (Route/Cap):</span>
                            <span>{Math.round(la.afterCorridorAndDetour).toLocaleString()} m³</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#94a3b8' }}>Stage 2 (Headroom):</span>
                            <span>{Math.round(la.afterTargetHeadroom).toLocaleString()} m³</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #1e293b', paddingTop: '3px', fontWeight: 700, color: '#22c55e' }}>
                            <span>Final Delivered:</span>
                            <span>{Math.round(la.finalDelivered).toLocaleString()} m³</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
                            <span style={{ color: '#94a3b8' }}>Bulking (OUT / IN):</span>
                            <span>{la.bulkOutApplied.toFixed(2)}× / {la.bulkInApplied.toFixed(2)}×</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                            <span style={{ color: '#94a3b8' }}>Src − / Tgt +:</span>
                            <span>−{Math.round(la.sourceDeductedM3).toLocaleString()} / +{Math.round(la.targetDepositedM3).toLocaleString()} m³</span>
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid #1e293b', paddingTop: '3px' }}>
                            <span style={{ color: '#94a3b8' }}>Binding Constraint:</span>
                            <span style={{ color: la.bindingConstraint === 'None (Full Rate)' ? '#22c55e' : '#f59e0b', fontWeight: 700 }}>{la.bindingConstraint}</span>
                          </div>
                          {la.partialRuleNote && (
                            <div style={{ color: '#fde68a', lineHeight: 1.35 }}>
                              {la.partialRuleNote}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })()}

          {/* Selected Route Corridor Live Telemetry */}
          {selectedCorridor && (() => {
            const assignedLinks = links.filter(l => getLinkCorridorIds(l).includes(selectedCorridor.id));
            const backupLinks = links.filter(l => getLinkBackupCorridorIds(l).includes(selectedCorridor.id));
            const combinedLiveFlow =
              currentFrame?.corridorFlows?.[selectedCorridor.id] ??
              assignedLinks.reduce((sum, l) => sum + (currentFrame?.linkFlows?.[l.id] ?? 0), 0);
            const detourFlow = currentFrame?.backupCorridorFlows?.[selectedCorridor.id] ?? 0;
            const combinedPlanned = assignedLinks.reduce((sum, l) => sum + l.dailyRate, 0);
            const corridorStatus = currentFrame?.corridorStatuses?.[selectedCorridor.id] ?? 'frozen';
            const activeCalEvt = getActiveCalendarEventForTarget('route', selectedCorridor.id);

            const statusConfig = {
              full: { label: 'Open / Flowing at Full Rate', color: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)', border: '#22c55e' },
              diverted: { label: 'Active Detour Spillover Corridor', color: '#a855f7', bg: 'rgba(168, 85, 247, 0.15)', border: '#a855f7' },
              restricted: { label: 'Restricted Route Cap Active', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', border: '#f59e0b' },
              blocked: { label: 'Route Blocked', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', border: '#ef4444' },
              starved: { label: 'Assigned Sources Starved', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              frozen: { label: currentDay === 0 ? 'Day 0 (Frozen)' : 'Idle / No Flow', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              idle: { label: 'Backup Route (Dormant)', color: '#94a3b8', bg: 'rgba(100, 116, 139, 0.15)', border: '#64748b' }
            }[corridorStatus] || { label: 'Frozen', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' };

            return (
              <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>ROUTE CORRIDOR TELEMETRY</div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#f8fafc' }}>{selectedCorridor.name}</div>
                {selectedCorridor.notes && (
                  <div style={{ padding: '8px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid #334155', fontSize: '11px', color: '#cbd5e1' }}>
                    <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>DESCRIPTION</div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{selectedCorridor.notes}</div>
                  </div>
                )}
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderRadius: '4px', backgroundColor: statusConfig.bg, border: `1px solid ${statusConfig.border}`, color: statusConfig.color, fontSize: '11px', fontWeight: 600, width: 'fit-content' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: statusConfig.color }} />
                  {statusConfig.label}
                </div>
                {activeCalEvt && (
                  <div style={{ fontSize: '11px', color: '#fde68a', backgroundColor: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)', borderRadius: '4px', padding: '5px 8px', fontVariantNumeric: 'tabular-nums' }}>
                    Calendar override: <strong style={{ textTransform: 'uppercase' }}>{activeCalEvt.state}</strong>
                    {activeCalEvt.state === 'restricted' ? ` (Cap ${Math.round(activeCalEvt.rateValue ?? 0).toLocaleString()} m³/d)` : ''} · D{activeCalEvt.startDay}–D{activeCalEvt.endDay}
                  </div>
                )}
                {detourFlow > 0 && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#e9d5ff', backgroundColor: 'rgba(168, 85, 247, 0.12)', border: '1px solid rgba(168, 85, 247, 0.35)', borderRadius: '4px', padding: '5px 8px', fontVariantNumeric: 'tabular-nums' }}>
                    <span>Detour Spillover Flow:</span>
                    <span style={{ fontWeight: 700 }}>{Math.round(detourFlow).toLocaleString()} m³/d</span>
                  </div>
                )}
                {(selectedCorridor.maxDailyRate !== undefined || selectedCorridor.maxFleetCount !== undefined) && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                    <span>Baseline Limits:</span>
                    <span>
                      {selectedCorridor.maxDailyRate !== undefined ? `${Math.round(selectedCorridor.maxDailyRate).toLocaleString()} m³/d` : 'No rate cap'}
                      {selectedCorridor.maxFleetCount !== undefined ? ` · ${selectedCorridor.maxFleetCount} fleet` : ''}
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                  <span>Combined Corridor Flow:</span>
                  <span style={{ fontWeight: 600 }}>{Math.round(combinedLiveFlow).toLocaleString()} / {Math.round(combinedPlanned).toLocaleString()} m³/d</span>
                </div>
                {backupLinks.length > 0 && (
                  <div style={{ fontSize: '10px', color: '#c084fc' }}>
                    Assigned as backup detour for {backupLinks.length} transfer{backupLinks.length > 1 ? 's' : ''}.
                  </div>
                )}
              </div>
            );
          })()}

          {/* Color Key Reference */}
          <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155' }}>
            <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600, marginBottom: '8px' }}>SIMULATION COLOR KEY</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#38bdf8' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#38bdf8', display: 'inline-block', flexShrink: 0 }} />
                <span><strong>Blue:</strong> Day 0 (Frozen) / Lack of Material</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#22c55e' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#22c55e', display: 'inline-block', flexShrink: 0 }} />
                <span><strong>Green:</strong> Flowing at full rate</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#a855f7' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#a855f7', display: 'inline-block', flexShrink: 0 }} />
                <span><strong>Violet:</strong> Diverted / Detour / Transfer-Through</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#f59e0b' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#f59e0b', display: 'inline-block', flexShrink: 0 }} />
                <span><strong>Amber:</strong> Flowing at restricted rate</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ef4444' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#ef4444', display: 'inline-block', flexShrink: 0 }} />
                <span><strong>Red:</strong> Blocked due to capacity issues</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#94a3b8' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#64748b', display: 'inline-block', flexShrink: 0 }} />
                <span><strong>Slate:</strong> Standby / Overflow (Dormant)</span>
              </div>
            </div>
          </div>

          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: '#eab308', marginBottom: '8px' }}>Active Alerts & Triggers</div>
            {currentFrame && currentFrame.alerts.length > 0 ? (
              currentFrame.alerts.map((alert, idx) => (
                <div key={idx} style={{ backgroundColor: '#451a03', border: '1px solid #f59e0b', color: '#fde047', padding: '8px 10px', borderRadius: '4px', marginBottom: '6px', fontSize: '11px' }}>
                  {alert}
                </div>
              ))
            ) : (
              <div style={{ color: '#64748b', fontSize: '12px', backgroundColor: '#0f172a', padding: '10px', borderRadius: '4px' }}>
                No triggers or capacity warnings on Day {currentDay}.
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {isCalendarEventSelected && selectedCalendarEvent && (() => {
            const info = getCalendarTargetInfo(selectedCalendarEvent);
            const targetLink = selectedCalendarEvent.targetType === 'transfer'
              ? links.find(l => l.id === selectedCalendarEvent.targetId)
              : undefined;

            const handleStateChange = (nextState: CalendarEventState) => {
              const updates: Partial<CalendarEvent> = { state: nextState };
              if (selectedCalendarEvent.targetType === 'global') {
                if (nextState === 'weather_haul' || nextState === 'combined_weather') {
                  if (selectedCalendarEvent.haulRatePct === undefined || isNaN(selectedCalendarEvent.haulRatePct)) {
                    updates.haulRatePct = 50;
                  }
                }
                if (nextState === 'weather_bulking' || nextState === 'combined_weather') {
                  if (selectedCalendarEvent.bulkInMultiplier === undefined || isNaN(selectedCalendarEvent.bulkInMultiplier)) {
                    updates.bulkInMultiplier = 1.15;
                  }
                  if (selectedCalendarEvent.bulkOutMultiplier === undefined || isNaN(selectedCalendarEvent.bulkOutMultiplier)) {
                    updates.bulkOutMultiplier = 1.0;
                  }
                }
              } else if (nextState === 'variable' && (selectedCalendarEvent.rateValue === undefined || isNaN(selectedCalendarEvent.rateValue))) {
                updates.rateValue = targetLink ? Math.round((targetLink.dailyRate * 0.5) / 50) * 50 : 500;
              } else if (nextState === 'restricted' && (selectedCalendarEvent.rateValue === undefined || isNaN(selectedCalendarEvent.rateValue))) {
                if (selectedCalendarEvent.targetType === 'container') {
                  const connected = links.filter(
                    l => l.sourceId === selectedCalendarEvent.targetId || l.targetId === selectedCalendarEvent.targetId
                  );
                  const combined = connected.reduce((s, l) => s + l.dailyRate, 0);
                  updates.rateValue = combined > 0 ? Math.max(50, Math.round((combined * 0.5) / 50) * 50) : 1000;
                } else {
                  const assigned = links.filter(l => getLinkCorridorIds(l).includes(selectedCalendarEvent.targetId));
                  const combined = assigned.reduce((s, l) => s + l.dailyRate, 0);
                  updates.rateValue = combined > 0 ? Math.max(50, Math.round((combined * 0.5) / 50) * 50) : 1000;
                }
              }
              onUpdateCalendarEvent(selectedCalendarEvent.id, updates);
            };

            const durationDays = selectedCalendarEvent.endDay - selectedCalendarEvent.startDay + 1;
            const startDateISO = dayIndexToDateISO(projectSettings.startDate, selectedCalendarEvent.startDay);
            const endDateISO = dayIndexToDateISO(projectSettings.startDate, selectedCalendarEvent.endDay);

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: '#94a3b8', backgroundColor: '#0f172a', padding: '8px 12px', borderRadius: '4px', border: '1px solid #334155' }}>
                  <span>
                    Selected: <strong style={{ color: '#38bdf8' }}>{selectedCalendarEvent.targetType === 'global' ? 'Global Event' : 'Calendar Event'}</strong>
                  </span>
                  <span style={{ fontSize: '10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums', color: '#cbd5e1' }}>
                    {durationDays}d
                  </span>
                </div>

                {/* Target Element Summary */}
                <div style={{ backgroundColor: '#0f172a', padding: '10px 12px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#94a3b8' }}>
                      {info.typeLabel}
                    </span>
                    {selectedCalendarEvent.targetType !== 'global' && (
                      <button
                        type="button"
                        onClick={() => onSelectTargetElement(selectedCalendarEvent.targetType, selectedCalendarEvent.targetId)}
                        style={{
                          background: 'none',
                          border: '1px solid #475569',
                          borderRadius: '4px',
                          color: '#38bdf8',
                          fontSize: '10px',
                          fontWeight: 600,
                          padding: '2px 7px',
                          cursor: 'pointer'
                        }}
                      >
                        Select on Canvas
                      </button>
                    )}
                  </div>
                  <div style={{ fontSize: '13px', fontWeight: 700, color: '#f8fafc', wordBreak: 'break-word' }}>
                    {info.name}
                  </div>
                  {info.baseSummary && (
                    <div style={{ fontSize: '11px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                      {info.baseSummary}
                    </div>
                  )}
                </div>

                {/* Event Description (kept at top right underneath element name) */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Description</label>
                    <span style={{ fontSize: '10px', color: '#64748b' }}>Included in CSV export</span>
                  </div>
                  <textarea
                    value={selectedCalendarEvent.notes || ''}
                    onChange={e => onUpdateCalendarEvent(selectedCalendarEvent.id, { notes: e.target.value })}
                    placeholder="Scheduling reason, weather forecast, permit window, traffic restriction details..."
                    rows={3}
                    style={{
                      backgroundColor: '#0f172a',
                      border: '1px solid #475569',
                      borderRadius: '4px',
                      color: '#f8fafc',
                      padding: '8px',
                      fontSize: '12px',
                      resize: 'vertical',
                      fontFamily: 'inherit',
                      lineHeight: 1.4
                    }}
                  />
                </div>

                {/* Start / End Date Controls */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Start Date</label>
                    <input
                      type="date"
                      min={projectSettings.startDate}
                      max={projectSettings.endDate}
                      value={startDateISO}
                      onChange={e => {
                        if (!e.target.value) return;
                        const dayIdx = dateISOToDayIndex(projectSettings.startDate, e.target.value, totalDays);
                        const clamped = getClampedDayRange(selectedCalendarEvent, dayIdx, Math.max(dayIdx, selectedCalendarEvent.endDay));
                        onUpdateCalendarEvent(selectedCalendarEvent.id, clamped);
                      }}
                      style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '7px', fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', colorScheme: 'dark' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>End Date</label>
                    <input
                      type="date"
                      min={projectSettings.startDate}
                      max={projectSettings.endDate}
                      value={endDateISO}
                      onChange={e => {
                        if (!e.target.value) return;
                        const dayIdx = dateISOToDayIndex(projectSettings.startDate, e.target.value, totalDays);
                        const clamped = getClampedDayRange(selectedCalendarEvent, Math.min(selectedCalendarEvent.startDay, dayIdx), dayIdx);
                        onUpdateCalendarEvent(selectedCalendarEvent.id, clamped);
                      }}
                      style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '7px', fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', colorScheme: 'dark' }}
                    />
                  </div>
                </div>

                {/* Start / End Day Index Controls */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Start Day (1–{totalDays})</label>
                    <input
                      type="number"
                      min={1}
                      max={totalDays}
                      value={selectedCalendarEvent.startDay}
                      onChange={e => {
                        const raw = Number(e.target.value);
                        if (!Number.isFinite(raw)) return;
                        const clamped = getClampedDayRange(selectedCalendarEvent, raw, Math.max(raw, selectedCalendarEvent.endDay));
                        onUpdateCalendarEvent(selectedCalendarEvent.id, clamped);
                      }}
                      style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>End Day (1–{totalDays})</label>
                    <input
                      type="number"
                      min={1}
                      max={totalDays}
                      value={selectedCalendarEvent.endDay}
                      onChange={e => {
                        const raw = Number(e.target.value);
                        if (!Number.isFinite(raw)) return;
                        const clamped = getClampedDayRange(selectedCalendarEvent, Math.min(selectedCalendarEvent.startDay, raw), raw);
                        onUpdateCalendarEvent(selectedCalendarEvent.id, clamped);
                      }}
                      style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}
                    />
                  </div>
                </div>

                {/* Event State Control */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>
                    {selectedCalendarEvent.targetType === 'global' ? 'Global Event Type' : 'Scheduled State'}
                  </label>
                  <select
                    value={selectedCalendarEvent.state}
                    onChange={e => handleStateChange(e.target.value as CalendarEventState)}
                    style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px', fontWeight: 600 }}
                  >
                    {selectedCalendarEvent.targetType === 'global' && (
                      <>
                        <option value="site_shutdown">Site Shutdown (0% Movement)</option>
                        <option value="weather_haul">Weather — Haul Movement Impact (%)</option>
                        <option value="weather_bulking">Weather — Bulking Modifier (IN / OUT)</option>
                        <option value="combined_weather">Combined Weather (Haul % + Bulking)</option>
                      </>
                    )}
                    {selectedCalendarEvent.targetType === 'container' && (
                      <>
                        <option value="open">Open (Normal Inbound & Outbound)</option>
                        <option value="restricted">Restricted (Combined Throughput Cap)</option>
                        <option value="blocked">Blocked (Halt Inbound & Outbound)</option>
                      </>
                    )}
                    {selectedCalendarEvent.targetType === 'transfer' && (
                      <>
                        <option value="max">Max (100% Stated Rate)</option>
                        <option value="variable">Variable Rate (Custom m³/d)</option>
                        <option value="stopped">Stopped (0 m³/d)</option>
                      </>
                    )}
                    {selectedCalendarEvent.targetType === 'route' && (
                      <>
                        <option value="open">Open (Unrestricted)</option>
                        <option value="restricted">Restricted (Combined Pro-Rata Cap)</option>
                        <option value="blocked">Blocked (Halt All Assigned Transfers)</option>
                      </>
                    )}
                  </select>
                </div>

                {/* Global Haul Rate Modifier */}
                {selectedCalendarEvent.targetType === 'global' &&
                  (selectedCalendarEvent.state === 'weather_haul' || selectedCalendarEvent.state === 'combined_weather') && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>
                        Site-Wide Haul Movement Rate (% of stated rate)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={200}
                        step={5}
                        value={selectedCalendarEvent.haulRatePct ?? 50}
                        onChange={e =>
                          onUpdateCalendarEvent(selectedCalendarEvent.id, {
                            haulRatePct: Math.max(0, Math.min(200, Number(e.target.value) || 0))
                          })
                        }
                        style={{ backgroundColor: '#0f172a', border: '1px solid #f59e0b', borderRadius: '4px', color: '#fde68a', padding: '8px', fontSize: '12px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
                      />
                    </div>
                  )}

                {/* Global Bulking Multipliers + Material Scope */}
                {selectedCalendarEvent.targetType === 'global' &&
                  (selectedCalendarEvent.state === 'weather_bulking' || selectedCalendarEvent.state === 'combined_weather') && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Bulk IN Mult (×)</label>
                          <input
                            type="number"
                            min={0.5}
                            max={2.5}
                            step={0.05}
                            value={selectedCalendarEvent.bulkInMultiplier ?? 1.0}
                            onChange={e =>
                              onUpdateCalendarEvent(selectedCalendarEvent.id, {
                                bulkInMultiplier: Math.max(0.5, Math.min(2.5, Number(e.target.value) || 1))
                              })
                            }
                            style={{ backgroundColor: '#0f172a', border: '1px solid #818cf8', borderRadius: '4px', color: '#e0e7ff', padding: '8px', fontSize: '12px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
                          />
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Bulk OUT Mult (×)</label>
                          <input
                            type="number"
                            min={0.5}
                            max={2.5}
                            step={0.05}
                            value={selectedCalendarEvent.bulkOutMultiplier ?? 1.0}
                            onChange={e =>
                              onUpdateCalendarEvent(selectedCalendarEvent.id, {
                                bulkOutMultiplier: Math.max(0.5, Math.min(2.5, Number(e.target.value) || 1))
                              })
                            }
                            style={{ backgroundColor: '#0f172a', border: '1px solid #818cf8', borderRadius: '4px', color: '#e0e7ff', padding: '8px', fontSize: '12px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
                          />
                        </div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '10px', color: '#94a3b8' }}>
                          Affected Materials (none selected = all materials)
                        </label>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {materials.map(mat => {
                            const currentList = selectedCalendarEvent.affectedMaterials || [];
                            const checked = currentList.includes(mat.code);
                            return (
                              <label
                                key={mat.code}
                                style={{
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '5px',
                                  fontSize: '11px',
                                  color: checked ? '#f8fafc' : '#94a3b8',
                                  cursor: 'pointer',
                                  padding: '3px 7px',
                                  borderRadius: '4px',
                                  backgroundColor: '#0f172a',
                                  border: `1px solid ${checked ? '#818cf8' : '#334155'}`
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => {
                                    const next = checked
                                      ? currentList.filter(c => c !== mat.code)
                                      : [...currentList, mat.code];
                                    onUpdateCalendarEvent(selectedCalendarEvent.id, {
                                      affectedMaterials: next.length > 0 ? next : undefined
                                    });
                                  }}
                                  style={{ accentColor: '#818cf8' }}
                                />
                                <span>{mat.code}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  )}

                {/* Conditional Rate Value input */}
                {((selectedCalendarEvent.targetType === 'transfer' && selectedCalendarEvent.state === 'variable') ||
                  (selectedCalendarEvent.targetType === 'container' && selectedCalendarEvent.state === 'restricted') ||
                  (selectedCalendarEvent.targetType === 'route' && selectedCalendarEvent.state === 'restricted')) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>
                      {selectedCalendarEvent.targetType === 'route'
                        ? 'Combined Route Daily Cap (m³/day)'
                        : selectedCalendarEvent.targetType === 'container'
                        ? 'Container Throughput Cap (m³/day)'
                        : 'Override Transfer Rate (m³/day)'}
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={50}
                      value={selectedCalendarEvent.rateValue ?? 0}
                      onChange={e => onUpdateCalendarEvent(selectedCalendarEvent.id, { rateValue: Math.max(0, Number(e.target.value) || 0) })}
                      style={{ backgroundColor: '#0f172a', border: '1px solid #f59e0b', borderRadius: '4px', color: '#fde68a', padding: '8px', fontSize: '12px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
                    />
                    <div style={{ fontSize: '10px', color: '#94a3b8', lineHeight: 1.4 }}>
                      {selectedCalendarEvent.targetType === 'route'
                        ? 'Splits this combined daily rate cap using the configured Allocation Policy across all active transfers assigned to this route.'
                        : selectedCalendarEvent.targetType === 'container'
                        ? 'Caps combined inbound & outbound transfer throughput through this container using the configured Allocation Policy.'
                        : targetLink
                        ? `Overrides stated rate of ${Math.round(targetLink.dailyRate).toLocaleString()} m³/d during Day ${selectedCalendarEvent.startDay}–${selectedCalendarEvent.endDay}.`
                        : 'Overrides daily transfer rate during this window.'}
                    </div>
                  </div>
                )}

                {/* Optional Label */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Bar Label (Optional)</label>
                  <input
                    type="text"
                    value={selectedCalendarEvent.label || ''}
                    onChange={e => onUpdateCalendarEvent(selectedCalendarEvent.id, { label: e.target.value })}
                    placeholder="e.g. Heavy Rain, Plant Service, Safety Stand-Down..."
                    style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }}
                  />
                </div>

                {/* Delete Event Button */}
                <button
                  type="button"
                  onClick={() => onDeleteCalendarEvent(selectedCalendarEvent.id)}
                  style={{
                    backgroundColor: 'rgba(239, 68, 68, 0.16)',
                    color: '#fca5a5',
                    border: '1px solid rgba(239, 68, 68, 0.45)',
                    borderRadius: '4px',
                    padding: '8px 12px',
                    fontSize: '11px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    marginTop: '4px'
                  }}
                >
                  Delete Event
                </button>
              </div>
            );
          })()}

          {isPureNode && selectedNodeIds.length === 1 && singleSelectedNode && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ fontSize: '12px', color: '#94a3b8', backgroundColor: '#0f172a', padding: '8px 12px', borderRadius: '4px' }}>
                Selected: <strong style={{ color: '#38bdf8' }}>Container Node</strong>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Node Name</label>
                <input type="text" value={singleSelectedNode.name} onChange={e => onUpdateSingleNode('name', e.target.value)} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }} />
              </div>

              {/* Container Description Section */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Description</label>
                  <span style={{ fontSize: '10px', color: '#64748b' }}>Included in CSV export</span>
                </div>
                <textarea
                  value={singleSelectedNode.notes || ''}
                  onChange={e => onUpdateSingleNode('notes', e.target.value)}
                  placeholder="Operational description, geotechnical constraints, equipment assignments..."
                  rows={3}
                  style={{
                    backgroundColor: '#0f172a',
                    border: '1px solid #475569',
                    borderRadius: '4px',
                    color: '#f8fafc',
                    padding: '8px',
                    fontSize: '12px',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                    lineHeight: 1.4
                  }}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Container Type</label>
                <select value={singleSelectedNode.type} onChange={e => onUpdateSingleNode('type', e.target.value as any)} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }}>
                  <option value="excavation">Excavation (Cut)</option>
                  <option value="stockpile">Stockpile (Fill)</option>
                  <option value="null">Null Junction (Pass-Through)</option>
                  <option value="external">External Boundary (Unbounded)</option>
                </select>
                {singleSelectedNode.type === 'null' && (
                  <div style={{ fontSize: '10px', color: '#94a3b8', lineHeight: 1.35 }}>
                    Zero-storage junction: matches daily inbound supply directly to outbound transfers without buffering.
                  </div>
                )}
                {singleSelectedNode.type === 'external' && (
                  <div style={{ fontSize: '10px', color: '#94a3b8', lineHeight: 1.35 }}>
                    Unbounded boundary: supplies outbound flow without stockout and absorbs inbound flow without capacity blocking.
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Operational Status (Baseline)</label>
                <select
                  value={singleSelectedNode.status || 'active'}
                  onChange={e => onUpdateSingleNode('status', e.target.value as any)}
                  style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }}
                >
                  <option value="active">Active (Open)</option>
                  <option value="maintenance">Maintenance (Halted)</option>
                  <option value="blocked">Blocked (Halted)</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Capacity (m³)</label>
                <input type="number" value={singleSelectedNode.capacity} onChange={e => onUpdateSingleNode('capacity', Number(e.target.value))} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Current Volume (m³)</label>
                <input type="number" value={singleSelectedNode.currentVolume} onChange={e => onUpdateSingleNode('currentVolume', Number(e.target.value))} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }} />
              </div>
              
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Assigned Material</label>
                <select
                  value={singleSelectedNode.materialType}
                  onChange={e => onUpdateSingleNode('materialType', e.target.value)}
                  style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px', fontWeight: 'bold' }}
                >
                  {materials.map(mat => (
                    <option key={mat.code} value={mat.code}>
                      {mat.code} — {mat.name} (IN: {mat.bulkIN}, OUT: {mat.bulkOUT})
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Allowed Inbound Materials</label>
                  <span style={{ fontSize: '10px', color: '#64748b' }}>
                    {singleSelectedNode.allowedMaterials && singleSelectedNode.allowedMaterials.length > 0
                      ? `${singleSelectedNode.allowedMaterials.length} selected`
                      : 'All allowed'}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', backgroundColor: '#0f172a', padding: '8px', borderRadius: '4px', border: '1px solid #334155' }}>
                  {materials.map(mat => {
                    const currentAllowed = singleSelectedNode.allowedMaterials || [];
                    const isChecked = currentAllowed.includes(mat.code);
                    return (
                      <label
                        key={mat.code}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          padding: '3px 7px',
                          borderRadius: '4px',
                          backgroundColor: isChecked ? 'rgba(56, 189, 248, 0.14)' : '#1e293b',
                          border: isChecked ? '1px solid rgba(56, 189, 248, 0.45)' : '1px solid #334155',
                          color: isChecked ? '#e0f2fe' : '#94a3b8',
                          fontSize: '10px',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={e => {
                            const next = e.target.checked
                              ? Array.from(new Set([...currentAllowed, mat.code]))
                              : currentAllowed.filter(c => c !== mat.code);
                            onUpdateSingleNode('allowedMaterials', next.length > 0 ? next : undefined);
                          }}
                          style={{ accentColor: '#38bdf8', margin: 0 }}
                        />
                        <span>{mat.code}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Plant / Fleet Count</label>
                <input type="number" value={singleSelectedNode.plantCount} onChange={e => onUpdateSingleNode('plantCount', Number(e.target.value))} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }} />
              </div>

              <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155', marginTop: '6px' }}>
                <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#38bdf8', marginBottom: '8px' }}>Strict Rules Controls</div>
                
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Node Overflow Mode</label>
                  <select
                    value={singleSelectedNode.overflowMode || 'strict'}
                    onChange={e => onUpdateSingleNode('overflowMode', e.target.value as OverflowMode)}
                    style={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '6px', fontSize: '11px' }}
                  >
                    <option value="strict">Strict Capacity (Enforced)</option>
                    <option value="overfill">Allow Overfill (Uncapped)</option>
                  </select>
                </div>

                {singleSelectedNode.overflowMode !== 'overfill' && (
                  <>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '8px' }}>
                      <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Strict Sub-Rule</label>
                      <select
                        value={singleSelectedNode.strictSubRule || 'throttleback'}
                        onChange={e => onUpdateSingleNode('strictSubRule', e.target.value as StrictSubRule)}
                        style={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '6px', fontSize: '11px' }}
                      >
                        <option value="throttleback">Proportional Throttleback</option>
                        <option value="headroom_hold">Headroom Hold (X Spare Space)</option>
                        <option value="transfer_through">Transfer-Through (Overflow Backup)</option>
                      </select>
                    </div>

                    {singleSelectedNode.strictSubRule === 'headroom_hold' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Required Spare Space (m³)</label>
                        <input
                          type="number"
                          value={singleSelectedNode.headroomThreshold ?? 500}
                          onChange={e => onUpdateSingleNode('headroomThreshold', Number(e.target.value))}
                          style={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '6px', fontSize: '11px', fontVariantNumeric: 'tabular-nums' }}
                        />
                      </div>
                    )}

                    {singleSelectedNode.strictSubRule === 'transfer_through' && (() => {
                      const triggerPct = Math.max(1, Math.min(100, singleSelectedNode.overflowTriggerPct ?? 100));
                      const triggerVol = Math.round(singleSelectedNode.capacity * (triggerPct / 100));
                      const connectedOverflowLinks = links
                        .filter(l => l.sourceId === singleSelectedNode.id && getLinkRole(l) === 'overflow')
                        .sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1));

                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px', paddingTop: '8px', borderTop: '1px solid #1e293b' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <label style={{ fontSize: '11px', color: '#c084fc', fontWeight: 600 }}>Activation Trigger (% Full)</label>
                              <span style={{ fontSize: '10px', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                                {triggerVol.toLocaleString()} m³
                              </span>
                            </div>
                            <input
                              type="number"
                              min={1}
                              max={100}
                              step={1}
                              value={triggerPct}
                              onChange={e => {
                                const raw = Number(e.target.value);
                                if (!Number.isFinite(raw)) return;
                                onUpdateSingleNode('overflowTriggerPct', Math.max(1, Math.min(100, Math.round(raw))));
                              }}
                              style={{ backgroundColor: '#1e293b', border: '1px solid rgba(168, 85, 247, 0.5)', borderRadius: '4px', color: '#f8fafc', padding: '6px', fontSize: '11px', fontVariantNumeric: 'tabular-nums' }}
                            />
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: '10px', fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase' }}>
                                Connected Overflow Links ({connectedOverflowLinks.length})
                              </span>
                            </div>
                            {connectedOverflowLinks.length === 0 ? (
                              <div style={{ fontSize: '10px', color: '#cbd5e1', backgroundColor: 'rgba(168, 85, 247, 0.08)', border: '1px dashed rgba(168, 85, 247, 0.45)', borderRadius: '4px', padding: '7px 8px', lineHeight: 1.4 }}>
                                Draw a transfer link from <strong>{singleSelectedNode.name}</strong> to an adjacent backup container and set its <strong>Link Role</strong> to <strong>Overflow</strong>. Falls back to Throttleback if none are available.
                              </div>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {connectedOverflowLinks.map(ovf => {
                                  const tgt = nodes.find(n => n.id === ovf.targetId);
                                  return (
                                    <button
                                      key={ovf.id}
                                      type="button"
                                      onClick={() => onSelectTargetElement('transfer', ovf.id)}
                                      style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        gap: '6px',
                                        padding: '5px 8px',
                                        backgroundColor: 'rgba(168, 85, 247, 0.10)',
                                        border: '1px solid rgba(168, 85, 247, 0.35)',
                                        borderRadius: '4px',
                                        color: '#e9d5ff',
                                        fontSize: '11px',
                                        cursor: 'pointer',
                                        textAlign: 'left'
                                      }}
                                      title="Select overflow transfer link"
                                    >
                                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                                        P{ovf.priority ?? 1} → {tgt?.name || ovf.targetId}
                                      </span>
                                      <span style={{ fontSize: '10px', color: '#c084fc', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                                        {Math.round(ovf.dailyRate).toLocaleString()} m³/d
                                      </span>
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Output Socket Edge</label>
                  <span style={{ fontSize: '10px', color: '#64748b' }}>Press O to cycle</span>
                </div>
                <select
                  value={singleSelectedNode.outputEdge || ''}
                  onChange={e => onUpdateSingleNode('outputEdge', e.target.value || undefined)}
                  style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }}
                >
                  <option value="">Auto (Shortest Path)</option>
                  <option value="N">North (Top Edge)</option>
                  <option value="E">East (Right Edge)</option>
                  <option value="S">South (Bottom Edge)</option>
                  <option value="W">West (Left Edge)</option>
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Input Socket Edge</label>
                  <span style={{ fontSize: '10px', color: '#64748b' }}>Press I to cycle</span>
                </div>
                <select
                  value={singleSelectedNode.inputEdge || ''}
                  onChange={e => onUpdateSingleNode('inputEdge', e.target.value || undefined)}
                  style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }}
                >
                  <option value="">Auto (Shortest Path)</option>
                  <option value="N">North (Top Edge)</option>
                  <option value="E">East (Right Edge)</option>
                  <option value="S">South (Bottom Edge)</option>
                  <option value="W">West (Left Edge)</option>
                </select>
              </div>
            </div>
          )}

          {isPureNode && selectedNodeIds.length > 1 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', backgroundColor: '#0f172a', padding: '16px', borderRadius: '6px', border: '1px solid #334155' }}>
              <div style={{ fontSize: '12px', color: '#94a3b8' }}>
                Selected: <strong style={{ color: '#38bdf8' }}>{selectedNodeIds.length} Container Nodes</strong>
              </div>
              <div style={{ fontSize: '13px', fontWeight: 600, color: '#f8fafc' }}>
                Multi-Container Selection
              </div>
              <div style={{ fontSize: '12px', color: '#94a3b8', lineHeight: 1.5 }}>
                Click <strong>Paste</strong> (<kbd style={{ padding: '2px 5px', backgroundColor: '#1e293b', borderRadius: '3px', border: '1px solid #475569', color: '#f8fafc', fontSize: '11px' }}>Ctrl+V</kbd>) above to paste copied container properties across all {selectedNodeIds.length} selected containers simultaneously, or click <strong>+ transfer</strong> to link the first two containers.
              </div>
            </div>
          )}

          {isPureSingleLink && selectedLink && (() => {
            const currentRole = getLinkRole(selectedLink);
            const srcNode = nodes.find(n => n.id === selectedLink.sourceId);
            const tgtNode = nodes.find(n => n.id === selectedLink.targetId);
            const assignedIds = getLinkCorridorIds(selectedLink);
            const backupIds = getLinkBackupCorridorIds(selectedLink);
            const assignedCorridors = assignedIds
              .map(id => corridors.find(c => c.id === id))
              .filter((c): c is RouteCorridor => Boolean(c));
            const orderedChain =
              srcNode && tgtNode
                ? resolveOrderedCorridorChain(srcNode, tgtNode, assignedCorridors)
                : [];
            const stepOrderMap = new Map(orderedChain.map((step, idx) => [step.corridor.id, idx + 1]));

            const watchablePrimaryLinks = links.filter(l => l.id !== selectedLink.id && getLinkRole(l) !== 'standby');
            const watchingStandbyLinks = links
              .filter(l => getLinkRole(l) === 'standby' && l.primaryLinkId === selectedLink.id)
              .sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1));

            const watchedPrimary = selectedLink.primaryLinkId
              ? links.find(l => l.id === selectedLink.primaryLinkId)
              : undefined;
            const isAltSourceStandby = watchedPrimary ? watchedPrimary.sourceId !== selectedLink.sourceId : false;
            const activeTriggers: DiversionTrigger[] =
              selectedLink.diversionTriggers && selectedLink.diversionTriggers.length > 0
                ? selectedLink.diversionTriggers
                : isAltSourceStandby
                ? ['route', 'target', 'calendar', 'source']
                : ['route', 'target', 'calendar'];

            const handleSetRole = (nextRole: LinkRole) => {
              const updates: Partial<TransferLink> = { linkRole: nextRole };
              if (nextRole !== 'standby') {
                updates.primaryLinkId = undefined;
              } else if (!selectedLink.diversionTriggers || selectedLink.diversionTriggers.length === 0) {
                updates.diversionTriggers = ['route', 'target', 'calendar'];
              }
              if (onUpdateLinkFields) {
                onUpdateLinkFields(selectedLink.id, updates);
              } else {
                onUpdateLink('linkRole', nextRole);
                if (nextRole !== 'standby') onUpdateLink('primaryLinkId', undefined);
              }
            };

            const handleToggleTrigger = (trigger: DiversionTrigger, checked: boolean) => {
              const next = checked
                ? Array.from(new Set([...activeTriggers, trigger]))
                : activeTriggers.filter(t => t !== trigger);
              onUpdateLink('diversionTriggers', next);
            };

            const triggerOptions: { key: DiversionTrigger; label: string }[] = [
              { key: 'route', label: 'Route Blocked / Capped' },
              { key: 'target', label: 'Target Full / Blocked' },
              { key: 'calendar', label: 'Calendar Stopped / Reduced' },
              { key: 'source', label: 'Source Starved / Blocked' }
            ];

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', color: '#94a3b8', backgroundColor: '#0f172a', padding: '8px 12px', borderRadius: '4px' }}>
                  <span>Selected: <strong style={{ color: '#38bdf8' }}>Transfer Link</strong></span>
                  {currentRole !== 'primary' && (
                    <span style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', color: '#c084fc' }}>
                      {currentRole}
                    </span>
                  )}
                </div>

                {/* Transfer Link Description Section */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Description</label>
                    <span style={{ fontSize: '10px', color: '#64748b' }}>Included in CSV export</span>
                  </div>
                  <textarea
                    value={selectedLink.notes || ''}
                    onChange={e => onUpdateLink('notes', e.target.value)}
                    placeholder="Transfer route description, corridor conditions, speed restrictions..."
                    rows={3}
                    style={{
                      backgroundColor: '#0f172a',
                      border: '1px solid #475569',
                      borderRadius: '4px',
                      color: '#f8fafc',
                      padding: '8px',
                      fontSize: '12px',
                      resize: 'vertical',
                      fontFamily: 'inherit',
                      lineHeight: 1.4
                    }}
                  />
                </div>

                {/* Link Role Selector */}
                <div style={{ backgroundColor: '#0f172a', padding: '10px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Link Role</label>
                    <span style={{ fontSize: '10px', color: currentRole === 'primary' ? '#64748b' : '#c084fc', fontWeight: 600 }}>
                      {currentRole === 'primary' ? 'Standard Transfer' : currentRole === 'standby' ? 'Spillover Diversion' : 'Container Backup'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '4px' }}>
                    {(['primary', 'standby', 'overflow'] as LinkRole[]).map(role => {
                      const active = currentRole === role;
                      const accent = role === 'primary' ? '#38bdf8' : '#a855f7';
                      const activeBg = role === 'primary' ? 'rgba(56, 189, 248, 0.16)' : 'rgba(168, 85, 247, 0.20)';
                      return (
                        <button
                          key={role}
                          type="button"
                          onClick={() => handleSetRole(role)}
                          style={{
                            padding: '6px 4px',
                            borderRadius: '4px',
                            border: active ? `1px solid ${accent}` : '1px solid #334155',
                            backgroundColor: active ? activeBg : '#1e293b',
                            color: active ? '#f8fafc' : '#94a3b8',
                            fontSize: '11px',
                            fontWeight: active ? 700 : 600,
                            cursor: 'pointer',
                            textTransform: 'capitalize'
                          }}
                        >
                          {role}
                        </button>
                      );
                    })}
                  </div>

                  {/* Standby Configuration */}
                  {currentRole === 'standby' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', paddingTop: '6px', borderTop: '1px solid #1e293b' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: '#c084fc', fontWeight: 600 }}>Watches Primary Transfer</label>
                        <select
                          value={selectedLink.primaryLinkId || ''}
                          onChange={e => {
                            const nextPrimaryId = e.target.value || undefined;
                            const nextPrimary = nextPrimaryId ? links.find(l => l.id === nextPrimaryId) : undefined;
                            if (nextPrimary && nextPrimary.sourceId !== selectedLink.sourceId && !activeTriggers.includes('source')) {
                              if (onUpdateLinkFields) {
                                onUpdateLinkFields(selectedLink.id, {
                                  primaryLinkId: nextPrimaryId,
                                  diversionTriggers: Array.from(new Set([...activeTriggers, 'source']))
                                });
                              } else {
                                onUpdateLink('primaryLinkId', nextPrimaryId);
                              }
                            } else {
                              onUpdateLink('primaryLinkId', nextPrimaryId);
                            }
                          }}
                          style={{ backgroundColor: '#1e293b', border: '1px solid rgba(168, 85, 247, 0.5)', borderRadius: '4px', color: '#f8fafc', padding: '6px', fontSize: '11px' }}
                        >
                          <option value="">-- Select primary link to watch --</option>
                          {watchablePrimaryLinks.map(l => {
                            const pSrc = nodes.find(n => n.id === l.sourceId);
                            const pTgt = nodes.find(n => n.id === l.targetId);
                            return (
                              <option key={l.id} value={l.id}>
                                {pSrc?.name || l.sourceId} → {pTgt?.name || l.targetId} ({Math.round(l.dailyRate).toLocaleString()} m³/d)
                              </option>
                            );
                          })}
                        </select>
                      </div>

                      <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                        <span style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600 }}>Spillover Activation Triggers</span>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '4px' }}>
                          {triggerOptions.map(opt => {
                            const checked = activeTriggers.includes(opt.key);
                            return (
                              <label
                                key={opt.key}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: '7px',
                                  padding: '4px 6px',
                                  borderRadius: '4px',
                                  backgroundColor: checked ? 'rgba(168, 85, 247, 0.12)' : '#1e293b',
                                  border: checked ? '1px solid rgba(168, 85, 247, 0.4)' : '1px solid #334155',
                                  fontSize: '10px',
                                  color: checked ? '#f3e8ff' : '#94a3b8',
                                  cursor: 'pointer'
                                }}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={e => handleToggleTrigger(opt.key, e.target.checked)}
                                  style={{ accentColor: '#a855f7', margin: 0 }}
                                />
                                <span>{opt.label}</span>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                      <div style={{ fontSize: '10px', color: '#94a3b8', lineHeight: 1.35 }}>
                        Dormant until the watched primary delivers less than planned due to a selected trigger; then diverts the unmet spillover remainder up to this link&apos;s Daily Rate.
                      </div>
                    </div>
                  )}

                  {/* Overflow Configuration */}
                  {currentRole === 'overflow' && srcNode && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', paddingTop: '6px', borderTop: '1px solid #1e293b' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px' }}>
                        <span style={{ fontSize: '11px', color: '#e9d5ff' }}>
                          Backup from <strong>{srcNode.name}</strong>
                        </span>
                        <button
                          type="button"
                          onClick={() => onSelectTargetElement('container', srcNode.id)}
                          style={{
                            background: 'none',
                            border: '1px solid #475569',
                            borderRadius: '4px',
                            color: '#38bdf8',
                            fontSize: '10px',
                            fontWeight: 600,
                            padding: '2px 6px',
                            cursor: 'pointer'
                          }}
                        >
                          Inspect Source
                        </button>
                      </div>
                      {srcNode.overflowMode === 'strict' && srcNode.strictSubRule === 'transfer_through' ? (
                        <div style={{ fontSize: '10px', color: '#d8b4fe', backgroundColor: 'rgba(168, 85, 247, 0.12)', border: '1px solid rgba(168, 85, 247, 0.35)', borderRadius: '4px', padding: '6px 8px', fontVariantNumeric: 'tabular-nums' }}>
                          Active when <strong>{srcNode.name}</strong> exceeds <strong>{srcNode.overflowTriggerPct ?? 100}%</strong> full ({Math.round(srcNode.capacity * ((srcNode.overflowTriggerPct ?? 100) / 100)).toLocaleString()} m³). Target <strong>{tgtNode?.name || selectedLink.targetId}</strong> drains via its normal outbound links.
                        </div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', backgroundColor: 'rgba(245, 158, 11, 0.10)', border: '1px solid rgba(245, 158, 11, 0.4)', borderRadius: '4px', padding: '7px 8px' }}>
                          <div style={{ fontSize: '10px', color: '#fde68a', lineHeight: 1.35 }}>
                            Source <strong>{srcNode.name}</strong> is currently set to <strong>{srcNode.overflowMode === 'overfill' ? 'Overfill' : (srcNode.strictSubRule || 'throttleback')}</strong>. Enable Transfer-Through on {srcNode.name} to activate this overflow link.
                          </div>
                          {onUpdateNodeById && (
                            <button
                              type="button"
                              onClick={() => onUpdateNodeById(srcNode.id, { overflowMode: 'strict', strictSubRule: 'transfer_through' })}
                              style={{
                                backgroundColor: 'rgba(168, 85, 247, 0.25)',
                                border: '1px solid #a855f7',
                                borderRadius: '4px',
                                color: '#f3e8ff',
                                fontSize: '10px',
                                fontWeight: 700,
                                padding: '5px 8px',
                                cursor: 'pointer'
                              }}
                            >
                              Enable Transfer-Through on {srcNode.name}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Primary link: show watching standbys */}
                  {currentRole === 'primary' && watchingStandbyLinks.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '6px', borderTop: '1px solid #1e293b' }}>
                      <span style={{ fontSize: '10px', fontWeight: 700, color: '#c084fc', textTransform: 'uppercase' }}>
                        Watched by Standby Links ({watchingStandbyLinks.length})
                      </span>
                      {watchingStandbyLinks.map(stby => {
                        const sSrc = nodes.find(n => n.id === stby.sourceId);
                        const sTgt = nodes.find(n => n.id === stby.targetId);
                        return (
                          <button
                            key={stby.id}
                            type="button"
                            onClick={() => onSelectTargetElement('transfer', stby.id)}
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              padding: '5px 8px',
                              backgroundColor: 'rgba(168, 85, 247, 0.10)',
                              border: '1px solid rgba(168, 85, 247, 0.35)',
                              borderRadius: '4px',
                              color: '#e9d5ff',
                              fontSize: '10px',
                              cursor: 'pointer'
                            }}
                          >
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              P{stby.priority ?? 1}: {sSrc?.name || stby.sourceId} → {sTgt?.name || stby.targetId}
                            </span>
                            <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0, marginLeft: '6px' }}>
                              {Math.round(stby.dailyRate).toLocaleString()} m³/d
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Daily Rate (m³/day)</label>
                  <input type="number" value={selectedLink.dailyRate} onChange={e => onUpdateLink('dailyRate', Number(e.target.value))} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Fleet Count</label>
                    <input type="number" min={0} value={selectedLink.fleetCount} onChange={e => onUpdateLink('fleetCount', Math.max(0, Number(e.target.value) || 0))} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }} />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Priority (1 = High)</label>
                    <input type="number" min={1} max={99} value={selectedLink.priority ?? 1} onChange={e => onUpdateLink('priority', Math.max(1, Math.round(Number(e.target.value) || 1)))} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }} />
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Material Override</label>
                  <select
                    value={selectedLink.materialId || ''}
                    onChange={e => onUpdateLink('materialId', e.target.value || undefined)}
                    style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }}
                  >
                    <option value="">Default (Inherit Source Material)</option>
                    {materials.map(mat => (
                      <option key={mat.code} value={mat.code}>
                        {mat.code} — {mat.name} (IN: {mat.bulkIN}, OUT: {mat.bulkOUT})
                      </option>
                    ))}
                  </select>
                </div>

                {/* Primary Route Corridors */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Primary Route Corridors</label>
                    <span style={{ fontSize: '10px', color: assignedIds.length > 0 ? '#38bdf8' : '#64748b', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {assignedIds.length > 0 ? `${assignedIds.length} active (auto-ordered)` : 'Direct Route'}
                    </span>
                  </div>
                  {corridors.length === 0 ? (
                    <div style={{ fontSize: '11px', color: '#64748b', backgroundColor: '#0f172a', padding: '10px', borderRadius: '4px', border: '1px solid #334155' }}>
                      No route corridors in model. Click <strong>+ route</strong> to create one.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', backgroundColor: '#0f172a', padding: '8px', borderRadius: '6px', border: '1px solid #334155', maxHeight: '160px', overflowY: 'auto' }}>
                      {corridors.map(corridor => {
                        const isChecked = assignedIds.includes(corridor.id);
                        const stepNum = stepOrderMap.get(corridor.id);
                        return (
                          <label
                            key={corridor.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '8px',
                              padding: '6px 8px',
                              borderRadius: '4px',
                              backgroundColor: isChecked ? 'rgba(56, 189, 248, 0.10)' : 'transparent',
                              border: isChecked ? '1px solid rgba(56, 189, 248, 0.35)' : '1px solid transparent',
                              cursor: 'pointer',
                              fontSize: '11px',
                              color: '#e2e8f0'
                            }}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={e => onToggleLinkCorridor(selectedLink.id, corridor.id, e.target.checked)}
                                style={{ accentColor: '#38bdf8', flexShrink: 0 }}
                              />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {corridor.name}
                              </span>
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                              {stepNum !== undefined && (
                                <span style={{ color: '#38bdf8', fontWeight: 700, fontSize: '10px' }}>
                                  #{stepNum}
                                </span>
                              )}
                              <span style={{ color: '#64748b', fontSize: '10px' }}>
                                {corridor.laneSpacing}px
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Backup Route Corridors (Spillover Detour) */}
                {corridors.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', backgroundColor: '#0f172a', padding: '10px', borderRadius: '6px', border: '1px solid #334155' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={{ fontSize: '11px', color: '#c084fc', fontWeight: 600 }}>Backup Route Corridors (Detour)</label>
                      <span style={{ fontSize: '10px', color: backupIds.length > 0 ? '#c084fc' : '#64748b', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {backupIds.length > 0 ? `${backupIds.length} detour` : 'None'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', maxHeight: '140px', overflowY: 'auto' }}>
                      {corridors.map(corridor => {
                        const isPrimary = assignedIds.includes(corridor.id);
                        const isBackup = backupIds.includes(corridor.id);
                        return (
                          <label
                            key={corridor.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: '8px',
                              padding: '5px 8px',
                              borderRadius: '4px',
                              backgroundColor: isBackup ? 'rgba(168, 85, 247, 0.14)' : 'transparent',
                              border: isBackup ? '1px solid rgba(168, 85, 247, 0.45)' : '1px solid transparent',
                              cursor: isPrimary ? 'not-allowed' : 'pointer',
                              opacity: isPrimary ? 0.45 : 1,
                              fontSize: '11px',
                              color: '#e2e8f0'
                            }}
                          >
                            <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                              <input
                                type="checkbox"
                                checked={isBackup}
                                disabled={isPrimary}
                                onChange={e => onToggleLinkBackupCorridor(selectedLink.id, corridor.id, e.target.checked)}
                                style={{ accentColor: '#a855f7', flexShrink: 0 }}
                              />
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {corridor.name}
                              </span>
                            </span>
                            {isPrimary && (
                              <span style={{ fontSize: '9px', color: '#38bdf8', fontWeight: 700, flexShrink: 0 }}>PRIMARY</span>
                            )}
                          </label>
                        );
                      })}
                    </div>

                    {backupIds.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', paddingTop: '6px', borderTop: '1px solid #1e293b' }}>
                        <label style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600 }}>Detour Rate Cap (m³/day, optional)</label>
                        <input
                          type="number"
                          min={0}
                          step={50}
                          placeholder={`Full spillover (up to ${Math.round(selectedLink.dailyRate).toLocaleString()} m³/d)`}
                          value={selectedLink.backupCorridorRate ?? ''}
                          onChange={e => {
                            const raw = e.target.value.trim();
                            onUpdateLink('backupCorridorRate', raw === '' ? undefined : Math.max(0, Number(raw) || 0));
                          }}
                          style={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '6px', fontSize: '11px', fontVariantNumeric: 'tabular-nums' }}
                        />
                        <div style={{ fontSize: '10px', color: '#94a3b8', lineHeight: 1.35 }}>
                          When a Primary Route is blocked or capped, unmet spillover automatically detours through these backup corridors.
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })()}

          {isPureSingleCorridor && selectedCorridor && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ fontSize: '12px', color: '#94a3b8', backgroundColor: '#0f172a', padding: '8px 12px', borderRadius: '4px' }}>
                Selected: <strong style={{ color: '#38bdf8' }}>Route Corridor</strong>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Corridor Name</label>
                <input
                  type="text"
                  value={selectedCorridor.name}
                  onChange={e => onUpdateCorridor('name', e.target.value)}
                  style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }}
                />
              </div>

              {/* Corridor Description Section */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Description</label>
                  <span style={{ fontSize: '10px', color: '#64748b' }}>Included in CSV export</span>
                </div>
                <textarea
                  value={selectedCorridor.notes || ''}
                  onChange={e => onUpdateCorridor('notes', e.target.value)}
                  placeholder="Route corridor grade, surface type, width constraints..."
                  rows={3}
                  style={{
                    backgroundColor: '#0f172a',
                    border: '1px solid #475569',
                    borderRadius: '4px',
                    color: '#f8fafc',
                    padding: '8px',
                    fontSize: '12px',
                    resize: 'vertical',
                    fontFamily: 'inherit',
                    lineHeight: 1.4
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Lane Spacing (px)</label>
                <input
                  type="number"
                  min={3}
                  max={24}
                  value={selectedCorridor.laneSpacing}
                  onChange={e => onUpdateCorridor('laneSpacing', Math.max(3, Math.min(24, Number(e.target.value) || 5)))}
                  style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}
                />
              </div>

              <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#38bdf8' }}>Baseline Route Limits</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Max Rate (m³/d)</label>
                    <input
                      type="number"
                      min={0}
                      step={50}
                      placeholder="Unlimited"
                      value={selectedCorridor.maxDailyRate ?? ''}
                      onChange={e => {
                        const raw = e.target.value.trim();
                        onUpdateCorridor('maxDailyRate', raw === '' ? undefined : Math.max(0, Number(raw) || 0));
                      }}
                      style={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '7px', fontSize: '11px', fontVariantNumeric: 'tabular-nums' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Max Fleet Units</label>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      placeholder="Unlimited"
                      value={selectedCorridor.maxFleetCount ?? ''}
                      onChange={e => {
                        const raw = e.target.value.trim();
                        onUpdateCorridor('maxFleetCount', raw === '' ? undefined : Math.max(1, Math.round(Number(raw) || 1)));
                      }}
                      style={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '7px', fontSize: '11px', fontVariantNumeric: 'tabular-nums' }}
                    />
                  </div>
                </div>
                <div style={{ fontSize: '10px', color: '#94a3b8', lineHeight: 1.4 }}>
                  Applied on days without a Route Calendar override. Calendar <strong>Open</strong> lifts baseline limits; <strong>Restricted</strong> overrides the rate cap.
                </div>
              </div>

              <div style={{ backgroundColor: '#0f172a', padding: '10px 12px', borderRadius: '6px', border: '1px solid #334155', fontSize: '11px', color: '#94a3b8', lineHeight: 1.45 }}>
                <div style={{ color: '#cbd5e1', fontWeight: 600, marginBottom: '2px', fontVariantNumeric: 'tabular-nums' }}>
                  Geometry ({selectedCorridor.waypoints.length} waypoints)
                </div>
                Drag the route band or label to move the whole route. Drag endpoints or bend handles to reshape; drag segment midpoints (+) to add bends or double-click a bend to remove it.
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Assigned Transfer Links</label>
                {links.length === 0 ? (
                  <div style={{ fontSize: '11px', color: '#64748b', backgroundColor: '#0f172a', padding: '10px', borderRadius: '4px', border: '1px solid #334155' }}>
                    No transfer links in model.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', backgroundColor: '#0f172a', padding: '8px', borderRadius: '6px', border: '1px solid #334155', maxHeight: '220px', overflowY: 'auto' }}>
                    {links.map(link => {
                      const src = nodes.find(n => n.id === link.sourceId);
                      const tgt = nodes.find(n => n.id === link.targetId);
                      const linkCorridorIds = getLinkCorridorIds(link);
                      const isAssignedHere = linkCorridorIds.includes(selectedCorridor.id);
                      const otherCount = linkCorridorIds.filter(id => id !== selectedCorridor.id).length;
                      return (
                        <label
                          key={link.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                            padding: '6px 8px',
                            borderRadius: '4px',
                            backgroundColor: isAssignedHere ? 'rgba(56, 189, 248, 0.10)' : 'transparent',
                            border: isAssignedHere ? '1px solid rgba(56, 189, 248, 0.35)' : '1px solid transparent',
                            cursor: 'pointer',
                            fontSize: '11px',
                            color: '#e2e8f0'
                          }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                            <input
                              type="checkbox"
                              checked={isAssignedHere}
                              onChange={e => onToggleLinkCorridor(link.id, selectedCorridor.id, e.target.checked)}
                              style={{ accentColor: '#38bdf8', flexShrink: 0 }}
                            />
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {src?.name || link.sourceId} → {tgt?.name || link.targetId}
                                {otherCount > 0 && (
                                  <span style={{ color: '#64748b', marginLeft: '6px', fontSize: '10px' }}>
                                    (+{otherCount} other route{otherCount > 1 ? 's' : ''})
                                  </span>
                                )}
                              </span>
                            </span>
                            <span style={{ color: '#94a3b8', fontSize: '10px', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                              {Math.round(link.dailyRate).toLocaleString()} m³/d
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}

            {isMixedOrMultiOther && (() => {
              const totalSelected = selectedNodeIds.length + selectedLinkIds.length + selectedCorridorIds.length;
              const linkedSelectedTransfers = selectedLinkIds.filter(id => {
                const link = links.find(l => l.id === id);
                return link ? getLinkCorridorIds(link).length > 0 : false;
              }).length;
              const activeCorridorLanes = links.filter(l =>
                getLinkCorridorIds(l).some(cid => selectedCorridorIds.includes(cid))
              ).length;

              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '6px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid #1e293b' }}>
                      <span style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#38bdf8' }}>
                        Selection Summary
                      </span>
                      <span style={{ fontSize: '12px', fontWeight: 700, color: '#f8fafc', fontVariantNumeric: 'tabular-nums' }}>
                        {totalSelected} selected
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', fontSize: '12px' }}>
                        <span style={{ color: '#94a3b8' }}>Containers</span>
                        <span style={{ color: selectedNodeIds.length > 0 ? '#f8fafc' : '#475569', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                          {selectedNodeIds.length}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: '1px solid #1e293b', fontSize: '12px' }}>
                        <span style={{ color: '#94a3b8' }}>
                          Transfer Links
                          {selectedLinkIds.length > 0 && linkedSelectedTransfers > 0 && (
                            <span style={{ color: '#64748b', fontSize: '11px', marginLeft: '6px' }}>
                              ({linkedSelectedTransfers} linked)
                            </span>
                          )}
                        </span>
                        <span style={{ color: selectedLinkIds.length > 0 ? '#f8fafc' : '#475569', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                          {selectedLinkIds.length}
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0', borderTop: '1px solid #1e293b', fontSize: '12px' }}>
                        <span style={{ color: '#94a3b8' }}>
                          Route Corridors
                          {selectedCorridorIds.length > 0 && activeCorridorLanes > 0 && (
                            <span style={{ color: '#64748b', fontSize: '11px', marginLeft: '6px' }}>
                              ({activeCorridorLanes} lane{activeCorridorLanes > 1 ? 's' : ''})
                            </span>
                          )}
                        </span>
                        <span style={{ color: selectedCorridorIds.length > 0 ? '#f8fafc' : '#475569', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                          {selectedCorridorIds.length}
                        </span>
                      </div>
                    </div>

                    <div style={{ borderTop: '1px solid #1e293b', paddingTop: '10px', fontSize: '11px', color: '#94a3b8', lineHeight: 1.45 }}>
                      Use <strong style={{ color: '#cbd5e1' }}>Ctrl/Cmd+click</strong> on the canvas to toggle containers, transfer links, or route corridors across types.
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px', paddingTop: '2px' }}>
                      <button
                        type="button"
                        onClick={onSetRouteLanes}
                        disabled={!canSetLanes}
                        style={{
                          backgroundColor: canSetLanes ? 'rgba(56, 189, 248, 0.14)' : '#1e293b',
                          color: canSetLanes ? '#7dd3fc' : '#475569',
                          border: canSetLanes ? '1px solid rgba(56, 189, 248, 0.45)' : '1px solid #334155',
                          borderRadius: '4px',
                          padding: '6px 8px',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: canSetLanes ? 'pointer' : 'not-allowed',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        + lanes
                      </button>
                      <button
                        type="button"
                        onClick={onUnlinkLanes}
                        disabled={!canUnlinkLanes}
                        style={{
                          backgroundColor: canUnlinkLanes ? 'rgba(245, 158, 11, 0.14)' : '#1e293b',
                          color: canUnlinkLanes ? '#fcd34d' : '#475569',
                          border: canUnlinkLanes ? '1px solid rgba(245, 158, 11, 0.45)' : '1px solid #334155',
                          borderRadius: '4px',
                          padding: '6px 8px',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: canUnlinkLanes ? 'pointer' : 'not-allowed',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        - lanes
                      </button>
                      <button
                        type="button"
                        onClick={onClearSelection}
                        style={{
                          backgroundColor: '#1e293b',
                          color: '#cbd5e1',
                          border: '1px solid #475569',
                          borderRadius: '4px',
                          padding: '6px 8px',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        Clear Selection
                      </button>
                      <button
                        type="button"
                        onClick={onDeleteSelected}
                        style={{
                          backgroundColor: 'rgba(239, 68, 68, 0.16)',
                          color: '#fca5a5',
                          border: '1px solid rgba(239, 68, 68, 0.45)',
                          borderRadius: '4px',
                          padding: '6px 8px',
                          fontSize: '11px',
                          fontWeight: 600,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        - element
                      </button>
                    </div>
                  </div>
                </div>
              );
            })()}

            {!hasSelection && !isCalendarEventSelected && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '250px', color: '#64748b', textAlign: 'center', fontSize: '12px', gap: '8px' }}>
                <div>No entity selected</div>
                <div style={{ fontSize: '11px' }}>Click containers, transfer links, route corridors, or calendar event bars to inspect and edit properties.</div>
              </div>
            )}
        </>
      )}
      </div>

      {!isPlayback && (
        <MaterialDrawer vm={vm} materials={materials} onMaterialsUpdated={onMaterialsUpdated} />
      )}
    </div>
  );
};