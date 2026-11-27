import { useState, useRef, useEffect, useCallback } from 'react';
import { CanvasViewModel } from './viewmodel/CanvasViewModel';
import { TopHeader } from './components/header/TopHeader';
import { BatchPresetBar } from './components/header/BatchPresetBar';
import { SimulationCanvas } from './components/canvas/SimulationCanvas';
import { PlaybackGraph } from './components/timeline/PlaybackGraph';
import { PropertyInspector } from './components/inspector/PropertyInspector';
import { ExportModal } from './components/modal/ExportModal';
import { RuleConfirmModal } from './components/modal/RuleConfirmModal';
import { ManualModal } from './components/modal/ManualModal';
import { SettingsDrawer } from './components/settings/SettingsDrawer';
import {
  CardinalEdge,
  ContainerNode,
  TransferLink,
  RouteCorridor,
  CalendarModel,
  CalendarEvent,
  CalendarEventState,
  CalendarTargetType,
  Point,
  OverflowMode,
  StrictSubRule,
  LinkRole,
  DiversionTrigger,
  MaterialDefinition,
  ClipboardData,
  ContainerProperties,
  LinkProperties,
  ProjectSettings,
  ProjectHoliday,
  SimSettings,
  SettingsPresetPayload,
  normalizeProjectSettings,
  normalizeSimSettings,
  getLinkCorridorIds,
  getLinkBackupCorridorIds
} from './models/types';
import { formatShortDate } from './utils/dateUtils';
import { getEffectiveContainerOutputEdge, getEffectiveContainerInputEdge, computeBestFitCorridorWaypoints } from './components/canvas/pipeRouter';

export default function App() {
  const [vm] = useState(() => new CanvasViewModel());
  const [nodes, setNodes] = useState(vm.getNodes());
  const [links, setLinks] = useState(vm.getLinks());
  const [corridors, setCorridors] = useState(vm.getCorridors());
  const [calendar, setCalendar] = useState<CalendarModel>(() => vm.getCalendar());
  const [materials, setMaterials] = useState(vm.getMaterials());
  const [projectSettings, setProjectSettings] = useState<ProjectSettings>(() => vm.getProjectSettings());
  const [simSettings, setSimSettings] = useState<SimSettings>(() => vm.getSimSettings());
  const [isSettingsDrawerOpen, setIsSettingsDrawerOpen] = useState<boolean>(false);
  
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>(['node-1']);
  const [selectedLinkIds, setSelectedLinkIds] = useState<string[]>([]);
  const [selectedCorridorIds, setSelectedCorridorIds] = useState<string[]>([]);
  const [selectedCalendarEventId, setSelectedCalendarEventId] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardData | null>(null);
  const [isPlayback, setIsPlayback] = useState<boolean>(false);
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<string[]>([]);
  const [currentDay, setCurrentDay] = useState<number>(0);
  const [isGraphExpanded, setIsGraphExpanded] = useState<boolean>(false);
  
  const [isExportModalOpen, setIsExportModalOpen] = useState<boolean>(false);
  const [isManualModalOpen, setIsManualModalOpen] = useState<boolean>(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };
  
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const currentFrame = vm.getCurrentFrame();
  const frames = vm.getFrames();
  const totalDays = vm.getTotalDays();

  const handleUpdateProjectSettings = useCallback((updates: Partial<ProjectSettings>) => {
    const next = vm.updateProjectSettings(updates);
    setProjectSettings(next);
    const nextMaxDay = vm.getTotalDays();
    setCurrentDay(prev => {
      const clamped = Math.min(prev, nextMaxDay);
      vm.setFrameIndex(clamped);
      return clamped;
    });
  }, [vm]);

  const handleResetProjectSettings = useCallback(() => {
    const next = vm.resetProjectSettings();
    setProjectSettings(next);
    const nextMaxDay = vm.getTotalDays();
    setCurrentDay(prev => {
      const clamped = Math.min(prev, nextMaxDay);
      vm.setFrameIndex(clamped);
      return clamped;
    });
  }, [vm]);

  const handleUpdateSimSettings = useCallback((updates: Partial<SimSettings>) => {
    const next = vm.updateSimSettings(updates);
    setSimSettings(next);
  }, [vm]);

  const handleResetSimSettings = useCallback(() => {
    const next = vm.resetSimSettings();
    setSimSettings(next);
  }, [vm]);

  const handleImportSettingsPreset = useCallback((preset: SettingsPresetPayload) => {
    const res = vm.applySettingsPreset(preset);
    setProjectSettings(vm.getProjectSettings());
    setSimSettings(vm.getSimSettings());
    setCalendar(vm.getCalendar());
    const nextMaxDay = vm.getTotalDays();
    setCurrentDay(prev => {
      const clamped = Math.min(prev, nextMaxDay);
      vm.setFrameIndex(clamped);
      return clamped;
    });
    const parts: string[] = [];
    if (res.appliedProject) parts.push('Project Settings');
    if (res.appliedSim) parts.push('Sim Settings');
    if (res.appliedGlobalEvents > 0) parts.push(`${res.appliedGlobalEvents} Global Event${res.appliedGlobalEvents > 1 ? 's' : ''}`);
    showToast(`Imported preset: ${parts.join(', ') || 'settings'}.`, 'success');
  }, [vm]);

  const togglePlayback = () => {
    const nextState = !isPlayback;
    setIsPlayback(nextState);
    vm.setPlayback(nextState);
    if (nextState) {
      // Upon playback mode, reset timeline to day 0
      setCurrentDay(0);
      vm.setFrameIndex(0);
      // When playback mode starts, deselect any containers, transfers, corridors, or calendar events
      setSelectedNodeIds([]);
      setSelectedLinkIds([]);
      setSelectedCorridorIds([]);
      setSelectedCalendarEventId(null);
      setHighlightedNodeIds([]);
    } else {
      setHighlightedNodeIds([]);
    }
    setNodes([...vm.getNodes()]);
  };

  const [pendingRule, setPendingRule] = useState<{
    mode: OverflowMode;
    subRule?: StrictSubRule;
    name: string;
    shape: 'circle' | 'diamond' | 'square' | 'triangle';
  } | null>(null);

  const getRuleMeta = (mode: OverflowMode, subRule?: StrictSubRule): { name: string; shape: 'circle' | 'diamond' | 'square' | 'triangle' } => {
    if (mode === 'overfill') return { name: 'Overfill', shape: 'square' };
    if (subRule === 'headroom_hold') return { name: 'Headroom Hold', shape: 'diamond' };
    if (subRule === 'transfer_through') return { name: 'Transfer-Through', shape: 'triangle' };
    return { name: 'Throttleback', shape: 'circle' };
  };

  const handleApplyPreset = (mode: OverflowMode, subRule?: StrictSubRule) => {
    const meta = getRuleMeta(mode, subRule);

    if (selectedNodeIds.length > 0) {
      vm.updateNodes(
        (n) => selectedNodeIds.includes(n.id),
        { overflowMode: mode, ...(subRule ? { strictSubRule: subRule } : {}) }
      );
      setNodes(vm.getNodes().map(n => ({ ...n })));
      showToast(`Applied ${meta.name} to ${selectedNodeIds.length} selected container${selectedNodeIds.length > 1 ? 's' : ''}.`, 'success');
    } else {
      setPendingRule({ mode, subRule, name: meta.name, shape: meta.shape });
    }
  };

  const confirmApplyRuleToAll = () => {
    if (!pendingRule) return;
    vm.updateNodes(
      () => true,
      { overflowMode: pendingRule.mode, ...(pendingRule.subRule ? { strictSubRule: pendingRule.subRule } : {}) }
    );
    setNodes(vm.getNodes().map(n => ({ ...n })));
    showToast(`Applied ${pendingRule.name} across all ${nodes.length} containers.`, 'success');
    setPendingRule(null);
  };

  const handleAddNode = () => {
    const isSingleContainerSelected = selectedNodeIds.length === 1;
    const sourceNode = isSingleContainerSelected ? nodes.find(n => n.id === selectedNodeIds[0]) : null;

    const newId = `node-${Date.now()}`;
    const newName = `New Container ${nodes.length + 1}`;

    const newNode: ContainerNode = sourceNode
      ? {
          id: newId,
          name: newName,
          type: sourceNode.type,
          x: sourceNode.x + 50,
          y: sourceNode.y + 50,
          capacity: sourceNode.capacity,
          currentVolume: sourceNode.currentVolume,
          materialType: sourceNode.materialType,
          plantCount: sourceNode.plantCount,
          overflowMode: sourceNode.overflowMode,
          strictSubRule: sourceNode.strictSubRule,
          headroomThreshold: sourceNode.headroomThreshold,
          overflowTriggerPct: sourceNode.overflowTriggerPct,
          status: sourceNode.status,
          allowedMaterials: sourceNode.allowedMaterials ? [...sourceNode.allowedMaterials] : undefined,
          notes: sourceNode.notes
        }
      : {
          id: newId,
          name: newName,
          type: 'stockpile',
          x: 300,
          y: 200,
          capacity: 25000,
          currentVolume: 10000,
          materialType: materials[0]?.code || 'TYPE1',
          plantCount: 2,
          overflowMode: 'strict',
          strictSubRule: 'throttleback',
          headroomThreshold: simSettings.defaultHeadroomThresholdM3,
          ...(simSettings.defaultOverflowTriggerPct < 100
            ? { overflowTriggerPct: simSettings.defaultOverflowTriggerPct }
            : {})
        };

    vm.addNode(newNode);
    setNodes(vm.getNodes().map(n => ({ ...n })));
    setLinks([...vm.getLinks()]);
    setSelectedNodeIds([newNode.id]);
    setSelectedLinkIds([]);
    setSelectedCorridorIds([]);
    setSelectedCalendarEventId(null);

    if (sourceNode) {
      showToast(`Created "${newName}" copying properties from "${sourceNode.name}"`, 'success');
    } else {
      showToast(`Created new container "${newName}"`, 'success');
    }
  };

  const handleAddLink = () => {
    if (selectedNodeIds.length < 2) return;
    const newLink: TransferLink = {
      id: `link-${Date.now()}`,
      sourceId: selectedNodeIds[0],
      targetId: selectedNodeIds[1],
      dailyRate: 1000,
      fleetCount: 3
    };
    vm.addLink(newLink);
    setLinks([...vm.getLinks()]);
    setSelectedNodeIds([]);
    setSelectedLinkIds([newLink.id]);
    setSelectedCorridorIds([]);
    setSelectedCalendarEventId(null);
  };

  const handleAddCorridor = (suggestedWaypoints?: Point[]) => {
    const validSelectedLinkIds = selectedLinkIds.filter(lid => links.some(l => l.id === lid));
    const bestFitWaypoints =
      validSelectedLinkIds.length > 0
        ? computeBestFitCorridorWaypoints(nodes, links, validSelectedLinkIds, corridors)
        : null;

    const waypoints: Point[] =
      bestFitWaypoints
        ? bestFitWaypoints.map(p => ({ x: p.x, y: p.y }))
        : suggestedWaypoints && suggestedWaypoints.length >= 2
        ? suggestedWaypoints.map(p => ({ x: p.x, y: p.y }))
        : [
            { x: 240, y: 240 },
            { x: 460, y: 240 }
          ];
    const newCorridor: RouteCorridor = {
      id: `corridor-${Date.now()}`,
      name: `Route Corridor ${corridors.length + 1}`,
      laneSpacing: 5,
      waypoints
    };
    vm.addCorridor(newCorridor);

    let attachedCount = 0;
    if (validSelectedLinkIds.length > 0) {
      attachedCount = vm.addLinksToCorridors([newCorridor.id], validSelectedLinkIds);
      setLinks([...vm.getLinks()]);
    }

    setCorridors(vm.getCorridors().map(c => ({ ...c, waypoints: c.waypoints.map(p => ({ ...p })) })));
    setSelectedCorridorIds([newCorridor.id]);
    setSelectedNodeIds([]);
    setSelectedLinkIds([]);
    setSelectedCalendarEventId(null);

    if (attachedCount > 0) {
      showToast(
        `Created "${newCorridor.name}" and attached ${attachedCount} transfer${attachedCount > 1 ? 's' : ''}.`,
        'success'
      );
    } else {
      showToast(`Created "${newCorridor.name}". Drag handles on canvas and assign transfers via + lanes or inspector.`, 'success');
    }
  };

  const handleSetRouteLanes = () => {
    if (isPlayback || selectedCorridorIds.length === 0 || selectedLinkIds.length === 0) return;
    const validCorridorIds = selectedCorridorIds.filter(cid => corridors.some(c => c.id === cid));
    if (validCorridorIds.length === 0) return;

    const addedCount = vm.addLinksToCorridors(validCorridorIds, selectedLinkIds);
    if (addedCount > 0) {
      setLinks([...vm.getLinks()]);
      const routeLabel =
        validCorridorIds.length === 1
          ? `"${corridors.find(c => c.id === validCorridorIds[0])?.name || 'Route'}"`
          : `${validCorridorIds.length} route corridors`;
      showToast(
        `Added ${addedCount} lane assignment${addedCount > 1 ? 's' : ''} to ${routeLabel}.`,
        'success'
      );
    } else {
      showToast('Selected transfer(s) are already assigned to the selected route(s).', 'success');
    }
  };

  const handleUnlinkLanes = () => {
    if (isPlayback) return;
    if (selectedLinkIds.length > 0 && selectedCorridorIds.length > 0) {
      const unlinkedCount = vm.unlinkLinksFromCorridors(selectedLinkIds, selectedCorridorIds);
      if (unlinkedCount > 0) {
        setLinks([...vm.getLinks()]);
        showToast(
          `Removed ${unlinkedCount} transfer${unlinkedCount > 1 ? 's' : ''} from selected route corridor${selectedCorridorIds.length > 1 ? 's' : ''}.`,
          'success'
        );
      }
      return;
    }

    if (selectedLinkIds.length > 0) {
      const unlinkedCount = vm.unlinkLinksFromCorridors(selectedLinkIds);
      if (unlinkedCount > 0) {
        setLinks([...vm.getLinks()]);
        showToast(
          `Unlinked ${unlinkedCount} transfer${unlinkedCount > 1 ? 's' : ''} from route corridors.`,
          'success'
        );
      }
      return;
    }

    if (selectedCorridorIds.length > 0) {
      const clearedCount = vm.clearCorridorLinks(selectedCorridorIds);
      if (clearedCount > 0) {
        setLinks([...vm.getLinks()]);
        showToast(
          `Cleared ${clearedCount} lane${clearedCount > 1 ? 's' : ''} from ${selectedCorridorIds.length} route corridor${selectedCorridorIds.length > 1 ? 's' : ''}.`,
          'success'
        );
      }
    }
  };

  const handleDeleteSelected = useCallback(() => {
    if (isPlayback) return;
    if (selectedCalendarEventId) {
      vm.removeCalendarEvent(selectedCalendarEventId);
      setCalendar(vm.getCalendar());
      setSelectedCalendarEventId(null);
      return;
    }
    if (selectedNodeIds.length === 0 && selectedLinkIds.length === 0 && selectedCorridorIds.length === 0) return;
    selectedNodeIds.forEach(id => vm.removeNode(id));
    selectedLinkIds.forEach(id => vm.removeLink(id));
    selectedCorridorIds.forEach(id => vm.removeCorridor(id));
    setNodes(vm.getNodes().map(n => ({ ...n })));
    setLinks([...vm.getLinks()]);
    setCorridors(vm.getCorridors().map(c => ({ ...c, waypoints: c.waypoints.map(p => ({ ...p })) })));
    setCalendar(vm.getCalendar());
    setSelectedNodeIds([]);
    setSelectedLinkIds([]);
    setSelectedCorridorIds([]);
  }, [isPlayback, selectedCalendarEventId, selectedNodeIds, selectedLinkIds, selectedCorridorIds, vm]);

  const handleClearSelection = useCallback(() => {
    setSelectedNodeIds([]);
    setSelectedLinkIds([]);
    setSelectedCorridorIds([]);
    setSelectedCalendarEventId(null);
  }, []);

  const handleSelectCalendarEvent = useCallback((eventId: string | null) => {
    setSelectedCalendarEventId(eventId);
    if (eventId) {
      setSelectedNodeIds([]);
      setSelectedLinkIds([]);
      setSelectedCorridorIds([]);
    }
  }, []);

  const handleSelectTargetElement = useCallback((targetType: CalendarTargetType, targetId: string) => {
    setSelectedCalendarEventId(null);
    if (targetType === 'global') {
      setIsSettingsDrawerOpen(true);
      return;
    }
    if (targetType === 'container') {
      setSelectedNodeIds([targetId]);
      setSelectedLinkIds([]);
      setSelectedCorridorIds([]);
    } else if (targetType === 'transfer') {
      setSelectedNodeIds([]);
      setSelectedLinkIds([targetId]);
      setSelectedCorridorIds([]);
    } else {
      setSelectedNodeIds([]);
      setSelectedLinkIds([]);
      setSelectedCorridorIds([targetId]);
    }
  }, []);

  const handleAddCalendarEvent = useCallback(
    (event: Omit<CalendarEvent, 'calendarId'>): CalendarEvent => {
      const created = vm.addCalendarEvent(event);
      setCalendar(vm.getCalendar());
      return created;
    },
    [vm]
  );

  const handleUpdateCalendarEvent = useCallback(
    (eventId: string, updates: Partial<CalendarEvent>) => {
      if (isPlayback) return;
      vm.updateCalendarEvent(eventId, updates);
      setCalendar(vm.getCalendar());
    },
    [isPlayback, vm]
  );

  const handleDeleteCalendarEvent = useCallback(
    (eventId: string) => {
      if (isPlayback) return;
      vm.removeCalendarEvent(eventId);
      setCalendar(vm.getCalendar());
      setSelectedCalendarEventId(prev => (prev === eventId ? null : prev));
    },
    [isPlayback, vm]
  );

  const handleCanvasSelectNodes = useCallback((updater: React.SetStateAction<string[]>) => {
    setSelectedCalendarEventId(null);
    setSelectedNodeIds(updater);
  }, []);

  const handleCanvasSelectLinks = useCallback((updater: React.SetStateAction<string[]>) => {
    setSelectedCalendarEventId(null);
    setSelectedLinkIds(updater);
  }, []);

  const handleCanvasSelectCorridors = useCallback((updater: React.SetStateAction<string[]>) => {
    setSelectedCalendarEventId(null);
    setSelectedCorridorIds(updater);
  }, []);

  const handleNodesUpdated = () => {
    setNodes(vm.getNodes().map(n => ({ ...n })));
  };

  const handleCorridorsUpdated = () => {
    setCorridors(vm.getCorridors().map(c => ({ ...c, waypoints: c.waypoints.map(p => ({ ...p })) })));
  };

  const handleImportCSVFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const text = event.target?.result as string;
        const rawLines = text.split(/\r?\n/);
        // Handle multiline quoted fields in CSV properly
        const lines: string[] = [];
        let buffer = '';
        for (const rawLine of rawLines) {
          if (buffer) {
            buffer += '\n' + rawLine;
          } else {
            buffer = rawLine;
          }
          const quoteCount = (buffer.match(/"/g) || []).length;
          if (quoteCount % 2 === 0) {
            lines.push(buffer);
            buffer = '';
          }
        }
        if (buffer) lines.push(buffer);
        
        const parsedMaterials: MaterialDefinition[] = [];
        const parsedNodes: ContainerNode[] = [];
        const parsedLinks: TransferLink[] = [];
        const parsedCorridors: RouteCorridor[] = [];
        let parsedCalendarMeta: { id: string; name: string; notes?: string } | null = null;
        const parsedCalendarEvents: CalendarEvent[] = [];
        const parsedProjectKV: Record<string, string> = {};
        const parsedHolidays: ProjectHoliday[] = [];
        const parsedSimKV: Record<string, string> = {};
        let hasProjectSettingsSection = false;
        let hasSimSettingsSection = false;
        let currentSection = '';
        let nodeHeaderCols: string[] = [];
        let corridorHeaderCols: string[] = [];
        let linkHeaderCols: string[] = [];
        let calendarEventHeaderCols: string[] = [];

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.startsWith('# SECTION: PROJECT SETTINGS')) {
            currentSection = 'PROJECT_SETTINGS';
            hasProjectSettingsSection = true;
            continue;
          } else if (trimmed.startsWith('# SECTION: PROJECT HOLIDAYS')) {
            currentSection = 'PROJECT_HOLIDAYS';
            hasProjectSettingsSection = true;
            continue;
          } else if (trimmed.startsWith('# SECTION: SIM SETTINGS')) {
            currentSection = 'SIM_SETTINGS';
            hasSimSettingsSection = true;
            continue;
          } else if (trimmed.startsWith('# SECTION: MATERIALS') || trimmed.startsWith('# SECTION: MATERIAL DEFINITIONS')) {
            currentSection = 'MATERIALS';
            continue;
          } else if (trimmed.startsWith('# SECTION: INITIAL MODEL NODES') || trimmed.startsWith('# SECTION: NODES')) {
            currentSection = 'NODES';
            nodeHeaderCols = [];
            continue;
          } else if (trimmed.startsWith('# SECTION: CORRIDORS')) {
            currentSection = 'CORRIDORS';
            corridorHeaderCols = [];
            continue;
          } else if (trimmed.startsWith('# SECTION: INITIAL MODEL LINKS') || trimmed.startsWith('# SECTION: LINKS')) {
            currentSection = 'LINKS';
            linkHeaderCols = [];
            continue;
          } else if (trimmed.startsWith('# SECTION: CALENDAR EVENTS')) {
            currentSection = 'CALENDAR_EVENTS';
            calendarEventHeaderCols = [];
            continue;
          } else if (trimmed.startsWith('# SECTION: CALENDAR')) {
            currentSection = 'CALENDAR';
            continue;
          } else if (trimmed.startsWith('# SECTION:')) {
            currentSection = '';
            continue;
          } else if (trimmed.startsWith('#')) {
            continue;
          }

          if (trimmed.toLowerCase().startsWith('nodeid,')) {
            nodeHeaderCols = trimmed.split(',').map(c => c.trim().toLowerCase().replace(/^"|"$/g, ''));
            continue; // Header row
          }
          if (trimmed.toLowerCase().startsWith('corridorid,')) {
            corridorHeaderCols = trimmed.split(',').map(c => c.trim().toLowerCase().replace(/^"|"$/g, ''));
            continue; // Header row
          }
          if (trimmed.toLowerCase().startsWith('linkid,')) {
            linkHeaderCols = trimmed.split(',').map(c => c.trim().toLowerCase().replace(/^"|"$/g, ''));
            continue; // Header row
          }
          if (trimmed.toLowerCase().startsWith('eventid,')) {
            calendarEventHeaderCols = trimmed.split(',').map(c => c.trim().toLowerCase().replace(/^"|"$/g, ''));
            continue; // Header row
          }
          if (
            trimmed.toLowerCase().startsWith('key,value') ||
            trimmed.toLowerCase().startsWith('holidayid,') ||
            trimmed.toLowerCase().startsWith('calendarid,') ||
            trimmed.toLowerCase().startsWith('code,') ||
            trimmed.toLowerCase().startsWith('day,')
          ) {
            continue; // Header row
          }

          if (currentSection === 'PROJECT_SETTINGS') {
            const parts = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 2) {
              const key = parts[0].replace(/^"|"$/g, '').trim();
              const val = parts[1].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
              if (key) parsedProjectKV[key] = val;
            }
          } else if (currentSection === 'PROJECT_HOLIDAYS') {
            const parts = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 2) {
              const id = parts[0].replace(/^"|"$/g, '').trim() || `hol-${parsedHolidays.length + 1}`;
              const startDate = parts[1].replace(/^"|"$/g, '').trim();
              const rawEnd = parts[2] ? parts[2].replace(/^"|"$/g, '').trim() : '';
              const endDate = rawEnd || startDate;
              const name = parts[3] ? parts[3].replace(/^"|"$/g, '').replace(/""/g, '"').trim() : 'Holiday';
              if (startDate) {
                parsedHolidays.push({
                  id,
                  startDate,
                  endDate,
                  name
                });
              }
            }
          } else if (currentSection === 'SIM_SETTINGS') {
            const parts = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 2) {
              const key = parts[0].replace(/^"|"$/g, '').trim();
              const val = parts[1].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
              if (key) parsedSimKV[key] = val;
            }
          } else if (currentSection === 'MATERIALS') {
            // Format: Code,Name,BulkIN,BulkOUT
            const parts = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 4) {
              const code = parts[0].replace(/^"|"$/g, '').trim().toUpperCase();
              const name = parts[1].replace(/^"|"$/g, '').trim();
              const bulkIN = parseFloat(parts[2]) || 1.0;
              const bulkOUT = parseFloat(parts[3]) || 1.0;
              if (code) {
                parsedMaterials.push({ code, name, bulkIN, bulkOUT });
              }
            }
          } else if (currentSection === 'NODES') {
            // Format: NodeID,Name,Type,X,Y,Capacity,InitialVolume,MaterialType,PlantCount,[OverflowMode],[StrictSubRule],[HeadroomThreshold],[Status],...,[Notes]
            const parts = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 8) {
              const rawType = parts[2]?.trim().toLowerCase();
              const validTypes: ContainerNode['type'][] = ['excavation', 'stockpile', 'null', 'external'];
              const type = validTypes.includes(rawType as any) ? (rawType as ContainerNode['type']) : 'stockpile';

              const rawOverflow = parts[9]?.replace(/^"|"$/g, '').trim().toLowerCase();
              const overflowMode: OverflowMode = rawOverflow === 'overfill' ? 'overfill' : 'strict';

              const rawSubRule = parts[10]?.replace(/^"|"$/g, '').trim().toLowerCase();
              const strictSubRule: StrictSubRule =
                rawSubRule === 'headroom_hold'
                  ? 'headroom_hold'
                  : rawSubRule === 'transfer_through'
                  ? 'transfer_through'
                  : 'throttleback';

              const rawHeadroom = parts[11]?.trim();
              const headroomThreshold = rawHeadroom ? parseFloat(rawHeadroom) : 500;

              const rawStatus = parts[12]?.replace(/^"|"$/g, '').trim().toLowerCase();
              const status: ContainerNode['status'] = (rawStatus === 'maintenance' || rawStatus === 'blocked') ? rawStatus : 'active';

              // Extract notes: dynamic header column index or column 16 (or column 13)
              let notes: string | undefined = undefined;
              const notesIdx = nodeHeaderCols.indexOf('notes');
              if (notesIdx !== -1 && parts[notesIdx] !== undefined) {
                notes = parts[notesIdx].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
              } else if (parts[16] !== undefined) {
                notes = parts[16].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
              } else if (parts.length === 14 && !nodeHeaderCols.includes('initialsimstate')) {
                notes = parts[13].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
              }

              const outputEdgeIdx = nodeHeaderCols.indexOf('outputedge');
              const rawOutputEdge = outputEdgeIdx !== -1 && parts[outputEdgeIdx]
                ? parts[outputEdgeIdx].replace(/^"|"$/g, '').trim().toUpperCase()
                : '';
              const inputEdgeIdx = nodeHeaderCols.indexOf('inputedge');
              const rawInputEdge = inputEdgeIdx !== -1 && parts[inputEdgeIdx]
                ? parts[inputEdgeIdx].replace(/^"|"$/g, '').trim().toUpperCase()
                : '';
              const validEdges: CardinalEdge[] = ['N', 'E', 'S', 'W'];
              const outputEdge = validEdges.includes(rawOutputEdge as CardinalEdge)
                ? (rawOutputEdge as CardinalEdge)
                : undefined;
              const inputEdge = validEdges.includes(rawInputEdge as CardinalEdge)
                ? (rawInputEdge as CardinalEdge)
                : undefined;

              const allowedMatsIdx = nodeHeaderCols.indexOf('allowedmaterials');
              let allowedMaterials: string[] | undefined = undefined;
              if (allowedMatsIdx !== -1 && parts[allowedMatsIdx] !== undefined) {
                const rawAllowed = parts[allowedMatsIdx].replace(/^"|"$/g, '').trim();
                const codes = rawAllowed
                  .split('|')
                  .map(s => s.trim().toUpperCase())
                  .filter(Boolean);
                if (codes.length > 0) allowedMaterials = Array.from(new Set(codes));
              }

              const overflowTriggerIdx = nodeHeaderCols.indexOf('overflowtriggerpct');
              let overflowTriggerPct: number | undefined = undefined;
              if (overflowTriggerIdx !== -1 && parts[overflowTriggerIdx] !== undefined) {
                const rawTrigger = parts[overflowTriggerIdx].replace(/^"|"$/g, '').trim();
                const parsedTrigger = parseFloat(rawTrigger);
                if (rawTrigger !== '' && !isNaN(parsedTrigger)) {
                  overflowTriggerPct = Math.max(1, Math.min(100, Math.round(parsedTrigger)));
                }
              }

              parsedNodes.push({
                id: parts[0].trim(),
                name: parts[1].replace(/^"|"$/g, '').trim(),
                type,
                x: parseFloat(parts[3]) || 100,
                y: parseFloat(parts[4]) || 100,
                capacity: parseFloat(parts[5]) || 50000,
                currentVolume: parseFloat(parts[6]) || 0,
                materialType: parts[7].replace(/^"|"$/g, '').trim().toUpperCase() || 'CLAY',
                plantCount: parseInt(parts[8], 10) || 1,
                overflowMode,
                strictSubRule,
                headroomThreshold: isNaN(headroomThreshold) ? 500 : headroomThreshold,
                ...(overflowTriggerPct !== undefined ? { overflowTriggerPct } : {}),
                status,
                ...(allowedMaterials ? { allowedMaterials } : {}),
                ...(outputEdge ? { outputEdge } : {}),
                ...(inputEdge ? { inputEdge } : {}),
                notes: notes || undefined
              });
            }
          } else if (currentSection === 'CORRIDORS') {
            // Format: CorridorID,Name,LaneSpacing,WaypointsJSON,Notes,[MaxDailyRate],[MaxFleetCount]
            const parts = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 4) {
              const id = parts[0].replace(/^"|"$/g, '').trim();
              const name = parts[1].replace(/^"|"$/g, '').replace(/""/g, '"').trim() || 'Route Corridor';
              const laneSpacing = parseFloat(parts[2]) || 5;
              const rawWaypoints = parts[3].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
              const notes = parts[4] ? parts[4].replace(/^"|"$/g, '').replace(/""/g, '"').trim() : undefined;

              const maxRateIdx = corridorHeaderCols.indexOf('maxdailyrate');
              const rawMaxRate = (maxRateIdx !== -1 ? parts[maxRateIdx] : parts[5])?.replace(/^"|"$/g, '').trim() ?? '';
              const maxDailyRate = rawMaxRate !== '' && !isNaN(parseFloat(rawMaxRate)) ? Math.max(0, parseFloat(rawMaxRate)) : undefined;

              const maxFleetIdx = corridorHeaderCols.indexOf('maxfleetcount');
              const rawMaxFleet = (maxFleetIdx !== -1 ? parts[maxFleetIdx] : parts[6])?.replace(/^"|"$/g, '').trim() ?? '';
              const maxFleetCount = rawMaxFleet !== '' && !isNaN(parseInt(rawMaxFleet, 10)) ? Math.max(1, parseInt(rawMaxFleet, 10)) : undefined;

              try {
                const parsedPts = JSON.parse(rawWaypoints);
                if (
                  id &&
                  Array.isArray(parsedPts) &&
                  parsedPts.length >= 2 &&
                  parsedPts.every((p: any) => typeof p?.x === 'number' && typeof p?.y === 'number')
                ) {
                  parsedCorridors.push({
                    id,
                    name,
                    laneSpacing,
                    waypoints: parsedPts.map((p: any) => ({ x: p.x, y: p.y })),
                    ...(maxDailyRate !== undefined ? { maxDailyRate } : {}),
                    ...(maxFleetCount !== undefined ? { maxFleetCount } : {}),
                    notes: notes || undefined
                  });
                }
              } catch {
                // Ignore malformed corridor row
              }
            }
          } else if (currentSection === 'LINKS') {
            // Format: LinkId,SourceId,TargetId,DailyRate,FleetCount,[Priority],[MaterialId],...,[Notes],[CorridorId]
            const parts = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 5) {
              const priority = parts[5] ? parseInt(parts[5], 10) : 1;
              const materialId = parts[6] ? parts[6].replace(/^"|"$/g, '').trim() : undefined;

              // Extract notes: dynamic header column index or column 10
              let notes: string | undefined = undefined;
              const linkNotesIdx = linkHeaderCols.indexOf('notes');
              if (linkNotesIdx !== -1 && parts[linkNotesIdx] !== undefined) {
                notes = parts[linkNotesIdx].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
              } else if (parts[10] !== undefined) {
                notes = parts[10].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
              } else if (parts.length === 8 && !linkHeaderCols.includes('initialsimstate')) {
                notes = parts[7].replace(/^"|"$/g, '').replace(/""/g, '"').trim();
              }

              let corridorIds: string[] | undefined = undefined;
              const corridorIdx = linkHeaderCols.indexOf('corridorid');
              if (corridorIdx !== -1 && parts[corridorIdx] !== undefined) {
                const rawCorridor = parts[corridorIdx].replace(/^"|"$/g, '').trim();
                const splitIds = rawCorridor
                  .split('|')
                  .map(s => s.trim())
                  .filter(Boolean);
                if (splitIds.length > 0) {
                  corridorIds = Array.from(new Set(splitIds));
                }
              }

              const linkRoleIdx = linkHeaderCols.indexOf('linkrole');
              let linkRole: LinkRole | undefined = undefined;
              if (linkRoleIdx !== -1 && parts[linkRoleIdx] !== undefined) {
                const rawRole = parts[linkRoleIdx].replace(/^"|"$/g, '').trim().toLowerCase();
                if (rawRole === 'standby' || rawRole === 'overflow' || rawRole === 'primary') {
                  linkRole = rawRole;
                }
              }

              const primaryLinkIdx = linkHeaderCols.indexOf('primarylinkid');
              let primaryLinkId: string | undefined = undefined;
              if (primaryLinkIdx !== -1 && parts[primaryLinkIdx] !== undefined) {
                const rawPrimary = parts[primaryLinkIdx].replace(/^"|"$/g, '').trim();
                if (rawPrimary) primaryLinkId = rawPrimary;
              }

              const triggersIdx = linkHeaderCols.indexOf('diversiontriggers');
              let diversionTriggers: DiversionTrigger[] | undefined = undefined;
              if (triggersIdx !== -1 && parts[triggersIdx] !== undefined) {
                const rawTriggers = parts[triggersIdx].replace(/^"|"$/g, '').trim();
                const validTriggers: DiversionTrigger[] = ['route', 'target', 'calendar', 'source'];
                const parsedTriggers = rawTriggers
                  .split('|')
                  .map(s => s.trim().toLowerCase())
                  .filter((t): t is DiversionTrigger => validTriggers.includes(t as DiversionTrigger));
                if (parsedTriggers.length > 0) {
                  diversionTriggers = Array.from(new Set(parsedTriggers));
                }
              }

              const backupCorridorIdx = linkHeaderCols.indexOf('backupcorridorids');
              let backupCorridorIds: string[] | undefined = undefined;
              if (backupCorridorIdx !== -1 && parts[backupCorridorIdx] !== undefined) {
                const rawBackup = parts[backupCorridorIdx].replace(/^"|"$/g, '').trim();
                const splitBackup = rawBackup
                  .split('|')
                  .map(s => s.trim())
                  .filter(Boolean);
                if (splitBackup.length > 0) {
                  backupCorridorIds = Array.from(new Set(splitBackup));
                }
              }

              const backupRateIdx = linkHeaderCols.indexOf('backupcorridorrate');
              let backupCorridorRate: number | undefined = undefined;
              if (backupRateIdx !== -1 && parts[backupRateIdx] !== undefined) {
                const rawBackupRate = parts[backupRateIdx].replace(/^"|"$/g, '').trim();
                const parsedBackupRate = parseFloat(rawBackupRate);
                if (rawBackupRate !== '' && !isNaN(parsedBackupRate)) {
                  backupCorridorRate = Math.max(0, parsedBackupRate);
                }
              }

              parsedLinks.push({
                id: parts[0].trim(),
                sourceId: parts[1].trim(),
                targetId: parts[2].trim(),
                dailyRate: parseFloat(parts[3]) || 1000,
                fleetCount: parseInt(parts[4], 10) || 1,
                priority: isNaN(priority) ? 1 : priority,
                materialId: materialId || undefined,
                corridorIds,
                ...(linkRole ? { linkRole } : {}),
                ...(primaryLinkId ? { primaryLinkId } : {}),
                ...(diversionTriggers ? { diversionTriggers } : {}),
                ...(backupCorridorIds ? { backupCorridorIds } : {}),
                ...(backupCorridorRate !== undefined ? { backupCorridorRate } : {}),
                notes: notes || undefined
              });
            }
          } else if (currentSection === 'CALENDAR') {
            // Format: CalendarID,Name,Notes
            const parts = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 2) {
              const id = parts[0].replace(/^"|"$/g, '').trim() || 'calendar-1';
              const name = parts[1].replace(/^"|"$/g, '').replace(/""/g, '"').trim() || 'Project Schedule';
              const notes = parts[2] ? parts[2].replace(/^"|"$/g, '').replace(/""/g, '"').trim() : undefined;
              parsedCalendarMeta = { id, name, notes: notes || undefined };
            }
          } else if (currentSection === 'CALENDAR_EVENTS') {
            // Format: EventID,CalendarID,TargetType,TargetID,StartDay,EndDay,State,RateValue,Label,Notes,[HaulRatePct],[BulkInMult],[BulkOutMult],[AffectedMaterials]
            const parts = trimmed.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            if (parts.length >= 7) {
              const id = parts[0].replace(/^"|"$/g, '').trim();
              const calendarId = parts[1].replace(/^"|"$/g, '').trim() || parsedCalendarMeta?.id || 'calendar-1';
              const rawTargetType = parts[2].replace(/^"|"$/g, '').trim().toLowerCase();
              const targetId = parts[3].replace(/^"|"$/g, '').trim();
              const startDay = parseInt(parts[4], 10);
              const endDay = parseInt(parts[5], 10);
              const rawState = parts[6].replace(/^"|"$/g, '').trim().toLowerCase();
              const rawRate = parts[7] !== undefined ? parts[7].replace(/^"|"$/g, '').trim() : '';
              const rateValue = rawRate !== '' && !isNaN(parseFloat(rawRate)) ? parseFloat(rawRate) : undefined;
              const label = parts[8] ? parts[8].replace(/^"|"$/g, '').replace(/""/g, '"').trim() : undefined;
              const notes = parts[9] ? parts[9].replace(/^"|"$/g, '').replace(/""/g, '"').trim() : undefined;

              const haulIdx = calendarEventHeaderCols.indexOf('haulratepct');
              const rawHaul = (haulIdx !== -1 ? parts[haulIdx] : parts[10])?.replace(/^"|"$/g, '').trim() ?? '';
              const haulRatePct = rawHaul !== '' && !isNaN(parseFloat(rawHaul)) ? parseFloat(rawHaul) : undefined;

              const bulkInIdx = calendarEventHeaderCols.indexOf('bulkinmult');
              const rawBulkIn = (bulkInIdx !== -1 ? parts[bulkInIdx] : parts[11])?.replace(/^"|"$/g, '').trim() ?? '';
              const bulkInMultiplier = rawBulkIn !== '' && !isNaN(parseFloat(rawBulkIn)) ? parseFloat(rawBulkIn) : undefined;

              const bulkOutIdx = calendarEventHeaderCols.indexOf('bulkoutmult');
              const rawBulkOut = (bulkOutIdx !== -1 ? parts[bulkOutIdx] : parts[12])?.replace(/^"|"$/g, '').trim() ?? '';
              const bulkOutMultiplier = rawBulkOut !== '' && !isNaN(parseFloat(rawBulkOut)) ? parseFloat(rawBulkOut) : undefined;

              const affectedIdx = calendarEventHeaderCols.indexOf('affectedmaterials');
              const rawAffected = (affectedIdx !== -1 ? parts[affectedIdx] : parts[13])?.replace(/^"|"$/g, '').trim() ?? '';
              const affectedList = rawAffected
                ? Array.from(new Set(rawAffected.split('|').map(s => s.trim().toUpperCase()).filter(Boolean)))
                : [];

              const validTargetTypes: CalendarTargetType[] = ['global', 'container', 'transfer', 'route'];
              const validStatesByType: Record<CalendarTargetType, CalendarEventState[]> = {
                global: ['site_shutdown', 'weather_haul', 'weather_bulking', 'combined_weather'],
                container: ['open', 'restricted', 'blocked'],
                transfer: ['max', 'variable', 'stopped'],
                route: ['open', 'restricted', 'blocked']
              };

              if (
                id &&
                (targetId || rawTargetType === 'global') &&
                validTargetTypes.includes(rawTargetType as CalendarTargetType) &&
                !isNaN(startDay) &&
                !isNaN(endDay) &&
                validStatesByType[rawTargetType as CalendarTargetType].includes(rawState as CalendarEventState)
              ) {
                parsedCalendarEvents.push({
                  id,
                  calendarId,
                  targetType: rawTargetType as CalendarTargetType,
                  targetId: rawTargetType === 'global' ? 'site' : targetId,
                  startDay,
                  endDay,
                  state: rawState as CalendarEventState,
                  ...(rateValue !== undefined ? { rateValue } : {}),
                  ...(haulRatePct !== undefined ? { haulRatePct } : {}),
                  ...(bulkInMultiplier !== undefined ? { bulkInMultiplier } : {}),
                  ...(bulkOutMultiplier !== undefined ? { bulkOutMultiplier } : {}),
                  ...(affectedList.length > 0 ? { affectedMaterials: affectedList } : {}),
                  ...(label ? { label } : {}),
                  ...(notes ? { notes } : {})
                });
              }
            }
          }
        }

        if (parsedNodes.length > 0) {
          const parsedNodeIds = new Set(parsedNodes.map(n => n.id));
          const seenLinkIds = new Set<string>();
          const validParsedLinks = parsedLinks.filter(l => {
            if (!parsedNodeIds.has(l.sourceId) || !parsedNodeIds.has(l.targetId)) return false;
            if (seenLinkIds.has(l.id)) return false;
            seenLinkIds.add(l.id);
            return true;
          });

          const parsedCalendar: CalendarModel | undefined =
            parsedCalendarMeta || parsedCalendarEvents.length > 0
              ? {
                  id: parsedCalendarMeta?.id || 'calendar-1',
                  name: parsedCalendarMeta?.name || 'Project Schedule',
                  notes: parsedCalendarMeta?.notes,
                  events: parsedCalendarEvents
                }
              : undefined;

          let parsedProjectSettings: ProjectSettings | undefined = undefined;
          if (hasProjectSettingsSection) {
            const rawWd = parsedProjectKV['WorkingDays'];
            let workingDays: ProjectSettings['workingDays'] | undefined = undefined;
            if (rawWd) {
              const bits = rawWd.split('|').map(s => s.trim() === '1' || s.trim().toLowerCase() === 'true');
              if (bits.length === 7) {
                workingDays = bits as ProjectSettings['workingDays'];
              }
            }
            parsedProjectSettings = normalizeProjectSettings({
              projectName: parsedProjectKV['ProjectName'],
              startDate: parsedProjectKV['StartDate'],
              endDate: parsedProjectKV['EndDate'],
              workingDays,
              holidays: parsedHolidays,
              projectNotes: parsedProjectKV['ProjectNotes']
            });
          }

          let parsedSimSettings: SimSettings | undefined = undefined;
          if (hasSimSettingsSection) {
            parsedSimSettings = normalizeSimSettings({
              allocationPolicy: parsedSimKV['AllocationPolicy'] as any,
              partialDeliveryPolicy: parsedSimKV['PartialDeliveryPolicy'] as any,
              truckPayloadM3: parsedSimKV['TruckPayloadM3'] ? parseFloat(parsedSimKV['TruckPayloadM3']) : undefined,
              minBatchPct: parsedSimKV['MinBatchPct'] ? parseFloat(parsedSimKV['MinBatchPct']) : undefined,
              sameDayDrainageCredit:
                parsedSimKV['SameDayDrainageCredit'] !== undefined
                  ? parsedSimKV['SameDayDrainageCredit'].toLowerCase() === 'true'
                  : undefined,
              bulkingMode: parsedSimKV['BulkingMode'] as any,
              diversionOrder: parsedSimKV['DiversionOrder'] as any,
              allowOvertimeOnNonWorkingDays:
                parsedSimKV['AllowOvertimeOnNonWorkingDays'] !== undefined
                  ? parsedSimKV['AllowOvertimeOnNonWorkingDays'].toLowerCase() === 'true'
                  : undefined,
              defaultHeadroomThresholdM3: parsedSimKV['DefaultHeadroomThresholdM3']
                ? parseFloat(parsedSimKV['DefaultHeadroomThresholdM3'])
                : undefined,
              defaultOverflowTriggerPct: parsedSimKV['DefaultOverflowTriggerPct']
                ? parseFloat(parsedSimKV['DefaultOverflowTriggerPct'])
                : undefined
            });
          }

          vm.loadModel(
            parsedNodes,
            validParsedLinks,
            parsedMaterials.length > 0 ? parsedMaterials : undefined,
            parsedCorridors,
            parsedCalendar,
            parsedProjectSettings,
            parsedSimSettings
          );
          // When a new model is loaded, reset timeline to day 0
          vm.setFrameIndex(0);
          setCurrentDay(0);
          setIsPlayback(false);
          vm.setPlayback(false);

          setNodes([...vm.getNodes()]);
          setLinks([...vm.getLinks()]);
          setCorridors(vm.getCorridors().map(c => ({ ...c, waypoints: c.waypoints.map(p => ({ ...p })) })));
          setCalendar(vm.getCalendar());
          setMaterials([...vm.getMaterials()]);
          setProjectSettings(vm.getProjectSettings());
          setSimSettings(vm.getSimSettings());
          setSelectedNodeIds([parsedNodes[0].id]);
          setSelectedLinkIds([]);
          setSelectedCorridorIds([]);
          setSelectedCalendarEventId(null);

          const importedCalCount = vm.getCalendar().events.length;
          const matSummary = parsedMaterials.length > 0 ? `, ${parsedMaterials.length} materials` : '';
          const corridorSummary = parsedCorridors.length > 0 ? `, ${parsedCorridors.length} corridors` : '';
          const calSummary = importedCalCount > 0 ? `, ${importedCalCount} event${importedCalCount > 1 ? 's' : ''}` : '';
          const settingsSummary = hasProjectSettingsSection || hasSimSettingsSection ? ' + project/sim settings' : '';
          showToast(`Imported ${parsedNodes.length} nodes, ${validParsedLinks.length} links${corridorSummary}${calSummary}${matSummary}${settingsSummary}!`, 'success');
        } else {
          showToast('No valid nodes found in CSV file.', 'error');
        }
      } catch (err) {
        console.error(err);
        showToast('Failed to parse CSV file format.', 'error');
      }
    };
    reader.readAsText(file);
    // Reset file input value so re-importing the same file triggers onChange
    e.target.value = '';
  };

  const selectedCalendarEvent = selectedCalendarEventId
    ? calendar.events.find(e => e.id === selectedCalendarEventId)
    : undefined;

  const isPureNodeSelection = !selectedCalendarEvent && selectedNodeIds.length > 0 && selectedLinkIds.length === 0 && selectedCorridorIds.length === 0;
  const isPureSingleLink = !selectedCalendarEvent && selectedNodeIds.length === 0 && selectedLinkIds.length === 1 && selectedCorridorIds.length === 0;
  const isPureSingleCorridor = !selectedCalendarEvent && selectedNodeIds.length === 0 && selectedLinkIds.length === 0 && selectedCorridorIds.length === 1;

  const singleSelectedNode = isPureNodeSelection && selectedNodeIds.length === 1 ? nodes.find(n => n.id === selectedNodeIds[0]) : undefined;
  const selectedLink = isPureSingleLink ? links.find(l => l.id === selectedLinkIds[0]) : undefined;
  const selectedCorridor = isPureSingleCorridor ? corridors.find(c => c.id === selectedCorridorIds[0]) : undefined;

  const hasSelection = selectedNodeIds.length > 0 || selectedLinkIds.length > 0 || selectedCorridorIds.length > 0;
  const hasDeletableSelection = hasSelection || Boolean(selectedCalendarEvent);
  const canLink = selectedNodeIds.length >= 2;
  const canSetLanes = selectedCorridorIds.length >= 1 && selectedLinkIds.length >= 1;
  const hasSelectedLinkedToSelectedCorridors =
    selectedLinkIds.length > 0 &&
    selectedCorridorIds.length > 0 &&
    selectedLinkIds.some(id => {
      const link = links.find(l => l.id === id);
      return link ? getLinkCorridorIds(link).some(cid => selectedCorridorIds.includes(cid)) : false;
    });
  const hasSelectedLinkedTransfers = selectedLinkIds.some(id => {
    const link = links.find(l => l.id === id);
    return link ? getLinkCorridorIds(link).length > 0 : false;
  });
  const hasSelectedCorridorWithTransfers = selectedCorridorIds.some(cid =>
    links.some(l => getLinkCorridorIds(l).includes(cid))
  );
  const canUnlinkLanes =
    selectedLinkIds.length > 0 && selectedCorridorIds.length > 0
      ? hasSelectedLinkedToSelectedCorridors
      : selectedLinkIds.length > 0
      ? hasSelectedLinkedTransfers
      : hasSelectedCorridorWithTransfers;

  const selectedKind: 'container' | 'link' | 'none' =
    isPureNodeSelection ? 'container' :
    isPureSingleLink ? 'link' :
    'none';

  const isClipboardInUse = clipboard !== null;
  const isWrongKind = isClipboardInUse && selectedKind !== 'none' && selectedKind !== clipboard.type;

  const handleCopy = useCallback(() => {
    if (isPlayback) return;
    if (selectedKind === 'none') {
      showToast('Select a container or transfer link to copy properties.', 'error');
      return;
    }
    if (isClipboardInUse && isWrongKind) {
      showToast(
        `Copy disabled: Clipboard contains ${clipboard.type === 'container' ? 'Container' : 'Transfer Link'} properties. Clear clipboard or select a matching element.`,
        'error'
      );
      return;
    }

    if (selectedKind === 'container') {
      const targetNode = nodes.find(n => selectedNodeIds.includes(n.id));
      if (!targetNode) return;

      const properties: ContainerProperties = {
        type: targetNode.type,
        capacity: targetNode.capacity,
        currentVolume: targetNode.currentVolume,
        materialType: targetNode.materialType,
        plantCount: targetNode.plantCount,
        overflowMode: targetNode.overflowMode,
        strictSubRule: targetNode.strictSubRule,
        headroomThreshold: targetNode.headroomThreshold,
        overflowTriggerPct: targetNode.overflowTriggerPct,
        status: targetNode.status,
        allowedMaterials: targetNode.allowedMaterials ? [...targetNode.allowedMaterials] : undefined,
        notes: targetNode.notes
      };

      setClipboard({
        type: 'container',
        sourceName: targetNode.name,
        properties
      });
      showToast(`Copied properties from container "${targetNode.name}"`, 'success');
    } else if (selectedKind === 'link' && selectedLink) {
      const copiedCorridorIds = getLinkCorridorIds(selectedLink);
      const copiedBackupCorridorIds = getLinkBackupCorridorIds(selectedLink);
      const properties: LinkProperties = {
        dailyRate: selectedLink.dailyRate,
        fleetCount: selectedLink.fleetCount,
        materialId: selectedLink.materialId,
        priority: selectedLink.priority,
        corridorIds: copiedCorridorIds.length > 0 ? copiedCorridorIds : undefined,
        linkRole: selectedLink.linkRole,
        diversionTriggers: selectedLink.diversionTriggers ? [...selectedLink.diversionTriggers] : undefined,
        backupCorridorIds: copiedBackupCorridorIds.length > 0 ? copiedBackupCorridorIds : undefined,
        backupCorridorRate: selectedLink.backupCorridorRate,
        rateSchedule: selectedLink.rateSchedule ? [...selectedLink.rateSchedule] : undefined,
        notes: selectedLink.notes
      };

      const src = nodes.find(n => n.id === selectedLink.sourceId);
      const tgt = nodes.find(n => n.id === selectedLink.targetId);
      const linkLabel = `${src?.name || 'Source'} → ${tgt?.name || 'Target'}`;

      setClipboard({
        type: 'link',
        sourceName: linkLabel,
        properties
      });
      showToast(`Copied properties from link "${linkLabel}"`, 'success');
    }
  }, [isPlayback, selectedKind, isClipboardInUse, isWrongKind, clipboard, nodes, selectedNodeIds, selectedLink]);

  const handlePaste = useCallback(() => {
    if (isPlayback) return;
    if (!clipboard) {
      showToast('Clipboard is empty. Select an element and press Ctrl+C to copy properties.', 'error');
      return;
    }
    if (selectedKind === 'none') {
      showToast(`Select target ${clipboard.type === 'container' ? 'container(s)' : 'transfer link'} to paste properties.`, 'error');
      return;
    }
    if (isWrongKind) {
      showToast(
        `Cannot paste: Clipboard contains ${clipboard.type === 'container' ? 'Container' : 'Transfer Link'} properties, but selected element is a ${selectedKind === 'container' ? 'Container' : 'Transfer Link'}.`,
        'error'
      );
      return;
    }

    if (clipboard.type === 'container') {
      const updateData: Partial<ContainerNode> = {
        type: clipboard.properties.type,
        capacity: clipboard.properties.capacity,
        currentVolume: clipboard.properties.currentVolume,
        materialType: clipboard.properties.materialType,
        plantCount: clipboard.properties.plantCount,
        overflowMode: clipboard.properties.overflowMode,
        strictSubRule: clipboard.properties.strictSubRule,
        headroomThreshold: clipboard.properties.headroomThreshold,
        overflowTriggerPct: clipboard.properties.overflowTriggerPct,
        status: clipboard.properties.status,
        allowedMaterials: clipboard.properties.allowedMaterials ? [...clipboard.properties.allowedMaterials] : undefined,
        notes: clipboard.properties.notes
      };

      vm.updateNodes(n => selectedNodeIds.includes(n.id), updateData);
      setNodes(vm.getNodes().map(n => ({ ...n })));
      const count = selectedNodeIds.length;
      showToast(`Pasted properties into ${count} container${count > 1 ? 's' : ''}`, 'success');
    } else if (clipboard.type === 'link' && selectedLink) {
      const pastedCorridorIds = getLinkCorridorIds(clipboard.properties);
      const pastedBackupCorridorIds = getLinkBackupCorridorIds(clipboard.properties);
      const updateData: Partial<TransferLink> = {
        dailyRate: clipboard.properties.dailyRate,
        fleetCount: clipboard.properties.fleetCount,
        materialId: clipboard.properties.materialId,
        priority: clipboard.properties.priority,
        corridorIds: pastedCorridorIds.length > 0 ? pastedCorridorIds : undefined,
        corridorId: undefined,
        linkRole: clipboard.properties.linkRole,
        primaryLinkId: undefined,
        diversionTriggers: clipboard.properties.diversionTriggers ? [...clipboard.properties.diversionTriggers] : undefined,
        backupCorridorIds: pastedBackupCorridorIds.length > 0 ? pastedBackupCorridorIds : undefined,
        backupCorridorRate: clipboard.properties.backupCorridorRate,
        rateSchedule: clipboard.properties.rateSchedule ? [...clipboard.properties.rateSchedule] : undefined,
        notes: clipboard.properties.notes
      };

      vm.updateLink(selectedLink.id, updateData);
      setLinks([...vm.getLinks()]);
      const src = nodes.find(n => n.id === selectedLink.sourceId);
      const tgt = nodes.find(n => n.id === selectedLink.targetId);
      const linkLabel = `${src?.name || 'Source'} → ${tgt?.name || 'Target'}`;
      showToast(`Pasted properties into link "${linkLabel}"`, 'success');
    }
  }, [isPlayback, clipboard, selectedKind, isWrongKind, selectedNodeIds, selectedLink, vm, nodes]);

  const handleClearClipboard = useCallback(() => {
    setClipboard(null);
    showToast('Clipboard cleared.', 'success');
  }, []);

  const handleCycleContainerOutputEdge = useCallback((reverse = false) => {
    if (isPlayback || selectedNodeIds.length === 0) return;
    const EDGE_ORDER: CardinalEdge[] = ['N', 'E', 'S', 'W'];
    const currentNodes = vm.getNodes();
    const currentLinks = vm.getLinks();
    const currentCorridors = vm.getCorridors();

    selectedNodeIds.forEach(nodeId => {
      const node = currentNodes.find(n => n.id === nodeId);
      if (!node) return;
      const currentEdge = getEffectiveContainerOutputEdge(node, currentNodes, currentLinks, currentCorridors);
      const idx = EDGE_ORDER.indexOf(currentEdge);
      const nextEdge = EDGE_ORDER[(idx + (reverse ? 3 : 1)) % 4];
      vm.setNodeOutputEdge(node.id, nextEdge);
    });

    setNodes(vm.getNodes().map(n => ({ ...n })));
  }, [isPlayback, selectedNodeIds, vm]);

  const handleCycleContainerInputEdge = useCallback((reverse = false) => {
    if (isPlayback || selectedNodeIds.length === 0) return;
    const EDGE_ORDER: CardinalEdge[] = ['N', 'E', 'S', 'W'];
    const currentNodes = vm.getNodes();
    const currentLinks = vm.getLinks();
    const currentCorridors = vm.getCorridors();

    selectedNodeIds.forEach(nodeId => {
      const node = currentNodes.find(n => n.id === nodeId);
      if (!node) return;
      const currentEdge = getEffectiveContainerInputEdge(node, currentNodes, currentLinks, currentCorridors);
      const idx = EDGE_ORDER.indexOf(currentEdge);
      const nextEdge = EDGE_ORDER[(idx + (reverse ? 3 : 1)) % 4];
      vm.setNodeInputEdge(node.id, nextEdge);
    });

    setNodes(vm.getNodes().map(n => ({ ...n })));
  }, [isPlayback, selectedNodeIds, vm]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          (activeEl as HTMLElement).isContentEditable)
      ) {
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && !isPlayback && hasDeletableSelection) {
        e.preventDefault();
        handleDeleteSelected();
        return;
      }

      const key = e.key.toLowerCase();
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;

      if (!isCtrlOrCmd && !e.altKey && key === 'o' && !isPlayback && selectedNodeIds.length > 0) {
        e.preventDefault();
        handleCycleContainerOutputEdge(e.shiftKey);
        return;
      }

      if (!isCtrlOrCmd && !e.altKey && key === 'i' && !isPlayback && selectedNodeIds.length > 0) {
        e.preventDefault();
        handleCycleContainerInputEdge(e.shiftKey);
        return;
      }

      if (!isCtrlOrCmd) return;

      if (key === 'c') {
        e.preventDefault();
        handleCopy();
      } else if (key === 'v') {
        e.preventDefault();
        handlePaste();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [handleCopy, handlePaste, handleDeleteSelected, handleCycleContainerOutputEdge, handleCycleContainerInputEdge, isPlayback, hasDeletableSelection, selectedNodeIds.length]);

  const handleUpdateSingleNode = (field: keyof ContainerNode, val: any) => {
    if (!singleSelectedNode || isPlayback) return;
    if (field === 'outputEdge') {
      vm.setNodeOutputEdge(singleSelectedNode.id, val || undefined);
    } else if (field === 'inputEdge') {
      vm.setNodeInputEdge(singleSelectedNode.id, val || undefined);
    } else {
      vm.updateNode(singleSelectedNode.id, { [field]: val });
    }
    setNodes(vm.getNodes().map(n => ({ ...n })));
  };

  const handleUpdateNodeById = (nodeId: string, updates: Partial<ContainerNode>) => {
    if (isPlayback) return;
    vm.updateNode(nodeId, updates);
    setNodes(vm.getNodes().map(n => ({ ...n })));
  };

  const handleUpdateLink = (field: keyof TransferLink, val: any) => {
    if (!selectedLink || isPlayback) return;
    vm.updateLink(selectedLink.id, { [field]: val });
    setLinks([...vm.getLinks()]);
  };

  const handleUpdateLinkFields = (linkId: string, updates: Partial<TransferLink>) => {
    if (isPlayback) return;
    vm.updateLink(linkId, updates);
    setLinks([...vm.getLinks()]);
  };

  const handleUpdateCorridor = (field: keyof RouteCorridor, val: any) => {
    if (!selectedCorridor || isPlayback) return;
    vm.updateCorridor(selectedCorridor.id, { [field]: val });
    setCorridors(vm.getCorridors().map(c => ({ ...c, waypoints: c.waypoints.map(p => ({ ...p })) })));
  };

  const handleToggleLinkCorridor = (linkId: string, corridorId: string, assign: boolean) => {
    if (isPlayback) return;
    vm.toggleLinkCorridor(linkId, corridorId, assign);
    setLinks([...vm.getLinks()]);
  };

  const handleToggleLinkBackupCorridor = (linkId: string, corridorId: string, assign: boolean) => {
    if (isPlayback) return;
    vm.toggleLinkBackupCorridor(linkId, corridorId, assign);
    setLinks([...vm.getLinks()]);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100vw', height: '100vh', overflow: 'hidden', backgroundColor: '#0f172a' }}>
      {/* Hidden file input referenced by TopHeader */}
      <input 
        type="file" 
        ref={fileInputRef} 
        style={{ display: 'none' }} 
        accept=".csv" 
        onChange={handleImportCSVFile} 
      />

      <TopHeader 
        fileInputRef={fileInputRef}
        isPlayback={isPlayback}
        onTogglePlayback={togglePlayback}
        onOpenExportModal={() => setIsExportModalOpen(true)}
        onOpenManualModal={() => setIsManualModalOpen(true)}
        isSettingsOpen={isSettingsDrawerOpen}
        onToggleSettings={() => setIsSettingsDrawerOpen(v => !v)}
        projectHorizonLabel={`${formatShortDate(projectSettings.startDate)} – ${formatShortDate(projectSettings.endDate)} (${totalDays}d)`}
      />
      
      <BatchPresetBar onApplyPreset={handleApplyPreset} selectedCount={selectedNodeIds.length} />

      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <div style={{ flex: 3, display: 'flex', flexDirection: 'column', position: 'relative', height: '100%', minHeight: 0, overflow: 'hidden' }}>
          <SimulationCanvas 
            vm={vm}
            nodes={nodes}
            links={links}
            corridors={corridors}
            selectedNodeIds={selectedNodeIds}
            selectedLinkIds={selectedLinkIds}
            selectedCorridorIds={selectedCorridorIds}
            setSelectedNodeIds={handleCanvasSelectNodes}
            setSelectedLinkIds={handleCanvasSelectLinks}
            setSelectedCorridorIds={handleCanvasSelectCorridors}
            isPlayback={isPlayback}
            highlightedNodeIds={highlightedNodeIds}
            setHighlightedNodeIds={setHighlightedNodeIds}
            currentFrame={currentFrame}
            isGraphExpanded={isGraphExpanded}
            onNodesUpdated={handleNodesUpdated}
            onCorridorsUpdated={handleCorridorsUpdated}
            onAddNode={handleAddNode}
            onAddLink={handleAddLink}
            onAddCorridor={handleAddCorridor}
            onSetRouteLanes={handleSetRouteLanes}
            onUnlinkLanes={handleUnlinkLanes}
            onDeleteSelected={handleDeleteSelected}
            canLink={canLink}
            canSetLanes={canSetLanes}
            canUnlinkLanes={canUnlinkLanes}
            hasSelection={hasSelection}
          />

          <PlaybackGraph 
            nodes={nodes}
            links={links}
            corridors={corridors}
            calendar={calendar}
            projectSettings={projectSettings}
            frames={frames}
            currentDay={currentDay}
            isPlayback={isPlayback}
            isGraphExpanded={isGraphExpanded}
            setIsGraphExpanded={setIsGraphExpanded}
            setCurrentDay={setCurrentDay}
            vm={vm}
            highlightedNodeIds={highlightedNodeIds}
            setHighlightedNodeIds={setHighlightedNodeIds}
            selectedCalendarEventId={selectedCalendarEventId}
            selectedNodeIds={selectedNodeIds}
            selectedLinkIds={selectedLinkIds}
            selectedCorridorIds={selectedCorridorIds}
            onSelectCalendarEvent={handleSelectCalendarEvent}
            onSelectTargetElement={handleSelectTargetElement}
            onAddCalendarEvent={handleAddCalendarEvent}
            onUpdateCalendarEvent={handleUpdateCalendarEvent}
          />
        </div>

        <PropertyInspector 
          vm={vm}
          isPlayback={isPlayback}
          currentDay={currentDay}
          totalDays={totalDays}
          projectSettings={projectSettings}
          simSettings={simSettings}
          currentFrame={currentFrame}
          selectedNodeIds={selectedNodeIds}
          selectedLinkIds={selectedLinkIds}
          selectedCorridorIds={selectedCorridorIds}
          singleSelectedNode={singleSelectedNode}
          selectedLink={selectedLink}
          selectedCorridor={selectedCorridor}
          calendar={calendar}
          selectedCalendarEvent={selectedCalendarEvent}
          corridors={corridors}
          links={links}
          nodes={nodes}
          hasSelection={hasSelection}
          canSetLanes={canSetLanes}
          canUnlinkLanes={canUnlinkLanes}
          materials={materials}
          clipboard={clipboard}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onClearClipboard={handleClearClipboard}
          onUpdateSingleNode={handleUpdateSingleNode}
          onUpdateNodeById={handleUpdateNodeById}
          onUpdateLink={handleUpdateLink}
          onUpdateLinkFields={handleUpdateLinkFields}
          onUpdateCorridor={handleUpdateCorridor}
          onUpdateCalendarEvent={handleUpdateCalendarEvent}
          onDeleteCalendarEvent={handleDeleteCalendarEvent}
          onSelectTargetElement={handleSelectTargetElement}
          onToggleLinkCorridor={handleToggleLinkCorridor}
          onToggleLinkBackupCorridor={handleToggleLinkBackupCorridor}
          onSetRouteLanes={handleSetRouteLanes}
          onUnlinkLanes={handleUnlinkLanes}
          onDeleteSelected={handleDeleteSelected}
          onClearSelection={handleClearSelection}
          onMaterialsUpdated={() => setMaterials([...vm.getMaterials()])}
        />
      </div>

      <SettingsDrawer
        isOpen={isSettingsDrawerOpen}
        onClose={() => setIsSettingsDrawerOpen(false)}
        isPlayback={isPlayback}
        projectSettings={projectSettings}
        simSettings={simSettings}
        materials={materials}
        calendarEvents={calendar.events}
        onUpdateProjectSettings={handleUpdateProjectSettings}
        onResetProjectSettings={handleResetProjectSettings}
        onUpdateSimSettings={handleUpdateSimSettings}
        onResetSimSettings={handleResetSimSettings}
        onAddGlobalEvent={evt => {
          const created = handleAddCalendarEvent(evt);
          handleSelectCalendarEvent(created.id);
          showToast(`Added global event "${created.label || created.state.replace(/_/g, ' ')}".`, 'success');
        }}
        onSelectGlobalEvent={eventId => {
          handleSelectCalendarEvent(eventId);
          setIsSettingsDrawerOpen(false);
        }}
        onDeleteGlobalEvent={eventId => {
          vm.removeCalendarEvent(eventId);
          setCalendar(vm.getCalendar());
          setSelectedCalendarEventId(prev => (prev === eventId ? null : prev));
          showToast('Removed global event.', 'success');
        }}
        onImportPreset={handleImportSettingsPreset}
        onShowToast={showToast}
      />

      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        nodes={nodes}
        links={links}
        corridors={corridors}
        calendar={calendar}
        projectSettings={projectSettings}
        simSettings={simSettings}
        frames={frames}
        materials={materials}
      />

      <ManualModal
        isOpen={isManualModalOpen}
        onClose={() => setIsManualModalOpen(false)}
      />

      <RuleConfirmModal
        isOpen={pendingRule !== null}
        onClose={() => setPendingRule(null)}
        onConfirm={confirmApplyRuleToAll}
        ruleName={pendingRule?.name || ''}
        ruleShape={pendingRule?.shape || 'circle'}
        containerCount={nodes.length}
      />

      {toast && (
        <div
          style={{
            position: 'fixed',
            bottom: '24px',
            right: '24px',
            backgroundColor: toast.type === 'error' ? '#ef4444' : '#16a34a',
            color: '#ffffff',
            padding: '10px 18px',
            borderRadius: '8px',
            fontWeight: 600,
            fontSize: '13px',
            boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.4)',
            zIndex: 10000,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            animation: 'fadeIn 0.2s ease-in-out'
          }}
        >
          <span>{toast.type === 'error' ? '⚠️' : '✓'}</span>
          <span>{toast.message}</span>
        </div>
      )}
    </div>
  );
}