import React, { useState } from 'react';
import { ContainerNode, TransferLink, RouteCorridor, CalendarModel, SimFrame, MaterialDefinition, FlowStatus, getLinkCorridorIds, getLinkBackupCorridorIds, getLinkRole } from '../../models/types';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  nodes: ContainerNode[];
  links: TransferLink[];
  corridors?: RouteCorridor[];
  calendar?: CalendarModel;
  frames: SimFrame[];
  materials: MaterialDefinition[];
}

export const getStatusMeta = (status: FlowStatus = 'frozen', day: number = 0) => {
  switch (status) {
    case 'full':
      return {
        state: 'full',
        label: 'Flowing at full rate',
        colour: 'Green',
        hex: '#22c55e'
      };
    case 'restricted':
      return {
        state: 'restricted',
        label: 'Flowing at restricted rate',
        colour: 'Amber',
        hex: '#f59e0b'
      };
    case 'blocked':
      return {
        state: 'blocked',
        label: 'Blocked from sending/receiving due to capacity',
        colour: 'Red',
        hex: '#ef4444'
      };
    case 'diverted':
      return {
        state: 'diverted',
        label: 'Diverted / Detour / Transfer-Through active',
        colour: 'Violet',
        hex: '#a855f7'
      };
    case 'starved':
      return {
        state: 'starved',
        label: 'Cannot deliver due to lack of material',
        colour: 'Blue',
        hex: '#38bdf8'
      };
    case 'idle':
      return {
        state: 'idle',
        label: 'Standby / Overflow (Dormant)',
        colour: 'Slate',
        hex: '#64748b'
      };
    case 'frozen':
    default:
      return {
        state: day === 0 ? 'frozen' : 'idle',
        label: day === 0 ? 'Day 0 (frozen)' : 'Inactive / Idle',
        colour: 'Blue',
        hex: '#38bdf8'
      };
  }
};

export const ExportModal: React.FC<ExportModalProps> = ({
  isOpen,
  onClose,
  nodes,
  links,
  corridors = [],
  calendar,
  frames,
  materials
}) => {
  const [filename, setFilename] = useState('material_transfer_sim_diagnostics');
  const [exportScope, setExportScope] = useState<'all' | 'model' | 'telemetry'>('all');
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv');
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [copiedSuccess, setCopiedSuccess] = useState(false);

  if (!isOpen) return null;

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const linkMap = new Map(links.map(l => [l.id, l]));
  const matMap = new Map(materials.map(m => [m.code, m]));

  const generateCSV = (): string => {
    const lines: string[] = [];
    const timestamp = new Date().toISOString();

    lines.push(`# Material Transfer Simulation Comprehensive Model & Diagnostics Export`);
    lines.push(`# Exported: ${timestamp}`);
    lines.push(`# Scope: ${exportScope}`);
    lines.push(`# Color Key: Blue (#38bdf8) = Day 0 / Starved (lack of material), Green (#22c55e) = Full rate, Violet (#a855f7) = Diverted / Detour / Transfer-Through, Amber (#f59e0b) = Restricted rate, Red (#ef4444) = Blocked (capacity), Slate (#64748b) = Standby / Overflow (dormant)`);
    lines.push('');

    // Model configuration (materials, nodes and links)
    if (exportScope === 'all' || exportScope === 'model') {
      // 1. Material definitions and bulking factors
      lines.push('# SECTION: MATERIALS');
      lines.push('Code,Name,BulkIN,BulkOUT');
      materials.forEach(m => {
        const escapedName = `"${(m.name || '').replace(/"/g, '""')}"`;
        lines.push(`${m.code.toUpperCase()},${escapedName},${m.bulkIN},${m.bulkOUT}`);
      });
      lines.push('');

      // 2. Container nodes with all properties
      lines.push('# SECTION: INITIAL MODEL NODES');
      lines.push('NodeID,Name,Type,X,Y,Capacity,InitialVolume,MaterialType,PlantCount,OverflowMode,StrictSubRule,HeadroomThreshold,Status,InitialSimState,InitialColour,InitialColourHex,Notes,OutputEdge,InputEdge,AllowedMaterials,OverflowTriggerPct');
      const day0Frame = frames[0];
      nodes.forEach(n => {
        const escapedName = `"${(n.name || '').replace(/"/g, '""')}"`;
        const escapedMaterial = `"${(n.materialType || '').replace(/"/g, '""')}"`;
        const overflow = n.overflowMode || 'strict';
        const strictSub = n.strictSubRule || 'throttleback';
        const headroom = n.headroomThreshold ?? 500;
        const status = n.status || 'active';
        const day0Status: FlowStatus = day0Frame?.nodeStatuses?.[n.id] ?? 'frozen';
        const meta = getStatusMeta(day0Status, 0);
        const escapedNotes = `"${(n.notes || '').replace(/"/g, '""')}"`;
        const outputEdge = n.outputEdge || '';
        const inputEdge = n.inputEdge || '';
        const allowedMats = n.allowedMaterials && n.allowedMaterials.length > 0
          ? `"${n.allowedMaterials.join('|').replace(/"/g, '""')}"`
          : '""';
        const overflowTriggerPct = n.overflowTriggerPct !== undefined ? `${n.overflowTriggerPct}` : '';
        lines.push(`${n.id},${escapedName},${n.type},${n.x},${n.y},${n.capacity},${n.currentVolume},${escapedMaterial},${n.plantCount},${overflow},${strictSub},${headroom},${status},${meta.state},${meta.colour},${meta.hex},${escapedNotes},${outputEdge},${inputEdge},${allowedMats},${overflowTriggerPct}`);
      });
      lines.push('');

      // 3. Route corridors
      lines.push('# SECTION: CORRIDORS');
      lines.push('CorridorID,Name,LaneSpacing,WaypointsJSON,Notes,MaxDailyRate,MaxFleetCount');
      corridors.forEach(c => {
        const escapedName = `"${(c.name || '').replace(/"/g, '""')}"`;
        const escapedWaypoints = `"${JSON.stringify(c.waypoints || []).replace(/"/g, '""')}"`;
        const escapedNotes = `"${(c.notes || '').replace(/"/g, '""')}"`;
        const maxRate = c.maxDailyRate !== undefined && Number.isFinite(c.maxDailyRate) ? `${c.maxDailyRate}` : '';
        const maxFleet = c.maxFleetCount !== undefined && Number.isFinite(c.maxFleetCount) ? `${c.maxFleetCount}` : '';
        lines.push(`${c.id},${escapedName},${c.laneSpacing},${escapedWaypoints},${escapedNotes},${maxRate},${maxFleet}`);
      });
      lines.push('');

      // 4. Transfer pipelines / links
      lines.push('# SECTION: INITIAL MODEL LINKS');
      lines.push('LinkId,SourceId,TargetId,DailyRate,FleetCount,Priority,MaterialId,InitialSimState,InitialColour,InitialColourHex,Notes,CorridorId,LinkRole,PrimaryLinkId,DiversionTriggers,BackupCorridorIds,BackupCorridorRate');
      links.forEach(l => {
        const priority = l.priority ?? 1;
        const matId = l.materialId ? `"${l.materialId.replace(/"/g, '""')}"` : '""';
        const day0Status: FlowStatus = day0Frame?.linkStatuses?.[l.id] ?? 'frozen';
        const meta = getStatusMeta(day0Status, 0);
        const escapedNotes = `"${(l.notes || '').replace(/"/g, '""')}"`;
        const linkCorridorIds = getLinkCorridorIds(l);
        const corridorIdVal = linkCorridorIds.length > 0 ? `"${linkCorridorIds.join('|').replace(/"/g, '""')}"` : '""';
        const linkRole = getLinkRole(l);
        const primaryLinkId = l.primaryLinkId ? `"${l.primaryLinkId.replace(/"/g, '""')}"` : '""';
        const triggersVal = l.diversionTriggers && l.diversionTriggers.length > 0
          ? `"${l.diversionTriggers.join('|')}"`
          : '""';
        const backupCorridorIds = getLinkBackupCorridorIds(l);
        const backupCorridorVal = backupCorridorIds.length > 0
          ? `"${backupCorridorIds.join('|').replace(/"/g, '""')}"`
          : '""';
        const backupRateVal = l.backupCorridorRate !== undefined && Number.isFinite(l.backupCorridorRate)
          ? `${l.backupCorridorRate}`
          : '';
        lines.push(`${l.id},${l.sourceId},${l.targetId},${l.dailyRate},${l.fleetCount},${priority},${matId},${meta.state},${meta.colour},${meta.hex},${escapedNotes},${corridorIdVal},${linkRole},${primaryLinkId},${triggersVal},${backupCorridorVal},${backupRateVal}`);
      });
      lines.push('');

      // 5. Calendar parent metadata
      const cal: CalendarModel = calendar || { id: 'calendar-1', name: 'Project Schedule', events: [] };
      lines.push('# SECTION: CALENDAR');
      lines.push('CalendarID,Name,Notes');
      const escapedCalName = `"${(cal.name || 'Project Schedule').replace(/"/g, '""')}"`;
      const escapedCalNotes = `"${(cal.notes || '').replace(/"/g, '""')}"`;
      lines.push(`${cal.id},${escapedCalName},${escapedCalNotes}`);
      lines.push('');

      // 6. Calendar Events (children of Calendar)
      lines.push('# SECTION: CALENDAR EVENTS');
      lines.push('EventID,CalendarID,TargetType,TargetID,StartDay,EndDay,State,RateValue,Label,Notes');
      (cal.events || []).forEach(evt => {
        const rateStr = evt.rateValue !== undefined && Number.isFinite(evt.rateValue) ? `${evt.rateValue}` : '';
        const escapedLabel = `"${(evt.label || '').replace(/"/g, '""')}"`;
        const escapedEvtNotes = `"${(evt.notes || '').replace(/"/g, '""')}"`;
        lines.push(`${evt.id},${evt.calendarId || cal.id},${evt.targetType},${evt.targetId},${evt.startDay},${evt.endDay},${evt.state},${rateStr},${escapedLabel},${escapedEvtNotes}`);
      });
      lines.push('');
    }

    // Simulation telemetry log with exact colour and simulation state on each record
    if (exportScope === 'all' || exportScope === 'telemetry') {
      // 4. Daily Container Records with SimState, Colour, ColourHex, and StateDescription
      lines.push('# SECTION: SIMULATION DAILY NODE VOLUMES');
      lines.push('Day,NodeID,NodeName,NodeType,MaterialType,BulkIN,BulkOUT,OverflowMode,StrictSubRule,Volume_m3,Capacity_m3,Utilization_pct,OverflowOut_m3,SimState,Colour,ColourHex,StateDescription');
      frames.forEach(frame => {
        Object.entries(frame.nodeVolumes || {}).forEach(([nodeId, volume]) => {
          const node = nodeMap.get(nodeId);
          const name = node ? `"${node.name.replace(/"/g, '""')}"` : nodeId;
          const type = node ? node.type : 'unknown';
          const matCode = node ? node.materialType : '';
          const matDef = matMap.get(matCode);
          const bulkIn = matDef ? matDef.bulkIN : 1.0;
          const bulkOut = matDef ? matDef.bulkOUT : 1.0;
          const overflow = node ? (node.overflowMode || 'strict') : 'strict';
          const strictSub = node ? (node.strictSubRule || 'throttleback') : 'throttleback';
          const cap = node ? node.capacity : 0;
          const pct = cap > 0 ? ((volume / cap) * 100).toFixed(1) : '0.0';
          const overflowOut = Math.round(frame.overflowActiveNodes?.[nodeId] ?? 0);

          const nodeStatus: FlowStatus = frame.nodeStatuses?.[nodeId] ?? (frame.day === 0 ? 'frozen' : 'idle');
          const meta = getStatusMeta(nodeStatus, frame.day);

          lines.push(`${frame.day},${nodeId},${name},${type},"${matCode}",${bulkIn},${bulkOut},${overflow},${strictSub},${Math.round(volume)},${cap},${pct}%,${overflowOut},${meta.state},${meta.colour},${meta.hex},"${meta.label}"`);
        });
      });
      lines.push('');

      // 5. Daily Transfer Records with SimState, Colour, ColourHex, and StateDescription
      lines.push('# SECTION: SIMULATION DAILY LINK FLOWS');
      lines.push('Day,LinkID,LinkRole,SourceNodeID,SourceName,TargetNodeID,TargetName,PlannedRate_m3d,Transferred_m3,PrimaryRouteFlow_m3,DetourRouteFlow_m3,SimState,Colour,ColourHex,StateDescription');
      frames.forEach(frame => {
        Object.entries(frame.linkFlows || {}).forEach(([linkId, flow]) => {
          const link = linkMap.get(linkId);
          const linkRole = link ? getLinkRole(link) : 'primary';
          const src = link ? link.sourceId : '';
          const tgt = link ? link.targetId : '';
          const srcNode = nodeMap.get(src);
          const tgtNode = nodeMap.get(tgt);
          const srcName = srcNode ? `"${srcNode.name.replace(/"/g, '""')}"` : src;
          const tgtName = tgtNode ? `"${tgtNode.name.replace(/"/g, '""')}"` : tgt;
          const plannedRate = link ? link.dailyRate : 0;
          const split = frame.linkRouteSplits?.[linkId];
          const primaryFlow = split ? Math.round(split.primaryFlow) : Math.round(flow);
          const detourFlow = split ? Math.round(split.backupFlow) : 0;

          const linkStatus: FlowStatus = frame.linkStatuses?.[linkId] ?? (frame.day === 0 ? 'frozen' : 'idle');
          const meta = getStatusMeta(linkStatus, frame.day);

          lines.push(`${frame.day},${linkId},${linkRole},${src},${srcName},${tgt},${tgtName},${plannedRate},${Math.round(flow)},${primaryFlow},${detourFlow},${meta.state},${meta.colour},${meta.hex},"${meta.label}"`);
        });
      });
      lines.push('');

      // 5b. Daily Route Corridor Records with combined flows, detour flows, caps, and simulation status
      if (corridors.length > 0) {
        lines.push('# SECTION: SIMULATION DAILY CORRIDOR FLOWS');
        lines.push('Day,CorridorID,CorridorName,AssignedLinkCount,PlannedCombined_m3d,ActualFlow_m3,DetourFlow_m3,BaselineRateCap_m3d,BaselineFleetCap,SimState,Colour,ColourHex,StateDescription');
        frames.forEach(frame => {
          corridors.forEach(c => {
            const assignedLinks = links.filter(l => getLinkCorridorIds(l).includes(c.id));
            const plannedCombined = assignedLinks.reduce((sum, l) => sum + (l.dailyRate || 0), 0);
            const actualFlow =
              frame.corridorFlows?.[c.id] ??
              assignedLinks.reduce((sum, l) => sum + (frame.linkFlows?.[l.id] ?? 0), 0);
            const detourFlow = Math.round(frame.backupCorridorFlows?.[c.id] ?? 0);
            const corridorStatus: FlowStatus = frame.corridorStatuses?.[c.id] ?? (frame.day === 0 ? 'frozen' : 'idle');
            const meta = getStatusMeta(corridorStatus, frame.day);
            const escapedName = `"${(c.name || c.id).replace(/"/g, '""')}"`;
            const baseCap = c.maxDailyRate !== undefined && Number.isFinite(c.maxDailyRate) ? `${c.maxDailyRate}` : '';
            const baseFleet = c.maxFleetCount !== undefined && Number.isFinite(c.maxFleetCount) ? `${c.maxFleetCount}` : '';
            lines.push(`${frame.day},${c.id},${escapedName},${assignedLinks.length},${Math.round(plannedCombined)},${Math.round(actualFlow)},${detourFlow},${baseCap},${baseFleet},${meta.state},${meta.colour},${meta.hex},"${meta.label}"`);
          });
        });
        lines.push('');
      }

      // 6. Unified Diagnostic Summary Table (combining container, transfer & route corridor records per day)
      lines.push('# SECTION: SIMULATION DIAGNOSTIC SUMMARY');
      lines.push('Day,EntityType,EntityID,EntityName,PlannedOrCapacity_m3,ActualVolumeOrFlow_m3,SimState,Colour,ColourHex,StateDescription');
      frames.forEach(frame => {
        // Containers for this day
        Object.entries(frame.nodeVolumes || {}).forEach(([nodeId, volume]) => {
          const node = nodeMap.get(nodeId);
          const name = node ? `"${node.name.replace(/"/g, '""')}"` : nodeId;
          const cap = node ? node.capacity : 0;
          const nodeStatus: FlowStatus = frame.nodeStatuses?.[nodeId] ?? (frame.day === 0 ? 'frozen' : 'idle');
          const meta = getStatusMeta(nodeStatus, frame.day);
          lines.push(`${frame.day},Container,${nodeId},${name},${cap},${Math.round(volume)},${meta.state},${meta.colour},${meta.hex},"${meta.label}"`);
        });

        // Transfers for this day
        Object.entries(frame.linkFlows || {}).forEach(([linkId, flow]) => {
          const link = linkMap.get(linkId);
          const srcNode = link ? nodeMap.get(link.sourceId) : undefined;
          const tgtNode = link ? nodeMap.get(link.targetId) : undefined;
          const label = `"${(srcNode?.name || link?.sourceId || '')} -> ${(tgtNode?.name || link?.targetId || '')}"`;
          const plannedRate = link ? link.dailyRate : 0;
          const linkStatus: FlowStatus = frame.linkStatuses?.[linkId] ?? (frame.day === 0 ? 'frozen' : 'idle');
          const meta = getStatusMeta(linkStatus, frame.day);
          lines.push(`${frame.day},Transfer,${linkId},${label},${plannedRate},${Math.round(flow)},${meta.state},${meta.colour},${meta.hex},"${meta.label}"`);
        });

        // Route Corridors for this day
        corridors.forEach(c => {
          const assignedLinks = links.filter(l => getLinkCorridorIds(l).includes(c.id));
          const plannedCombined = assignedLinks.reduce((sum, l) => sum + (l.dailyRate || 0), 0);
          const actualFlow =
            frame.corridorFlows?.[c.id] ??
            assignedLinks.reduce((sum, l) => sum + (frame.linkFlows?.[l.id] ?? 0), 0);
          const corridorStatus: FlowStatus = frame.corridorStatuses?.[c.id] ?? (frame.day === 0 ? 'frozen' : 'idle');
          const meta = getStatusMeta(corridorStatus, frame.day);
          const escapedName = `"${(c.name || c.id).replace(/"/g, '""')}"`;
          lines.push(`${frame.day},Route,${c.id},${escapedName},${Math.round(plannedCombined)},${Math.round(actualFlow)},${meta.state},${meta.colour},${meta.hex},"${meta.label}"`);
        });
      });
      lines.push('');

      // 7. Simulation Alerts
      lines.push('# SECTION: SIMULATION DAILY ALERTS');
      lines.push('Day,AlertMessage');
      frames.forEach(frame => {
        if (frame.alerts && frame.alerts.length > 0) {
          frame.alerts.forEach(alert => {
            lines.push(`${frame.day},"${alert.replace(/"/g, '""')}"`);
          });
        }
      });
    }

    return lines.join('\r\n');
  };

  const generateJSON = (): string => {
    const payload: any = {
      metadata: {
        title: 'Material Transfer Simulation Diagnostics Export',
        exportedAt: new Date().toISOString(),
        scope: exportScope,
        colorKey: {
          blue: { colour: 'Blue', hex: '#38bdf8', meaning: 'Day 0 (frozen) + any time a container cannot deliver due to lack of material' },
          green: { colour: 'Green', hex: '#22c55e', meaning: 'Flowing at full rate' },
          violet: { colour: 'Violet', hex: '#a855f7', meaning: 'Active standby diversion, backup route detour, or container transfer-through' },
          amber: { colour: 'Amber', hex: '#f59e0b', meaning: 'Flowing at restricted rate (downstream capacity throttleback)' },
          red: { colour: 'Red', hex: '#ef4444', meaning: 'Blocked from sending/receiving due to capacity issues or calendar restriction' },
          slate: { colour: 'Slate', hex: '#64748b', meaning: 'Dormant standby or overflow link' }
        }
      }
    };

    if (exportScope === 'all' || exportScope === 'model') {
      payload.materials = materials;
      payload.nodes = nodes.map(n => ({
        id: n.id,
        name: n.name,
        type: n.type,
        capacity: n.capacity,
        currentVolume: n.currentVolume,
        materialType: n.materialType,
        plantCount: n.plantCount,
        overflowMode: n.overflowMode || 'strict',
        strictSubRule: n.strictSubRule || 'throttleback',
        headroomThreshold: n.headroomThreshold ?? 500,
        ...(n.overflowTriggerPct !== undefined ? { overflowTriggerPct: n.overflowTriggerPct } : {}),
        status: n.status || 'active',
        ...(n.allowedMaterials && n.allowedMaterials.length > 0 ? { allowedMaterials: [...n.allowedMaterials] } : {}),
        outputEdge: n.outputEdge || '',
        inputEdge: n.inputEdge || ''
      }));
      payload.corridors = corridors.map(c => ({
        id: c.id,
        name: c.name,
        laneSpacing: c.laneSpacing,
        waypoints: c.waypoints,
        ...(c.maxDailyRate !== undefined ? { maxDailyRate: c.maxDailyRate } : {}),
        ...(c.maxFleetCount !== undefined ? { maxFleetCount: c.maxFleetCount } : {}),
        notes: c.notes || ''
      }));
      payload.links = links.map(l => {
        const backupCorridorIds = getLinkBackupCorridorIds(l);
        return {
          id: l.id,
          sourceId: l.sourceId,
          targetId: l.targetId,
          dailyRate: l.dailyRate,
          fleetCount: l.fleetCount,
          priority: l.priority ?? 1,
          materialId: l.materialId || '',
          corridorIds: getLinkCorridorIds(l),
          linkRole: getLinkRole(l),
          ...(l.primaryLinkId ? { primaryLinkId: l.primaryLinkId } : {}),
          ...(l.diversionTriggers && l.diversionTriggers.length > 0 ? { diversionTriggers: [...l.diversionTriggers] } : {}),
          ...(backupCorridorIds.length > 0 ? { backupCorridorIds } : {}),
          ...(l.backupCorridorRate !== undefined ? { backupCorridorRate: l.backupCorridorRate } : {})
        };
      });
      const cal: CalendarModel = calendar || { id: 'calendar-1', name: 'Project Schedule', events: [] };
      payload.calendar = {
        id: cal.id,
        name: cal.name,
        notes: cal.notes || '',
        events: (cal.events || []).map(evt => ({
          id: evt.id,
          calendarId: evt.calendarId || cal.id,
          targetType: evt.targetType,
          targetId: evt.targetId,
          startDay: evt.startDay,
          endDay: evt.endDay,
          state: evt.state,
          ...(evt.rateValue !== undefined ? { rateValue: evt.rateValue } : {}),
          ...(evt.label ? { label: evt.label } : {}),
          ...(evt.notes ? { notes: evt.notes } : {})
        }))
      };
    }

    if (exportScope === 'all' || exportScope === 'telemetry') {
      payload.dailyFrames = frames.map(f => {
        const dayContainers = Object.entries(f.nodeVolumes || {}).map(([nodeId, volume]) => {
          const node = nodeMap.get(nodeId);
          const nodeStatus: FlowStatus = f.nodeStatuses?.[nodeId] ?? (f.day === 0 ? 'frozen' : 'idle');
          const meta = getStatusMeta(nodeStatus, f.day);
          return {
            nodeId,
            nodeName: node?.name ?? nodeId,
            nodeType: node?.type ?? 'unknown',
            materialType: node?.materialType ?? '',
            volume_m3: Math.round(volume),
            capacity_m3: node?.capacity ?? 0,
            utilization_pct: node && node.capacity > 0 ? Number(((volume / node.capacity) * 100).toFixed(1)) : 0,
            overflowMode: node?.overflowMode || 'strict',
            strictSubRule: node?.strictSubRule || 'throttleback',
            overflowOut_m3: Math.round(f.overflowActiveNodes?.[nodeId] ?? 0),
            simState: meta.state,
            colour: meta.colour,
            colourHex: meta.hex,
            stateDescription: meta.label
          };
        });

        const dayTransfers = Object.entries(f.linkFlows || {}).map(([linkId, flow]) => {
          const link = linkMap.get(linkId);
          const srcNode = link ? nodeMap.get(link.sourceId) : undefined;
          const tgtNode = link ? nodeMap.get(link.targetId) : undefined;
          const linkStatus: FlowStatus = f.linkStatuses?.[linkId] ?? (f.day === 0 ? 'frozen' : 'idle');
          const meta = getStatusMeta(linkStatus, f.day);
          const split = f.linkRouteSplits?.[linkId];
          return {
            linkId,
            linkRole: link ? getLinkRole(link) : 'primary',
            sourceId: link?.sourceId ?? '',
            sourceName: srcNode?.name ?? link?.sourceId ?? '',
            targetId: link?.targetId ?? '',
            targetName: tgtNode?.name ?? link?.targetId ?? '',
            plannedRate_m3d: link?.dailyRate ?? 0,
            transferred_m3: Math.round(flow),
            primaryRouteFlow_m3: split ? Math.round(split.primaryFlow) : Math.round(flow),
            detourRouteFlow_m3: split ? Math.round(split.backupFlow) : 0,
            ...(f.standbyActivatedFrom?.[linkId] ? { standbyActivatedFrom: f.standbyActivatedFrom[linkId] } : {}),
            simState: meta.state,
            colour: meta.colour,
            colourHex: meta.hex,
            stateDescription: meta.label
          };
        });

        const dayCorridors = corridors.map(c => {
          const assignedLinks = links.filter(l => getLinkCorridorIds(l).includes(c.id));
          const plannedCombined = assignedLinks.reduce((sum, l) => sum + (l.dailyRate || 0), 0);
          const actualFlow =
            f.corridorFlows?.[c.id] ??
            assignedLinks.reduce((sum, l) => sum + (f.linkFlows?.[l.id] ?? 0), 0);
          const detourFlow = Math.round(f.backupCorridorFlows?.[c.id] ?? 0);
          const corridorStatus: FlowStatus = f.corridorStatuses?.[c.id] ?? (f.day === 0 ? 'frozen' : 'idle');
          const meta = getStatusMeta(corridorStatus, f.day);
          return {
            corridorId: c.id,
            corridorName: c.name,
            assignedLinkCount: assignedLinks.length,
            plannedCombined_m3d: Math.round(plannedCombined),
            actualFlow_m3: Math.round(actualFlow),
            detourFlow_m3: detourFlow,
            ...(c.maxDailyRate !== undefined ? { baselineRateCap_m3d: c.maxDailyRate } : {}),
            ...(c.maxFleetCount !== undefined ? { baselineFleetCap: c.maxFleetCount } : {}),
            simState: meta.state,
            colour: meta.colour,
            colourHex: meta.hex,
            stateDescription: meta.label
          };
        });

        return {
          day: f.day,
          containers: dayContainers,
          transfers: dayTransfers,
          corridors: dayCorridors,
          alerts: f.alerts || []
        };
      });
    }

    return JSON.stringify(payload, null, 2);
  };

  const currentContent = exportFormat === 'csv' ? generateCSV() : generateJSON();
  const previewSnippet = currentContent.split('\n').slice(0, 16).join('\n');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentContent);
      setCopiedSuccess(true);
      setTimeout(() => setCopiedSuccess(false), 2000);
    } catch (err) {
      console.error('Failed to copy', err);
    }
  };

  const handleDownload = () => {
    const ext = exportFormat === 'csv' ? '.csv' : '.json';
    const mime = exportFormat === 'csv' ? 'text/csv;charset=utf-8;' : 'application/json;charset=utf-8;';

    let cleanFilename = (filename.trim() || 'material_transfer_sim_diagnostics')
      .replace(/[\\/:*?"<>|]/g, '_');
    if (cleanFilename.toLowerCase().endsWith('.csv') || cleanFilename.toLowerCase().endsWith('.json')) {
      cleanFilename = cleanFilename.replace(/\.(csv|json)$/i, '');
    }
    const finalName = `${cleanFilename}${ext}`;

    const blob = new Blob([currentContent], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = finalName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    setDownloadSuccess(true);
    setTimeout(() => {
      setDownloadSuccess(false);
      onClose();
    }, 900);
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.75)',
        backdropFilter: 'blur(3px)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px'
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: '#1e293b',
          border: '1px solid #475569',
          borderRadius: '10px',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
          width: '100%',
          maxWidth: '560px',
          maxHeight: '90vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column'
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #334155',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backgroundColor: '#0f172a'
          }}
        >
          <div>
            <span style={{ fontWeight: 700, fontSize: '15px', color: '#f8fafc' }}>
              Export Simulation & Diagnostic Records
            </span>
            <div style={{ fontSize: '11px', color: '#38bdf8', marginTop: '2px' }}>
              Includes simulation state & color key for all containers & transfers
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none',
              border: 'none',
              color: '#94a3b8',
              fontSize: '20px',
              cursor: 'pointer',
              lineHeight: 1,
              padding: '4px'
            }}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/* Format Selector: CSV or JSON */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8' }}>
              Export Format
            </label>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                type="button"
                onClick={() => setExportFormat('csv')}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: `1px solid ${exportFormat === 'csv' ? '#0284c7' : '#334155'}`,
                  backgroundColor: exportFormat === 'csv' ? 'rgba(2, 132, 199, 0.2)' : '#0f172a',
                  color: exportFormat === 'csv' ? '#38bdf8' : '#94a3b8',
                  fontWeight: 600,
                  fontSize: '12px',
                  cursor: 'pointer'
                }}
              >
                CSV (.csv)
              </button>
              <button
                type="button"
                onClick={() => setExportFormat('json')}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: '6px',
                  border: `1px solid ${exportFormat === 'json' ? '#0284c7' : '#334155'}`,
                  backgroundColor: exportFormat === 'json' ? 'rgba(2, 132, 199, 0.2)' : '#0f172a',
                  color: exportFormat === 'json' ? '#38bdf8' : '#94a3b8',
                  fontWeight: 600,
                  fontSize: '12px',
                  cursor: 'pointer'
                }}
              >
                JSON (.json)
              </button>
            </div>
          </div>

          {/* Filename input */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8' }}>
              File Name
            </label>
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <input
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="material_transfer_sim_diagnostics"
                style={{
                  flex: 1,
                  backgroundColor: '#0f172a',
                  border: '1px solid #475569',
                  borderTopLeftRadius: '6px',
                  borderBottomLeftRadius: '6px',
                  color: '#f8fafc',
                  padding: '9px 12px',
                  fontSize: '13px',
                  outline: 'none'
                }}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleDownload();
                  if (e.key === 'Escape') onClose();
                }}
              />
              <span
                style={{
                  backgroundColor: '#334155',
                  border: '1px solid #475569',
                  borderLeft: 'none',
                  borderTopRightRadius: '6px',
                  borderBottomRightRadius: '6px',
                  color: '#94a3b8',
                  padding: '9px 12px',
                  fontSize: '13px',
                  fontWeight: 600
                }}
              >
                .{exportFormat}
              </span>
            </div>
          </div>

          {/* Scope Selector */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8' }}>
              Export Content Scope
            </label>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                backgroundColor: '#0f172a',
                padding: '12px',
                borderRadius: '6px',
                border: '1px solid #334155'
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#f8fafc'
                }}
              >
                <input
                  type="radio"
                  name="exportScope"
                  checked={exportScope === 'all'}
                  onChange={() => setExportScope('all')}
                  style={{ accentColor: '#0284c7' }}
                />
                <div>
                  <div style={{ fontWeight: 600 }}>All Records: Model Setup + Diagnostics Telemetry</div>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                    Full material parameters, initial node/link states, plus daily volume, flow, simulation state & colour records.
                  </div>
                </div>
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#f8fafc'
                }}
              >
                <input
                  type="radio"
                  name="exportScope"
                  checked={exportScope === 'telemetry'}
                  onChange={() => setExportScope('telemetry')}
                  style={{ accentColor: '#0284c7' }}
                />
                <div>
                  <div style={{ fontWeight: 600 }}>Simulation Diagnostics & Daily Telemetry Only</div>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                    Every container and transfer entry annotated with SimState, Colour, ColourHex, and StateDescription.
                  </div>
                </div>
              </label>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  cursor: 'pointer',
                  fontSize: '13px',
                  color: '#f8fafc'
                }}
              >
                <input
                  type="radio"
                  name="exportScope"
                  checked={exportScope === 'model'}
                  onChange={() => setExportScope('model')}
                  style={{ accentColor: '#0284c7' }}
                />
                <div>
                  <div style={{ fontWeight: 600 }}>Model Configuration Only</div>
                  <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                    Materials, bulking factors, initial node rules, and links.
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Diagnostic Record Preview */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: '#94a3b8' }}>
                Diagnostic Records Preview
              </label>
              <button
                type="button"
                onClick={handleCopy}
                style={{
                  background: 'none',
                  border: 'none',
                  color: copiedSuccess ? '#22c55e' : '#38bdf8',
                  fontSize: '11px',
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: '2px 6px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '4px'
                }}
              >
                {copiedSuccess ? '✓ Copied to Clipboard!' : '📋 Copy to Clipboard'}
              </button>
            </div>
            <pre
              style={{
                backgroundColor: '#0b1120',
                border: '1px solid #334155',
                borderRadius: '6px',
                padding: '10px 12px',
                fontSize: '10px',
                lineHeight: 1.45,
                color: '#cbd5e1',
                maxHeight: '120px',
                overflowX: 'auto',
                overflowY: 'auto',
                whiteSpace: 'pre',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
              }}
            >
              {previewSnippet}
              {'\n...'}
            </pre>
          </div>

          {/* Quick dataset summary */}
          <div
            style={{
              fontSize: '11px',
              color: '#64748b',
              display: 'flex',
              justifyContent: 'space-between',
              padding: '0 4px',
              flexWrap: 'wrap',
              gap: '6px'
            }}
          >
            <span>Containers: <strong style={{ color: '#38bdf8' }}>{nodes.length}</strong></span>
            <span>Transfers: <strong style={{ color: '#38bdf8' }}>{links.length}</strong></span>
            <span>Route Corridors: <strong style={{ color: '#38bdf8' }}>{corridors.length}</strong></span>
            <span>Calendar Events: <strong style={{ color: '#38bdf8' }}>{calendar?.events?.length ?? 0}</strong></span>
            <span>Sim Frames: <strong style={{ color: '#22c55e' }}>{frames.length} days</strong></span>
          </div>
        </div>

        {/* Footer buttons */}
        <div
          style={{
            padding: '14px 20px',
            backgroundColor: '#0f172a',
            borderTop: '1px solid #334155',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px'
          }}
        >
          <button
            type="button"
            onClick={handleCopy}
            style={{
              backgroundColor: copiedSuccess ? '#15803d' : '#1e293b',
              color: copiedSuccess ? '#f0fdf4' : '#e2e8f0',
              border: '1px solid #475569',
              padding: '8px 14px',
              borderRadius: '6px',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            {copiedSuccess ? '✓ Copied!' : '📋 Copy to Clipboard'}
          </button>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={onClose}
              style={{
                backgroundColor: '#334155',
                color: '#f8fafc',
                border: 'none',
                padding: '8px 16px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleDownload}
              style={{
                backgroundColor: downloadSuccess ? '#16a34a' : '#0284c7',
                color: '#fff',
                border: 'none',
                padding: '8px 18px',
                borderRadius: '6px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background-color 0.2s'
              }}
            >
              {downloadSuccess ? 'Saved!' : `Download .${exportFormat}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
