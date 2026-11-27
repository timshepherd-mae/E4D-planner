export type ContainerType = 'excavation' | 'stockpile' | 'null' | 'external';
export type OverflowMode = 'strict' | 'overfill';
export type StrictSubRule = 'throttleback' | 'headroom_hold' | 'transfer_through';
export type NodeStatus = 'active' | 'maintenance' | 'blocked';
export type CardinalEdge = 'N' | 'E' | 'S' | 'W';
export type LinkRole = 'primary' | 'standby' | 'overflow';
export type DiversionTrigger = 'route' | 'target' | 'calendar' | 'source';

export interface MaterialDefinition {
  code: string;
  name: string;
  bulkIN: number;   // Swell / deposit factor (e.g., 1.25)
  bulkOUT: number;  // Shrinkage / extraction factor (e.g., 0.90)
}

export interface ContainerNode {
  id: string;
  name: string;
  type: ContainerType;
  x: number;
  y: number;
  capacity: number;
  currentVolume: number;
  materialType: string; // Material code reference (e.g., 'CLAY', 'TOPS')
  plantCount: number;
  overflowMode?: OverflowMode;
  strictSubRule?: StrictSubRule;
  headroomThreshold?: number; // e.g. 500 m³ spare space required to resume after headroom hold
  overflowTriggerPct?: number; // 1..100 (% full) at which transfer-through activates (default 100)
  status?: NodeStatus;
  allowedMaterials?: string[];
  outputEdge?: CardinalEdge;
  inputEdge?: CardinalEdge;
  notes?: string;
}

export interface Point {
  x: number;
  y: number;
}

export interface RouteCorridor {
  id: string;
  name: string;
  waypoints: Point[]; // Minimum 2 points (start, optional bend points, end)
  laneSpacing: number; // Parallel pipe spacing inside corridor in world pixels (default 5)
  notes?: string;
  maxDailyRate?: number;  // Optional baseline combined daily rate cap (m³/d)
  maxFleetCount?: number; // Optional baseline max combined fleet units
}

export interface TransferLink {
  id: string;
  sourceId: string;
  targetId: string;
  dailyRate: number;
  fleetCount: number;
  materialId?: string;
  priority?: number;
  linkRole?: LinkRole; // 'primary' (default), 'standby' (spillover diversion), 'overflow' (container transfer-through)
  primaryLinkId?: string; // Watched primary transfer ID when linkRole === 'standby'
  diversionTriggers?: DiversionTrigger[]; // Qualifying constraints when linkRole === 'standby'
  corridorIds?: string[];
  corridorId?: string; // Legacy single-corridor fallback
  backupCorridorIds?: string[]; // Detour route corridors used for spillover when primary corridors block/throttle
  backupCorridorRate?: number; // Optional detour daily rate cap (m³/d)
  rateSchedule?: { day: number; rate: number }[];
  notes?: string;
}

export const getLinkRole = (link: { linkRole?: LinkRole }): LinkRole => {
  if (link.linkRole === 'standby' || link.linkRole === 'overflow') return link.linkRole;
  return 'primary';
};

export const getLinkCorridorIds = (link: { corridorIds?: string[]; corridorId?: string }): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  if (Array.isArray(link.corridorIds)) {
    link.corridorIds.forEach(id => {
      if (id && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    });
  }
  if (link.corridorId && !seen.has(link.corridorId)) {
    seen.add(link.corridorId);
    result.push(link.corridorId);
  }
  return result;
};

export const getLinkBackupCorridorIds = (link: {
  corridorIds?: string[];
  corridorId?: string;
  backupCorridorIds?: string[];
}): string[] => {
  const primarySet = new Set(getLinkCorridorIds(link));
  const seen = new Set<string>();
  const result: string[] = [];
  if (Array.isArray(link.backupCorridorIds)) {
    link.backupCorridorIds.forEach(id => {
      if (id && !primarySet.has(id) && !seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    });
  }
  return result;
};

export type FlowStatus = 'frozen' | 'starved' | 'full' | 'restricted' | 'blocked' | 'diverted' | 'idle';

export type CalendarTargetType = 'global' | 'container' | 'transfer' | 'route';
export type GlobalEventState = 'site_shutdown' | 'weather_haul' | 'weather_bulking' | 'combined_weather';
export type ContainerEventState = 'open' | 'restricted' | 'blocked';
export type TransferEventState = 'max' | 'variable' | 'stopped';
export type RouteEventState = 'open' | 'restricted' | 'blocked';
export type CalendarEventState = GlobalEventState | ContainerEventState | TransferEventState | RouteEventState;

export interface CalendarEvent {
  id: string;
  calendarId: string;
  targetType: CalendarTargetType;
  targetId: string;     // 'site' for global events, or element id
  startDay: number;     // 1..totalDays inclusive
  endDay: number;       // 1..totalDays inclusive (>= startDay)
  state: CalendarEventState;
  rateValue?: number;   // m³/d for transfer 'variable', container 'restricted', or route 'restricted' cap
  haulRatePct?: number; // Global weather_haul / combined_weather: 0..200% vehicle movement multiplier (default 60)
  bulkInMultiplier?: number;  // Global weather_bulking / combined_weather: multiplier applied to material bulkIN (default 1.15)
  bulkOutMultiplier?: number; // Global weather_bulking / combined_weather: multiplier applied to material bulkOUT (default 1.0)
  affectedMaterials?: string[]; // Optional material codes affected by global weather bulking/haul (empty = all)
  label?: string;
  notes?: string;
}

export interface CalendarModel {
  id: string;
  name: string;
  notes?: string;
  events: CalendarEvent[];
}

export interface ProjectHoliday {
  id: string;
  name: string;
  startDate: string; // YYYY-MM-DD inclusive
  endDate: string;   // YYYY-MM-DD inclusive
}

export interface ProjectSettings {
  projectName: string;
  projectNotes?: string;
  startDate: string; // YYYY-MM-DD (Day 1)
  endDate: string;   // YYYY-MM-DD (Day N)
  /** [Sun, Mon, Tue, Wed, Thu, Fri, Sat] — true = working day */
  workingDays: [boolean, boolean, boolean, boolean, boolean, boolean, boolean];
  holidays: ProjectHoliday[];
}

export type AllocationPolicy = 'priority_prorata' | 'priority_equal' | 'strict_order';
export type PartialDeliveryPolicy = 'allow_partial' | 'discrete_loads' | 'min_batch';
export type BulkingMode = 'strict_bulking' | 'bank_volume_only';
export type DiversionOrder = 'backup_corridor_first' | 'standby_link_first';

export interface SimSettings {
  allocationPolicy: AllocationPolicy;
  partialDeliveryPolicy: PartialDeliveryPolicy;
  truckPayloadM3: number;
  minBatchPct: number;
  sameDayDrainageCredit: boolean;
  bulkingMode: BulkingMode;
  diversionOrder: DiversionOrder;
  allowOvertimeOnNonWorkingDays: boolean;
  defaultHeadroomThresholdM3: number;
  defaultOverflowTriggerPct: number;
}

export interface SettingsPresetPayload {
  schemaVersion: 1;
  exportedAt: string;
  presetName?: string;
  projectSettings?: ProjectSettings;
  simSettings?: SimSettings;
  globalEvents?: CalendarEvent[];
}

export const createDefaultProjectSettings = (): ProjectSettings => ({
  projectName: 'Earthworks Programme',
  projectNotes: '',
  startDate: '2026-04-01',
  endDate: '2026-04-30',
  workingDays: [true, true, true, true, true, true, true],
  holidays: []
});

export const createDefaultSimSettings = (): SimSettings => ({
  allocationPolicy: 'priority_prorata',
  partialDeliveryPolicy: 'allow_partial',
  truckPayloadM3: 18,
  minBatchPct: 20,
  sameDayDrainageCredit: true,
  bulkingMode: 'strict_bulking',
  diversionOrder: 'backup_corridor_first',
  allowOvertimeOnNonWorkingDays: false,
  defaultHeadroomThresholdM3: 500,
  defaultOverflowTriggerPct: 100
});

export const normalizeProjectSettings = (raw?: Partial<ProjectSettings> | null): ProjectSettings => {
  const def = createDefaultProjectSettings();
  if (!raw || typeof raw !== 'object') return def;
  const isoRegex = /^\d{4}-\d{2}-\d{2}$/;
  const startDate = typeof raw.startDate === 'string' && isoRegex.test(raw.startDate.trim()) ? raw.startDate.trim() : def.startDate;
  const rawEnd = typeof raw.endDate === 'string' && isoRegex.test(raw.endDate.trim()) ? raw.endDate.trim() : def.endDate;
  const endDate = rawEnd >= startDate ? rawEnd : startDate;
  const workingDays: [boolean, boolean, boolean, boolean, boolean, boolean, boolean] =
    Array.isArray(raw.workingDays) && raw.workingDays.length === 7
      ? [
          Boolean(raw.workingDays[0]),
          Boolean(raw.workingDays[1]),
          Boolean(raw.workingDays[2]),
          Boolean(raw.workingDays[3]),
          Boolean(raw.workingDays[4]),
          Boolean(raw.workingDays[5]),
          Boolean(raw.workingDays[6])
        ]
      : [...def.workingDays];
  const holidays: ProjectHoliday[] = Array.isArray(raw.holidays)
    ? raw.holidays
        .filter(
          (h): h is ProjectHoliday =>
            Boolean(h) &&
            typeof h.name === 'string' &&
            typeof h.startDate === 'string' &&
            isoRegex.test(h.startDate.trim()) &&
            typeof h.endDate === 'string' &&
            isoRegex.test(h.endDate.trim())
        )
        .map((h, idx) => {
          const s = h.startDate.trim();
          const e = h.endDate.trim() >= s ? h.endDate.trim() : s;
          return {
            id: typeof h.id === 'string' && h.id.trim() ? h.id.trim() : `hol-${idx + 1}`,
            name: h.name.trim() || 'Site Holiday',
            startDate: s,
            endDate: e
          };
        })
    : [];

  return {
    projectName: typeof raw.projectName === 'string' && raw.projectName.trim() ? raw.projectName.trim() : def.projectName,
    projectNotes: typeof raw.projectNotes === 'string' ? raw.projectNotes : '',
    startDate,
    endDate,
    workingDays,
    holidays
  };
};

export const normalizeSimSettings = (raw?: Partial<SimSettings> | null): SimSettings => {
  const def = createDefaultSimSettings();
  if (!raw || typeof raw !== 'object') return def;
  const allocationPolicy: AllocationPolicy =
    raw.allocationPolicy === 'priority_equal' || raw.allocationPolicy === 'strict_order'
      ? raw.allocationPolicy
      : 'priority_prorata';
  const partialDeliveryPolicy: PartialDeliveryPolicy =
    raw.partialDeliveryPolicy === 'discrete_loads' || raw.partialDeliveryPolicy === 'min_batch'
      ? raw.partialDeliveryPolicy
      : 'allow_partial';
  const bulkingMode: BulkingMode =
    raw.bulkingMode === 'bank_volume_only' ? 'bank_volume_only' : 'strict_bulking';
  const diversionOrder: DiversionOrder =
    raw.diversionOrder === 'standby_link_first' ? 'standby_link_first' : 'backup_corridor_first';

  return {
    allocationPolicy,
    partialDeliveryPolicy,
    truckPayloadM3:
      typeof raw.truckPayloadM3 === 'number' && Number.isFinite(raw.truckPayloadM3) && raw.truckPayloadM3 >= 1
        ? Math.min(500, Math.round(raw.truckPayloadM3 * 10) / 10)
        : def.truckPayloadM3,
    minBatchPct:
      typeof raw.minBatchPct === 'number' && Number.isFinite(raw.minBatchPct)
        ? Math.max(1, Math.min(100, Math.round(raw.minBatchPct)))
        : def.minBatchPct,
    sameDayDrainageCredit:
      typeof raw.sameDayDrainageCredit === 'boolean' ? raw.sameDayDrainageCredit : def.sameDayDrainageCredit,
    bulkingMode,
    diversionOrder,
    allowOvertimeOnNonWorkingDays:
      typeof raw.allowOvertimeOnNonWorkingDays === 'boolean'
        ? raw.allowOvertimeOnNonWorkingDays
        : def.allowOvertimeOnNonWorkingDays,
    defaultHeadroomThresholdM3:
      typeof raw.defaultHeadroomThresholdM3 === 'number' && Number.isFinite(raw.defaultHeadroomThresholdM3)
        ? Math.max(0, Math.round(raw.defaultHeadroomThresholdM3))
        : def.defaultHeadroomThresholdM3,
    defaultOverflowTriggerPct:
      typeof raw.defaultOverflowTriggerPct === 'number' && Number.isFinite(raw.defaultOverflowTriggerPct)
        ? Math.max(1, Math.min(100, Math.round(raw.defaultOverflowTriggerPct)))
        : def.defaultOverflowTriggerPct
  };
};

export interface LinkRouteSplit {
  primaryFlow: number;
  backupFlow: number;
  activeBackupCorridorIds: string[];
}

export interface LinkDayMathAudit {
  linkId: string;
  role: LinkRole;
  materialCode: string;
  statedRate: number;
  afterCalendar: number;
  afterGlobalWeather: number;
  afterSourceStock: number;
  afterContainerCap: number;
  afterCorridorAndDetour: number;
  afterTargetHeadroom: number;
  afterPartialRule: number;
  finalDelivered: number;
  bulkOutApplied: number;
  bulkInApplied: number;
  sourceDeductedM3: number;
  targetDepositedM3: number;
  bindingConstraint: string;
  partialRuleNote?: string;
}

export interface ContainerDayMathAudit {
  nodeId: string;
  startVol: number;
  outboundRemovedM3: number;
  sameDayCreditApplied: boolean;
  effectiveHeadroomM3: number;
  inboundDepositedM3: number;
  overflowTransferredOutM3: number;
  endVol: number;
  headroomHoldLatched: boolean;
}

export interface DayMathAudit {
  dateISO: string;
  weekdayShort: string;
  isWorkingDay: boolean;
  nonWorkingReason?: string;
  siteShutdownActive: boolean;
  activeGlobalLabels: string[];
  effectiveHaulPct: number;
  activeBulkingSummary: string[];
  totalDeliveredM3: number;
  links: Record<string, LinkDayMathAudit>;
  containers: Record<string, ContainerDayMathAudit>;
}

export interface SimFrame {
  day: number;
  dateISO?: string;
  isWorkingDay?: boolean;
  nonWorkingReason?: string;
  globalHaulMultiplier?: number;
  nodeVolumes: Record<string, number>;
  linkFlows: Record<string, number>;
  corridorFlows?: Record<string, number>;
  backupCorridorFlows?: Record<string, number>;
  linkRouteSplits?: Record<string, LinkRouteSplit>;
  overflowActiveNodes?: Record<string, number>;
  standbyActivatedFrom?: Record<string, { primaryLinkId: string; divertedFlow: number }>;
  linkStatuses: Record<string, FlowStatus>;
  nodeStatuses: Record<string, FlowStatus>;
  corridorStatuses?: Record<string, FlowStatus>;
  alerts: string[];
  dayAudit?: DayMathAudit;
}

export interface ContainerProperties {
  type: ContainerType;
  capacity: number;
  currentVolume: number;
  materialType: string;
  plantCount: number;
  overflowMode?: OverflowMode;
  strictSubRule?: StrictSubRule;
  headroomThreshold?: number;
  overflowTriggerPct?: number;
  status?: NodeStatus;
  allowedMaterials?: string[];
  outputEdge?: CardinalEdge;
  inputEdge?: CardinalEdge;
  notes?: string;
}

export interface LinkProperties {
  dailyRate: number;
  fleetCount: number;
  materialId?: string;
  priority?: number;
  linkRole?: LinkRole;
  diversionTriggers?: DiversionTrigger[];
  corridorIds?: string[];
  corridorId?: string;
  backupCorridorIds?: string[];
  backupCorridorRate?: number;
  rateSchedule?: { day: number; rate: number }[];
  notes?: string;
}

export type ClipboardData =
  | {
      type: 'container';
      sourceName: string;
      properties: ContainerProperties;
    }
  | {
      type: 'link';
      sourceName: string;
      properties: LinkProperties;
    };

export const GRAPH_LINE_COLORS = [
  '#0d9488', // Teal
  '#b45309', // Amber / Orange
  '#38bdf8', // Cyan / Light Blue
  '#a855f7', // Purple
  '#22c55e', // Green
  '#ec4899', // Pink
  '#eab308', // Yellow
  '#6366f1', // Indigo
];

export const HIGHLIGHT_DASH_PATTERNS = [
  { name: 'dots', canvas: [9, 12], svg: '9 12' },                         // Dotted (3x)
  { name: 'medium-dashes', canvas: [24, 15], svg: '24 15' },              // Dashed (3x)
  { name: 'dash-dot', canvas: [36, 12, 9, 12], svg: '36 12 9 12' },       // Dash-dot (3x)
  { name: 'long-dashes', canvas: [48, 18], svg: '48 18' },                 // Long-dash (3x)
  { name: 'short-dashes', canvas: [15, 12], svg: '15 12' },                // Short-dash (3x)
  { name: 'dash-two-dots', canvas: [36, 9, 9, 9, 9, 9], svg: '36 9 9 9 9 9' }, // Dash-two-dots (3x)
];