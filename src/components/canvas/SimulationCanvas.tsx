import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ContainerNode, TransferLink, RouteCorridor, SimFrame, FlowStatus, GRAPH_LINE_COLORS, getLinkCorridorIds } from '../../models/types';
import { CanvasViewModel } from '../../viewmodel/CanvasViewModel';
import { initPipeRouter, isPipeRouterReady, computeAllLinkRoutes, getEffectiveContainerOutputEdge, getEffectiveContainerInputEdge } from './pipeRouter';

interface Point { x: number; y: number; }

export const getFlowColor = (status: FlowStatus = 'frozen'): string => {
  switch (status) {
    case 'full':
      return '#22c55e'; // Green: flowing at full rate
    case 'restricted':
      return '#f59e0b'; // Amber: flowing at restricted rate
    case 'blocked':
      return '#ef4444'; // Red: blocked from sending/receiving due to capacity issues
    case 'starved':
    case 'frozen':
    default:
      return '#38bdf8'; // Blue: day 0 (frozen) + any time a container cannot deliver due to lack of material
  }
};

interface SimulationCanvasProps {
  vm: CanvasViewModel;
  nodes: ContainerNode[];
  links: TransferLink[];
  corridors: RouteCorridor[];
  selectedNodeIds: string[];
  selectedLinkIds: string[];
  selectedCorridorIds: string[];
  setSelectedNodeIds: (ids: string[]) => void;
  setSelectedLinkIds: (ids: string[]) => void;
  setSelectedCorridorIds: (ids: string[]) => void;
  isPlayback: boolean;
  highlightedNodeIds?: string[];
  setHighlightedNodeIds?: (ids: string[]) => void;
  currentFrame: SimFrame;
  onNodesUpdated: () => void;
  onCorridorsUpdated: () => void;
  onAddNode: () => void;
  onAddLink: () => void;
  onAddCorridor: (suggestedWaypoints?: Point[]) => void;
  onSetRouteLanes: () => void;
  onUnlinkLanes: () => void;
  onDeleteSelected: () => void;
  canLink: boolean;
  canSetLanes: boolean;
  canUnlinkLanes: boolean;
  hasSelection: boolean;
  isGraphExpanded?: boolean;
}

// Multi-tier dynamic grid configuration: 1 major gridline for every 4 minor gridlines
const getAdaptiveGrid = (z: number) => {
  if (z >= 1.8) {
    return { minorStep: 10, majorStep: 40, snap: 5 }; // 40 = 4 * 10
  } else if (z >= 0.75) {
    return { minorStep: 20, majorStep: 80, snap: 20 }; // 80 = 4 * 20
  } else if (z >= 0.4) {
    return { minorStep: 40, majorStep: 160, snap: 40 }; // 160 = 4 * 40
  } else {
    return { minorStep: 80, majorStep: 320, snap: 80 }; // 320 = 4 * 80
  }
};

export const SimulationCanvas: React.FC<SimulationCanvasProps> = ({
  vm,
  nodes,
  links,
  corridors,
  selectedNodeIds,
  selectedLinkIds,
  selectedCorridorIds,
  setSelectedNodeIds,
  setSelectedLinkIds,
  setSelectedCorridorIds,
  isPlayback,
  highlightedNodeIds = [],
  setHighlightedNodeIds,
  currentFrame,
  onNodesUpdated,
  onCorridorsUpdated,
  onAddNode,
  onAddLink,
  onAddCorridor,
  onSetRouteLanes,
  onUnlinkLanes,
  onDeleteSelected,
  canLink,
  canSetLanes,
  canUnlinkLanes,
  hasSelection
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Camera Viewport State: Pan (offset in screen pixels) and Zoom (scale factor)
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState<number>(1.0);
  const [isPanning, setIsPanning] = useState<boolean>(false);
  const [isSpacePressed, setIsSpacePressed] = useState<boolean>(false);

  // Refs for current transformation during continuous mouse/wheel events
  const panRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const zoomRef = useRef<number>(1.0);
  panRef.current = pan;
  zoomRef.current = zoom;

  const panStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const panOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  // Node Dragging State
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 }); // In world coordinates
  const nodeInitialPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());

  // Route Corridor Dragging (whole route) & Vertex/Bend Handle Dragging State
  const [isDraggingCorridor, setIsDraggingCorridor] = useState<boolean>(false);
  const corridorInitialWaypointsRef = useRef<Map<string, Point[]>>(new Map());
  const corridorLastDeltaRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDraggingCorridorHandle, setIsDraggingCorridorHandle] = useState<boolean>(false);
  const draggedCorridorHandleRef = useRef<{ corridorId: string; waypointIndex: number } | null>(null);

  // libavoid-js WASM Router Readiness
  const [routerReady, setRouterReady] = useState<boolean>(() => isPipeRouterReady());
  useEffect(() => {
    let mounted = true;
    initPipeRouter().then((ready) => {
      if (mounted && ready) setRouterReady(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Coordinate Conversion Helpers
  const screenToWorld = useCallback((screenX: number, screenY: number, p = panRef.current, z = zoomRef.current): Point => {
    return {
      x: (screenX - p.x) / z,
      y: (screenY - p.y) / z
    };
  }, []);

  const drawArrowHead = (ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, color: string) => {
    const headLength = 21;
    const headWidth = 15;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.translate(-headLength / 2, 0);

    ctx.fillStyle = color;
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.75;

    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-headLength, -headWidth / 2);
    ctx.lineTo(-headLength + 5, 0);
    ctx.lineTo(-headLength, headWidth / 2);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  };

  const distToSegment = (p: Point, v: Point, w: Point): number => {
    const l2 = (w.x - v.x) ** 2 + (w.y - v.y) ** 2;
    if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
    let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
  };

  const getCorridorBandWidth = (corridor: RouteCorridor, assignedCount: number): number => {
    const spacing = Math.max(2, corridor.laneSpacing || 5);
    return Math.max(28, Math.max(0, assignedCount - 1) * spacing + 24);
  };

  const getCorridorLabelBox = (
    corridor: RouteCorridor,
    bandWidth: number,
    ctx?: CanvasRenderingContext2D | null
  ): { midX: number; midY: number; width: number; height: number; angle: number } | null => {
    const wps = corridor.waypoints;
    if (!wps || wps.length < 2 || !corridor.name) return null;

    let longestIdx = 0;
    let longestLen = -1;
    for (let i = 0; i < wps.length - 1; i++) {
      const segLen = Math.hypot(wps[i + 1].x - wps[i].x, wps[i + 1].y - wps[i].y);
      if (segLen > longestLen) {
        longestLen = segLen;
        longestIdx = i;
      }
    }
    if (longestLen <= 1) return null;

    const segA = wps[longestIdx];
    const segB = wps[longestIdx + 1];
    let angle = Math.atan2(segB.y - segA.y, segB.x - segA.x);
    if (angle >= Math.PI / 2) angle -= Math.PI;
    else if (angle < -Math.PI / 2) angle += Math.PI;

    const offsetDist = bandWidth / 2 + 11;
    const midX = (segA.x + segB.x) / 2 + Math.sin(angle) * offsetDist;
    const midY = (segA.y + segB.y) / 2 - Math.cos(angle) * offsetDist;

    let textWidth = corridor.name.length * 6.5;
    if (ctx) {
      ctx.save();
      ctx.font = '600 10px system-ui, sans-serif';
      textWidth = ctx.measureText(corridor.name).width;
      ctx.restore();
    }

    return {
      midX,
      midY,
      width: Math.max(36, textWidth + 16),
      height: 20,
      angle
    };
  };

  const getCorridorRateMeta = (corridorId: string): { text: string; status: FlowStatus } => {
    const sharedLinks = links.filter((l) => getLinkCorridorIds(l).includes(corridorId));
    const combinedRate = sharedLinks.reduce((sum, l) => {
      const rate = isPlayback ? (currentFrame?.linkFlows[l.id] ?? 0) : l.dailyRate;
      return sum + (Number.isFinite(rate) ? rate : 0);
    }, 0);

    let status: FlowStatus = 'frozen';
    if (isPlayback) {
      const explicitCorridorStatus = currentFrame?.corridorStatuses?.[corridorId];
      if (explicitCorridorStatus) {
        status = explicitCorridorStatus;
      } else if (sharedLinks.length > 0) {
        const statuses = sharedLinks.map((l) => currentFrame?.linkStatuses?.[l.id] ?? 'frozen');
        if (statuses.includes('blocked')) status = 'blocked';
        else if (statuses.includes('restricted')) status = 'restricted';
        else if (statuses.includes('full')) status = 'full';
        else if (statuses.includes('starved')) status = 'starved';
      }
    }

    return {
      text: (combinedRate / 1000).toFixed(2),
      status
    };
  };

  const getCorridorBadgeBox = (
    corridor: RouteCorridor,
    bandWidth: number,
    rateText: string,
    ctx?: CanvasRenderingContext2D | null
  ): { x: number; y: number; width: number; height: number } | null => {
    const wps = corridor.waypoints;
    if (!wps || wps.length < 2) return null;

    let longestIdx = 0;
    let longestLen = -1;
    for (let i = 0; i < wps.length - 1; i++) {
      const segLen = Math.hypot(wps[i + 1].x - wps[i].x, wps[i + 1].y - wps[i].y);
      if (segLen > longestLen) {
        longestLen = segLen;
        longestIdx = i;
      }
    }
    if (longestLen <= 1) return null;

    const segA = wps[longestIdx];
    const segB = wps[longestIdx + 1];
    let angle = Math.atan2(segB.y - segA.y, segB.x - segA.x);
    if (angle >= Math.PI / 2) angle -= Math.PI;
    else if (angle < -Math.PI / 2) angle += Math.PI;

    let textWidth = rateText.length * 7;
    if (ctx) {
      ctx.save();
      ctx.font = 'bold 11px system-ui, sans-serif';
      textWidth = ctx.measureText(rateText).width;
      ctx.restore();
    }

    const width = Math.max(54, Math.ceil(textWidth) + 18);
    const height = 20;

    // Opposite unit normal to getCorridorLabelBox's (sin(angle), -cos(angle))
    const oppNormX = -Math.sin(angle);
    const oppNormY = Math.cos(angle);
    const projHalfExtent = Math.abs(oppNormX) * (width / 2) + Math.abs(oppNormY) * (height / 2);
    const offsetDist = bandWidth / 2 + projHalfExtent + 5;

    return {
      x: (segA.x + segB.x) / 2 + oppNormX * offsetDist,
      y: (segA.y + segB.y) / 2 + oppNormY * offsetDist,
      width,
      height
    };
  };

  // 1. Mousewheel Zoom Event Handler (attached natively with passive: false to prevent document scroll)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const currentZoom = zoomRef.current;
      const currentPan = panRef.current;

      // Exponential zoom curve for consistent smooth sensitivity
      const zoomFactor = Math.pow(1.0015, -e.deltaY);
      const newZoom = Math.min(3.0, Math.max(0.25, currentZoom * zoomFactor));

      if (newZoom === currentZoom) return;

      // Invariant: the world coordinate under the cursor remains at (mouseX, mouseY)
      const worldX = (mouseX - currentPan.x) / currentZoom;
      const worldY = (mouseY - currentPan.y) / currentZoom;

      const newPanX = mouseX - worldX * newZoom;
      const newPanY = mouseY - worldY * newZoom;

      setZoom(newZoom);
      setPan({ x: newPanX, y: newPanY });
    };

    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // 2. Global Keyboard Listener for Spacebar Pan Affordance
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.code === 'Space' && !e.repeat) {
        setIsSpacePressed(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        setIsSpacePressed(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  // 3. Global Window Listeners for Active Panning, Node Dragging, Whole-Corridor Dragging, and Corridor Handle Dragging
  useEffect(() => {
    if (!isPanning && !isDragging && !isDraggingCorridor && !isDraggingCorridorHandle) return;

    const handleWindowMouseMove = (e: MouseEvent) => {
      if (isPanning) {
        const dx = e.clientX - panStartRef.current.x;
        const dy = e.clientY - panStartRef.current.y;
        setPan({
          x: panOriginRef.current.x + dx,
          y: panOriginRef.current.y + dy
        });
      } else if (isDraggingCorridorHandle && draggedCorridorHandleRef.current) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const currentZ = zoomRef.current;
        const currentP = panRef.current;
        const worldX = (mouseX - currentP.x) / currentZ;
        const worldY = (mouseY - currentP.y) / currentZ;

        const snap = getAdaptiveGrid(currentZ).snap;
        const snappedX = Math.round(worldX / snap) * snap;
        const snappedY = Math.round(worldY / snap) * snap;

        const { corridorId, waypointIndex } = draggedCorridorHandleRef.current;
        vm.updateCorridorWaypoint(corridorId, waypointIndex, { x: snappedX, y: snappedY });
        onCorridorsUpdated();
      } else if (isDraggingCorridor) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const currentZ = zoomRef.current;
        const currentP = panRef.current;
        const worldX = (mouseX - currentP.x) / currentZ;
        const worldY = (mouseY - currentP.y) / currentZ;

        const dWorldX = worldX - dragStartRef.current.x;
        const dWorldY = worldY - dragStartRef.current.y;

        const snap = getAdaptiveGrid(currentZ).snap;
        const finalDeltaX = Math.round(dWorldX / snap) * snap;
        const finalDeltaY = Math.round(dWorldY / snap) * snap;

        if (
          finalDeltaX !== corridorLastDeltaRef.current.x ||
          finalDeltaY !== corridorLastDeltaRef.current.y
        ) {
          corridorLastDeltaRef.current = { x: finalDeltaX, y: finalDeltaY };
          corridors.forEach(c => {
            if (selectedCorridorIds.includes(c.id)) {
              const initial = corridorInitialWaypointsRef.current.get(c.id);
              if (initial) {
                vm.setCorridorWaypoints(
                  c.id,
                  initial.map(pt => ({ x: pt.x + finalDeltaX, y: pt.y + finalDeltaY }))
                );
              }
            }
          });
          onCorridorsUpdated();
        }
      } else if (isDragging) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const currentZ = zoomRef.current;
        const currentP = panRef.current;
        const worldX = (mouseX - currentP.x) / currentZ;
        const worldY = (mouseY - currentP.y) / currentZ;

        const dWorldX = worldX - dragStartRef.current.x;
        const dWorldY = worldY - dragStartRef.current.y;

        const snap = getAdaptiveGrid(currentZ).snap;

        // Container side-snapping configuration (hardcoded defaults, ready for Settings integration)
        const CONTAINER_SNAP_RANGE = 24; // Snap distance threshold in world pixels
        const CONTAINER_GAP_MARGIN = 12; // Gap margin between facing sides in world pixels
        const CARD_W = 120;
        const CARD_H = 80;

        const otherNodes = nodes.filter(n => !selectedNodeIds.includes(n.id));

        let bestDeltaX: number | null = null;
        let minDiffX = CONTAINER_SNAP_RANGE + 1;

        let bestDeltaY: number | null = null;
        let minDiffY = CONTAINER_SNAP_RANGE + 1;

        // Check each dragged node against stationary nodes for snapping opportunities
        for (const n of nodes) {
          if (!selectedNodeIds.includes(n.id)) continue;
          const initial = nodeInitialPositionsRef.current.get(n.id);
          if (!initial) continue;

          const rawX = initial.x + dWorldX;
          const rawY = initial.y + dWorldY;

          for (const other of otherNodes) {
            // Check Y-axis snap candidates (top/bottom edges)
            // Relevant when horizontally overlapping or close
            const horizontalOverlap =
              rawX + CARD_W >= other.x - CONTAINER_SNAP_RANGE &&
              rawX <= other.x + CARD_W + CONTAINER_SNAP_RANGE;
            const horizontalNear =
              rawX + CARD_W >= other.x - CARD_W - CONTAINER_GAP_MARGIN - CONTAINER_SNAP_RANGE &&
              rawX <= other.x + CARD_W + CARD_W + CONTAINER_GAP_MARGIN + CONTAINER_SNAP_RANGE;

            if (horizontalOverlap) {
              // 1. Moving DOWN towards other: top of other with 12px gap margin
              const targetYTop = other.y - CARD_H - CONTAINER_GAP_MARGIN;
              const diffYTop = Math.abs(rawY - targetYTop);
              if (diffYTop <= CONTAINER_SNAP_RANGE && diffYTop < minDiffY) {
                minDiffY = diffYTop;
                bestDeltaY = targetYTop - initial.y;
              }

              // 2. Moving UP towards other: bottom of other with 12px gap margin
              const targetYBottom = other.y + CARD_H + CONTAINER_GAP_MARGIN;
              const diffYBottom = Math.abs(rawY - targetYBottom);
              if (diffYBottom <= CONTAINER_SNAP_RANGE && diffYBottom < minDiffY) {
                minDiffY = diffYBottom;
                bestDeltaY = targetYBottom - initial.y;
              }
            }

            if (horizontalNear) {
              // 3. Side-by-side alignment: top-to-top (and bottom-to-bottom) flush alignment
              const targetYAlign = other.y;
              const diffYAlign = Math.abs(rawY - targetYAlign);
              if (diffYAlign <= CONTAINER_SNAP_RANGE && diffYAlign < minDiffY) {
                minDiffY = diffYAlign;
                bestDeltaY = targetYAlign - initial.y;
              }
            }

            // Check X-axis snap candidates (left/right edges)
            // Relevant when vertically overlapping or close
            const verticalOverlap =
              rawY + CARD_H >= other.y - CONTAINER_SNAP_RANGE &&
              rawY <= other.y + CARD_H + CONTAINER_SNAP_RANGE;
            const verticalNear =
              rawY + CARD_H >= other.y - CARD_H - CONTAINER_GAP_MARGIN - CONTAINER_SNAP_RANGE &&
              rawY <= other.y + CARD_H + CARD_H + CONTAINER_GAP_MARGIN + CONTAINER_SNAP_RANGE;

            if (verticalOverlap) {
              // 1. Moving RIGHT towards other: left of other with 12px gap margin
              const targetXLeft = other.x - CARD_W - CONTAINER_GAP_MARGIN;
              const diffXLeft = Math.abs(rawX - targetXLeft);
              if (diffXLeft <= CONTAINER_SNAP_RANGE && diffXLeft < minDiffX) {
                minDiffX = diffXLeft;
                bestDeltaX = targetXLeft - initial.x;
              }

              // 2. Moving LEFT towards other: right of other with 12px gap margin
              const targetXRight = other.x + CARD_W + CONTAINER_GAP_MARGIN;
              const diffXRight = Math.abs(rawX - targetXRight);
              if (diffXRight <= CONTAINER_SNAP_RANGE && diffXRight < minDiffX) {
                minDiffX = diffXRight;
                bestDeltaX = targetXRight - initial.x;
              }
            }

            if (verticalNear) {
              // 3. Stacked alignment: left-to-left (and right-to-right) flush alignment
              const targetXAlign = other.x;
              const diffXAlign = Math.abs(rawX - targetXAlign);
              if (diffXAlign <= CONTAINER_SNAP_RANGE && diffXAlign < minDiffX) {
                minDiffX = diffXAlign;
                bestDeltaX = targetXAlign - initial.x;
              }
            }
          }
        }

        // Apply container side-snapping if in range, otherwise fall back to adaptive grid snapping
        const finalDeltaX = bestDeltaX !== null ? bestDeltaX : Math.round(dWorldX / snap) * snap;
        const finalDeltaY = bestDeltaY !== null ? bestDeltaY : Math.round(dWorldY / snap) * snap;

        nodes.forEach(n => {
          if (selectedNodeIds.includes(n.id)) {
            const initial = nodeInitialPositionsRef.current.get(n.id);
            if (initial) {
              vm.updateNodePosition(n.id, initial.x + finalDeltaX, initial.y + finalDeltaY);
            }
          }
        });
        onNodesUpdated();
      }
    };

    const handleWindowMouseUp = (e: MouseEvent) => {
      if (isPanning && (e.button === 1 || e.button === 0)) {
        setIsPanning(false);
      }
      if (isDragging && e.button === 0) {
        setIsDragging(false);
      }
      if (isDraggingCorridor && e.button === 0) {
        setIsDraggingCorridor(false);
      }
      if (isDraggingCorridorHandle && e.button === 0) {
        setIsDraggingCorridorHandle(false);
        draggedCorridorHandleRef.current = null;
      }
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isPanning, isDragging, isDraggingCorridor, isDraggingCorridorHandle, selectedNodeIds, selectedCorridorIds, nodes, corridors, onNodesUpdated, onCorridorsUpdated, vm]);

  // 4. Main Canvas Render Pipeline with Proportional Viewport Transform & Dynamic Grid
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    const render = () => {
      // Recalculate canvas buffer dimensions from parent container instantly
      canvas.width = parent.clientWidth;
      canvas.height = parent.clientHeight;

      // 1. Clear background
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Compute visible world coordinate bounds
      const minWorldX = -pan.x / zoom;
      const maxWorldX = (canvas.width - pan.x) / zoom;
      const minWorldY = -pan.y / zoom;
      const maxWorldY = (canvas.height - pan.y) / zoom;

      const gridConfig = getAdaptiveGrid(zoom);

      // 2. Apply Camera Viewport Matrix: all nodes, links, badges, texts & grid scale proportionately
      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(zoom, zoom);

      // Minor Dynamic Grid Lines (constant screen-space thickness, does not scale with zoom)
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1 / zoom;
      const startX = Math.floor(minWorldX / gridConfig.minorStep) * gridConfig.minorStep;
      const endX = Math.ceil(maxWorldX / gridConfig.minorStep) * gridConfig.minorStep;
      const startY = Math.floor(minWorldY / gridConfig.minorStep) * gridConfig.minorStep;
      const endY = Math.ceil(maxWorldY / gridConfig.minorStep) * gridConfig.minorStep;

      ctx.beginPath();
      for (let x = startX; x <= endX; x += gridConfig.minorStep) {
        if (x % gridConfig.majorStep !== 0) {
          ctx.moveTo(x, minWorldY);
          ctx.lineTo(x, maxWorldY);
        }
      }
      for (let y = startY; y <= endY; y += gridConfig.minorStep) {
        if (y % gridConfig.majorStep !== 0) {
          ctx.moveTo(minWorldX, y);
          ctx.lineTo(maxWorldX, y);
        }
      }
      ctx.stroke();

      // Major Dynamic Grid Lines (1 major for every 4 minor grids; constant 1.2px screen thickness)
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.2 / zoom;
      ctx.beginPath();
      const majorStartX = Math.floor(minWorldX / gridConfig.majorStep) * gridConfig.majorStep;
      const majorEndX = Math.ceil(maxWorldX / gridConfig.majorStep) * gridConfig.majorStep;
      const majorStartY = Math.floor(minWorldY / gridConfig.majorStep) * gridConfig.majorStep;
      const majorEndY = Math.ceil(maxWorldY / gridConfig.majorStep) * gridConfig.majorStep;

      for (let x = majorStartX; x <= majorEndX; x += gridConfig.majorStep) {
        ctx.moveTo(x, minWorldY);
        ctx.lineTo(x, maxWorldY);
      }
      for (let y = majorStartY; y <= majorEndY; y += gridConfig.majorStep) {
        ctx.moveTo(minWorldX, y);
        ctx.lineTo(maxWorldX, y);
      }
      ctx.stroke();

      // Subtle Origin Crosshair at (0, 0) (constant screen size and thickness)
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.5 / zoom;
      ctx.beginPath();
      ctx.moveTo(-12 / zoom, 0); ctx.lineTo(12 / zoom, 0);
      ctx.moveTo(0, -12 / zoom); ctx.lineTo(0, 12 / zoom);
      ctx.stroke();

      // 2.5 Draw Route Corridors (underneath pipes and containers)
      const assignedCorridorCounts = new Map<string, number>();
      links.forEach((l) => {
        getLinkCorridorIds(l).forEach((cid) => {
          assignedCorridorCounts.set(cid, (assignedCorridorCounts.get(cid) || 0) + 1);
        });
      });

      corridors.forEach((corridor) => {
        const wps = corridor.waypoints;
        if (!wps || wps.length < 2) return;

        const isSelected = selectedCorridorIds.includes(corridor.id);
        const assignedCount = assignedCorridorCounts.get(corridor.id) || 0;
        const bandWidth = getCorridorBandWidth(corridor, assignedCount);

        // Shaded halo band (straight butt end caps, no outer edges)
        ctx.save();
        ctx.lineCap = 'butt';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = isSelected ? 'rgba(56, 189, 248, 0.28)' : 'rgba(203, 213, 225, 0.20)';
        ctx.lineWidth = bandWidth;
        ctx.beginPath();
        ctx.moveTo(wps[0].x, wps[0].y);
        for (let i = 1; i < wps.length; i++) {
          ctx.lineTo(wps[i].x, wps[i].y);
        }
        ctx.stroke();

        // Selectable route label aligned to longest segment
        const labelBox = getCorridorLabelBox(corridor, bandWidth, ctx);
        if (labelBox && corridor.name) {
          ctx.save();
          ctx.translate(labelBox.midX, labelBox.midY);
          ctx.rotate(labelBox.angle);
          ctx.fillStyle = isSelected ? '#38bdf8' : '#cbd5e1';
          ctx.font = '600 10px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(corridor.name, 0, 0);
          ctx.restore();
        }
        ctx.restore();
      });

      // 3. Draw Links & Flow Animation Badges
      const computedRoutes = computeAllLinkRoutes(nodes, links, corridors);

      links.forEach(link => {
        const route = computedRoutes.get(link.id);
        if (!route || route.points.length < 2) return;

        const points = route.points;
        const isSelected = selectedLinkIds.includes(link.id);
        const linkFlow = isPlayback ? (currentFrame?.linkFlows[link.id] ?? 0) : link.dailyRate;
        const linkStatus: FlowStatus = isPlayback ? (currentFrame?.linkStatuses?.[link.id] ?? 'frozen') : 'frozen';

        const linkColor = isPlayback ? getFlowColor(linkStatus) : (isSelected ? '#38bdf8' : '#64748b');
        ctx.strokeStyle = linkColor;
        ctx.lineWidth = isSelected ? (isPlayback ? 5 : 4) : (isPlayback ? 3.5 : 2.5);
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) {
          ctx.lineTo(points[i].x, points[i].y);
        }
        ctx.stroke();

        const startArrowOffset = 36;
        const p0 = points[0];
        const p1 = points[1];
        const angle0 = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        const seg0Len = Math.hypot(p1.x - p0.x, p1.y - p0.y);
        if (seg0Len > 5) {
          const dist = Math.min(startArrowOffset, seg0Len / 2 + 21);
          drawArrowHead(ctx, p0.x + Math.cos(angle0) * dist, p0.y + Math.sin(angle0) * dist, angle0, linkColor);
        }

        const endArrowOffset = 16;
        const pEndPrev = points[points.length - 2];
        const pEnd = points[points.length - 1];
        const angleEnd = Math.atan2(pEnd.y - pEndPrev.y, pEnd.x - pEndPrev.x);
        const segEndLen = Math.hypot(pEnd.x - pEndPrev.x, pEnd.y - pEndPrev.y);
        if (segEndLen > 5) {
          const dist = Math.min(endArrowOffset, segEndLen / 2);
          drawArrowHead(ctx, pEnd.x - Math.cos(angleEnd) * dist, pEnd.y - Math.sin(angleEnd) * dist, angleEnd, linkColor);
        }

        // Draw Rate Badge at computed unshared branch position
        const badgePt = route.badgePt;

        const displayRateText = (linkFlow / 1000).toFixed(2);
        const badgeW = 50;
        const badgeH = 20;
        ctx.fillStyle = isSelected ? '#0369a1' : '#0f172a';
        ctx.fillRect(badgePt.x - badgeW / 2, badgePt.y - badgeH / 2, badgeW, badgeH);
        ctx.strokeStyle = linkColor;
        ctx.lineWidth = isSelected ? 2 : 1.5;
        ctx.strokeRect(badgePt.x - badgeW / 2, badgePt.y - badgeH / 2, badgeW, badgeH);

        ctx.fillStyle = isPlayback ? linkColor : '#f8fafc';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(displayRateText, badgePt.x, badgePt.y + 1.5);
      });

      // 3.5 Draw Always-Upright Route Corridor Combined-Rate Badges (opposite side of route label)
      corridors.forEach((corridor) => {
        const wps = corridor.waypoints;
        if (!wps || wps.length < 2) return;

        const isSelected = selectedCorridorIds.includes(corridor.id);
        const assignedCount = assignedCorridorCounts.get(corridor.id) || 0;
        const bandWidth = getCorridorBandWidth(corridor, assignedCount);
        const rateMeta = getCorridorRateMeta(corridor.id);
        const badgeBox = getCorridorBadgeBox(corridor, bandWidth, rateMeta.text, ctx);
        if (!badgeBox) return;

        const badgeColor = isPlayback ? getFlowColor(rateMeta.status) : (isSelected ? '#38bdf8' : '#94a3b8');

        ctx.save();
        const left = badgeBox.x - badgeBox.width / 2;
        const top = badgeBox.y - badgeBox.height / 2;
        const w = badgeBox.width;
        const h = badgeBox.height;
        const cut = 5;

        ctx.beginPath();
        ctx.moveTo(left + cut, top);
        ctx.lineTo(left + w - cut, top);
        ctx.lineTo(left + w, top + cut);
        ctx.lineTo(left + w, top + h - cut);
        ctx.lineTo(left + w - cut, top + h);
        ctx.lineTo(left + cut, top + h);
        ctx.lineTo(left, top + h - cut);
        ctx.lineTo(left, top + cut);
        ctx.closePath();

        ctx.fillStyle = !isPlayback && isSelected ? '#0369a1' : '#0f172a';
        ctx.fill();
        ctx.strokeStyle = badgeColor;
        ctx.lineWidth = isSelected ? 2 : 1.5;
        ctx.stroke();

        ctx.fillStyle = isPlayback ? badgeColor : '#f8fafc';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(rateMeta.text, badgeBox.x, badgeBox.y + 1.5);
        ctx.restore();
      });

      // 4. Draw Container Nodes
      nodes.forEach((node, nodeIdx) => {
        const isSelected = selectedNodeIds.includes(node.id);
        const isHighlighted = isPlayback && highlightedNodeIds.includes(node.id);
        const liveVol = isPlayback && currentFrame ? (currentFrame.nodeVolumes[node.id] ?? node.currentVolume) : node.currentVolume;
        const nodeStatus: FlowStatus = isPlayback ? (currentFrame?.nodeStatuses?.[node.id] ?? 'frozen') : 'frozen';
        const nodeBorderColor = isPlayback 
          ? getFlowColor(nodeStatus)
          : (isSelected ? '#38bdf8' : '#334155');

        // Standard 120x80 Container Card
        const width = 120;
        const height = 80;
        const fillPct = Math.min(1, Math.max(0, liveVol / node.capacity));
        const isOverfilled = liveVol > node.capacity;

        if (isSelected) {
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 3;
          ctx.strokeRect(node.x - 4, node.y - 4, width + 8, height + 8);
        }

        ctx.fillStyle = '#1e293b';
        ctx.fillRect(node.x, node.y, width, height);

        // When highlighted in playback: vibrant, wide halo outside of the container box
        if (isHighlighted) {
          const graphColor = GRAPH_LINE_COLORS[nodeIdx % GRAPH_LINE_COLORS.length];
          ctx.save();
          ctx.strokeStyle = graphColor;
          ctx.lineWidth = 10;
          ctx.globalAlpha = 0.52;
          ctx.strokeRect(node.x - 5, node.y - 5, width + 10, height + 10);
          ctx.restore();
        }

        // Inner sim-engine colored border (always solid, crisp and unaffected)
        ctx.strokeStyle = nodeBorderColor;
        ctx.lineWidth = isPlayback ? 3 : 2;
        ctx.strokeRect(node.x, node.y, width, height);

        ctx.fillStyle = isOverfilled ? '#ef4444' : (node.type === 'excavation' ? '#0d9488' : node.type === 'stockpile' ? '#b45309' : '#475569');
        ctx.fillRect(node.x + 8, node.y + 55, (width - 16) * Math.min(1, fillPct), 12);

        ctx.strokeStyle = '#64748b';
        ctx.lineWidth = 1;
        ctx.strokeRect(node.x + 8, node.y + 55, width - 16, 12);

        ctx.fillStyle = '#f8fafc';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(node.name, node.x + 10, node.y + 22);

        ctx.fillStyle = isOverfilled ? '#fca5a5' : '#94a3b8';
        ctx.font = '9px system-ui, sans-serif';
        ctx.fillText(`Mat: ${node.materialType}`, node.x + 10, node.y + 38);
        ctx.fillText(`Vol: ${Math.round(liveVol).toLocaleString()} m³`, node.x + 10, node.y + 50);

        // Draw corner rule badge
        const badgeX = node.x + width;
        const badgeY = node.y;
        ctx.save();
        ctx.fillStyle = '#f8fafc';
        ctx.strokeStyle = '#0f172a';
        ctx.lineWidth = 1.5;

        if (node.overflowMode === 'overfill') {
          const size = 12;
          ctx.beginPath();
          ctx.rect(badgeX - size / 2, badgeY - size / 2, size, size);
          ctx.fill();
          ctx.stroke();
        } else if (node.strictSubRule === 'headroom_hold') {
          const r = 7;
          ctx.beginPath();
          ctx.moveTo(badgeX, badgeY - r);
          ctx.lineTo(badgeX + r, badgeY);
          ctx.lineTo(badgeX, badgeY + r);
          ctx.lineTo(badgeX - r, badgeY);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          const r = 6.5;
          ctx.beginPath();
          ctx.arc(badgeX, badgeY, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();

        // Draw output and input socket edge indicators when container is selected (Edit Mode)
        if (isSelected && !isPlayback) {
          const activeOutEdge = getEffectiveContainerOutputEdge(node, nodes, links, corridors);
          const activeInEdge = getEffectiveContainerInputEdge(node, nodes, links, corridors);
          const sameEdge = activeOutEdge === activeInEdge;

          const getEdgePose = (edge: 'N' | 'E' | 'S' | 'W', alongOffset: number) =>
            edge === 'N'
              ? { x: node.x + width / 2 + alongOffset, y: node.y, angle: -Math.PI / 2 }
              : edge === 'S'
              ? { x: node.x + width / 2 + alongOffset, y: node.y + height, angle: Math.PI / 2 }
              : edge === 'W'
              ? { x: node.x, y: node.y + height / 2 + alongOffset, angle: Math.PI }
              : { x: node.x + width, y: node.y + height / 2 + alongOffset, angle: 0 };

          // Input socket indicator (points inward into container)
          const inPose = getEdgePose(activeInEdge, sameEdge ? -10 : 0);
          ctx.save();
          ctx.translate(inPose.x, inPose.y);
          ctx.rotate(inPose.angle + Math.PI);
          ctx.fillStyle = '#22c55e';
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(-7, -6);
          ctx.lineTo(2, 0);
          ctx.lineTo(-7, 6);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();

          // Output socket indicator (points outward from container)
          const outPose = getEdgePose(activeOutEdge, sameEdge ? 10 : 0);
          ctx.save();
          ctx.translate(outPose.x, outPose.y);
          ctx.rotate(outPose.angle);
          ctx.fillStyle = '#38bdf8';
          ctx.strokeStyle = '#0f172a';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(-2, -6);
          ctx.lineTo(7, 0);
          ctx.lineTo(-2, 6);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
      });

      // 5. Draw Selected Route Corridor Edit Handles (only when 1 corridor is selected)
      if (selectedCorridorIds.length === 1 && !isPlayback) {
        const activeCorridor = corridors.find((c) => c.id === selectedCorridorIds[0]);
        if (activeCorridor && activeCorridor.waypoints.length >= 2) {
          const wps = activeCorridor.waypoints;

          // Midpoint '+' insertion handles
          for (let i = 0; i < wps.length - 1; i++) {
            const segLen = Math.hypot(wps[i + 1].x - wps[i].x, wps[i + 1].y - wps[i].y);
            if (segLen < 24) continue;
            const mx = (wps[i].x + wps[i + 1].x) / 2;
            const my = (wps[i].y + wps[i + 1].y) / 2;

            ctx.save();
            ctx.fillStyle = '#0f172a';
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.arc(mx, my, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.strokeStyle = '#e2e8f0';
            ctx.lineWidth = 1.25;
            ctx.beginPath();
            ctx.moveTo(mx - 2.5, my);
            ctx.lineTo(mx + 2.5, my);
            ctx.moveTo(mx, my - 2.5);
            ctx.lineTo(mx, my + 2.5);
            ctx.stroke();
            ctx.restore();
          }

          // Endpoint & bend handles
          wps.forEach((pt, idx) => {
            const isEndpoint = idx === 0 || idx === wps.length - 1;
            ctx.save();
            ctx.fillStyle = isEndpoint ? '#0284c7' : '#1e293b';
            ctx.strokeStyle = isEndpoint ? '#f8fafc' : '#38bdf8';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, isEndpoint ? 6.5 : 5.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          });
        }
      }

      ctx.restore();
    };

    render();

    const resizeObserver = new ResizeObserver(() => {
      render();
    });
    resizeObserver.observe(parent);

    return () => {
      resizeObserver.disconnect();
    };
  }, [nodes, links, corridors, selectedNodeIds, selectedLinkIds, selectedCorridorIds, isPlayback, highlightedNodeIds, currentFrame, pan, zoom, routerReady]);

  // 5. Canvas Mouse Down Handler: Distinguishes Middle Mouse Pan, Space Pan, Node Drag, and Link Selection
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const isMiddleClick = e.button === 1;
    const isSpacePan = e.button === 0 && isSpacePressed;

    // Viewport Panning Activation (Middle Click or Space + Left Click)
    if (isMiddleClick || isSpacePan) {
      e.preventDefault();
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY };
      panOriginRef.current = { ...panRef.current };
      return;
    }

    if (e.button !== 0) return; // Only proceed with left-clicks for selection/drag

    if (isPlayback) {
      // In playback mode containers cannot be selected.
      // Left-clicking empty space clears graph line highlights if Ctrl is not pressed
      if (!e.ctrlKey && !e.metaKey && setHighlightedNodeIds) {
        setHighlightedNodeIds([]);
      }
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const worldMouse = screenToWorld(mouseX, mouseY);
    const isCtrl = e.ctrlKey || e.metaKey;

    // 0. Hit-test active corridor vertex & midpoint handles first (only when 1 corridor is selected)
    if (selectedCorridorIds.length === 1 && !isCtrl) {
      const activeCorridor = corridors.find((c) => c.id === selectedCorridorIds[0]);
      if (activeCorridor && activeCorridor.waypoints.length >= 2) {
        const handleTolerance = Math.max(9, 11 / zoomRef.current);
        const wps = activeCorridor.waypoints;

        for (let i = 0; i < wps.length; i++) {
          if (Math.hypot(worldMouse.x - wps[i].x, worldMouse.y - wps[i].y) <= handleTolerance) {
            setIsDraggingCorridorHandle(true);
            draggedCorridorHandleRef.current = { corridorId: activeCorridor.id, waypointIndex: i };
            return;
          }
        }

        const midTolerance = Math.max(8, 10 / zoomRef.current);
        for (let i = 0; i < wps.length - 1; i++) {
          const segLen = Math.hypot(wps[i + 1].x - wps[i].x, wps[i + 1].y - wps[i].y);
          if (segLen < 24) continue;
          const mx = (wps[i].x + wps[i + 1].x) / 2;
          const my = (wps[i].y + wps[i + 1].y) / 2;
          if (Math.hypot(worldMouse.x - mx, worldMouse.y - my) <= midTolerance) {
            const snap = getAdaptiveGrid(zoomRef.current).snap;
            const snappedPt = {
              x: Math.round(worldMouse.x / snap) * snap,
              y: Math.round(worldMouse.y / snap) * snap
            };
            vm.insertCorridorWaypoint(activeCorridor.id, i + 1, snappedPt);
            onCorridorsUpdated();
            setIsDraggingCorridorHandle(true);
            draggedCorridorHandleRef.current = { corridorId: activeCorridor.id, waypointIndex: i + 1 };
            return;
          }
        }
      }
    }

    // 1. Hit-test nodes
    const clickedNode = nodes.slice().reverse().find(n => 
      worldMouse.x >= n.x && worldMouse.x <= n.x + 120 && worldMouse.y >= n.y && worldMouse.y <= n.y + 80
    );

    if (clickedNode) {
      let newSelectedNodeIds = [...selectedNodeIds];

      if (isCtrl) {
        if (newSelectedNodeIds.includes(clickedNode.id)) {
          newSelectedNodeIds = newSelectedNodeIds.filter(id => id !== clickedNode.id);
        } else {
          newSelectedNodeIds.push(clickedNode.id);
        }
        setSelectedNodeIds(newSelectedNodeIds);
      } else {
        if (!newSelectedNodeIds.includes(clickedNode.id) || selectedLinkIds.length > 0 || selectedCorridorIds.length > 0) {
          newSelectedNodeIds = [clickedNode.id];
          setSelectedNodeIds(newSelectedNodeIds);
          setSelectedLinkIds([]);
          setSelectedCorridorIds([]);
        }
      }

      if (newSelectedNodeIds.includes(clickedNode.id)) {
        setIsDragging(true);
        dragStartRef.current = { x: worldMouse.x, y: worldMouse.y };
        const initialMap = new Map<string, { x: number; y: number }>();
        nodes.forEach(n => initialMap.set(n.id, { x: n.x, y: n.y }));
        nodeInitialPositionsRef.current = initialMap;
      }
      return;
    }

    // 1.5 Hit-test route corridor labels first so route labels are reliably selectable
    const ctxForMeasure = canvas.getContext('2d');
    const assignedCorridorCounts = new Map<string, number>();
    links.forEach((l) => {
      getLinkCorridorIds(l).forEach((cid) => {
        assignedCorridorCounts.set(cid, (assignedCorridorCounts.get(cid) || 0) + 1);
      });
    });

    const labelClickedCorridor = corridors.slice().reverse().find((corridor) => {
      const assignedCount = assignedCorridorCounts.get(corridor.id) || 0;
      const bandWidth = getCorridorBandWidth(corridor, assignedCount);
      const box = getCorridorLabelBox(corridor, bandWidth, ctxForMeasure);
      if (box) {
        const dx = worldMouse.x - box.midX;
        const dy = worldMouse.y - box.midY;
        const cos = Math.cos(-box.angle);
        const sin = Math.sin(-box.angle);
        const localX = dx * cos - dy * sin;
        const localY = dx * sin + dy * cos;
        if (Math.abs(localX) <= box.width / 2 && Math.abs(localY) <= box.height / 2) {
          return true;
        }
      }

      const rateMeta = getCorridorRateMeta(corridor.id);
      const badgeBox = getCorridorBadgeBox(corridor, bandWidth, rateMeta.text, ctxForMeasure);
      if (
        badgeBox &&
        worldMouse.x >= badgeBox.x - badgeBox.width / 2 &&
        worldMouse.x <= badgeBox.x + badgeBox.width / 2 &&
        worldMouse.y >= badgeBox.y - badgeBox.height / 2 &&
        worldMouse.y <= badgeBox.y + badgeBox.height / 2
      ) {
        return true;
      }

      return false;
    });

    const selectAndStartCorridorDrag = (targetCorridor: RouteCorridor) => {
      let newSelectedCorridorIds = [...selectedCorridorIds];

      if (isCtrl) {
        if (newSelectedCorridorIds.includes(targetCorridor.id)) {
          newSelectedCorridorIds = newSelectedCorridorIds.filter(id => id !== targetCorridor.id);
        } else {
          newSelectedCorridorIds.push(targetCorridor.id);
        }
        setSelectedCorridorIds(newSelectedCorridorIds);
      } else {
        if (!newSelectedCorridorIds.includes(targetCorridor.id) || selectedNodeIds.length > 0 || selectedLinkIds.length > 0) {
          newSelectedCorridorIds = [targetCorridor.id];
          setSelectedCorridorIds(newSelectedCorridorIds);
          setSelectedNodeIds([]);
          setSelectedLinkIds([]);
        }
      }

      if (newSelectedCorridorIds.includes(targetCorridor.id)) {
        setIsDraggingCorridor(true);
        dragStartRef.current = { x: worldMouse.x, y: worldMouse.y };
        corridorLastDeltaRef.current = { x: 0, y: 0 };
        const initialMap = new Map<string, Point[]>();
        corridors.forEach(c => initialMap.set(c.id, c.waypoints.map(p => ({ x: p.x, y: p.y }))));
        corridorInitialWaypointsRef.current = initialMap;
      }
    };

    const isPointOnCorridorBand = (corridor: RouteCorridor, pt: Point): boolean => {
      const wps = corridor.waypoints;
      if (!wps || wps.length < 2) return false;
      const assignedCount = assignedCorridorCounts.get(corridor.id) || 0;
      const bandWidth = getCorridorBandWidth(corridor, assignedCount);
      const bandTolerance = Math.max(bandWidth / 2 + 4, 12 / zoomRef.current);

      for (let i = 0; i < wps.length - 1; i++) {
        if (distToSegment(pt, wps[i], wps[i + 1]) <= bandTolerance) return true;
      }
      return false;
    };

    if (labelClickedCorridor) {
      selectAndStartCorridorDrag(labelClickedCorridor);
      return;
    }

    // 2. Hit-test links & rate badges
    const hitTolerance = Math.max(4, 6 / zoomRef.current);
    const computedRoutes = computeAllLinkRoutes(nodes, links, corridors);

    const selectClickedLink = (targetLink: TransferLink) => {
      if (isCtrl) {
        const nextLinks = selectedLinkIds.includes(targetLink.id)
          ? selectedLinkIds.filter(id => id !== targetLink.id)
          : [...selectedLinkIds, targetLink.id];
        setSelectedLinkIds(nextLinks);
      } else {
        setSelectedLinkIds([targetLink.id]);
        setSelectedNodeIds([]);
        setSelectedCorridorIds([]);
      }
    };

    // 2a. Offline transfer rate badges always stay selectable
    const clickedLinkBadge = links.slice().reverse().find(link => {
      const route = computedRoutes.get(link.id);
      if (!route || route.points.length < 2) return false;
      const badgePt = route.badgePt;
      const badgeW = 50;
      const badgeH = 20;
      return (
        worldMouse.x >= badgePt.x - badgeW / 2 &&
        worldMouse.x <= badgePt.x + badgeW / 2 &&
        worldMouse.y >= badgePt.y - badgeH / 2 &&
        worldMouse.y <= badgePt.y + badgeH / 2
      );
    });

    if (clickedLinkBadge) {
      selectClickedLink(clickedLinkBadge);
      return;
    }

    // 2b. If a corridor is already selected (and not Ctrl-selecting), allow dragging its band even over bundled lanes
    if (!isCtrl && selectedCorridorIds.length > 0) {
      const selectedBandCorridor = corridors
        .slice()
        .reverse()
        .find((corridor) => selectedCorridorIds.includes(corridor.id) && isPointOnCorridorBand(corridor, worldMouse));

      if (selectedBandCorridor) {
        selectAndStartCorridorDrag(selectedBandCorridor);
        return;
      }
    }

    // 2c. Hit-test transfer link segments
    const clickedLink = links.slice().reverse().find(link => {
      const route = computedRoutes.get(link.id);
      if (!route || route.points.length < 2) return false;

      for (let i = 0; i < route.points.length - 1; i++) {
        if (distToSegment(worldMouse, route.points[i], route.points[i + 1]) < hitTolerance) return true;
      }
      return false;
    });

    if (clickedLink) {
      selectClickedLink(clickedLink);
      return;
    }

    // 3. Hit-test route corridor halo bands
    const clickedCorridor = corridors.slice().reverse().find((corridor) => isPointOnCorridorBand(corridor, worldMouse));

    if (clickedCorridor) {
      selectAndStartCorridorDrag(clickedCorridor);
      return;
    }

    // Clicked empty canvas space
    if (!isCtrl) {
      setSelectedNodeIds([]);
      setSelectedLinkIds([]);
      setSelectedCorridorIds([]);
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isPlayback || selectedCorridorIds.length !== 1) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const worldMouse = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);

    const activeCorridor = corridors.find((c) => c.id === selectedCorridorIds[0]);
    if (!activeCorridor || activeCorridor.waypoints.length <= 2) return;

    const handleTolerance = Math.max(9, 11 / zoomRef.current);
    const wps = activeCorridor.waypoints;
    for (let i = 1; i < wps.length - 1; i++) {
      if (Math.hypot(worldMouse.x - wps[i].x, worldMouse.y - wps[i].y) <= handleTolerance) {
        if (vm.removeCorridorWaypoint(activeCorridor.id, i)) {
          onCorridorsUpdated();
        }
        return;
      }
    }
  };

  // 6. Step Zoom & Reset Handlers for HUD
  const handleStepZoom = (direction: 1 | -1) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const currentZoom = zoomRef.current;
    const currentPan = panRef.current;

    const centerX = canvas.clientWidth / 2;
    const centerY = canvas.clientHeight / 2;

    const factor = direction > 0 ? 1.25 : 0.8;
    const newZoom = Math.min(3.0, Math.max(0.25, Number((currentZoom * factor).toFixed(2))));

    const worldX = (centerX - currentPan.x) / currentZoom;
    const worldY = (centerY - currentPan.y) / currentZoom;

    const newPanX = centerX - worldX * newZoom;
    const newPanY = centerY - worldY * newZoom;

    setZoom(newZoom);
    setPan({ x: newPanX, y: newPanY });
  };

  const handleResetView = () => {
    setZoom(1.0);
    setPan({ x: 0, y: 0 });
  };

  const getCanvasCursor = () => {
    if (isPanning) return 'grabbing';
    if (isSpacePressed) return 'grab';
    if (isDragging || isDraggingCorridor || isDraggingCorridorHandle) return 'grabbing';
    return isPlayback ? 'default' : 'default';
  };

  const handleCreateCorridorClick = () => {
    const canvas = canvasRef.current;
    if (!canvas) {
      onAddCorridor();
      return;
    }
    const center = screenToWorld(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const snap = 20;
    const cx = Math.round(center.x / snap) * snap;
    const cy = Math.round(center.y / snap) * snap;
    onAddCorridor([
      { x: cx - 120, y: cy },
      { x: cx + 120, y: cy }
    ]);
  };

  return (
    <div style={{ flex: 1, position: 'relative', minHeight: 0, overflow: 'hidden' }}>
      {/* Top 6-Button Equal-Width State-Machine Toolbar */}
      {!isPlayback && (
        <div
          style={{
            position: 'absolute',
            top: '16px',
            right: '16px',
            maxWidth: 'calc(100% - 32px)',
            display: 'grid',
            gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
            gap: '6px',
            zIndex: 20,
            backgroundColor: 'rgba(15, 23, 42, 0.9)',
            padding: '6px 8px',
            borderRadius: '8px',
            border: '1px solid #334155',
            backdropFilter: 'blur(6px)'
          }}
        >
          <button
            type="button"
            onClick={onAddNode}
            title={selectedNodeIds.length === 1 ? 'Add new container (copying properties from selected container)' : 'Add new container'}
            style={{
              backgroundColor: 'rgba(30, 41, 59, 0.95)',
              color: '#e2e8f0',
              border: '1px solid #475569',
              padding: '6px 10px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            + container
          </button>
          <button
            type="button"
            onClick={onAddLink}
            disabled={!canLink}
            title={canLink ? 'Create transfer link between the first two selected containers' : 'Select 2+ containers (Ctrl/Cmd+click) to unlock + transfer'}
            style={{
              backgroundColor: canLink ? 'rgba(56, 189, 248, 0.14)' : 'rgba(15, 23, 42, 0.65)',
              color: canLink ? '#7dd3fc' : '#475569',
              border: canLink ? '1px solid rgba(56, 189, 248, 0.45)' : '1px solid rgba(51, 65, 85, 0.5)',
              padding: '6px 10px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: canLink ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            + transfer
          </button>
          <button
            type="button"
            onClick={handleCreateCorridorClick}
            title={
              selectedLinkIds.length > 0
                ? 'Create a best-fit horizontal/vertical route corridor and attach the selected transfer(s)'
                : 'Place a route corridor on the canvas to bunch assigned transfer links into parallel lanes'
            }
            style={{
              backgroundColor: selectedLinkIds.length > 0 ? 'rgba(56, 189, 248, 0.14)' : 'rgba(30, 41, 59, 0.95)',
              color: selectedLinkIds.length > 0 ? '#7dd3fc' : '#e2e8f0',
              border: selectedLinkIds.length > 0 ? '1px solid rgba(56, 189, 248, 0.45)' : '1px solid #475569',
              padding: '6px 10px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            + route
          </button>
          <button
            type="button"
            onClick={onSetRouteLanes}
            disabled={!canSetLanes}
            title={
              canSetLanes
                ? 'Add selected transfer link(s) to selected route corridor(s)'
                : 'Select 1+ route corridor(s) and 1+ transfer link(s) (Ctrl/Cmd+click) to unlock + lanes'
            }
            style={{
              backgroundColor: canSetLanes ? 'rgba(56, 189, 248, 0.14)' : 'rgba(15, 23, 42, 0.65)',
              color: canSetLanes ? '#7dd3fc' : '#475569',
              border: canSetLanes ? '1px solid rgba(56, 189, 248, 0.45)' : '1px solid rgba(51, 65, 85, 0.5)',
              padding: '6px 10px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: canSetLanes ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            + lanes
          </button>
          <button
            type="button"
            onClick={onUnlinkLanes}
            disabled={!canUnlinkLanes}
            title={
              !canUnlinkLanes
                ? 'Select linked transfer(s) or an occupied route corridor to unlock - lanes'
                : selectedLinkIds.length > 0 && selectedCorridorIds.length > 0
                ? 'Remove selected transfer(s) from selected route corridor(s)'
                : selectedLinkIds.length > 0
                ? 'Unlink selected transfer(s) from all route corridors'
                : 'Unlink all transfers from selected route corridor(s)'
            }
            style={{
              backgroundColor: canUnlinkLanes ? 'rgba(245, 158, 11, 0.14)' : 'rgba(15, 23, 42, 0.65)',
              color: canUnlinkLanes ? '#fcd34d' : '#475569',
              border: canUnlinkLanes ? '1px solid rgba(245, 158, 11, 0.45)' : '1px solid rgba(51, 65, 85, 0.5)',
              padding: '6px 10px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: canUnlinkLanes ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            - lanes
          </button>
          <button
            type="button"
            onClick={onDeleteSelected}
            disabled={!hasSelection}
            title={hasSelection ? 'Delete all selected element(s) (Delete / Backspace)' : 'Select any element to unlock - element'}
            style={{
              backgroundColor: hasSelection ? 'rgba(239, 68, 68, 0.16)' : 'rgba(15, 23, 42, 0.65)',
              color: hasSelection ? '#fca5a5' : '#475569',
              border: hasSelection ? '1px solid rgba(239, 68, 68, 0.45)' : '1px solid rgba(51, 65, 85, 0.5)',
              padding: '6px 10px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
              cursor: hasSelection ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            - element
          </button>
        </div>
      )}

      {/* Floating Zoom HUD Controls in bottom-left */}
      <div style={{
        position: 'absolute',
        bottom: '16px',
        left: '20px',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
        zIndex: 20,
        backgroundColor: 'rgba(30, 41, 59, 0.9)',
        padding: '4px 8px',
        borderRadius: '8px',
        border: '1px solid #334155',
        backdropFilter: 'blur(4px)',
        fontSize: '11px',
        color: '#94a3b8',
        userSelect: 'none',
        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)'
      }}>
        <button
          type="button"
          onClick={() => handleStepZoom(-1)}
          title="Zoom Out (Mousewheel down)"
          style={{
            background: 'none',
            border: 'none',
            color: '#f8fafc',
            width: '24px',
            height: '24px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 'bold',
            borderRadius: '4px'
          }}
        >
          −
        </button>
        <button
          type="button"
          onClick={handleResetView}
          title="Current Zoom Level (Click to reset to 100%)"
          style={{
            background: 'none',
            border: 'none',
            color: '#38bdf8',
            fontFamily: 'monospace',
            fontWeight: 700,
            fontSize: '11px',
            padding: '2px 6px',
            cursor: 'pointer',
            borderRadius: '4px'
          }}
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={() => handleStepZoom(1)}
          title="Zoom In (Mousewheel up)"
          style={{
            background: 'none',
            border: 'none',
            color: '#f8fafc',
            width: '24px',
            height: '24px',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 'bold',
            borderRadius: '4px'
          }}
        >
          +
        </button>
        <span style={{ height: '14px', width: '1px', backgroundColor: 'rgba(255, 255, 255, 0.2)', margin: '0 4px' }} />
        <button
          type="button"
          onClick={handleResetView}
          title="Reset Camera to Center (0, 0) and 100% Zoom"
          style={{
            background: 'none',
            border: 'none',
            color: '#94a3b8',
            fontSize: '11px',
            padding: '2px 6px',
            cursor: 'pointer',
            borderRadius: '4px'
          }}
        >
          Reset
        </button>
      </div>

      {/* Main Interactive Simulation Canvas */}
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          cursor: getCanvasCursor()
        }}
      />
    </div>
  );
};