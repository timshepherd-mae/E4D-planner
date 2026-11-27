import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AllocationPolicy,
  BulkingMode,
  CalendarEvent,
  DiversionOrder,
  GlobalEventState,
  MaterialDefinition,
  PartialDeliveryPolicy,
  ProjectHoliday,
  ProjectSettings,
  SettingsPresetPayload,
  SimSettings
} from '../../models/types';
import {
  MAX_SIM_DAYS,
  addDaysISO,
  computeInclusiveDays,
  computeWorkingDayStats,
  dateISOToDayIndex,
  dayIndexToDateISO,
  formatShortDate
} from '../../utils/dateUtils';

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  isPlayback: boolean;
  projectSettings: ProjectSettings;
  simSettings: SimSettings;
  materials: MaterialDefinition[];
  calendarEvents: CalendarEvent[];
  onUpdateProjectSettings: (updates: Partial<ProjectSettings>) => void;
  onResetProjectSettings: () => void;
  onUpdateSimSettings: (updates: Partial<SimSettings>) => void;
  onResetSimSettings: () => void;
  onAddGlobalEvent: (event: Omit<CalendarEvent, 'calendarId'>) => void;
  onSelectGlobalEvent: (eventId: string) => void;
  onDeleteGlobalEvent: (eventId: string) => void;
  onImportPreset: (preset: SettingsPresetPayload) => void;
  onShowToast: (message: string, type?: 'success' | 'error') => void;
}

type SettingsTab = 'project' | 'sim';

const WEEKDAY_LABELS: Array<{ label: string; index: number }> = [
  { label: 'Mon', index: 1 },
  { label: 'Tue', index: 2 },
  { label: 'Wed', index: 3 },
  { label: 'Thu', index: 4 },
  { label: 'Fri', index: 5 },
  { label: 'Sat', index: 6 },
  { label: 'Sun', index: 0 }
];

const HORIZON_PRESETS = [
  { label: '30d', days: 30 },
  { label: '60d', days: 60 },
  { label: '90d', days: 90 },
  { label: '180d', days: 180 },
  { label: '1 yr', days: 365 }
];

const GLOBAL_EVENT_META: Record<GlobalEventState, { label: string; accent: string }> = {
  site_shutdown: { label: 'Site Shutdown', accent: '#ef4444' },
  weather_haul: { label: 'Weather — Haul Impact', accent: '#f59e0b' },
  weather_bulking: { label: 'Weather — Bulking Modifier', accent: '#818cf8' },
  combined_weather: { label: 'Combined Weather', accent: '#38bdf8' }
};

export const SettingsDrawer: React.FC<SettingsDrawerProps> = ({
  isOpen,
  onClose,
  isPlayback,
  projectSettings,
  simSettings,
  materials,
  calendarEvents,
  onUpdateProjectSettings,
  onResetProjectSettings,
  onUpdateSimSettings,
  onResetSimSettings,
  onAddGlobalEvent,
  onSelectGlobalEvent,
  onDeleteGlobalEvent,
  onImportPreset,
  onShowToast
}) => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('project');
  const [expandedFormulas, setExpandedFormulas] = useState<Record<string, boolean>>({});
  const [exportIncludeProject, setExportIncludeProject] = useState(true);
  const [exportIncludeSim, setExportIncludeSim] = useState(true);
  const [exportIncludeGlobals, setExportIncludeGlobals] = useState(true);

  // Holiday form state
  const [holidayStartDate, setHolidayStartDate] = useState(projectSettings.startDate);
  const [holidayEndDate, setHolidayEndDate] = useState('');
  const [holidayName, setHolidayName] = useState('');

  // Global event quick-add form state
  const [showAddGlobalForm, setShowAddGlobalForm] = useState(false);
  const [newGlobalType, setNewGlobalType] = useState<GlobalEventState>('weather_haul');
  const [newGlobalStartDate, setNewGlobalStartDate] = useState(projectSettings.startDate);
  const [newGlobalEndDate, setNewGlobalEndDate] = useState(addDaysISO(projectSettings.startDate, 2));
  const [newGlobalHaulPct, setNewGlobalHaulPct] = useState<number>(60);
  const [newGlobalBulkInMult, setNewGlobalBulkInMult] = useState<number>(1.15);
  const [newGlobalBulkOutMult, setNewGlobalBulkOutMult] = useState<number>(1.0);
  const [newGlobalMaterials, setNewGlobalMaterials] = useState<string[]>([]);
  const [newGlobalLabel, setNewGlobalLabel] = useState('');
  const [newGlobalNotes, setNewGlobalNotes] = useState('');

  const presetFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setHolidayStartDate(prev =>
      prev < projectSettings.startDate || prev > projectSettings.endDate
        ? projectSettings.startDate
        : prev
    );
    setNewGlobalStartDate(prev =>
      prev < projectSettings.startDate || prev > projectSettings.endDate
        ? projectSettings.startDate
        : prev
    );
    setNewGlobalEndDate(prev =>
      prev < projectSettings.startDate || prev > projectSettings.endDate
        ? addDaysISO(projectSettings.startDate, Math.min(2, Math.max(0, computeInclusiveDays(projectSettings.startDate, projectSettings.endDate) - 1)))
        : prev
    );
  }, [projectSettings.startDate, projectSettings.endDate]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isOpen, onClose]);

  const totalDays = useMemo(
    () => computeInclusiveDays(projectSettings.startDate, projectSettings.endDate),
    [projectSettings.startDate, projectSettings.endDate]
  );

  const dayStats = useMemo(
    () => computeWorkingDayStats(projectSettings),
    [projectSettings]
  );

  const clippedEventsCount = useMemo(
    () => calendarEvents.filter(e => e.endDay > totalDays).length,
    [calendarEvents, totalDays]
  );

  const globalEvents = useMemo(
    () =>
      calendarEvents
        .filter(e => e.targetType === 'global')
        .sort((a, b) => a.startDay - b.startDay),
    [calendarEvents]
  );

  const toggleFormula = (key: string) => {
    setExpandedFormulas(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const handleStartDateChange = (nextStart: string) => {
    if (!nextStart) return;
    let nextEnd = projectSettings.endDate;
    if (nextEnd < nextStart) {
      nextEnd = addDaysISO(nextStart, 29);
    } else if (computeInclusiveDays(nextStart, nextEnd) > MAX_SIM_DAYS) {
      nextEnd = addDaysISO(nextStart, MAX_SIM_DAYS - 1);
    }
    onUpdateProjectSettings({ startDate: nextStart, endDate: nextEnd });
  };

  const handleEndDateChange = (nextEnd: string) => {
    if (!nextEnd) return;
    if (nextEnd < projectSettings.startDate) {
      onUpdateProjectSettings({ endDate: projectSettings.startDate });
      return;
    }
    const clampedEnd =
      computeInclusiveDays(projectSettings.startDate, nextEnd) > MAX_SIM_DAYS
        ? addDaysISO(projectSettings.startDate, MAX_SIM_DAYS - 1)
        : nextEnd;
    onUpdateProjectSettings({ endDate: clampedEnd });
  };

  const handleApplyHorizonDays = (days: number) => {
    const nextEnd = addDaysISO(projectSettings.startDate, days - 1);
    onUpdateProjectSettings({ endDate: nextEnd });
  };

  const handleToggleWeekday = (dayIdx: number) => {
    const next = [...projectSettings.workingDays] as ProjectSettings['workingDays'];
    next[dayIdx] = !next[dayIdx];
    onUpdateProjectSettings({ workingDays: next });
  };

  const handleWorkweekPreset = (preset: '5day' | '6day' | '7day') => {
    if (preset === '5day') {
      onUpdateProjectSettings({ workingDays: [false, true, true, true, true, true, false] });
    } else if (preset === '6day') {
      onUpdateProjectSettings({ workingDays: [false, true, true, true, true, true, true] });
    } else {
      onUpdateProjectSettings({ workingDays: [true, true, true, true, true, true, true] });
    }
  };

  const handleAddHoliday = () => {
    if (!holidayStartDate) return;
    const label = holidayName.trim() || 'Site Holiday';
    const endIso = holidayEndDate && holidayEndDate >= holidayStartDate ? holidayEndDate : holidayStartDate;
    const newHoliday: ProjectHoliday = {
      id: `hol-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      startDate: holidayStartDate,
      endDate: endIso,
      name: label
    };
    const nextHolidays = [...projectSettings.holidays, newHoliday].sort((a, b) =>
      a.startDate.localeCompare(b.startDate)
    );
    onUpdateProjectSettings({ holidays: nextHolidays });
    setHolidayName('');
    setHolidayEndDate('');
  };

  const handleRemoveHoliday = (id: string) => {
    onUpdateProjectSettings({
      holidays: projectSettings.holidays.filter(h => h.id !== id)
    });
  };

  const handleCreateGlobalEvent = () => {
    const startDay = dateISOToDayIndex(projectSettings.startDate, newGlobalStartDate, totalDays);
    const endDay = Math.max(
      startDay,
      dateISOToDayIndex(projectSettings.startDate, newGlobalEndDate, totalDays)
    );

    const isHaul = newGlobalType === 'weather_haul' || newGlobalType === 'combined_weather';
    const isBulk = newGlobalType === 'weather_bulking' || newGlobalType === 'combined_weather';

    onAddGlobalEvent({
      id: `global-evt-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      targetType: 'global',
      targetId: 'site',
      startDay,
      endDay,
      state: newGlobalType,
      ...(isHaul ? { haulRatePct: Math.max(0, Math.min(200, newGlobalHaulPct)) } : {}),
      ...(isBulk
        ? {
            bulkInMultiplier: Math.max(0.5, Math.min(2.5, newGlobalBulkInMult)),
            bulkOutMultiplier: Math.max(0.5, Math.min(2.5, newGlobalBulkOutMult)),
            ...(newGlobalMaterials.length > 0 ? { affectedMaterials: [...newGlobalMaterials] } : {})
          }
        : {}),
      ...(newGlobalLabel.trim() ? { label: newGlobalLabel.trim() } : {}),
      ...(newGlobalNotes.trim() ? { notes: newGlobalNotes.trim() } : {})
    });

    setNewGlobalLabel('');
    setNewGlobalNotes('');
    setShowAddGlobalForm(false);
  };

  const handleExportPresetJSON = () => {
    if (!exportIncludeProject && !exportIncludeSim && !exportIncludeGlobals) {
      onShowToast('Select at least one section to export.', 'error');
      return;
    }
    const payload: SettingsPresetPayload = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      ...(exportIncludeProject ? { projectSettings } : {}),
      ...(exportIncludeSim ? { simSettings } : {}),
      ...(exportIncludeGlobals ? { globalEvents } : {})
    };
    const slug = (projectSettings.projectName || 'e4d_settings')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || 'e4d_settings';
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slug}_settings_preset.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onShowToast('Exported settings preset JSON.', 'success');
  };

  const handleImportPresetFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(String(ev.target?.result || ''));
        if (!parsed || typeof parsed !== 'object') {
          onShowToast('Invalid settings JSON file.', 'error');
          return;
        }
        const hasAnySection =
          Boolean(parsed.projectSettings) ||
          Boolean(parsed.simSettings) ||
          Array.isArray(parsed.globalEvents);
        if (!hasAnySection) {
          onShowToast('JSON file contains no Project Settings, Sim Settings, or Global Events.', 'error');
          return;
        }
        const preset: SettingsPresetPayload = {
          schemaVersion: 1,
          exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : new Date().toISOString(),
          ...(parsed.projectSettings ? { projectSettings: parsed.projectSettings } : {}),
          ...(parsed.simSettings ? { simSettings: parsed.simSettings } : {}),
          ...(Array.isArray(parsed.globalEvents) ? { globalEvents: parsed.globalEvents } : {})
        };
        onImportPreset(preset);
      } catch {
        onShowToast('Failed to parse settings JSON file.', 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const inputStyle: React.CSSProperties = {
    backgroundColor: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '4px',
    color: '#f8fafc',
    padding: '7px 9px',
    fontSize: '12px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box'
  };

  const sectionCardStyle: React.CSSProperties = {
    backgroundColor: '#0f172a',
    border: '1px solid #334155',
    borderRadius: '6px',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px'
  };

  const sectionLabelStyle: React.CSSProperties = {
    fontSize: '11px',
    fontWeight: 700,
    color: '#94a3b8',
    textTransform: 'uppercase',
    letterSpacing: '0.6px'
  };

  const renderFormulaBlock = (key: string, summary: string, formulaLines: string[], example: string) => {
    const isExpanded = Boolean(expandedFormulas[key]);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.45 }}>{summary}</div>
        <button
          type="button"
          onClick={() => toggleFormula(key)}
          style={{
            alignSelf: 'flex-start',
            background: 'none',
            border: 'none',
            padding: 0,
            color: '#38bdf8',
            fontSize: '11px',
            fontWeight: 600,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '5px'
          }}
        >
          <span>{isExpanded ? '▾' : '▸'}</span>
          <span>{isExpanded ? 'Hide Formula & Worked Example' : 'Show Formula & Worked Example'}</span>
        </button>
        {isExpanded && (
          <div
            style={{
              backgroundColor: '#0b1120',
              border: '1px solid #1e293b',
              borderRadius: '4px',
              padding: '9px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              fontSize: '11px',
              lineHeight: 1.45
            }}
          >
            <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: '#e2e8f0', display: 'flex', flexDirection: 'column', gap: '2px' }}>
              {formulaLines.map((line, i) => (
                <div key={i}>{line}</div>
              ))}
            </div>
            <div style={{ borderTop: '1px solid #1e293b', paddingTop: '6px', color: '#94a3b8' }}>
              <strong style={{ color: '#cbd5e1' }}>Worked Example:</strong> {example}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {/* Hidden preset JSON file input */}
      <input
        ref={presetFileInputRef}
        type="file"
        accept=".json"
        style={{ display: 'none' }}
        onChange={handleImportPresetFile}
      />

      {/* Click-outside subtle backdrop */}
      {isOpen && (
        <div
          onClick={onClose}
          style={{
            position: 'fixed',
            top: '52px',
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(15, 23, 42, 0.42)',
            zIndex: 60
          }}
        />
      )}

      {/* Right Slide-Out Drawer */}
      <aside
        aria-label="Project and Simulation Settings"
        style={{
          position: 'fixed',
          top: '52px',
          right: 0,
          bottom: 0,
          width: '440px',
          maxWidth: '94vw',
          backgroundColor: '#1e293b',
          borderLeft: '1px solid #334155',
          boxShadow: '-10px 0 28px rgba(0, 0, 0, 0.45)',
          zIndex: 65,
          display: 'flex',
          flexDirection: 'column',
          transform: isOpen ? 'translateX(0)' : 'translateX(102%)',
          transition: 'transform 180ms cubic-bezier(0.2, 0, 0, 1)',
          pointerEvents: isOpen ? 'auto' : 'none',
          color: '#f8fafc',
          boxSizing: 'border-box'
        }}
      >
        {/* Drawer Header + Two-Tab Bar */}
        <div
          style={{
            padding: '14px 16px 0 16px',
            backgroundColor: '#0f172a',
            borderBottom: '1px solid #334155',
            flexShrink: 0
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 700, letterSpacing: '0.7px', color: '#f8fafc', textTransform: 'uppercase' }}>
                Settings & Simulation Math
              </div>
              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums' }}>
                {formatShortDate(projectSettings.startDate)} – {formatShortDate(projectSettings.endDate)} · {totalDays}d
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: 'none',
                border: '1px solid #334155',
                borderRadius: '4px',
                color: '#94a3b8',
                width: '28px',
                height: '28px',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                fontSize: '14px'
              }}
              title="Close Settings Drawer (Esc)"
            >
              ✕
            </button>
          </div>

          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              type="button"
              onClick={() => setActiveTab('project')}
              style={{
                flex: 1,
                padding: '9px 12px',
                backgroundColor: activeTab === 'project' ? '#1e293b' : 'transparent',
                color: activeTab === 'project' ? '#38bdf8' : '#94a3b8',
                border: 'none',
                borderBottom: activeTab === 'project' ? '2px solid #38bdf8' : '2px solid transparent',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              Project Settings
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('sim')}
              style={{
                flex: 1,
                padding: '9px 12px',
                backgroundColor: activeTab === 'sim' ? '#1e293b' : 'transparent',
                color: activeTab === 'sim' ? '#38bdf8' : '#94a3b8',
                border: 'none',
                borderBottom: activeTab === 'sim' ? '2px solid #38bdf8' : '2px solid transparent',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              Sim Settings & Math
            </button>
          </div>
        </div>

        {/* Playback notice */}
        {isPlayback && (
          <div
            style={{
              padding: '8px 16px',
              backgroundColor: 'rgba(245, 158, 11, 0.12)',
              borderBottom: '1px solid rgba(245, 158, 11, 0.3)',
              fontSize: '11px',
              color: '#fde68a',
              flexShrink: 0
            }}
          >
            Playback mode is active — edits recalculate the simulation immediately.
          </div>
        )}

        {/* Scrollable Drawer Body */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            padding: '14px 16px 20px 16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px'
          }}
        >
          {activeTab === 'project' ? (
            <>
              {/* 1. Project Identity */}
              <div style={sectionCardStyle}>
                <div style={sectionLabelStyle}>Project Identity</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>Project Name</label>
                  <input
                    type="text"
                    value={projectSettings.projectName}
                    onChange={e => onUpdateProjectSettings({ projectName: e.target.value })}
                    placeholder="Earthworks Programme"
                    style={inputStyle}
                  />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>Project Notes</label>
                  <textarea
                    rows={2}
                    value={projectSettings.projectNotes || ''}
                    onChange={e => onUpdateProjectSettings({ projectNotes: e.target.value })}
                    placeholder="Programme assumptions, haul permit basis, weather allowance..."
                    style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.4 }}
                  />
                </div>
              </div>

              {/* 2. Simulation Date Range */}
              <div style={sectionCardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={sectionLabelStyle}>Simulation Horizon</span>
                  <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    Max {MAX_SIM_DAYS} days
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>Start Date (Day 1)</label>
                    <input
                      type="date"
                      value={projectSettings.startDate}
                      onChange={e => handleStartDateChange(e.target.value)}
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', colorScheme: 'dark' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>End Date (Day {totalDays})</label>
                    <input
                      type="date"
                      value={projectSettings.endDate}
                      min={projectSettings.startDate}
                      max={addDaysISO(projectSettings.startDate, MAX_SIM_DAYS - 1)}
                      onChange={e => handleEndDateChange(e.target.value)}
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', colorScheme: 'dark' }}
                    />
                  </div>
                </div>

                {/* Quick Horizon Buttons */}
                <div style={{ display: 'flex', gap: '6px' }}>
                  {HORIZON_PRESETS.map(p => {
                    const isActive = totalDays === p.days;
                    return (
                      <button
                        key={p.label}
                        type="button"
                        onClick={() => handleApplyHorizonDays(p.days)}
                        style={{
                          flex: 1,
                          padding: '5px 0',
                          borderRadius: '4px',
                          border: `1px solid ${isActive ? '#38bdf8' : '#334155'}`,
                          backgroundColor: isActive ? 'rgba(56, 189, 248, 0.16)' : '#1e293b',
                          color: isActive ? '#38bdf8' : '#cbd5e1',
                          fontSize: '11px',
                          fontWeight: 600,
                          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                          cursor: 'pointer'
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>

                {/* Unboxed Working-Day Stats Strip */}
                <div
                  style={{
                    fontSize: '11px',
                    color: '#cbd5e1',
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontVariantNumeric: 'tabular-nums',
                    borderTop: '1px solid #1e293b',
                    paddingTop: '8px'
                  }}
                >
                  <strong style={{ color: '#f8fafc' }}>{dayStats.totalDays}</strong> calendar days
                  {' · '}
                  <strong style={{ color: '#22c55e' }}>{dayStats.workingDaysCount}</strong> working
                  {' · '}
                  <strong style={{ color: '#f59e0b' }}>{dayStats.nonWorkingDaysCount}</strong> non-working
                  {dayStats.holidayDaysCount > 0 ? ` (${dayStats.holidayDaysCount} hol)` : ''}
                </div>

                {clippedEventsCount > 0 && (
                  <div
                    style={{
                      fontSize: '11px',
                      color: '#fde68a',
                      backgroundColor: 'rgba(245, 158, 11, 0.12)',
                      border: '1px solid rgba(245, 158, 11, 0.35)',
                      borderRadius: '4px',
                      padding: '7px 9px',
                      lineHeight: 1.4
                    }}
                  >
                    {clippedEventsCount} scheduled event{clippedEventsCount > 1 ? 's extend' : ' extends'} past Day {totalDays}. Days beyond {formatShortDate(projectSettings.endDate)} are not simulated unless you extend the end date.
                  </div>
                )}
              </div>

              {/* 3. Workweek Schedule */}
              <div style={sectionCardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={sectionLabelStyle}>Workweek Schedule</span>
                  <div style={{ display: 'flex', gap: '4px' }}>
                    {(
                      [
                        { id: '5day', label: '5-Day' },
                        { id: '6day', label: '6-Day' },
                        { id: '7day', label: '7-Day' }
                      ] as const
                    ).map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => handleWorkweekPreset(p.id)}
                        style={{
                          padding: '2px 7px',
                          borderRadius: '4px',
                          border: '1px solid #334155',
                          backgroundColor: '#1e293b',
                          color: '#cbd5e1',
                          fontSize: '10px',
                          fontWeight: 600,
                          cursor: 'pointer'
                        }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '5px' }}>
                  {WEEKDAY_LABELS.map(wd => {
                    const active = projectSettings.workingDays[wd.index];
                    return (
                      <button
                        key={wd.label}
                        type="button"
                        onClick={() => handleToggleWeekday(wd.index)}
                        style={{
                          padding: '7px 0',
                          borderRadius: '4px',
                          border: `1px solid ${active ? '#22c55e' : '#334155'}`,
                          backgroundColor: active ? 'rgba(34, 197, 94, 0.16)' : '#1e293b',
                          color: active ? '#bbf7d0' : '#64748b',
                          fontSize: '11px',
                          fontWeight: 700,
                          cursor: 'pointer'
                        }}
                      >
                        {wd.label}
                      </button>
                    );
                  })}
                </div>
                <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
                  Unchecked weekdays halt all material transfers automatically unless Non-Working Day Overtime is enabled in Sim Settings.
                </div>
              </div>

              {/* 4. Custom Holidays & Shutdown Dates */}
              <div style={sectionCardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={sectionLabelStyle}>Holidays & Planned Shutdowns</span>
                  <span style={{ fontSize: '10px', color: '#64748b', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                    {projectSettings.holidays.length} configured
                  </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <label style={{ fontSize: '10px', color: '#94a3b8' }}>Date (Start)</label>
                    <input
                      type="date"
                      value={holidayStartDate}
                      onChange={e => setHolidayStartDate(e.target.value)}
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', colorScheme: 'dark' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                    <label style={{ fontSize: '10px', color: '#94a3b8' }}>End Date (Optional)</label>
                    <input
                      type="date"
                      value={holidayEndDate}
                      min={holidayStartDate}
                      onChange={e => setHolidayEndDate(e.target.value)}
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', colorScheme: 'dark' }}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={holidayName}
                    onChange={e => setHolidayName(e.target.value)}
                    placeholder="e.g. Easter Bank Holiday, Christmas Shutdown"
                    style={{ ...inputStyle, flex: 1 }}
                    onKeyDown={e => {
                      if (e.key === 'Enter') handleAddHoliday();
                    }}
                  />
                  <button
                    type="button"
                    onClick={handleAddHoliday}
                    style={{
                      padding: '0 12px',
                      backgroundColor: '#334155',
                      border: '1px solid #475569',
                      borderRadius: '4px',
                      color: '#38bdf8',
                      fontSize: '11px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    + Add
                  </button>
                </div>

                {projectSettings.holidays.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px', marginTop: '2px' }}>
                    {projectSettings.holidays.map(hol => (
                      <div
                        key={hol.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '8px',
                          padding: '6px 8px',
                          backgroundColor: '#1e293b',
                          border: '1px solid #334155',
                          borderRadius: '4px',
                          fontSize: '11px'
                        }}
                      >
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: '#f8fafc', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {hol.name}
                          </div>
                          <div style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
                            {formatShortDate(hol.startDate)}
                            {hol.endDate && hol.endDate !== hol.startDate ? ` – ${formatShortDate(hol.endDate)}` : ''}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRemoveHoliday(hol.id)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#94a3b8',
                            cursor: 'pointer',
                            fontSize: '12px',
                            padding: '2px 5px'
                          }}
                          title="Remove holiday"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 5. Global Site & Weather Events */}
              <div style={sectionCardStyle}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={sectionLabelStyle}>Global Site & Weather Events</span>
                  <button
                    type="button"
                    onClick={() => setShowAddGlobalForm(v => !v)}
                    style={{
                      padding: '4px 9px',
                      backgroundColor: showAddGlobalForm ? '#334155' : 'rgba(56, 189, 248, 0.14)',
                      border: '1px solid #38bdf8',
                      borderRadius: '4px',
                      color: '#38bdf8',
                      fontSize: '11px',
                      fontWeight: 700,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {showAddGlobalForm ? 'Cancel' : '+ Add Global Event'}
                  </button>
                </div>

                <div style={{ fontSize: '11px', color: '#94a3b8', lineHeight: 1.4 }}>
                  Site-wide shutdowns, wet-weather haul rate reductions, or bulking factor modifiers. Also editable directly on the top Calendar Gantt row.
                </div>

                {showAddGlobalForm && (
                  <div
                    style={{
                      backgroundColor: '#1e293b',
                      border: '1px solid #475569',
                      borderRadius: '5px',
                      padding: '10px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '9px'
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>Event Type</label>
                      <select
                        value={newGlobalType}
                        onChange={e => setNewGlobalType(e.target.value as GlobalEventState)}
                        style={inputStyle}
                      >
                        <option value="site_shutdown">Site Shutdown (0% Movement)</option>
                        <option value="weather_haul">Weather — Haul Movement Impact (%)</option>
                        <option value="weather_bulking">Weather — Bulking Modifier (IN / OUT)</option>
                        <option value="combined_weather">Combined Weather (Haul % + Bulking)</option>
                      </select>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <label style={{ fontSize: '10px', color: '#94a3b8' }}>Start Date</label>
                        <input
                          type="date"
                          value={newGlobalStartDate}
                          min={projectSettings.startDate}
                          max={projectSettings.endDate}
                          onChange={e => {
                            setNewGlobalStartDate(e.target.value);
                            if (newGlobalEndDate < e.target.value) setNewGlobalEndDate(e.target.value);
                          }}
                          style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', colorScheme: 'dark' }}
                        />
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                        <label style={{ fontSize: '10px', color: '#94a3b8' }}>End Date</label>
                        <input
                          type="date"
                          value={newGlobalEndDate}
                          min={newGlobalStartDate}
                          max={projectSettings.endDate}
                          onChange={e => setNewGlobalEndDate(e.target.value)}
                          style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', colorScheme: 'dark' }}
                        />
                      </div>
                    </div>

                    {(newGlobalType === 'weather_haul' || newGlobalType === 'combined_weather') && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>
                          Haul Movement Rate (% of stated rate)
                        </label>
                        <input
                          type="number"
                          min={0}
                          max={200}
                          step={5}
                          value={newGlobalHaulPct}
                          onChange={e => setNewGlobalHaulPct(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
                          style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                        />
                      </div>
                    )}

                    {(newGlobalType === 'weather_bulking' || newGlobalType === 'combined_weather') && (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            <label style={{ fontSize: '10px', color: '#cbd5e1' }}>Bulk IN Multiplier (×)</label>
                            <input
                              type="number"
                              min={0.5}
                              max={2.5}
                              step={0.05}
                              value={newGlobalBulkInMult}
                              onChange={e => setNewGlobalBulkInMult(Number(e.target.value) || 1)}
                              style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                            />
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                            <label style={{ fontSize: '10px', color: '#cbd5e1' }}>Bulk OUT Multiplier (×)</label>
                            <input
                              type="number"
                              min={0.5}
                              max={2.5}
                              step={0.05}
                              value={newGlobalBulkOutMult}
                              onChange={e => setNewGlobalBulkOutMult(Number(e.target.value) || 1)}
                              style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                            />
                          </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <label style={{ fontSize: '10px', color: '#94a3b8' }}>
                            Affected Materials (leave unchecked for all materials)
                          </label>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {materials.map(mat => {
                              const checked = newGlobalMaterials.includes(mat.code);
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
                                    onChange={() =>
                                      setNewGlobalMaterials(prev =>
                                        prev.includes(mat.code)
                                          ? prev.filter(c => c !== mat.code)
                                          : [...prev, mat.code]
                                      )
                                    }
                                    style={{ accentColor: '#818cf8' }}
                                  />
                                  <span>{mat.code}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      </>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>Label</label>
                      <input
                        type="text"
                        value={newGlobalLabel}
                        onChange={e => setNewGlobalLabel(e.target.value)}
                        placeholder="e.g. Heavy Rain Storm, Wet Clay Swell, Safety Stand-Down"
                        style={inputStyle}
                      />
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                      <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>Description</label>
                      <textarea
                        rows={2}
                        value={newGlobalNotes}
                        onChange={e => setNewGlobalNotes(e.target.value)}
                        placeholder="Engineering notes or site weather record..."
                        style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleCreateGlobalEvent}
                      style={{
                        padding: '8px 12px',
                        backgroundColor: '#0284c7',
                        border: 'none',
                        borderRadius: '4px',
                        color: '#ffffff',
                        fontSize: '12px',
                        fontWeight: 700,
                        cursor: 'pointer'
                      }}
                    >
                      Save Global Event
                    </button>
                  </div>
                )}

                {globalEvents.length === 0 ? (
                  <div style={{ fontSize: '11px', color: '#64748b', fontStyle: 'italic' }}>
                    No global site or weather events scheduled.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {globalEvents.map(evt => {
                      const st = (evt.state as GlobalEventState) || 'site_shutdown';
                      const meta = GLOBAL_EVENT_META[st] || GLOBAL_EVENT_META.site_shutdown;
                      const startIso = dayIndexToDateISO(projectSettings.startDate, evt.startDay);
                      const endIso = dayIndexToDateISO(projectSettings.startDate, evt.endDay);
                      const impactParts: string[] = [];
                      if (st === 'site_shutdown') impactParts.push('0% haul');
                      if (st === 'weather_haul' || st === 'combined_weather') {
                        impactParts.push(`${evt.haulRatePct ?? 50}% haul`);
                      }
                      if (st === 'weather_bulking' || st === 'combined_weather') {
                        impactParts.push(`IN×${(evt.bulkInMultiplier ?? 1).toFixed(2)} OUT×${(evt.bulkOutMultiplier ?? 1).toFixed(2)}`);
                        if (evt.affectedMaterials && evt.affectedMaterials.length > 0) {
                          impactParts.push(evt.affectedMaterials.join(','));
                        }
                      }
                      return (
                        <div
                          key={evt.id}
                          onClick={() => onSelectGlobalEvent(evt.id)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '8px',
                            padding: '7px 9px',
                            backgroundColor: '#1e293b',
                            border: '1px solid #334155',
                            borderRadius: '4px',
                            cursor: 'pointer'
                          }}
                          title="Click to edit in Property Inspector"
                        >
                          <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ width: '7px', height: '7px', borderRadius: '2px', backgroundColor: meta.accent, flexShrink: 0 }} />
                              <span style={{ fontSize: '11px', fontWeight: 700, color: '#f8fafc', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {evt.label || meta.label}
                              </span>
                            </div>
                            <div style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums' }}>
                              D{evt.startDay}–D{evt.endDay} ({formatShortDate(startIso)}–{formatShortDate(endIso)}) · {impactParts.join(' · ')}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={e => {
                              e.stopPropagation();
                              onDeleteGlobalEvent(evt.id);
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#94a3b8',
                              cursor: 'pointer',
                              fontSize: '12px',
                              padding: '2px 5px',
                              flexShrink: 0
                            }}
                            title="Delete global event"
                          >
                            ✕
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {/* SIM SETTINGS TAB */}

              {/* 1. Throttleback & Contention Allocation */}
              <div style={sectionCardStyle}>
                <div style={sectionLabelStyle}>1. Throttleback & Contention Allocation</div>
                <select
                  value={simSettings.allocationPolicy}
                  onChange={e => onUpdateSimSettings({ allocationPolicy: e.target.value as AllocationPolicy })}
                  style={inputStyle}
                >
                  <option value="priority_prorata">Priority Tiers + Pro-Rata Split (Default)</option>
                  <option value="priority_equal">Priority Tiers + Equal-Share Split</option>
                  <option value="strict_order">Strict Priority Order (No Splitting)</option>
                </select>
                {renderFormulaBlock(
                  'allocation',
                  'Governs how limited source inventory, target container headroom, container throughput caps, and shared route caps are distributed when competing transfers exceed available capacity.',
                  [
                    'Priority tiers execute sequentially: P1 → P2 → P3 → …',
                    'Pro-Rata:  alloc_i = Budget × (demand_i / Σ demand_tier)',
                    'Equal:     water-filling equal share capped at demand_i',
                    'Strict:    alloc_i = min(demand_i, remaining_budget) in link order'
                  ],
                  'Target headroom = 1,000 m³; two P1 links request 1,500 m³ and 500 m³. Pro-Rata grants 750 + 250 m³; Equal-Share grants 500 + 500 m³; Strict Order grants 1,000 + 0 m³.'
                )}
              </div>

              {/* 2. Partial Delivery & Dispatch Handling */}
              <div style={sectionCardStyle}>
                <div style={sectionLabelStyle}>2. Partial Delivery & Dispatch Handling</div>
                <select
                  value={simSettings.partialDeliveryPolicy}
                  onChange={e => onUpdateSimSettings({ partialDeliveryPolicy: e.target.value as PartialDeliveryPolicy })}
                  style={inputStyle}
                >
                  <option value="allow_partial">Allow Continuous Partial Delivery (Default)</option>
                  <option value="discrete_loads">Snap Partial Deliveries to Discrete Truckloads</option>
                  <option value="min_batch">Minimum Batch Threshold (Halt Below %)</option>
                </select>

                {simSettings.partialDeliveryPolicy === 'discrete_loads' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>
                      Truck Payload Increment (m³ per load)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      step={1}
                      value={simSettings.truckPayloadM3}
                      onChange={e => onUpdateSimSettings({ truckPayloadM3: Math.max(1, Number(e.target.value) || 18) })}
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                    />
                  </div>
                )}

                {simSettings.partialDeliveryPolicy === 'min_batch' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>
                      Minimum Viable Dispatch (% of expected daily rate)
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={5}
                      value={simSettings.minBatchPct}
                      onChange={e => onUpdateSimSettings({ minBatchPct: Math.max(1, Math.min(100, Number(e.target.value) || 20)) })}
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                    />
                  </div>
                )}

                {renderFormulaBlock(
                  'partial',
                  'Determines what happens when a link is constrained below its expected daily rate (due to low source volume, tight target headroom, or route/container throttling).',
                  [
                    'Continuous:     actual = constrained_flow',
                    'Discrete Loads: actual = floor(flow / payload) × payload',
                    'Min Batch:      actual = (flow / expected < minPct) ? 0 : flow'
                  ],
                  'With payload = 18 m³, a throttled flow of 130 m³ snaps to floor(130/18)×18 = 126 m³ (7 full loads). With Min Batch = 20% on a 1,000 m³/d link, 150 m³ halts to 0 m³.'
                )}
              </div>

              {/* 3. Target Headroom & Same-Day Drainage */}
              <div style={sectionCardStyle}>
                <div style={sectionLabelStyle}>3. Target Headroom & Same-Day Drainage</div>
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '8px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    color: '#f8fafc'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={simSettings.sameDayDrainageCredit}
                    onChange={e => onUpdateSimSettings({ sameDayDrainageCredit: e.target.checked })}
                    style={{ marginTop: '2px', accentColor: '#22c55e' }}
                  />
                  <span>
                    <strong>Credit Same-Day Outbound Drainage</strong>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                      Allow receiving containers to count today's outbound haulage as freed headroom before capping inbound deliveries.
                    </div>
                  </span>
                </label>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '10px', color: '#cbd5e1', fontWeight: 600 }}>Default Headroom Hold (m³)</label>
                    <input
                      type="number"
                      min={0}
                      step={100}
                      value={simSettings.defaultHeadroomThresholdM3}
                      onChange={e => onUpdateSimSettings({ defaultHeadroomThresholdM3: Math.max(0, Number(e.target.value) || 0) })}
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                    />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '10px', color: '#cbd5e1', fontWeight: 600 }}>Default Overflow Trigger (%)</label>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      step={1}
                      value={simSettings.defaultOverflowTriggerPct}
                      onChange={e => onUpdateSimSettings({ defaultOverflowTriggerPct: Math.max(1, Math.min(100, Number(e.target.value) || 100)) })}
                      style={{ ...inputStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
                    />
                  </div>
                </div>

                {renderFormulaBlock(
                  'headroom',
                  'Controls whether a stockpile can receive simultaneous inflow equal to its outbound drainage on the same day, or must strictly respect start-of-day empty space.',
                  [
                    'Credit ON:  headroom = max(0, cap − startVol + outbound_m3)',
                    'Credit OFF: headroom = max(0, cap − startVol)',
                    'End Vol = max(0, startVol − Σ outbound + Σ inbound)'
                  ],
                  'Buffer B holds 29,000 / 30,000 m³ and ships 1,200 m³ out today. Credit ON permits 2,200 m³ inbound (net 30,000 m³); Credit OFF caps inbound at 1,000 m³ (net 28,800 m³).'
                )}
              </div>

              {/* 4. Bulking & Volume Accounting */}
              <div style={sectionCardStyle}>
                <div style={sectionLabelStyle}>4. Bulking & Volume Accounting</div>
                <select
                  value={simSettings.bulkingMode}
                  onChange={e => onUpdateSimSettings({ bulkingMode: e.target.value as BulkingMode })}
                  style={inputStyle}
                >
                  <option value="strict_bulking">Strict Material Bulking (BulkIN / BulkOUT)</option>
                  <option value="bank_volume_only">Bank Volume Only (1.0 / 1.0 Neutral)</option>
                </select>
                {renderFormulaBlock(
                  'bulking',
                  'Applies loose-to-bank expansion and compaction factors when moving material between containers, combined with any active global weather bulking multipliers.',
                  [
                    'effBulkIN  = mat.bulkIN × globalWeatherBulkInMult',
                    'effBulkOUT = mat.bulkOUT × globalWeatherBulkOutMult',
                    'Source deduction = flow_m3 × effBulkOUT',
                    'Target addition  = flow_m3 × effBulkIN'
                  ],
                  'Hauling 1,000 m³ of Stiff Clay (BulkIN 1.25, BulkOUT 0.90) removes 900 m³ from source and deposits 1,250 m³ into target. With a 1.15× wet-clay weather event, BulkIN becomes 1.4375.'
                )}
              </div>

              {/* 5. Diversions & Overtime */}
              <div style={sectionCardStyle}>
                <div style={sectionLabelStyle}>5. Diversions & Non-Working Day Overtime</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <label style={{ fontSize: '11px', color: '#cbd5e1', fontWeight: 600 }}>Diversion Priority Order</label>
                  <select
                    value={simSettings.diversionOrder}
                    onChange={e => onUpdateSimSettings({ diversionOrder: e.target.value as DiversionOrder })}
                    style={inputStyle}
                  >
                    <option value="backup_corridor_first">Backup Corridor Detour First, Then Standby Link (Default)</option>
                    <option value="standby_link_first">Standby Link Diversion First, Then Backup Corridor Detour</option>
                  </select>
                </div>

                <label
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '8px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    color: '#f8fafc',
                    marginTop: '2px'
                  }}
                >
                  <input
                    type="checkbox"
                    checked={simSettings.allowOvertimeOnNonWorkingDays}
                    onChange={e => onUpdateSimSettings({ allowOvertimeOnNonWorkingDays: e.target.checked })}
                    style={{ marginTop: '2px', accentColor: '#38bdf8' }}
                  />
                  <span>
                    <strong>Allow Transfer Calendar Overrides on Non-Working Days</strong>
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>
                      Explicit Transfer calendar events (Max / Variable Rate) run as weekend/holiday overtime unless a Global Site Shutdown is active.
                    </div>
                  </span>
                </label>

                {renderFormulaBlock(
                  'diversions',
                  'Controls whether a route-constrained transfer tries its backup corridor detour before spilling over onto a standby transfer link, and how non-working days interact with explicit schedule overrides.',
                  [
                    'Order A: Primary → Backup Corridor Detour → Standby Link',
                    'Order B: Primary → Standby Link → Backup Corridor Detour',
                    'Non-Working Day: site haul = 0 (unless Overtime ON & link has explicit event)'
                  ],
                  'If North Haul Road is blocked on Day 5 and Link A has both a South Detour corridor and a Standby link to Stockpile C, Diversion Order determines which relief path absorbs the shortfall first.'
                )}
              </div>
            </>
          )}
        </div>

        {/* Sticky Footer: Preset Import/Export & Reset */}
        <div
          style={{
            padding: '12px 16px',
            backgroundColor: '#0f172a',
            borderTop: '1px solid #334155',
            display: 'flex',
            flexDirection: 'column',
            gap: '9px',
            flexShrink: 0
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', fontSize: '11px', color: '#94a3b8' }}>
            <span style={{ fontWeight: 600 }}>Preset JSON Scope:</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: '#cbd5e1' }}>
                <input
                  type="checkbox"
                  checked={exportIncludeProject}
                  onChange={e => setExportIncludeProject(e.target.checked)}
                  style={{ accentColor: '#38bdf8' }}
                />
                <span>Project</span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: '#cbd5e1' }}>
                <input
                  type="checkbox"
                  checked={exportIncludeSim}
                  onChange={e => setExportIncludeSim(e.target.checked)}
                  style={{ accentColor: '#38bdf8' }}
                />
                <span>Sim</span>
              </label>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', cursor: 'pointer', color: '#cbd5e1' }}>
                <input
                  type="checkbox"
                  checked={exportIncludeGlobals}
                  onChange={e => setExportIncludeGlobals(e.target.checked)}
                  style={{ accentColor: '#38bdf8' }}
                />
                <span>Global</span>
              </label>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              onClick={handleExportPresetJSON}
              style={{
                flex: 1,
                height: '32px',
                backgroundColor: '#334155',
                border: '1px solid #475569',
                borderRadius: '5px',
                color: '#38bdf8',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              Export Preset JSON
            </button>
            <button
              type="button"
              onClick={() => presetFileInputRef.current?.click()}
              style={{
                flex: 1,
                height: '32px',
                backgroundColor: '#334155',
                border: '1px solid #475569',
                borderRadius: '5px',
                color: '#f8fafc',
                fontSize: '11px',
                fontWeight: 700,
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              Import Preset JSON
            </button>
            <button
              type="button"
              onClick={() => {
                if (activeTab === 'project') {
                  onResetProjectSettings();
                  onShowToast('Project Settings reset to defaults.', 'success');
                } else {
                  onResetSimSettings();
                  onShowToast('Sim Settings reset to defaults.', 'success');
                }
              }}
              style={{
                height: '32px',
                padding: '0 10px',
                backgroundColor: 'transparent',
                border: '1px solid #475569',
                borderRadius: '5px',
                color: '#94a3b8',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
              title={`Reset ${activeTab === 'project' ? 'Project' : 'Sim'} Settings to defaults`}
            >
              Reset
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};
