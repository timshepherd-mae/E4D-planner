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
  ClipboardData,
  getLinkCorridorIds
} from '../../models/types';
import { CanvasViewModel } from '../../viewmodel/CanvasViewModel';
import { resolveOrderedCorridorChain } from '../canvas/pipeRouter';
import { MaterialDrawer } from './MaterialDrawer';

interface PropertyInspectorProps {
  vm: CanvasViewModel;
  isPlayback: boolean;
  currentDay: number;
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
  onUpdateLink: (field: keyof TransferLink, val: any) => void;
  onUpdateCorridor: (field: keyof RouteCorridor, val: any) => void;
  onUpdateCalendarEvent: (eventId: string, updates: Partial<CalendarEvent>) => void;
  onDeleteCalendarEvent: (eventId: string) => void;
  onSelectTargetElement: (targetType: CalendarTargetType, targetId: string) => void;
  onToggleLinkCorridor: (linkId: string, corridorId: string, assign: boolean) => void;
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
  onUpdateLink,
  onUpdateCorridor,
  onUpdateCalendarEvent,
  onDeleteCalendarEvent,
  onSelectTargetElement,
  onToggleLinkCorridor,
  onSetRouteLanes,
  onUnlinkLanes,
  onDeleteSelected,
  onClearSelection,
  onMaterialsUpdated,
}) => {
  const isCalendarEventSelected = Boolean(selectedCalendarEvent);
  const isPureNode = !isCalendarEventSelected && selectedNodeIds.length > 0 && selectedLinkIds.length === 0 && selectedCorridorIds.length === 0;
  const isPureSingleLink = !isCalendarEventSelected && selectedNodeIds.length === 0 && selectedLinkIds.length === 1 && selectedCorridorIds.length === 0;
  const isPureSingleCorridor = !isCalendarEventSelected && selectedNodeIds.length === 0 && selectedLinkIds.length === 0 && selectedCorridorIds.length === 1;
  const isMixedOrMultiOther = !isCalendarEventSelected && hasSelection && !isPureNode && !isPureSingleLink && !isPureSingleCorridor;

  const getCalendarTargetInfo = (evt: CalendarEvent): { typeLabel: string; name: string; baseSummary: string } => {
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
    return {
      typeLabel: 'Route Corridor',
      name: corridor?.name || evt.targetId,
      baseSummary: `${assignedLinks.length} transfer${assignedLinks.length === 1 ? '' : 's'} · ${Math.round(combinedRate).toLocaleString()} m³/d combined`
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
      31
    );
    const minAllowed = prevEnd + 1;
    const maxAllowed = nextStart - 1;
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
    <div style={{ flex: 1, backgroundColor: '#1e293b', borderLeft: '1px solid #334155', display: 'flex', flexDirection: 'column', color: '#f8fafc', padding: '20px', boxSizing: 'border-box', overflowY: 'auto', minWidth: '320px', height: '100%', position: 'relative' }}>
      
      {/* Header with Title and Copy/Paste Actions */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        marginBottom: '16px',
        borderBottom: '1px solid #334155',
        paddingBottom: '12px',
        minHeight: '36px'
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

      {isPlayback ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155' }}>
            <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600, marginBottom: '4px' }}>TIMELINE STATUS</div>
            <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#22c55e' }}>Day {currentDay} of 30</div>
          </div>

          {/* Selected Calendar Event Read-Only Inspection in Playback */}
          {selectedCalendarEvent && (() => {
            const info = getCalendarTargetInfo(selectedCalendarEvent);
            const isActiveToday =
              currentDay >= 1 &&
              currentDay >= selectedCalendarEvent.startDay &&
              currentDay <= selectedCalendarEvent.endDay;
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
                <div style={{ fontSize: '13px', fontWeight: 700, color: '#f8fafc' }}>{info.name}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                  <span>Schedule Window:</span>
                  <span style={{ fontWeight: 600 }}>Day {selectedCalendarEvent.startDay} – Day {selectedCalendarEvent.endDay}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1' }}>
                  <span>State Override:</span>
                  <span style={{ fontWeight: 700, textTransform: 'uppercase', color: selectedCalendarEvent.state === 'blocked' || selectedCalendarEvent.state === 'stopped' ? '#ef4444' : selectedCalendarEvent.state === 'restricted' || selectedCalendarEvent.state === 'variable' ? '#f59e0b' : '#22c55e' }}>
                    {selectedCalendarEvent.state}
                  </span>
                </div>
                {(selectedCalendarEvent.state === 'variable' || selectedCalendarEvent.state === 'restricted') && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                    <span>{selectedCalendarEvent.state === 'restricted' ? 'Combined Cap:' : 'Target Rate:'}</span>
                    <span style={{ fontWeight: 600 }}>{Math.round(selectedCalendarEvent.rateValue ?? 0).toLocaleString()} m³/d</span>
                  </div>
                )}
                {selectedCalendarEvent.notes && (
                  <div style={{ marginTop: '2px', padding: '8px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid #334155', fontSize: '11px', color: '#cbd5e1' }}>
                    <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>NOTES</div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{selectedCalendarEvent.notes}</div>
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
            const statusConfig = {
              full: { label: 'Flowing at Full Rate', color: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)', border: '#22c55e' },
              restricted: { label: 'Flowing at Restricted Rate', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', border: '#f59e0b' },
              blocked: { label: activeCalEvt?.state === 'blocked' ? 'Blocked (Calendar Event)' : 'Blocked (Capacity Constraint)', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', border: '#ef4444' },
              starved: { label: 'Cannot Deliver (Lack of Material)', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              frozen: { label: currentDay === 0 ? 'Day 0 (Frozen)' : 'Inactive / Idle', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              idle: { label: 'Idle', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' }
            }[nodeStatus] || { label: 'Frozen', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' };

            const fillPct = Math.min(100, Math.round((liveVol / singleSelectedNode.capacity) * 100));

            return (
              <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>CONTAINER TELEMETRY</div>
                <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#f8fafc' }}>{singleSelectedNode.name}</div>
                
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderRadius: '4px', backgroundColor: statusConfig.bg, border: `1px solid ${statusConfig.border}`, color: statusConfig.color, fontSize: '11px', fontWeight: 600, width: 'fit-content' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: statusConfig.color }} />
                  {statusConfig.label}
                </div>

                {activeCalEvt && (
                  <div style={{ fontSize: '11px', color: '#fde68a', backgroundColor: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)', borderRadius: '4px', padding: '5px 8px', fontVariantNumeric: 'tabular-nums' }}>
                    Calendar override: <strong style={{ textTransform: 'uppercase' }}>{activeCalEvt.state}</strong> (D{activeCalEvt.startDay}–D{activeCalEvt.endDay})
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                  <span>Live Volume:</span>
                  <span style={{ fontWeight: 600 }}>{Math.round(liveVol).toLocaleString()} / {Math.round(singleSelectedNode.capacity).toLocaleString()} m³ ({fillPct}%)</span>
                </div>
                <div style={{ width: '100%', height: '8px', backgroundColor: '#334155', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ width: `${Math.min(100, fillPct)}%`, height: '100%', backgroundColor: liveVol > singleSelectedNode.capacity ? '#ef4444' : (singleSelectedNode.type === 'excavation' ? '#0d9488' : singleSelectedNode.type === 'stockpile' ? '#b45309' : '#475569') }} />
                </div>
                {singleSelectedNode.notes && (
                  <div style={{ marginTop: '2px', padding: '8px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid #334155', fontSize: '11px', color: '#cbd5e1' }}>
                    <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>NOTES</div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{singleSelectedNode.notes}</div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Selected Transfer Link Live Telemetry */}
          {selectedLink && (() => {
            const linkFlow = currentFrame ? (currentFrame.linkFlows[selectedLink.id] ?? 0) : 0;
            const linkStatus = currentFrame?.linkStatuses?.[selectedLink.id] ?? 'frozen';
            const source = vm.getNodes().find(n => n.id === selectedLink.sourceId);
            const target = vm.getNodes().find(n => n.id === selectedLink.targetId);
            const activeCalEvt = getActiveCalendarEventForTarget('transfer', selectedLink.id);

            const statusConfig = {
              full: { label: 'Flowing at Full Rate', color: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)', border: '#22c55e' },
              restricted: { label: 'Flowing at Restricted Rate', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', border: '#f59e0b' },
              blocked: { label: activeCalEvt?.state === 'stopped' ? 'Stopped (Calendar Event)' : 'Blocked (Capacity / Schedule)', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', border: '#ef4444' },
              starved: { label: 'Cannot Deliver (Lack of Material)', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              frozen: { label: currentDay === 0 ? 'Day 0 (Frozen)' : 'Inactive / Idle', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              idle: { label: 'Idle', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' }
            }[linkStatus] || { label: 'Frozen', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' };

            return (
              <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>TRANSFER LINK TELEMETRY</div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#f8fafc' }}>{source?.name ?? 'Source'} → {target?.name ?? 'Target'}</div>

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

                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                  <span>Transfer Rate:</span>
                  <span style={{ fontWeight: 600 }}>{Math.round(linkFlow).toLocaleString()} / {Math.round(selectedLink.dailyRate).toLocaleString()} m³/d</span>
                </div>
                {selectedLink.notes && (
                  <div style={{ marginTop: '2px', padding: '8px', backgroundColor: 'rgba(255,255,255,0.03)', borderRadius: '4px', border: '1px solid #334155', fontSize: '11px', color: '#cbd5e1' }}>
                    <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: 600, marginBottom: '2px' }}>NOTES</div>
                    <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.4 }}>{selectedLink.notes}</div>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Selected Route Corridor Live Telemetry */}
          {selectedCorridor && (() => {
            const assignedLinks = links.filter(l => getLinkCorridorIds(l).includes(selectedCorridor.id));
            const combinedLiveFlow = assignedLinks.reduce((sum, l) => sum + (currentFrame?.linkFlows?.[l.id] ?? 0), 0);
            const combinedPlanned = assignedLinks.reduce((sum, l) => sum + l.dailyRate, 0);
            const corridorStatus = currentFrame?.corridorStatuses?.[selectedCorridor.id] ?? 'frozen';
            const activeCalEvt = getActiveCalendarEventForTarget('route', selectedCorridor.id);

            const statusConfig = {
              full: { label: 'Open / Flowing at Full Rate', color: '#22c55e', bg: 'rgba(34, 197, 94, 0.15)', border: '#22c55e' },
              restricted: { label: 'Restricted Route Cap Active', color: '#f59e0b', bg: 'rgba(245, 158, 11, 0.15)', border: '#f59e0b' },
              blocked: { label: 'Route Blocked', color: '#ef4444', bg: 'rgba(239, 68, 68, 0.15)', border: '#ef4444' },
              starved: { label: 'Assigned Sources Starved', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              frozen: { label: currentDay === 0 ? 'Day 0 (Frozen)' : 'Idle / No Flow', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' },
              idle: { label: 'Idle', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' }
            }[corridorStatus] || { label: 'Frozen', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.15)', border: '#38bdf8' };

            return (
              <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>ROUTE CORRIDOR TELEMETRY</div>
                <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#f8fafc' }}>{selectedCorridor.name}</div>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderRadius: '4px', backgroundColor: statusConfig.bg, border: `1px solid ${statusConfig.border}`, color: statusConfig.color, fontSize: '11px', fontWeight: 600, width: 'fit-content' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: statusConfig.color }} />
                  {statusConfig.label}
                </div>
                {activeCalEvt && (
                  <div style={{ fontSize: '11px', color: '#fde68a', backgroundColor: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)', borderRadius: '4px', padding: '5px 8px', fontVariantNumeric: 'tabular-nums' }}>
                    Calendar override: <strong style={{ textTransform: 'uppercase' }}>{activeCalEvt.state}</strong>
                    {activeCalEvt.state === 'restricted' ? ` (Cap ${Math.round(activeCalEvt.rateValue ?? 0).toLocaleString()} m³/d pro-rata)` : ''} · D{activeCalEvt.startDay}–D{activeCalEvt.endDay}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#cbd5e1', fontVariantNumeric: 'tabular-nums' }}>
                  <span>Combined Corridor Flow:</span>
                  <span style={{ fontWeight: 600 }}>{Math.round(combinedLiveFlow).toLocaleString()} / {Math.round(combinedPlanned).toLocaleString()} m³/d</span>
                </div>
              </div>
            );
          })()}

          {/* Color Key Reference */}
          <div style={{ backgroundColor: '#0f172a', padding: '12px', borderRadius: '6px', border: '1px solid #334155' }}>
            <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600, marginBottom: '8px' }}>SIMULATION COLOR KEY</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#38bdf8' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#38bdf8', display: 'inline-block' }} />
                <span><strong>Blue:</strong> Day 0 (Frozen) / Lack of Material</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#22c55e' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#22c55e', display: 'inline-block' }} />
                <span><strong>Green:</strong> Flowing at full rate</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#f59e0b' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#f59e0b', display: 'inline-block' }} />
                <span><strong>Amber:</strong> Flowing at restricted rate</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#ef4444' }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#ef4444', display: 'inline-block' }} />
                <span><strong>Red:</strong> Blocked due to capacity issues</span>
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
              if (nextState === 'variable' && (selectedCalendarEvent.rateValue === undefined || isNaN(selectedCalendarEvent.rateValue))) {
                updates.rateValue = targetLink ? Math.round((targetLink.dailyRate * 0.5) / 50) * 50 : 500;
              } else if (nextState === 'restricted' && (selectedCalendarEvent.rateValue === undefined || isNaN(selectedCalendarEvent.rateValue))) {
                const assigned = links.filter(l => getLinkCorridorIds(l).includes(selectedCalendarEvent.targetId));
                const combined = assigned.reduce((s, l) => s + l.dailyRate, 0);
                updates.rateValue = combined > 0 ? Math.max(50, Math.round((combined * 0.5) / 50) * 50) : 1000;
              }
              onUpdateCalendarEvent(selectedCalendarEvent.id, updates);
            };

            const durationDays = selectedCalendarEvent.endDay - selectedCalendarEvent.startDay + 1;

            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', paddingBottom: '120px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '12px', color: '#94a3b8', backgroundColor: '#0f172a', padding: '8px 12px', borderRadius: '4px', border: '1px solid #334155' }}>
                  <span>
                    Selected: <strong style={{ color: '#38bdf8' }}>Calendar Event</strong>
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

                {/* Start / End Day Controls */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Start Day (1–30)</label>
                    <input
                      type="number"
                      min={1}
                      max={30}
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
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>End Day (1–30)</label>
                    <input
                      type="number"
                      min={1}
                      max={30}
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
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Scheduled State</label>
                  <select
                    value={selectedCalendarEvent.state}
                    onChange={e => handleStateChange(e.target.value as CalendarEventState)}
                    style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px', fontWeight: 600 }}
                  >
                    {selectedCalendarEvent.targetType === 'container' && (
                      <>
                        <option value="open">Open (Normal Inbound & Outbound)</option>
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

                {/* Conditional Rate Value input */}
                {((selectedCalendarEvent.targetType === 'transfer' && selectedCalendarEvent.state === 'variable') ||
                  (selectedCalendarEvent.targetType === 'route' && selectedCalendarEvent.state === 'restricted')) && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>
                      {selectedCalendarEvent.targetType === 'route'
                        ? 'Combined Route Daily Cap (m³/day)'
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
                        ? 'Splits this combined daily rate cap pro-rata across all active transfers assigned to this route.'
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
                    placeholder="e.g. Plant Service, Rain Delay, Night Shift..."
                    style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }}
                  />
                </div>

                {/* Event Notes */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Notes</label>
                    <span style={{ fontSize: '10px', color: '#64748b' }}>Included in CSV export</span>
                  </div>
                  <textarea
                    value={selectedCalendarEvent.notes || ''}
                    onChange={e => onUpdateCalendarEvent(selectedCalendarEvent.id, { notes: e.target.value })}
                    placeholder="Scheduling reason, permit window, traffic restriction details..."
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', paddingBottom: '150px' }}>
              <div style={{ fontSize: '12px', color: '#94a3b8', backgroundColor: '#0f172a', padding: '8px 12px', borderRadius: '4px' }}>
                Selected: <strong style={{ color: '#38bdf8' }}>Container Node</strong>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Node Name</label>
                <input type="text" value={singleSelectedNode.name} onChange={e => onUpdateSingleNode('name', e.target.value)} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Container Type</label>
                <select value={singleSelectedNode.type} onChange={e => onUpdateSingleNode('type', e.target.value as any)} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }}>
                  <option value="excavation">Excavation (Cut)</option>
                  <option value="stockpile">Stockpile (Fill)</option>
                  <option value="null">Null Junction</option>
                  <option value="external">External Boundary</option>
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
                      </select>
                    </div>

                    {singleSelectedNode.strictSubRule === 'headroom_hold' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Required Spare Space (m³)</label>
                        <input
                          type="number"
                          value={singleSelectedNode.headroomThreshold ?? 500}
                          onChange={e => onUpdateSingleNode('headroomThreshold', Number(e.target.value))}
                          style={{ backgroundColor: '#1e293b', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '6px', fontSize: '11px' }}
                        />
                      </div>
                    )}
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

              {/* Container Notes Section */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Notes</label>
                  <span style={{ fontSize: '10px', color: '#64748b' }}>Included in CSV export</span>
                </div>
                <textarea
                  value={singleSelectedNode.notes || ''}
                  onChange={e => onUpdateSingleNode('notes', e.target.value)}
                  placeholder="Operational notes, geotechnical constraints, equipment assignments..."
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

          {isPureSingleLink && selectedLink && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ fontSize: '12px', color: '#94a3b8', backgroundColor: '#0f172a', padding: '8px 12px', borderRadius: '4px' }}>
                Selected: <strong style={{ color: '#38bdf8' }}>Transfer Link</strong>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Daily Rate (m³/day)</label>
                <input type="number" value={selectedLink.dailyRate} onChange={e => onUpdateLink('dailyRate', Number(e.target.value))} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Fleet Count</label>
                <input type="number" value={selectedLink.fleetCount} onChange={e => onUpdateLink('fleetCount', Number(e.target.value))} style={{ backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '4px', color: '#f8fafc', padding: '8px', fontSize: '12px' }} />
              </div>

              {(() => {
                const assignedIds = getLinkCorridorIds(selectedLink);
                const srcNode = nodes.find(n => n.id === selectedLink.sourceId);
                const tgtNode = nodes.find(n => n.id === selectedLink.targetId);
                const assignedCorridors = assignedIds
                  .map(id => corridors.find(c => c.id === id))
                  .filter((c): c is RouteCorridor => Boolean(c));
                const orderedChain =
                  srcNode && tgtNode
                    ? resolveOrderedCorridorChain(srcNode, tgtNode, assignedCorridors)
                    : [];
                const stepOrderMap = new Map(orderedChain.map((step, idx) => [step.corridor.id, idx + 1]));

                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Route Corridors</label>
                      <span style={{ fontSize: '10px', color: assignedIds.length > 0 ? '#38bdf8' : '#64748b', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {assignedIds.length > 0 ? `${assignedIds.length} active (auto-ordered)` : 'Direct Route'}
                      </span>
                    </div>
                    {corridors.length === 0 ? (
                      <div style={{ fontSize: '11px', color: '#64748b', backgroundColor: '#0f172a', padding: '10px', borderRadius: '4px', border: '1px solid #334155' }}>
                        No route corridors in model. Click <strong>+ route</strong> to create one.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', backgroundColor: '#0f172a', padding: '8px', borderRadius: '6px', border: '1px solid #334155', maxHeight: '200px', overflowY: 'auto' }}>
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
                );
              })()}

              {/* Transfer Link Notes Section */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Notes</label>
                  <span style={{ fontSize: '10px', color: '#64748b' }}>Included in CSV export</span>
                </div>
                <textarea
                  value={selectedLink.notes || ''}
                  onChange={e => onUpdateLink('notes', e.target.value)}
                  placeholder="Transfer route notes, corridor conditions, speed restrictions..."
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
            </div>
          )}

          {isPureSingleCorridor && selectedCorridor && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', paddingBottom: '120px' }}>
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

                <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <label style={{ fontSize: '11px', color: '#94a3b8', fontWeight: 600 }}>Notes</label>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', paddingBottom: '120px' }}>
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

      {!isPlayback && (
        <MaterialDrawer vm={vm} materials={materials} onMaterialsUpdated={onMaterialsUpdated} />
      )}
    </div>
  );
};