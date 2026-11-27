import React, { RefObject } from 'react';

interface TopHeaderProps {
  isPlayback: boolean;
  onTogglePlayback: () => void;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onOpenExportModal?: () => void;
  onOpenManualModal?: () => void;
  isSettingsOpen?: boolean;
  onToggleSettings?: () => void;
  projectHorizonLabel?: string;
}

export const TopHeader: React.FC<TopHeaderProps> = ({ 
  isPlayback, 
  onTogglePlayback, 
  fileInputRef, 
  onOpenExportModal,
  isSettingsOpen = false,
  onToggleSettings,
  projectHorizonLabel
}) => {
  return (
    <header style={{ height: '52px', minHeight: '52px', backgroundColor: '#1e293b', borderBottom: '1px solid #334155', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 20px', boxSizing: 'border-box', zIndex: 50, gap: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0 }}>
        <span style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '2px', color: '#22c55e', whiteSpace: 'nowrap' }}>E4D PLANNER</span>
        <span style={{ height: '14px', width: '1px', backgroundColor: 'rgba(255, 255, 255, 0.2)', flexShrink: 0 }} />
        <span style={{ fontSize: '12px', fontWeight: 500, letterSpacing: '1px', color: '#94a3b8', textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          MATERIAL TRANSFER SIMULATOR
        </span>
        {projectHorizonLabel && (
          <>
            <span style={{ height: '14px', width: '1px', backgroundColor: 'rgba(255, 255, 255, 0.14)', flexShrink: 0 }} />
            <span style={{ fontSize: '11px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums', color: '#cbd5e1', whiteSpace: 'nowrap' }}>
              {projectHorizonLabel}
            </span>
          </>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{
            padding: '0 14px',
            height: '36px',
            backgroundColor: '#334155',
            color: '#38bdf8',
            border: '1px solid #475569',
            borderRadius: '6px',
            fontWeight: 'bold',
            cursor: 'pointer',
            fontSize: '12px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
            whiteSpace: 'nowrap',
            flexShrink: 0
          }}
          title="Import Model CSV to repopulate the canvas and links"
        >
          Import Model
        </button>

        {onOpenExportModal && (
          <button
            onClick={onOpenExportModal}
            style={{
              padding: '0 14px',
              height: '36px',
              backgroundColor: '#334155',
              color: '#38bdf8',
              border: '1px solid #475569',
              borderRadius: '6px',
              fontWeight: 'bold',
              cursor: 'pointer',
              fontSize: '12px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxSizing: 'border-box',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
            title="Export Model and Simulation CSV"
          >
            Export Model
          </button>
        )}

        <button
          onClick={onTogglePlayback}
          style={{
            padding: '0 16px',
            minWidth: '156px',
            height: '36px',
            backgroundColor: isPlayback ? '#ef4444' : '#22c55e',
            color: isPlayback ? '#ffffff' : '#0f172a',
            border: 'none',
            borderRadius: '6px',
            fontWeight: 'bold',
            cursor: 'pointer',
            fontSize: '12px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
            whiteSpace: 'nowrap',
            flexShrink: 0
          }}
        >
          {isPlayback ? 'Exit Playback' : 'Run Simulation & Play'}
        </button>

        {onToggleSettings && (
          <button
            type="button"
            onClick={onToggleSettings}
            style={{
              padding: '0 12px',
              height: '36px',
              backgroundColor: isSettingsOpen ? 'rgba(56, 189, 248, 0.18)' : '#334155',
              color: isSettingsOpen ? '#38bdf8' : '#e2e8f0',
              border: `1px solid ${isSettingsOpen ? '#38bdf8' : '#475569'}`,
              borderRadius: '6px',
              fontWeight: 700,
              cursor: 'pointer',
              fontSize: '12px',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              boxSizing: 'border-box',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
            title="Open Project & Simulation Settings Drawer"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Settings</span>
          </button>
        )}
      </div>
    </header>
  );
};