import { AvoidLib, type Avoid, type ConnDirFlags, type ShapeRef } from 'libavoid-js';
import { getLinkCorridorIds, type CardinalEdge, type ContainerNode, type Point, type RouteCorridor, type TransferLink } from '../../models/types';

export type { Point };

export interface ComputedRoute {
  linkId: string;
  source: ContainerNode;
  target: ContainerNode;
  points: Point[];
  startPort: Point;
  endPort: Point;
  badgePt: Point;
  sDir: CardinalEdge;
  tDir: CardinalEdge;
}

type CardinalDirection = CardinalEdge;

interface PortOption {
  point: Point;
  dir: CardinalDirection;
}

const CARD_W = 120;
const CARD_H = 80;
const LANE_SPACING = 12;
// Minimum straight socket lead length at both output and input container edges before any turn point
const MIN_SOCKET_LEAD = 50;

let avoidInstance: Avoid | null = null;
let avoidLoadPromise: Promise<boolean> | null = null;

// Cache computed routes so pan, zoom, selection, and playback ticks do not re-run WASM routing
let cachedTopologyKey = '';
let cachedRoutes: Map<string, ComputedRoute> | null = null;

export const isPipeRouterReady = (): boolean => avoidInstance !== null;

export const initPipeRouter = (customWasmUrl?: string): Promise<boolean> => {
  if (avoidInstance) return Promise.resolve(true);
  if (avoidLoadPromise) return avoidLoadPromise;

  const baseUrl = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const wasmUrl = customWasmUrl ?? `${baseUrl}libavoid.wasm`;
  avoidLoadPromise = AvoidLib.load(wasmUrl)
    .then(() => {
      avoidInstance = AvoidLib.getInstance();
      cachedTopologyKey = '';
      cachedRoutes = null;
      return true;
    })
    .catch((err) => {
      console.error('Failed to initialize libavoid-js WASM router:', err);
      avoidLoadPromise = null;
      return false;
    });

  return avoidLoadPromise;
};

const getCardinalPorts = (node: ContainerNode): PortOption[] => [
  { point: { x: node.x + CARD_W / 2, y: node.y }, dir: 'N' },
  { point: { x: node.x + CARD_W / 2, y: node.y + CARD_H }, dir: 'S' },
  { point: { x: node.x + CARD_W, y: node.y + CARD_H / 2 }, dir: 'E' },
  { point: { x: node.x, y: node.y + CARD_H / 2 }, dir: 'W' }
];

const isPointInsideNode = (pt: Point, node: ContainerNode, margin = 4): boolean =>
  pt.x > node.x + margin &&
  pt.x < node.x + CARD_W - margin &&
  pt.y > node.y + margin &&
  pt.y < node.y + CARD_H - margin;

const simplifyCollinear = (pts: Point[]): Point[] => {
  if (pts.length <= 2) return pts;
  const deduped: Point[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const prev = deduped[deduped.length - 1];
    if (Math.hypot(pts[i].x - prev.x, pts[i].y - prev.y) >= 0.5) {
      deduped.push(pts[i]);
    }
  }
  if (deduped.length <= 2) return deduped;

  const result: Point[] = [deduped[0]];
  for (let i = 1; i < deduped.length - 1; i++) {
    const prev = result[result.length - 1];
    const curr = deduped[i];
    const next = deduped[i + 1];

    const isH = Math.abs(prev.y - curr.y) < 0.5 && Math.abs(curr.y - next.y) < 0.5;
    const isV = Math.abs(prev.x - curr.x) < 0.5 && Math.abs(curr.x - next.x) < 0.5;

    if (!isH && !isV) {
      result.push(curr);
    }
  }
  result.push(deduped[deduped.length - 1]);
  return result;
};

const getSegmentUnitNormal = (a: Point, b: Point): Point => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return { x: 0, y: -1 };
  return { x: -dy / len, y: dx / len };
};

export const offsetPolyline = (pts: Point[], offset: number): Point[] => {
  if (pts.length < 2 || Math.abs(offset) < 0.01) {
    return pts.map((p) => ({ x: p.x, y: p.y }));
  }

  const normals: Point[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    normals.push(getSegmentUnitNormal(pts[i], pts[i + 1]));
  }

  const result: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      result.push({
        x: pts[0].x + normals[0].x * offset,
        y: pts[0].y + normals[0].y * offset
      });
    } else if (i === pts.length - 1) {
      const nLast = normals[normals.length - 1];
      result.push({
        x: pts[i].x + nLast.x * offset,
        y: pts[i].y + nLast.y * offset
      });
    } else {
      const n1 = normals[i - 1];
      const n2 = normals[i];
      const dot = n1.x * n2.x + n1.y * n2.y;
      const denom = Math.max(0.25, 1 + dot);
      result.push({
        x: pts[i].x + ((n1.x + n2.x) / denom) * offset,
        y: pts[i].y + ((n1.y + n2.y) / denom) * offset
      });
    }
  }

  return result;
};

const selectBestCardinalFaces = (
  source: ContainerNode,
  target: ContainerNode,
  forcedSDir?: CardinalDirection
): { sDir: CardinalDirection; tDir: CardinalDirection } => {
  const srcPorts = forcedSDir
    ? getCardinalPorts(source).filter((p) => p.dir === forcedSDir)
    : getCardinalPorts(source);
  const tgtPorts = getCardinalPorts(target);

  const srcCenter = { x: source.x + CARD_W / 2, y: source.y + CARD_H / 2 };
  const tgtCenter = { x: target.x + CARD_W / 2, y: target.y + CARD_H / 2 };
  const dx = Math.abs(tgtCenter.x - srcCenter.x);
  const dy = Math.abs(tgtCenter.y - srcCenter.y);

  let bestScore = -Infinity;
  const defaultAutoSDir: CardinalDirection =
    dx >= dy ? (tgtCenter.x >= srcCenter.x ? 'E' : 'W') : (tgtCenter.y >= srcCenter.y ? 'S' : 'N');
  let bestFaces: { sDir: CardinalDirection; tDir: CardinalDirection } = {
    sDir: forcedSDir ?? defaultAutoSDir,
    tDir: dx >= dy ? (tgtCenter.x >= srcCenter.x ? 'W' : 'E') : (tgtCenter.y >= srcCenter.y ? 'N' : 'S')
  };

  srcPorts.forEach((s) => {
    tgtPorts.forEach((t) => {
      const sValid =
        (s.dir === 'E' && t.point.x > s.point.x + 6) ||
        (s.dir === 'W' && t.point.x < s.point.x - 6) ||
        (s.dir === 'S' && t.point.y > s.point.y + 6) ||
        (s.dir === 'N' && t.point.y < s.point.y - 6);

      const tValid =
        (t.dir === 'W' && s.point.x < t.point.x - 6) ||
        (t.dir === 'E' && s.point.x > t.point.x + 6) ||
        (t.dir === 'N' && s.point.y < t.point.y - 6) ||
        (t.dir === 'S' && s.point.y > t.point.y + 6);

      if (!sValid || !tValid) return;

      const sIsVert = s.dir === 'N' || s.dir === 'S';
      const tIsVert = t.dir === 'N' || t.dir === 'S';

      let score = 0;
      if (sIsVert !== tIsVert) {
        const bend: Point = sIsVert ? { x: s.point.x, y: t.point.y } : { x: t.point.x, y: s.point.y };

        if (!isPointInsideNode(bend, source) && !isPointInsideNode(bend, target)) {
          const legS = Math.abs(bend.x - s.point.x) + Math.abs(bend.y - s.point.y);
          const legT = Math.abs(t.point.x - bend.x) + Math.abs(t.point.y - bend.y);
          const fitsSocketLeads = legS >= MIN_SOCKET_LEAD && legT >= MIN_SOCKET_LEAD;
          const primaryMatch = sIsVert ? dy >= dx : dx >= dy;
          const manhattanDist = legS + legT;
          score = (fitsSocketLeads ? 200 : 40) + (primaryMatch ? 30 : 0) - manhattanDist * 0.05;
        }
      } else if (!sIsVert && !tIsVert) {
        if ((s.dir === 'E' && s.point.x < t.point.x) || (s.dir === 'W' && s.point.x > t.point.x)) {
          const manhattanDist = Math.abs(t.point.x - s.point.x) + Math.abs(t.point.y - s.point.y);
          score = 100 + (dx >= dy ? 20 : 0) - manhattanDist * 0.05;
        }
      } else {
        if ((s.dir === 'S' && s.point.y < t.point.y) || (s.dir === 'N' && s.point.y > t.point.y)) {
          const manhattanDist = Math.abs(t.point.x - s.point.x) + Math.abs(t.point.y - s.point.y);
          score = 100 + (dy >= dx ? 20 : 0) - manhattanDist * 0.05;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestFaces = { sDir: s.dir, tDir: t.dir };
      }
    });
  });

  if (forcedSDir && bestScore === -Infinity && srcPorts[0]) {
    const port = srcPorts[0].point;
    const outVec =
      forcedSDir === 'N'
        ? { x: 0, y: -32 }
        : forcedSDir === 'S'
        ? { x: 0, y: 32 }
        : forcedSDir === 'E'
        ? { x: 32, y: 0 }
        : { x: -32, y: 0 };
    const exitHint = { x: port.x + outVec.x, y: port.y + outVec.y };
    bestFaces = {
      sDir: forcedSDir,
      tDir: selectBestTargetFaceFromPoint(exitHint, target)
    };
  }

  return bestFaces;
};

const selectBestSourceFaceTowardPoint = (source: ContainerNode, pt: Point): CardinalDirection => {
  const srcCenter = { x: source.x + CARD_W / 2, y: source.y + CARD_H / 2 };
  const dx = pt.x - srcCenter.x;
  const dy = pt.y - srcCenter.y;
  const fallback: CardinalDirection =
    Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'E' : 'W') : (dy >= 0 ? 'S' : 'N');

  let bestScore = -Infinity;
  let bestDir: CardinalDirection = fallback;

  getCardinalPorts(source).forEach((s) => {
    const valid =
      (s.dir === 'E' && pt.x > s.point.x + 2) ||
      (s.dir === 'W' && pt.x < s.point.x - 2) ||
      (s.dir === 'S' && pt.y > s.point.y + 2) ||
      (s.dir === 'N' && pt.y < s.point.y - 2);
    if (!valid) return;

    const isVert = s.dir === 'N' || s.dir === 'S';
    const primaryMatch = isVert ? Math.abs(dy) >= Math.abs(dx) : Math.abs(dx) >= Math.abs(dy);
    const dist = Math.abs(pt.x - s.point.x) + Math.abs(pt.y - s.point.y);
    const score = 100 + (primaryMatch ? 30 : 0) - dist * 0.05;

    if (score > bestScore) {
      bestScore = score;
      bestDir = s.dir;
    }
  });

  return bestDir;
};

const selectBestTargetFaceFromPoint = (pt: Point, target: ContainerNode): CardinalDirection => {
  const tgtCenter = { x: target.x + CARD_W / 2, y: target.y + CARD_H / 2 };
  const dx = tgtCenter.x - pt.x;
  const dy = tgtCenter.y - pt.y;
  const fallback: CardinalDirection =
    Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'W' : 'E') : (dy >= 0 ? 'N' : 'S');

  let bestScore = -Infinity;
  let bestDir: CardinalDirection = fallback;

  getCardinalPorts(target).forEach((t) => {
    const valid =
      (t.dir === 'W' && pt.x < t.point.x - 2) ||
      (t.dir === 'E' && pt.x > t.point.x + 2) ||
      (t.dir === 'N' && pt.y < t.point.y - 2) ||
      (t.dir === 'S' && pt.y > t.point.y + 2);
    if (!valid) return;

    const isVert = t.dir === 'N' || t.dir === 'S';
    const primaryMatch = isVert ? Math.abs(dy) >= Math.abs(dx) : Math.abs(dx) >= Math.abs(dy);
    const dist = Math.abs(t.point.x - pt.x) + Math.abs(t.point.y - pt.y);
    const score = 100 + (primaryMatch ? 30 : 0) - dist * 0.05;

    if (score > bestScore) {
      bestScore = score;
      bestDir = t.dir;
    }
  });

  return bestDir;
};

const EDGE_MARGIN = 16;

const getPortWithLaneOffset = (node: ContainerNode, dir: CardinalDirection, offset: number): Point => {
  if (dir === 'N') {
    return { x: Math.max(node.x + EDGE_MARGIN, Math.min(node.x + CARD_W - EDGE_MARGIN, node.x + CARD_W / 2 + offset)), y: node.y };
  } else if (dir === 'S') {
    return { x: Math.max(node.x + EDGE_MARGIN, Math.min(node.x + CARD_W - EDGE_MARGIN, node.x + CARD_W / 2 + offset)), y: node.y + CARD_H };
  } else if (dir === 'E') {
    return { x: node.x + CARD_W, y: Math.max(node.y + EDGE_MARGIN, Math.min(node.y + CARD_H - EDGE_MARGIN, node.y + CARD_H / 2 + offset)) };
  } else {
    return { x: node.x, y: Math.max(node.y + EDGE_MARGIN, Math.min(node.y + CARD_H - EDGE_MARGIN, node.y + CARD_H / 2 + offset)) };
  }
};

const toConnDirFlag = (avoid: Avoid, dir: CardinalDirection): ConnDirFlags => {
  switch (dir) {
    case 'N':
      return avoid.ConnDirFlag.ConnDirUp;
    case 'S':
      return avoid.ConnDirFlag.ConnDirDown;
    case 'E':
      return avoid.ConnDirFlag.ConnDirRight;
    case 'W':
      return avoid.ConnDirFlag.ConnDirLeft;
  }
};

const buildFallbackPoints = (
  startPort: Point,
  endPort: Point,
  sDir: CardinalDirection,
  tDir: CardinalDirection
): Point[] => {
  const sIsVert = sDir === 'N' || sDir === 'S';
  const tIsVert = tDir === 'N' || tDir === 'S';

  let rawPoints: Point[];
  if (sIsVert !== tIsVert) {
    const bend = sIsVert ? { x: startPort.x, y: endPort.y } : { x: endPort.x, y: startPort.y };
    rawPoints = [startPort, bend, endPort];
  } else if (!sIsVert && !tIsVert) {
    const midX = (startPort.x + endPort.x) / 2;
    rawPoints = [startPort, { x: midX, y: startPort.y }, { x: midX, y: endPort.y }, endPort];
  } else {
    const midY = (startPort.y + endPort.y) / 2;
    rawPoints = [startPort, { x: startPort.x, y: midY }, { x: endPort.x, y: midY }, endPort];
  }

  return simplifyCollinear(rawPoints);
};

const clipSegmentToExpandedRect = (
  p1: Point,
  p2: Point,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number
): boolean => {
  let t0 = 0;
  let t1 = 1;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-9) return q >= 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  return (
    clip(-dx, p1.x - minX) &&
    clip(dx, maxX - p1.x) &&
    clip(-dy, p1.y - minY) &&
    clip(dy, maxY - p1.y) &&
    t0 <= t1
  );
};

const subtractIntervalFromList = (
  intervals: [number, number][],
  cutStart: number,
  cutEnd: number
): [number, number][] => {
  if (cutEnd <= cutStart) return intervals;
  const next: [number, number][] = [];
  for (const [a, b] of intervals) {
    if (cutEnd <= a || cutStart >= b) {
      next.push([a, b]);
    } else {
      if (cutStart > a + 1e-4) next.push([a, cutStart]);
      if (cutEnd < b - 1e-4) next.push([cutEnd, b]);
    }
  }
  return next;
};

const subtractOverlappingSegments = (
  baseIntervals: [number, number][],
  segP1: Point,
  segP2: Point,
  blockers: { p1: Point; p2: Point; tol: number }[]
): [number, number][] => {
  const dx = segP2.x - segP1.x;
  const dy = segP2.y - segP1.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) return [];

  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;

  let result = baseIntervals.slice();
  const padT = Math.min(0.08, 4 / len);

  for (const blk of blockers) {
    if (result.length === 0) break;
    const bx = blk.p2.x - blk.p1.x;
    const by = blk.p2.y - blk.p1.y;
    const bLen = Math.hypot(bx, by);
    if (bLen < 1) continue;

    const bux = bx / bLen;
    const buy = by / bLen;
    // Must be parallel / collinear (within ~25 deg)
    if (Math.abs(ux * bux + uy * buy) < 0.9) continue;

    const bMidX = (blk.p1.x + blk.p2.x) / 2;
    const bMidY = (blk.p1.y + blk.p2.y) / 2;
    const perpDist = Math.abs((bMidX - segP1.x) * nx + (bMidY - segP1.y) * ny);
    if (perpDist > blk.tol) continue;

    const t1 = ((blk.p1.x - segP1.x) * ux + (blk.p1.y - segP1.y) * uy) / len;
    const t2 = ((blk.p2.x - segP1.x) * ux + (blk.p2.y - segP1.y) * uy) / len;
    const lo = Math.max(0, Math.min(t1, t2) - padT);
    const hi = Math.min(1, Math.max(t1, t2) + padT);
    if (hi > lo + 1e-4) {
      result = subtractIntervalFromList(result, lo, hi);
    }
  }

  return result;
};

const computeTopologyKey = (
  nodesList: ContainerNode[],
  linksList: TransferLink[],
  corridorsList: RouteCorridor[]
): string => {
  const nodeKey = nodesList.map((n) => `${n.id}:${n.x},${n.y}:${n.outputEdge || ''}`).join('|');
  const linkKey = linksList
    .map((l) => `${l.id}:${l.sourceId}->${l.targetId}@${getLinkCorridorIds(l).join(',')}`)
    .join('|');
  const corridorKey = corridorsList
    .map((c) => `${c.id}:${c.laneSpacing}:${c.waypoints.map((p) => `${p.x},${p.y}`).join(';')}`)
    .join('|');
  return `${avoidInstance ? '1' : '0'}#${nodeKey}#${linkKey}#${corridorKey}`;
};

export interface OrderedCorridorStep {
  corridor: RouteCorridor;
  isReversed: boolean;
}

const manhattanDist = (a: Point, b: Point): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

export const resolveOrderedCorridorChain = (
  source: ContainerNode,
  target: ContainerNode,
  corridors: RouteCorridor[]
): OrderedCorridorStep[] => {
  const valid = corridors.filter((c) => c.waypoints && c.waypoints.length >= 2);
  if (valid.length === 0) return [];

  const srcCenter = { x: source.x + CARD_W / 2, y: source.y + CARD_H / 2 };
  const tgtCenter = { x: target.x + CARD_W / 2, y: target.y + CARD_H / 2 };

  if (valid.length === 1) {
    const c = valid[0];
    const baseStart = c.waypoints[0];
    const baseEnd = c.waypoints[c.waypoints.length - 1];
    const forwardCost = manhattanDist(srcCenter, baseStart) + manhattanDist(baseEnd, tgtCenter);
    const reverseCost = manhattanDist(srcCenter, baseEnd) + manhattanDist(baseStart, tgtCenter);
    return [{ corridor: c, isReversed: reverseCost < forwardCost }];
  }

  // Exact shortest-chain search over permutations + orientations for typical chain lengths (<= 6)
  if (valid.length <= 6) {
    let bestCost = Infinity;
    let bestChain: OrderedCorridorStep[] = [];
    const used = new Array<boolean>(valid.length).fill(false);
    const current: OrderedCorridorStep[] = [];

    const dfs = (curPt: Point, accCost: number) => {
      if (accCost >= bestCost) return;
      if (current.length === valid.length) {
        const total = accCost + manhattanDist(curPt, tgtCenter);
        if (total < bestCost) {
          bestCost = total;
          bestChain = current.slice();
        }
        return;
      }

      for (let i = 0; i < valid.length; i++) {
        if (used[i]) continue;
        const c = valid[i];
        const wps = c.waypoints;
        const pStart = wps[0];
        const pEnd = wps[wps.length - 1];

        used[i] = true;

        // Forward orientation: enter pStart, exit pEnd
        current.push({ corridor: c, isReversed: false });
        dfs(pEnd, accCost + manhattanDist(curPt, pStart));
        current.pop();

        // Reverse orientation: enter pEnd, exit pStart
        current.push({ corridor: c, isReversed: true });
        dfs(pStart, accCost + manhattanDist(curPt, pEnd));
        current.pop();

        used[i] = false;
      }
    };

    dfs(srcCenter, 0);
    return bestChain;
  }

  // Greedy nearest-next fallback if a transfer is assigned to > 6 corridors
  const remaining = valid.slice();
  const chain: OrderedCorridorStep[] = [];
  let curPt = srcCenter;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestRev = false;
    let bestScore = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const pStart = c.waypoints[0];
      const pEnd = c.waypoints[c.waypoints.length - 1];
      const fwdScore = manhattanDist(curPt, pStart) + manhattanDist(pEnd, tgtCenter) * 0.15;
      if (fwdScore < bestScore) {
        bestScore = fwdScore;
        bestIdx = i;
        bestRev = false;
      }
      const revScore = manhattanDist(curPt, pEnd) + manhattanDist(pStart, tgtCenter) * 0.15;
      if (revScore < bestScore) {
        bestScore = revScore;
        bestIdx = i;
        bestRev = true;
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0];
    chain.push({ corridor: chosen, isReversed: bestRev });
    curPt = bestRev ? chosen.waypoints[0] : chosen.waypoints[chosen.waypoints.length - 1];
  }

  return chain;
};

export const computeAllLinkRoutes = (
  nodesList: ContainerNode[],
  linksList: TransferLink[],
  corridorsList: RouteCorridor[] = []
): Map<string, ComputedRoute> => {
  const topologyKey = computeTopologyKey(nodesList, linksList, corridorsList);
  if (cachedRoutes && cachedTopologyKey === topologyKey) {
    return cachedRoutes;
  }

  const resultMap = new Map<string, ComputedRoute>();

  const nodeMap = new Map<string, ContainerNode>();
  nodesList.forEach((n) => nodeMap.set(n.id, n));

  const corridorMap = new Map<string, RouteCorridor>();
  corridorsList.forEach((c) => {
    if (c.waypoints && c.waypoints.length >= 2) {
      corridorMap.set(c.id, c);
    }
  });

  // 1. Pre-compute auto-ordered multi-route chains & tight parallel lane polylines per corridor
  interface CorridorChainStep {
    corridor: RouteCorridor;
    isReversed: boolean;
    lanePts: Point[];
    prevApproachPt: Point;
    nextDeparturePt: Point;
  }

  const corridorChainsMap = new Map<string, CorridorChainStep[]>();
  const linksByCorridor = new Map<
    string,
    {
      link: TransferLink;
      stepIdx: number;
      source: ContainerNode;
      target: ContainerNode;
      isReversed: boolean;
      prevApproachPt: Point;
      nextDeparturePt: Point;
      sortProjection: number;
    }[]
  >();

  linksList.forEach((link) => {
    const source = nodeMap.get(link.sourceId);
    const target = nodeMap.get(link.targetId);
    if (!source || !target) return;

    const assignedCorridors = getLinkCorridorIds(link)
      .map((cid) => corridorMap.get(cid))
      .filter((c): c is RouteCorridor => Boolean(c));
    if (assignedCorridors.length === 0) return;

    const orderedChain = resolveOrderedCorridorChain(source, target, assignedCorridors);
    if (orderedChain.length === 0) return;

    const srcCenter = { x: source.x + CARD_W / 2, y: source.y + CARD_H / 2 };
    const tgtCenter = { x: target.x + CARD_W / 2, y: target.y + CARD_H / 2 };

    corridorChainsMap.set(
      link.id,
      orderedChain.map((s) => ({
        corridor: s.corridor,
        isReversed: s.isReversed,
        lanePts: s.isReversed ? s.corridor.waypoints.slice().reverse() : s.corridor.waypoints.map((p) => ({ ...p })),
        prevApproachPt: srcCenter,
        nextDeparturePt: tgtCenter
      }))
    );

    orderedChain.forEach((step, stepIdx) => {
      const corridor = step.corridor;
      const wps = corridor.waypoints;
      const baseStart = wps[0];
      const baseEnd = wps[wps.length - 1];

      const prevStep = stepIdx > 0 ? orderedChain[stepIdx - 1] : null;
      const nextStep = stepIdx < orderedChain.length - 1 ? orderedChain[stepIdx + 1] : null;

      const prevApproachPt = prevStep
        ? prevStep.isReversed
          ? prevStep.corridor.waypoints[0]
          : prevStep.corridor.waypoints[prevStep.corridor.waypoints.length - 1]
        : srcCenter;

      const nextDeparturePt = nextStep
        ? nextStep.isReversed
          ? nextStep.corridor.waypoints[nextStep.corridor.waypoints.length - 1]
          : nextStep.corridor.waypoints[0]
        : tgtCenter;

      const chainArr = corridorChainsMap.get(link.id)!;
      chainArr[stepIdx].prevApproachPt = prevApproachPt;
      chainArr[stepIdx].nextDeparturePt = nextDeparturePt;

      if (!linksByCorridor.has(corridor.id)) linksByCorridor.set(corridor.id, []);
      linksByCorridor.get(corridor.id)!.push({
        link,
        stepIdx,
        source,
        target,
        isReversed: step.isReversed,
        prevApproachPt,
        nextDeparturePt,
        sortProjection: 0
      });
    });
  });

  const computeSortProjection = (
    corridor: RouteCorridor,
    isReversed: boolean,
    prevApproachPt: Point,
    nextDeparturePt: Point
  ): number => {
    const wps = corridor.waypoints;
    const baseStart = wps[0];
    const baseEnd = wps[wps.length - 1];
    const nStart = getSegmentUnitNormal(wps[0], wps[1]);
    const nEnd = getSegmentUnitNormal(wps[wps.length - 2], wps[wps.length - 1]);
    const startSideCenter = isReversed ? nextDeparturePt : prevApproachPt;
    const endSideCenter = isReversed ? prevApproachPt : nextDeparturePt;

    const dxS = wps[1].x - baseStart.x;
    const dyS = wps[1].y - baseStart.y;
    const lenS = Math.hypot(dxS, dyS) || 1;
    const outTangentStart = { x: -dxS / lenS, y: -dyS / lenS };

    const dxE = baseEnd.x - wps[wps.length - 2].x;
    const dyE = baseEnd.y - wps[wps.length - 2].y;
    const lenE = Math.hypot(dxE, dyE) || 1;
    const outTangentEnd = { x: dxE / lenE, y: dyE / lenE };

    const perpStart = (startSideCenter.x - baseStart.x) * nStart.x + (startSideCenter.y - baseStart.y) * nStart.y;
    const outDotStart =
      (startSideCenter.x - baseStart.x) * outTangentStart.x + (startSideCenter.y - baseStart.y) * outTangentStart.y;
    const angleStart = Math.atan2(perpStart, outDotStart);

    const perpEnd = (endSideCenter.x - baseEnd.x) * nEnd.x + (endSideCenter.y - baseEnd.y) * nEnd.y;
    const outDotEnd =
      (endSideCenter.x - baseEnd.x) * outTangentEnd.x + (endSideCenter.y - baseEnd.y) * outTangentEnd.y;
    const angleEnd = Math.atan2(perpEnd, outDotEnd);

    return angleStart + angleEnd;
  };

  const sortAndAssignCorridorLanes = () => {
    linksByCorridor.forEach((group, corridorId) => {
      const corridor = corridorMap.get(corridorId);
      if (!corridor) return;

      group.forEach((entry) => {
        entry.sortProjection = computeSortProjection(
          corridor,
          entry.isReversed,
          entry.prevApproachPt,
          entry.nextDeparturePt
        );
      });

      group.sort(
        (a, b) =>
          a.sortProjection - b.sortProjection ||
          a.link.id.localeCompare(b.link.id) ||
          a.stepIdx - b.stepIdx
      );
      const spacing = Math.max(2, corridor.laneSpacing || 5);

      group.forEach((entry, idx) => {
        const laneOffset = (idx - (group.length - 1) / 2) * spacing;
        const offsetPts = offsetPolyline(corridor.waypoints, laneOffset);
        const lanePts = entry.isReversed ? offsetPts.slice().reverse() : offsetPts;
        const chainArr = corridorChainsMap.get(entry.link.id);
        if (chainArr && chainArr[entry.stepIdx]) {
          chainArr[entry.stepIdx].lanePts = lanePts;
        }
      });
    });
  };

  // Multi-pass planar sort: Pass 1 places initial lanes, Pass 2 & 3 refine chained bridges using exact neighbor lane endpoints
  sortAndAssignCorridorLanes();
  for (let pass = 0; pass < 2; pass++) {
    let anyMultiStep = false;
    corridorChainsMap.forEach((chainArr, linkId) => {
      if (chainArr.length <= 1) return;
      anyMultiStep = true;
      chainArr.forEach((step, stepIdx) => {
        if (stepIdx > 0) {
          const prevLane = chainArr[stepIdx - 1].lanePts;
          step.prevApproachPt = prevLane[prevLane.length - 1];
        }
        if (stepIdx < chainArr.length - 1) {
          const nextLane = chainArr[stepIdx + 1].lanePts;
          step.nextDeparturePt = nextLane[0];
        }
      });
      // Sync updated approach/departure points into linksByCorridor entries
      chainArr.forEach((step, stepIdx) => {
        const group = linksByCorridor.get(step.corridor.id);
        const entry = group?.find((e) => e.link.id === linkId && e.stepIdx === stepIdx);
        if (entry) {
          entry.prevApproachPt = step.prevApproachPt;
          entry.nextDeparturePt = step.nextDeparturePt;
        }
      });
    });
    if (!anyMultiStep) break;
    sortAndAssignCorridorLanes();
  }

  const projectPointToSegmentT = (pt: Point, a: Point, b: Point): number => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-4) return 0;
    return ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq;
  };

  const getAlongSegmentPoint = (pt: Point, a: Point, b: Point, tMin: number, tMax: number): { point: Point; t: number } | null => {
    const rawT = projectPointToSegmentT(pt, a, b);
    if (rawT <= tMin || rawT >= tMax) return null;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen < 20) return null;
    const candidate = {
      x: a.x + (b.x - a.x) * rawT,
      y: a.y + (b.y - a.y) * rawT
    };
    const hitsNode = nodesList.some((n) => isPointInsideNode(candidate, n, -6));
    if (hitsNode) return null;
    return { point: candidate, t: rawT };
  };

  // 2. Select container faces (aimed toward first corridor entry and last corridor exit if bunched, or directly between containers)
  interface LinkWithFaces {
    link: TransferLink;
    source: ContainerNode;
    target: ContainerNode;
    sDir: CardinalDirection;
    tDir: CardinalDirection;
    corridorChain?: CorridorChainStep[];
  }

  const validLinks: LinkWithFaces[] = [];
  linksList.forEach((link) => {
    const source = nodeMap.get(link.sourceId);
    const target = nodeMap.get(link.targetId);
    if (!source || !target) return;

    const corridorChain = corridorChainsMap.get(link.id);
    if (corridorChain && corridorChain.length > 0) {
      const firstLane = corridorChain[0].lanePts;
      const lastLane = corridorChain[corridorChain.length - 1].lanePts;
      const srcCenter = { x: source.x + CARD_W / 2, y: source.y + CARD_H / 2 };
      const tgtCenter = { x: target.x + CARD_W / 2, y: target.y + CARD_H / 2 };

      const kFirst = firstLane.length;
      const kLast = lastLane.length;
      const srcAlong = kFirst >= 2 ? getAlongSegmentPoint(srcCenter, firstLane[0], firstLane[1], 0.02, 0.9) : null;
      const tgtAlong = kLast >= 2 ? getAlongSegmentPoint(tgtCenter, lastLane[kLast - 2], lastLane[kLast - 1], 0.1, 0.98) : null;

      let entryHint = firstLane[0];
      let exitHint = lastLane[kLast - 1];
      if (corridorChain.length === 1 && srcAlong && tgtAlong) {
        if (kFirst > 2 || srcAlong.t < tgtAlong.t - 0.05) {
          entryHint = srcAlong.point;
          exitHint = tgtAlong.point;
        }
      } else {
        if (srcAlong) entryHint = srcAlong.point;
        if (tgtAlong) exitHint = tgtAlong.point;
      }

      const sDir = source.outputEdge ?? selectBestSourceFaceTowardPoint(source, entryHint);
      const tDir = selectBestTargetFaceFromPoint(exitHint, target);
      validLinks.push({ link, source, target, sDir, tDir, corridorChain });
    } else {
      const { sDir, tDir } = selectBestCardinalFaces(source, target, source.outputEdge);
      validLinks.push({ link, source, target, sDir, tDir });
    }
  });

  // 3. Pre-compute staggered fan-in/fan-out anchor points at each corridor mouth (and alongside on/off-ramps)
  const STAGGER_STEP = 12;
  const entryAnchorMap = new Map<string, Point>();
  const exitAnchorMap = new Map<string, Point>();
  const entryAlongsideSet = new Set<string>();
  const exitAlongsideSet = new Set<string>();

  const makeStepKey = (linkId: string, stepIdx: number): string => `${linkId}::${stepIdx}`;

  interface MouthAttachment {
    stepKey: string;
    role: 'entry' | 'exit';
    mouthPt: Point;
    lanePerp: number;
    portPerp: number;
    remoteAlongDist: number;
  }

  const computeSafeStaggeredAnchor = (mouthPt: Point, outTangent: Point, rawStagger: number): Point => {
    if (rawStagger <= 0.5) return mouthPt;
    for (let d = rawStagger; d >= 0; d -= 4) {
      const candidate = {
        x: mouthPt.x + outTangent.x * d,
        y: mouthPt.y + outTangent.y * d
      };
      const hitsNode = nodesList.some((n) => isPointInsideNode(candidate, n, -6));
      if (!hitsNode) return candidate;
    }
    return mouthPt;
  };

  const cardinalToVec = (dir: CardinalDirection): Point => {
    switch (dir) {
      case 'N':
        return { x: 0, y: -1 };
      case 'S':
        return { x: 0, y: 1 };
      case 'E':
        return { x: 1, y: 0 };
      case 'W':
        return { x: -1, y: 0 };
    }
  };

  const getCorridorMouthVectors = (corridor: RouteCorridor, isMouthStart: boolean): { outTangent: Point; sideNorm: Point } => {
    const wps = corridor.waypoints;
    if (isMouthStart) {
      const dx = wps[1].x - wps[0].x;
      const dy = wps[1].y - wps[0].y;
      const len = Math.hypot(dx, dy) || 1;
      return {
        outTangent: { x: -dx / len, y: -dy / len },
        sideNorm: getSegmentUnitNormal(wps[0], wps[1])
      };
    } else {
      const last = wps.length - 1;
      const dx = wps[last].x - wps[last - 1].x;
      const dy = wps[last].y - wps[last - 1].y;
      const len = Math.hypot(dx, dy) || 1;
      return {
        outTangent: { x: dx / len, y: dy / len },
        sideNorm: getSegmentUnitNormal(wps[last - 1], wps[last])
      };
    }
  };

  const needsMouthStagger = (
    mouthPt: Point,
    mouthOutTangent: Point,
    sideNorm: Point,
    remotePt: Point,
    remoteOutVec: Point
  ): boolean => {
    const forwardMouth =
      (remotePt.x - mouthPt.x) * mouthOutTangent.x + (remotePt.y - mouthPt.y) * mouthOutTangent.y;
    const forwardRemote =
      (mouthPt.x - remotePt.x) * remoteOutVec.x + (mouthPt.y - remotePt.y) * remoteOutVec.y;
    const dotAxes = mouthOutTangent.x * remoteOutVec.x + mouthOutTangent.y * remoteOutVec.y;

    // Perpendicular L-corners or straight aligned runs form clean nested bends without artificial mouth stubs
    const isCleanLTurn = Math.abs(dotAxes) < 0.35 && forwardMouth > 4 && forwardRemote > 4;
    if (isCleanLTurn) return false;

    const perpOffset = Math.abs(
      (remotePt.x - mouthPt.x) * sideNorm.x + (remotePt.y - mouthPt.y) * sideNorm.y
    );
    const isStraightAligned = dotAxes < -0.75 && forwardMouth > 4 && forwardRemote > 4 && perpOffset < 2;
    if (isStraightAligned) return false;

    return true;
  };

  corridorMap.forEach((corridor) => {
    const wps = corridor.waypoints;
    if (wps.length < 2) return;

    const baseStart = wps[0];
    const baseEnd = wps[wps.length - 1];

    const { outTangent: outTangentStart, sideNorm: sideNormStart } = getCorridorMouthVectors(corridor, true);
    const { outTangent: outTangentEnd, sideNorm: sideNormEnd } = getCorridorMouthVectors(corridor, false);

    const startMouthAttachments: MouthAttachment[] = [];
    const endMouthAttachments: MouthAttachment[] = [];

    validLinks.forEach((item) => {
      const chain = item.corridorChain;
      if (!chain || chain.length === 0) return;

      const startPortCenter = getPortWithLaneOffset(item.source, item.sDir, 0);
      const endPortCenter = getPortWithLaneOffset(item.target, item.tDir, 0);

      chain.forEach((assign, stepIdx) => {
        if (assign.corridor.id !== corridor.id) return;

        const key = makeStepKey(item.link.id, stepIdx);
        const lanePts = assign.lanePts;
        const k = lanePts.length;
        const entryPt = lanePts[0];
        const exitPt = lanePts[k - 1];

        const isFirstStep = stepIdx === 0;
        const isLastStep = stepIdx === chain.length - 1;
        const approachPt = isFirstStep ? startPortCenter : assign.prevApproachPt;
        const departurePt = isLastStep ? endPortCenter : assign.nextDeparturePt;

        const prevStep = !isFirstStep ? chain[stepIdx - 1] : null;
        const nextStep = !isLastStep ? chain[stepIdx + 1] : null;

        const approachOutVec = prevStep
          ? getCorridorMouthVectors(prevStep.corridor, prevStep.isReversed).outTangent
          : cardinalToVec(item.sDir);
        const departureOutVec = nextStep
          ? getCorridorMouthVectors(nextStep.corridor, !nextStep.isReversed).outTangent
          : cardinalToVec(item.tDir);

        const srcAlong = isFirstStep && k >= 2 ? getAlongSegmentPoint(startPortCenter, lanePts[0], lanePts[1], 0.02, 0.9) : null;
        const tgtAlong = isLastStep && k >= 2 ? getAlongSegmentPoint(endPortCenter, lanePts[k - 2], lanePts[k - 1], 0.1, 0.98) : null;

        let useSrcAlong = srcAlong !== null;
        let useTgtAlong = tgtAlong !== null;
        if (chain.length === 1 && srcAlong && tgtAlong && k === 2 && srcAlong.t >= tgtAlong.t - 0.05) {
          useSrcAlong = false;
          useTgtAlong = false;
        }

        if (useSrcAlong && srcAlong) {
          entryAlongsideSet.add(key);
          entryAnchorMap.set(key, srcAlong.point);
        } else {
          const entryOut = !assign.isReversed ? outTangentStart : outTangentEnd;
          const entrySideNorm = !assign.isReversed ? sideNormStart : sideNormEnd;
          if (!needsMouthStagger(entryPt, entryOut, entrySideNorm, approachPt, approachOutVec)) {
            entryAnchorMap.set(key, entryPt);
          } else {
            const alongDist =
              (approachPt.x - entryPt.x) * entryOut.x + (approachPt.y - entryPt.y) * entryOut.y;
            const maxClearStagger =
              isFirstStep && alongDist > 0 ? Math.max(0, alongDist - MIN_SOCKET_LEAD - 6) : Infinity;
            const mouthAtt: MouthAttachment = !assign.isReversed
              ? {
                  stepKey: key,
                  role: 'entry',
                  mouthPt: entryPt,
                  lanePerp: (entryPt.x - baseStart.x) * sideNormStart.x + (entryPt.y - baseStart.y) * sideNormStart.y,
                  portPerp: (approachPt.x - baseStart.x) * sideNormStart.x + (approachPt.y - baseStart.y) * sideNormStart.y,
                  remoteAlongDist: maxClearStagger
                }
              : {
                  stepKey: key,
                  role: 'entry',
                  mouthPt: entryPt,
                  lanePerp: (entryPt.x - baseEnd.x) * sideNormEnd.x + (entryPt.y - baseEnd.y) * sideNormEnd.y,
                  portPerp: (approachPt.x - baseEnd.x) * sideNormEnd.x + (approachPt.y - baseEnd.y) * sideNormEnd.y,
                  remoteAlongDist: maxClearStagger
                };
            if (!assign.isReversed) startMouthAttachments.push(mouthAtt);
            else endMouthAttachments.push(mouthAtt);
          }
        }

        if (useTgtAlong && tgtAlong) {
          exitAlongsideSet.add(key);
          exitAnchorMap.set(key, tgtAlong.point);
        } else {
          const exitOut = !assign.isReversed ? outTangentEnd : outTangentStart;
          const exitSideNorm = !assign.isReversed ? sideNormEnd : sideNormStart;
          if (!needsMouthStagger(exitPt, exitOut, exitSideNorm, departurePt, departureOutVec)) {
            exitAnchorMap.set(key, exitPt);
          } else {
            const alongDist =
              (departurePt.x - exitPt.x) * exitOut.x + (departurePt.y - exitPt.y) * exitOut.y;
            const maxClearStagger =
              isLastStep && alongDist > 0 ? Math.max(0, alongDist - MIN_SOCKET_LEAD - 6) : Infinity;
            const mouthAtt: MouthAttachment = !assign.isReversed
              ? {
                  stepKey: key,
                  role: 'exit',
                  mouthPt: exitPt,
                  lanePerp: (exitPt.x - baseEnd.x) * sideNormEnd.x + (exitPt.y - baseEnd.y) * sideNormEnd.y,
                  portPerp: (departurePt.x - baseEnd.x) * sideNormEnd.x + (departurePt.y - baseEnd.y) * sideNormEnd.y,
                  remoteAlongDist: maxClearStagger
                }
              : {
                  stepKey: key,
                  role: 'exit',
                  mouthPt: exitPt,
                  lanePerp: (exitPt.x - baseStart.x) * sideNormStart.x + (exitPt.y - baseStart.y) * sideNormStart.y,
                  portPerp: (departurePt.x - baseStart.x) * sideNormStart.x + (departurePt.y - baseStart.y) * sideNormStart.y,
                  remoteAlongDist: maxClearStagger
                };
            if (!assign.isReversed) endMouthAttachments.push(mouthAtt);
            else startMouthAttachments.push(mouthAtt);
          }
        }
      });
    });

    const assignMouthStaggers = (attachments: MouthAttachment[], outTangent: Point) => {
      const posGroup = attachments.filter((a) => a.portPerp >= 0);
      const negGroup = attachments.filter((a) => a.portPerp < 0);

      posGroup.sort((a, b) => b.lanePerp - a.lanePerp || a.stepKey.localeCompare(b.stepKey));
      negGroup.sort((a, b) => a.lanePerp - b.lanePerp || a.stepKey.localeCompare(b.stepKey));

      [posGroup, negGroup].forEach((grp) => {
        grp.forEach((att, idx) => {
          const cappedStagger = Math.min(idx * STAGGER_STEP, att.remoteAlongDist);
          const anchor = computeSafeStaggeredAnchor(att.mouthPt, outTangent, cappedStagger);
          if (att.role === 'entry') entryAnchorMap.set(att.stepKey, anchor);
          else exitAnchorMap.set(att.stepKey, anchor);
        });
      });
    };

    assignMouthStaggers(startMouthAttachments, outTangentStart);
    assignMouthStaggers(endMouthAttachments, outTangentEnd);
  });

  // 3.5 Unified multi-socket lane offsets per container face (N, E, S, W) across both outgoing and incoming links
  interface FaceAttachment {
    linkId: string;
    role: 'source' | 'target';
    dir: CardinalDirection;
    node: ContainerNode;
    aimPoint: Point;
  }

  const srcLaneOffsets = new Map<string, number>();
  const tgtLaneOffsets = new Map<string, number>();
  const srcLeadDists = new Map<string, number>();
  const tgtLeadDists = new Map<string, number>();
  const faceGroups = new Map<string, FaceAttachment[]>();

  const addAttachment = (nodeId: string, att: FaceAttachment) => {
    const key = `${nodeId}_${att.dir}`;
    if (!faceGroups.has(key)) faceGroups.set(key, []);
    faceGroups.get(key)!.push(att);
  };

  validLinks.forEach((item) => {
    const chain = item.corridorChain;
    const hasChain = Boolean(chain && chain.length > 0);
    const firstLane = hasChain ? chain![0].lanePts : undefined;
    const lastLane = hasChain ? chain![chain!.length - 1].lanePts : undefined;
    const firstKey = makeStepKey(item.link.id, 0);
    const lastKey = makeStepKey(item.link.id, (chain?.length || 1) - 1);

    const srcAim = firstLane
      ? entryAlongsideSet.has(firstKey) && firstLane.length >= 2
        ? firstLane[1]
        : (entryAnchorMap.get(firstKey) ?? firstLane[0])
      : { x: item.target.x + CARD_W / 2, y: item.target.y + CARD_H / 2 };
    const tgtAim = lastLane
      ? exitAlongsideSet.has(lastKey) && lastLane.length >= 2
        ? lastLane[lastLane.length - 2]
        : (exitAnchorMap.get(lastKey) ?? lastLane[lastLane.length - 1])
      : { x: item.source.x + CARD_W / 2, y: item.source.y + CARD_H / 2 };

    addAttachment(item.source.id, {
      linkId: item.link.id,
      role: 'source',
      dir: item.sDir,
      node: item.source,
      aimPoint: srcAim
    });
    addAttachment(item.target.id, {
      linkId: item.link.id,
      role: 'target',
      dir: item.tDir,
      node: item.target,
      aimPoint: tgtAim
    });
  });

  const getFaceOutwardTangentAngle = (node: ContainerNode, dir: CardinalDirection, aimPt: Point): number => {
    const faceCenter = getPortWithLaneOffset(node, dir, 0);
    const vx = aimPt.x - faceCenter.x;
    const vy = aimPt.y - faceCenter.y;
    switch (dir) {
      case 'N':
        return Math.atan2(vx, -vy);
      case 'S':
        return Math.atan2(vx, vy);
      case 'E':
        return Math.atan2(vy, vx);
      case 'W':
        return Math.atan2(vy, -vx);
    }
  };

  faceGroups.forEach((group) => {
    const setLeadDist = (att: FaceAttachment, dist: number) => {
      if (att.role === 'source') srcLeadDists.set(att.linkId, dist);
      else tgtLeadDists.set(att.linkId, dist);
    };

    if (group.length === 1) {
      const only = group[0];
      if (only.role === 'source') srcLaneOffsets.set(only.linkId, 0);
      else tgtLaneOffsets.set(only.linkId, 0);
      setLeadDist(only, MIN_SOCKET_LEAD);
      return;
    }

    const dir = group[0].dir;
    const node = group[0].node;
    group.sort((a, b) => {
      const angleA = getFaceOutwardTangentAngle(node, dir, a.aimPoint);
      const angleB = getFaceOutwardTangentAngle(node, dir, b.aimPoint);
      return (
        angleA - angleB ||
        a.role.localeCompare(b.role) ||
        a.linkId.localeCompare(b.linkId)
      );
    });

    const usableSpan = (dir === 'N' || dir === 'S' ? CARD_W : CARD_H) - EDGE_MARGIN * 2;
    const step = Math.min(LANE_SPACING, usableSpan / (group.length - 1));

    group.forEach((att, idx) => {
      const offset = (idx - (group.length - 1) / 2) * step;
      if (att.role === 'source') srcLaneOffsets.set(att.linkId, offset);
      else tgtLaneOffsets.set(att.linkId, offset);
    });

    // Nest minimum socket lead lengths across all links sharing an edge so turning pipes never collide
    const negTurners: FaceAttachment[] = [];
    const posTurners: FaceAttachment[] = [];
    group.forEach((att) => {
      const angle = getFaceOutwardTangentAngle(node, dir, att.aimPoint);
      if (angle < -0.05) {
        negTurners.push(att);
      } else if (angle > 0.05) {
        posTurners.push(att);
      } else {
        setLeadDist(att, MIN_SOCKET_LEAD);
      }
    });
    negTurners.forEach((att, i) => {
      setLeadDist(att, MIN_SOCKET_LEAD + i * LANE_SPACING);
    });
    posTurners.forEach((att, i) => {
      setLeadDist(att, MIN_SOCKET_LEAD + (posTurners.length - 1 - i) * LANE_SPACING);
    });
  });

  const oppositeCardinal = (dir: CardinalDirection): CardinalDirection => {
    switch (dir) {
      case 'N':
        return 'S';
      case 'S':
        return 'N';
      case 'E':
        return 'W';
      case 'W':
        return 'E';
    }
  };

  const shouldSkipDirectLeadsForStraightGap = (
    startPort: Point,
    endPort: Point,
    sDir: CardinalDirection,
    tDir: CardinalDirection,
    minCombinedLead: number
  ): boolean => {
    if (oppositeCardinal(sDir) !== tDir) return false;
    const sVec = cardinalToVec(sDir);
    const forward = (endPort.x - startPort.x) * sVec.x + (endPort.y - startPort.y) * sVec.y;
    const perp = Math.abs((endPort.x - startPort.x) * -sVec.y + (endPort.y - startPort.y) * sVec.x);
    return perp < 1 && forward > 0 && forward <= minCombinedLead + 4;
  };

  // 3.6 Cross-container aligned socket track allocation so aligned containers never overlay turn segments
  {
    const getOutCoord = (p: Point, d: CardinalDirection): number =>
      d === 'E' ? p.x : d === 'W' ? -p.x : d === 'S' ? p.y : -p.y;
    const getPerpCoord = (p: Point, d: CardinalDirection): number =>
      d === 'E' || d === 'W' ? p.y : p.x;

    interface SocketTrackRecord {
      idx: number;
      key: string;
      linkId: string;
      role: 'source' | 'target';
      dir: CardinalDirection;
      portPerp: number;
      aimPerp: number;
      deltaPerp: number;
      minPerp: number;
      maxPerp: number;
      outStart: number;
      leadDist: number;
    }

    const recordsByDir = new Map<CardinalDirection, SocketTrackRecord[]>();
    const addTrackRecord = (rec: Omit<SocketTrackRecord, 'idx'>) => {
      if (Math.abs(rec.deltaPerp) < 2) return;
      if (!recordsByDir.has(rec.dir)) recordsByDir.set(rec.dir, []);
      const arr = recordsByDir.get(rec.dir)!;
      arr.push({ ...rec, idx: arr.length });
    };

    validLinks.forEach((item) => {
      const chain = item.corridorChain;
      const hasChain = Boolean(chain && chain.length > 0);
      const srcOffset = srcLaneOffsets.get(item.link.id) || 0;
      const tgtOffset = tgtLaneOffsets.get(item.link.id) || 0;
      const startPort = getPortWithLaneOffset(item.source, item.sDir, srcOffset);
      const endPort = getPortWithLaneOffset(item.target, item.tDir, tgtOffset);
      const rawSrcLead = srcLeadDists.get(item.link.id) ?? MIN_SOCKET_LEAD;
      const rawTgtLead = tgtLeadDists.get(item.link.id) ?? MIN_SOCKET_LEAD;

      if (!hasChain && shouldSkipDirectLeadsForStraightGap(startPort, endPort, item.sDir, item.tDir, rawSrcLead + rawTgtLead)) {
        return;
      }

      const firstLane = hasChain ? chain![0].lanePts : undefined;
      const lastLane = hasChain ? chain![chain!.length - 1].lanePts : undefined;
      const firstKey = makeStepKey(item.link.id, 0);
      const lastKey = makeStepKey(item.link.id, (chain?.length || 1) - 1);

      const srcAim = firstLane
        ? entryAlongsideSet.has(firstKey) && firstLane.length >= 2
          ? firstLane[1]
          : (entryAnchorMap.get(firstKey) ?? firstLane[0])
        : endPort;
      const tgtAim = lastLane
        ? exitAlongsideSet.has(lastKey) && lastLane.length >= 2
          ? lastLane[lastLane.length - 2]
          : (exitAnchorMap.get(lastKey) ?? lastLane[lastLane.length - 1])
        : startPort;

      const sPortPerp = getPerpCoord(startPort, item.sDir);
      const sAimPerp = getPerpCoord(srcAim, item.sDir);
      addTrackRecord({
        key: `${item.link.id}:source`,
        linkId: item.link.id,
        role: 'source',
        dir: item.sDir,
        portPerp: sPortPerp,
        aimPerp: sAimPerp,
        deltaPerp: sAimPerp - sPortPerp,
        minPerp: Math.min(sPortPerp, sAimPerp),
        maxPerp: Math.max(sPortPerp, sAimPerp),
        outStart: getOutCoord(startPort, item.sDir),
        leadDist: rawSrcLead
      });

      const tPortPerp = getPerpCoord(endPort, item.tDir);
      const tAimPerp = getPerpCoord(tgtAim, item.tDir);
      addTrackRecord({
        key: `${item.link.id}:target`,
        linkId: item.link.id,
        role: 'target',
        dir: item.tDir,
        portPerp: tPortPerp,
        aimPerp: tAimPerp,
        deltaPerp: tAimPerp - tPortPerp,
        minPerp: Math.min(tPortPerp, tAimPerp),
        maxPerp: Math.max(tPortPerp, tAimPerp),
        outStart: getOutCoord(endPort, item.tDir),
        leadDist: rawTgtLead
      });
    });

    const PERP_CLEAR_PAD = 2;
    const STEM_PAD = 4;

    recordsByDir.forEach((group) => {
      if (group.length <= 1) return;

      const n = group.length;
      const adj: number[][] = Array.from({ length: n }, () => []);
      const inDeg = new Array<number>(n).fill(0);

      for (let i = 0; i < n; i++) {
        const a = group[i];
        for (let j = i + 1; j < n; j++) {
          const b = group[j];
          const bCrossesA = b.minPerp - STEM_PAD <= a.portPerp && a.portPerp <= b.maxPerp + STEM_PAD;
          const aCrossesB = a.minPerp - STEM_PAD <= b.portPerp && b.portPerp <= a.maxPerp + STEM_PAD;
          if (bCrossesA && !aCrossesB) {
            adj[i].push(j);
            inDeg[j]++;
          } else if (aCrossesB && !bCrossesA) {
            adj[j].push(i);
            inDeg[i]++;
          }
        }
      }

      const sortIndices = (aIdx: number, bIdx: number) =>
        group[aIdx].outStart - group[bIdx].outStart ||
        Math.abs(group[aIdx].deltaPerp) - Math.abs(group[bIdx].deltaPerp) ||
        group[aIdx].key.localeCompare(group[bIdx].key);

      const used = new Array<boolean>(n).fill(false);
      const ordered: SocketTrackRecord[] = [];
      const ready: number[] = [];
      for (let i = 0; i < n; i++) {
        if (inDeg[i] === 0) ready.push(i);
      }

      while (ordered.length < n) {
        if (ready.length === 0) {
          const remaining: number[] = [];
          for (let i = 0; i < n; i++) {
            if (!used[i]) remaining.push(i);
          }
          remaining.sort(sortIndices);
          ready.push(remaining[0]);
        }
        ready.sort(sortIndices);
        const cur = ready.shift()!;
        if (used[cur]) continue;
        used[cur] = true;
        ordered.push(group[cur]);
        for (const nxt of adj[cur]) {
          inDeg[nxt]--;
          if (inDeg[nxt] === 0 && !used[nxt]) ready.push(nxt);
        }
      }

      interface PlacedTrack extends SocketTrackRecord {
        turnOut: number;
      }

      const placed: PlacedTrack[] = [];
      for (const r of ordered) {
        let minAllowedOut = r.outStart + r.leadDist;
        for (const p of placed) {
          if (r.minPerp - STEM_PAD <= p.portPerp && p.portPerp <= r.maxPerp + STEM_PAD && minAllowedOut >= p.outStart - STEM_PAD) {
            minAllowedOut = Math.max(minAllowedOut, p.turnOut + LANE_SPACING);
          }
        }

        let candidateOut = minAllowedOut;
        let moved = true;
        while (moved) {
          moved = false;
          for (const p of placed) {
            if (Math.abs(candidateOut - p.turnOut) < LANE_SPACING - 0.5) {
              const overlapsPerp = Math.max(r.minPerp, p.minPerp) <= Math.min(r.maxPerp, p.maxPerp) + PERP_CLEAR_PAD;
              if (overlapsPerp) {
                candidateOut = Math.max(candidateOut, p.turnOut + LANE_SPACING);
                moved = true;
              }
            }
          }
        }

        const updatedLead = candidateOut - r.outStart;
        if (r.role === 'source') srcLeadDists.set(r.linkId, updatedLead);
        else tgtLeadDists.set(r.linkId, updatedLead);
        placed.push({ ...r, turnOut: candidateOut });
      }
    });
  }

  const computeSafeSocketLeadPt = (
    port: Point,
    dir: CardinalDirection,
    leadDist: number,
    destPt: Point,
    mouthOutTangent?: Point
  ): Point | null => {
    const vec = cardinalToVec(dir);
    const forwardToDest = (destPt.x - port.x) * vec.x + (destPt.y - port.y) * vec.y;
    const perpToDest = Math.abs((destPt.x - port.x) * -vec.y + (destPt.y - port.y) * vec.x);
    if (perpToDest < 1 && forwardToDest > 0 && forwardToDest <= leadDist + 4) {
      return null;
    }
    let effectiveLead = leadDist;
    if (mouthOutTangent && forwardToDest > 0 && forwardToDest < leadDist + 6) {
      const facingMouth = vec.x * mouthOutTangent.x + vec.y * mouthOutTangent.y < -0.5;
      if (facingMouth) {
        if (forwardToDest <= 14) return null;
        effectiveLead = Math.min(leadDist, Math.max(12, forwardToDest - 6));
      }
    }
    for (let d = effectiveLead; d >= 8; d -= 4) {
      const candidate = {
        x: port.x + vec.x * d,
        y: port.y + vec.y * d
      };
      const blocked = nodesList.some((n) => isPointInsideNode(candidate, n, -5));
      if (!blocked) return candidate;
    }
    return null;
  };

  const getAnchoredStepPts = (
    linkId: string,
    stepIdx: number,
    totalSteps: number,
    lanePts: Point[],
    startPort: Point,
    endPort: Point
  ): Point[] => {
    const key = makeStepKey(linkId, stepIdx);
    const k = lanePts.length;
    const isEntryAlong = stepIdx === 0 && entryAlongsideSet.has(key);
    const isExitAlong = stepIdx === totalSteps - 1 && exitAlongsideSet.has(key);

    const base = lanePts.map((p) => ({ x: p.x, y: p.y }));
    let srcT: number | null = null;
    let tgtT: number | null = null;

    if (isEntryAlong && k >= 2) {
      const along = getAlongSegmentPoint(startPort, lanePts[0], lanePts[1], 0.02, 0.9);
      if (along) {
        srcT = along.t;
        base[0] = along.point;
      }
    }
    if (isExitAlong && k >= 2) {
      const along = getAlongSegmentPoint(endPort, lanePts[k - 2], lanePts[k - 1], 0.1, 0.98);
      if (along) {
        tgtT = along.t;
        base[k - 1] = along.point;
      }
    }
    if (totalSteps === 1 && k === 2 && srcT !== null && tgtT !== null && srcT >= tgtT - 0.05) {
      base[0] = lanePts[0];
      base[k - 1] = lanePts[k - 1];
    }

    const entryAnchor = !isEntryAlong ? entryAnchorMap.get(key) : undefined;
    const exitAnchor = !isExitAlong ? exitAnchorMap.get(key) : undefined;
    const pts: Point[] = [];
    if (entryAnchor && Math.hypot(entryAnchor.x - base[0].x, entryAnchor.y - base[0].y) >= 0.5) {
      pts.push(entryAnchor);
    }
    pts.push(...base);
    const last = base[base.length - 1];
    if (exitAnchor && Math.hypot(exitAnchor.x - last.x, exitAnchor.y - last.y) >= 0.5) {
      pts.push(exitAnchor);
    }
    return pts;
  };

  // 4. Compute orthogonal approach/bridge/exit/direct routes using libavoid-js (with graceful fallback)
  interface TempRoute {
    link: TransferLink;
    source: ContainerNode;
    target: ContainerNode;
    points: Point[];
    startPort: Point;
    endPort: Point;
    sDir: CardinalDirection;
    tDir: CardinalDirection;
    corridorSegments: { p1: Point; p2: Point }[];
  }

  const tempRoutes: TempRoute[] = [];
  const avoid = avoidInstance;

  const outTangentToArrivalDir = (outTangent: Point): CardinalDirection =>
    Math.abs(outTangent.x) >= Math.abs(outTangent.y)
      ? outTangent.x >= 0
        ? 'E'
        : 'W'
      : outTangent.y >= 0
      ? 'S'
      : 'N';

  if (avoid && validLinks.length > 0) {
    const runWasmRoutingPass = () => {
      const passRoutes: TempRoute[] = [];
      const leadsByLink = new Map<string, { srcLeadPt: Point | null; tgtLeadPt: Point | null }>();
      const router = new avoid.Router(avoid.RouterFlag.OrthogonalRouting);
      try {
        // Shape buffer of 5px keeps corridors clear while fitting cleanly inside 12px snapped gaps (5 + 5 < 12)
        router.setRoutingParameter(avoid.RoutingParameter.shapeBufferDistance, 5);
        router.setRoutingParameter(avoid.RoutingParameter.idealNudgingDistance, LANE_SPACING);
        router.setRoutingParameter(avoid.RoutingParameter.segmentPenalty, 10);
        router.setRoutingParameter(avoid.RoutingParameter.crossingPenalty, 150);
        router.setRoutingParameter(avoid.RoutingParameter.fixedSharedPathPenalty, 50);

        // Keep port anchor segments locked to the sorted lane offsets while nudging shared interior corridors
        router.setRoutingOption(avoid.RoutingOption.nudgeOrthogonalSegmentsConnectedToShapes, false);
        router.setRoutingOption(avoid.RoutingOption.nudgeOrthogonalTouchingColinearSegments, true);
        router.setRoutingOption(avoid.RoutingOption.performUnifyingNudgingPreprocessingStep, true);

        const shapeMap = new Map<string, ShapeRef>();
        nodesList.forEach((node) => {
          const shape = router.addShape({
            x: node.x,
            y: node.y,
            width: CARD_W,
            height: CARD_H
          });
          shapeMap.set(node.id, shape);
        });

        const getLeadDepartureDirs = (dir: CardinalDirection): ConnDirFlags =>
          avoid.ConnDirFlag.ConnDirAll & ~toConnDirFlag(avoid, oppositeCardinal(dir));

        let nextPinClassId = 1;
        const pendingConnectors: {
          item: LinkWithFaces;
          startPort: Point;
          endPort: Point;
          srcLeadPt: Point | null;
          tgtLeadPt: Point | null;
          anchoredSteps?: Point[][];
          directConn: ReturnType<typeof router.addConnector> | null;
          entryConn: ReturnType<typeof router.addConnector> | null;
          bridgeConns: (ReturnType<typeof router.addConnector> | null)[];
          exitConn: ReturnType<typeof router.addConnector> | null;
        }[] = [];

        validLinks.forEach((item) => {
          const srcOffset = srcLaneOffsets.get(item.link.id) || 0;
          const tgtOffset = tgtLaneOffsets.get(item.link.id) || 0;
          const startPort = getPortWithLaneOffset(item.source, item.sDir, srcOffset);
          const endPort = getPortWithLaneOffset(item.target, item.tDir, tgtOffset);
          const rawSrcLeadDist = srcLeadDists.get(item.link.id) ?? MIN_SOCKET_LEAD;
          const rawTgtLeadDist = tgtLeadDists.get(item.link.id) ?? MIN_SOCKET_LEAD;

          const srcShape = shapeMap.get(item.source.id);
          const tgtShape = shapeMap.get(item.target.id);

          if (!srcShape || !tgtShape || item.source.id === item.target.id) {
            pendingConnectors.push({
              item,
              startPort,
              endPort,
              srcLeadPt: null,
              tgtLeadPt: null,
              directConn: null,
              entryConn: null,
              bridgeConns: [],
              exitConn: null
            });
            return;
          }

          const srcPinId = nextPinClassId++;
          const tgtPinId = nextPinClassId++;

          srcShape.addPin({
            classId: srcPinId,
            x: startPort.x - item.source.x,
            y: startPort.y - item.source.y,
            proportional: false,
            directions: toConnDirFlag(avoid, item.sDir)
          });

          tgtShape.addPin({
            classId: tgtPinId,
            x: endPort.x - item.target.x,
            y: endPort.y - item.target.y,
            proportional: false,
            directions: toConnDirFlag(avoid, item.tDir)
          });

          if (item.corridorChain && item.corridorChain.length > 0) {
            const totalSteps = item.corridorChain.length;
            const anchoredSteps = item.corridorChain.map((step, sIdx) =>
              getAnchoredStepPts(item.link.id, sIdx, totalSteps, step.lanePts, startPort, endPort)
            );

            const getPointEndDirs = (
              mouthPt: Point,
              outTangent: Point,
              remotePt: Point,
              isAlongside: boolean
            ): ConnDirFlags => {
              if (isAlongside) {
                const perpDir: CardinalDirection =
                  Math.abs(outTangent.x) >= Math.abs(outTangent.y)
                    ? remotePt.y < mouthPt.y
                      ? 'N'
                      : 'S'
                    : remotePt.x < mouthPt.x
                    ? 'W'
                    : 'E';
                return toConnDirFlag(avoid, perpDir);
              }

              const forward =
                (remotePt.x - mouthPt.x) * outTangent.x + (remotePt.y - mouthPt.y) * outTangent.y;
              let flags: ConnDirFlags = 0;
              if (Math.abs(outTangent.x) > 0.25) {
                flags |= toConnDirFlag(avoid, outTangent.x >= 0 ? 'E' : 'W');
              }
              if (Math.abs(outTangent.y) > 0.25) {
                flags |= toConnDirFlag(avoid, outTangent.y >= 0 ? 'S' : 'N');
              }
              if (forward > 4) {
                return flags || avoid.ConnDirFlag.ConnDirAll;
              }
              // Allow perpendicular exit/entry when remote point is beside/behind the mouth without doubling back into the corridor
              if (Math.abs(outTangent.x) >= Math.abs(outTangent.y)) {
                flags |= avoid.ConnDirFlag.ConnDirUp | avoid.ConnDirFlag.ConnDirDown;
              } else {
                flags |= avoid.ConnDirFlag.ConnDirLeft | avoid.ConnDirFlag.ConnDirRight;
              }
              return flags;
            };

            const firstStep = item.corridorChain[0];
            const firstEntryPt = anchoredSteps[0][0];
            const firstOutTangent = getCorridorMouthVectors(firstStep.corridor, !firstStep.isReversed).outTangent;
            const firstEntryKey = makeStepKey(item.link.id, 0);
            const srcLeadPt = computeSafeSocketLeadPt(startPort, item.sDir, rawSrcLeadDist, firstEntryPt, firstOutTangent);
            const firstEntryDirs = getPointEndDirs(
              firstEntryPt,
              firstOutTangent,
              srcLeadPt ?? startPort,
              entryAlongsideSet.has(firstEntryKey)
            );

            const lastStepIdx = totalSteps - 1;
            const lastStepMeta = item.corridorChain[lastStepIdx];
            const lastStep = anchoredSteps[lastStepIdx];
            const lastExitPt = lastStep[lastStep.length - 1];
            const lastOutTangent = getCorridorMouthVectors(lastStepMeta.corridor, lastStepMeta.isReversed).outTangent;
            const lastExitKey = makeStepKey(item.link.id, lastStepIdx);
            const tgtLeadPt = computeSafeSocketLeadPt(endPort, item.tDir, rawTgtLeadDist, lastExitPt, lastOutTangent);
            const lastExitDirs = getPointEndDirs(
              lastExitPt,
              lastOutTangent,
              tgtLeadPt ?? endPort,
              exitAlongsideSet.has(lastExitKey)
            );

            const entryConn = router.addConnector(
              srcLeadPt
                ? { x: srcLeadPt.x, y: srcLeadPt.y, directions: getLeadDepartureDirs(item.sDir) }
                : { shape: srcShape, pin: srcPinId },
              { x: firstEntryPt.x, y: firstEntryPt.y, directions: firstEntryDirs }
            );

            const bridgeConns: (ReturnType<typeof router.addConnector> | null)[] = [];
            for (let s = 0; s < totalSteps - 1; s++) {
              const curExit = anchoredSteps[s][anchoredSteps[s].length - 1];
              const nextEntry = anchoredSteps[s + 1][0];
              if (Math.hypot(nextEntry.x - curExit.x, nextEntry.y - curExit.y) < 1) {
                bridgeConns.push(null);
              } else {
                const curMeta = item.corridorChain[s];
                const nextMeta = item.corridorChain[s + 1];
                const curOutTangent = getCorridorMouthVectors(curMeta.corridor, curMeta.isReversed).outTangent;
                const nextOutTangent = getCorridorMouthVectors(nextMeta.corridor, !nextMeta.isReversed).outTangent;
                const curExitDirs = getPointEndDirs(curExit, curOutTangent, nextEntry, false);
                const nextEntryDirs = getPointEndDirs(nextEntry, nextOutTangent, curExit, false);

                bridgeConns.push(
                  router.addConnector(
                    { x: curExit.x, y: curExit.y, directions: curExitDirs },
                    { x: nextEntry.x, y: nextEntry.y, directions: nextEntryDirs }
                  )
                );
              }
            }

            const exitConn = router.addConnector(
              { x: lastExitPt.x, y: lastExitPt.y, directions: lastExitDirs },
              tgtLeadPt
                ? { x: tgtLeadPt.x, y: tgtLeadPt.y, directions: getLeadDepartureDirs(item.tDir) }
                : { shape: tgtShape, pin: tgtPinId }
            );

            pendingConnectors.push({
              item,
              startPort,
              endPort,
              srcLeadPt,
              tgtLeadPt,
              anchoredSteps,
              directConn: null,
              entryConn,
              bridgeConns,
              exitConn
            });
          } else {
            const skipLeads = shouldSkipDirectLeadsForStraightGap(
              startPort,
              endPort,
              item.sDir,
              item.tDir,
              rawSrcLeadDist + rawTgtLeadDist
            );
            const srcLeadPt = skipLeads ? null : computeSafeSocketLeadPt(startPort, item.sDir, rawSrcLeadDist, endPort);
            const tgtLeadPt = skipLeads ? null : computeSafeSocketLeadPt(endPort, item.tDir, rawTgtLeadDist, startPort);
            const directConn = router.addConnector(
              srcLeadPt
                ? { x: srcLeadPt.x, y: srcLeadPt.y, directions: getLeadDepartureDirs(item.sDir) }
                : { shape: srcShape, pin: srcPinId },
              tgtLeadPt
                ? { x: tgtLeadPt.x, y: tgtLeadPt.y, directions: getLeadDepartureDirs(item.tDir) }
                : { shape: tgtShape, pin: tgtPinId }
            );
            pendingConnectors.push({
              item,
              startPort,
              endPort,
              srcLeadPt,
              tgtLeadPt,
              directConn,
              entryConn: null,
              bridgeConns: [],
              exitConn: null
            });
          }
        });

        router.processTransaction();

        pendingConnectors.forEach(({ item, startPort, endPort, srcLeadPt, tgtLeadPt, anchoredSteps, directConn, entryConn, bridgeConns, exitConn }) => {
          leadsByLink.set(item.link.id, { srcLeadPt, tgtLeadPt });
          const corridorSegments: { p1: Point; p2: Point }[] = [];
          let points: Point[];

          if (anchoredSteps && anchoredSteps.length > 0 && item.corridorChain) {
            const firstEntryPt = anchoredSteps[0][0];
            const lastStepIdx = anchoredSteps.length - 1;
            const lastStep = anchoredSteps[lastStepIdx];
            const lastExitPt = lastStep[lastStep.length - 1];
            const firstOut = getCorridorMouthVectors(item.corridorChain[0].corridor, !item.corridorChain[0].isReversed).outTangent;
            const lastOut = getCorridorMouthVectors(item.corridorChain[lastStepIdx].corridor, item.corridorChain[lastStepIdx].isReversed).outTangent;

            let entryPts: Point[];
            if (entryConn && entryConn.hasValidRoute()) {
              const r = entryConn.displayRoute().map((p) => ({ x: p.x, y: p.y }));
              entryPts =
                r.length >= 2 || (srcLeadPt && r.length >= 1)
                  ? (srcLeadPt ? [startPort, ...r] : r)
                  : (srcLeadPt
                      ? [startPort, ...buildFallbackPoints(srcLeadPt, firstEntryPt, item.sDir, outTangentToArrivalDir(firstOut))]
                      : buildFallbackPoints(startPort, firstEntryPt, item.sDir, outTangentToArrivalDir(firstOut)));
            } else {
              entryPts = srcLeadPt
                ? [startPort, ...buildFallbackPoints(srcLeadPt, firstEntryPt, item.sDir, outTangentToArrivalDir(firstOut))]
                : buildFallbackPoints(startPort, firstEntryPt, item.sDir, outTangentToArrivalDir(firstOut));
            }

            let exitPts: Point[];
            if (exitConn && exitConn.hasValidRoute()) {
              const r = exitConn.displayRoute().map((p) => ({ x: p.x, y: p.y }));
              exitPts =
                r.length >= 2 || (tgtLeadPt && r.length >= 1)
                  ? (tgtLeadPt ? [...r, endPort] : r)
                  : (tgtLeadPt
                      ? [...buildFallbackPoints(lastExitPt, tgtLeadPt, outTangentToArrivalDir(lastOut), item.tDir), endPort]
                      : buildFallbackPoints(lastExitPt, endPort, outTangentToArrivalDir(lastOut), item.tDir));
            } else {
              exitPts = tgtLeadPt
                ? [...buildFallbackPoints(lastExitPt, tgtLeadPt, outTangentToArrivalDir(lastOut), item.tDir), endPort]
                : buildFallbackPoints(lastExitPt, endPort, outTangentToArrivalDir(lastOut), item.tDir);
            }

            const combined: Point[] = [...entryPts];
            anchoredSteps.forEach((stepPts, sIdx) => {
              for (let i = 0; i < stepPts.length - 1; i++) {
                corridorSegments.push({ p1: stepPts[i], p2: stepPts[i + 1] });
              }
              combined.push(...stepPts.slice(1));

              if (sIdx < anchoredSteps.length - 1) {
                const curExit = stepPts[stepPts.length - 1];
                const nextEntry = anchoredSteps[sIdx + 1][0];
                const curOut = getCorridorMouthVectors(item.corridorChain![sIdx].corridor, item.corridorChain![sIdx].isReversed).outTangent;
                const nextOut = getCorridorMouthVectors(item.corridorChain![sIdx + 1].corridor, !item.corridorChain![sIdx + 1].isReversed).outTangent;
                const bridgeConn = bridgeConns[sIdx];
                let bridgePts: Point[];
                if (bridgeConn && bridgeConn.hasValidRoute()) {
                  const r = bridgeConn.displayRoute().map((p) => ({ x: p.x, y: p.y }));
                  bridgePts =
                    r.length >= 2
                      ? r
                      : buildFallbackPoints(
                          curExit,
                          nextEntry,
                          outTangentToArrivalDir(curOut),
                          outTangentToArrivalDir(nextOut)
                        );
                } else if (Math.hypot(nextEntry.x - curExit.x, nextEntry.y - curExit.y) < 1) {
                  bridgePts = [curExit, nextEntry];
                } else {
                  bridgePts = buildFallbackPoints(
                    curExit,
                    nextEntry,
                    outTangentToArrivalDir(curOut),
                    outTangentToArrivalDir(nextOut)
                  );
                }
                combined.push(...bridgePts.slice(1));
              }
            });
            combined.push(...exitPts.slice(1));

            points = simplifyCollinear(combined);
          } else {
            if (directConn && directConn.hasValidRoute()) {
              const routePts = directConn.displayRoute().map((p) => ({ x: p.x, y: p.y }));
              const hasEnoughPts =
                routePts.length >= 2 || ((srcLeadPt !== null || tgtLeadPt !== null) && routePts.length >= 1);
              if (hasEnoughPts) {
                const assembled: Point[] = [];
                if (srcLeadPt) assembled.push(startPort);
                assembled.push(...routePts);
                if (tgtLeadPt) assembled.push(endPort);
                points = simplifyCollinear(assembled);
              } else {
                const mid = buildFallbackPoints(srcLeadPt ?? startPort, tgtLeadPt ?? endPort, item.sDir, item.tDir);
                points = simplifyCollinear([
                  ...(srcLeadPt ? [startPort] : []),
                  ...mid,
                  ...(tgtLeadPt ? [endPort] : [])
                ]);
              }
            } else {
              const mid = buildFallbackPoints(srcLeadPt ?? startPort, tgtLeadPt ?? endPort, item.sDir, item.tDir);
              points = simplifyCollinear([
                ...(srcLeadPt ? [startPort] : []),
                ...mid,
                ...(tgtLeadPt ? [endPort] : [])
              ]);
            }
          }

          passRoutes.push({
            link: item.link,
            source: item.source,
            target: item.target,
            points,
            startPort,
            endPort,
            sDir: item.sDir,
            tDir: item.tDir,
            corridorSegments
          });
        });
      } finally {
        router.delete();
      }
      return { passRoutes, leadsByLink };
    };

    const isSegOnCorridor = (p1: Point, p2: Point, corrSegs: { p1: Point; p2: Point }[]): boolean => {
      if (corrSegs.length === 0) return false;
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      return corrSegs.some((c) => {
        const minX = Math.min(c.p1.x, c.p2.x) - 1;
        const maxX = Math.max(c.p1.x, c.p2.x) + 1;
        const minY = Math.min(c.p1.y, c.p2.y) - 1;
        const maxY = Math.max(c.p1.y, c.p2.y) + 1;
        return midX >= minX && midX <= maxX && midY >= minY && midY <= maxY;
      });
    };

    const ptNear = (a: Point, b: Point | null): boolean =>
      b !== null && Math.hypot(a.x - b.x, a.y - b.y) < 1;

    let finalPassRoutes: TempRoute[] = [];
    for (let pass = 0; pass < 3; pass++) {
      const { passRoutes, leadsByLink } = runWasmRoutingPass();
      finalPassRoutes = passRoutes;
      if (pass >= 2) break;

      let adjustedLead = false;
      for (let i = 0; i < passRoutes.length && !adjustedLead; i++) {
        const rA = passRoutes[i];
        const leadsA = leadsByLink.get(rA.link.id);
        for (let j = i + 1; j < passRoutes.length && !adjustedLead; j++) {
          const rB = passRoutes[j];
          const leadsB = leadsByLink.get(rB.link.id);
          for (let a = 0; a < rA.points.length - 1 && !adjustedLead; a++) {
            const a1 = rA.points[a];
            const a2 = rA.points[a + 1];
            if (isSegOnCorridor(a1, a2, rA.corridorSegments)) continue;
            const aH = Math.abs(a1.y - a2.y) < 0.5;
            const aV = Math.abs(a1.x - a2.x) < 0.5;
            if (!aH && !aV) continue;

            for (let b = 0; b < rB.points.length - 1 && !adjustedLead; b++) {
              const b1 = rB.points[b];
              const b2 = rB.points[b + 1];
              if (isSegOnCorridor(b1, b2, rB.corridorSegments)) continue;
              const bH = Math.abs(b1.y - b2.y) < 0.5;
              const bV = Math.abs(b1.x - b2.x) < 0.5;
              if (aH !== bH || aV !== bV) continue;

              const ov = aH
                ? Math.abs(a1.y - b1.y) < 2
                  ? Math.min(Math.max(a1.x, a2.x), Math.max(b1.x, b2.x)) -
                    Math.max(Math.min(a1.x, a2.x), Math.min(b1.x, b2.x))
                  : 0
                : Math.abs(a1.x - b1.x) < 2
                ? Math.min(Math.max(a1.y, a2.y), Math.max(b1.y, b2.y)) -
                  Math.max(Math.min(a1.y, a2.y), Math.min(b1.y, b2.y))
                : 0;
              if (ov <= 0.5) continue;

              const aLen = Math.hypot(a2.x - a1.x, a2.y - a1.y);
              const bLen = Math.hypot(b2.x - b1.x, b2.y - b1.y);
              const aTouchesTgt = leadsA && (ptNear(a1, leadsA.tgtLeadPt) || ptNear(a2, leadsA.tgtLeadPt));
              const bTouchesTgt = leadsB && (ptNear(b1, leadsB.tgtLeadPt) || ptNear(b2, leadsB.tgtLeadPt));
              const aTouchesSrc = leadsA && (ptNear(a1, leadsA.srcLeadPt) || ptNear(a2, leadsA.srcLeadPt));
              const bTouchesSrc = leadsB && (ptNear(b1, leadsB.srcLeadPt) || ptNear(b2, leadsB.srcLeadPt));

              if (aTouchesTgt && (!bTouchesTgt || aLen >= bLen)) {
                tgtLeadDists.set(rA.link.id, (tgtLeadDists.get(rA.link.id) ?? MIN_SOCKET_LEAD) + LANE_SPACING);
                adjustedLead = true;
              } else if (bTouchesTgt) {
                tgtLeadDists.set(rB.link.id, (tgtLeadDists.get(rB.link.id) ?? MIN_SOCKET_LEAD) + LANE_SPACING);
                adjustedLead = true;
              } else if (aTouchesSrc && (!bTouchesSrc || aLen >= bLen)) {
                srcLeadDists.set(rA.link.id, (srcLeadDists.get(rA.link.id) ?? MIN_SOCKET_LEAD) + LANE_SPACING);
                adjustedLead = true;
              } else if (bTouchesSrc) {
                srcLeadDists.set(rB.link.id, (srcLeadDists.get(rB.link.id) ?? MIN_SOCKET_LEAD) + LANE_SPACING);
                adjustedLead = true;
              }
            }
          }
        }
      }
      if (!adjustedLead) break;
    }

    tempRoutes.push(...finalPassRoutes);
  } else {
    validLinks.forEach((item) => {
      const srcOffset = srcLaneOffsets.get(item.link.id) || 0;
      const tgtOffset = tgtLaneOffsets.get(item.link.id) || 0;
      const startPort = getPortWithLaneOffset(item.source, item.sDir, srcOffset);
      const endPort = getPortWithLaneOffset(item.target, item.tDir, tgtOffset);
      const rawSrcLeadDist = srcLeadDists.get(item.link.id) ?? MIN_SOCKET_LEAD;
      const rawTgtLeadDist = tgtLeadDists.get(item.link.id) ?? MIN_SOCKET_LEAD;
      const corridorSegments: { p1: Point; p2: Point }[] = [];

      let points: Point[];
      if (item.corridorChain && item.corridorChain.length > 0) {
        const totalSteps = item.corridorChain.length;
        const anchoredSteps = item.corridorChain.map((step, sIdx) =>
          getAnchoredStepPts(item.link.id, sIdx, totalSteps, step.lanePts, startPort, endPort)
        );
        const firstEntryPt = anchoredSteps[0][0];
        const lastStepIdx = totalSteps - 1;
        const lastStep = anchoredSteps[lastStepIdx];
        const lastExitPt = lastStep[lastStep.length - 1];
        const firstOut = getCorridorMouthVectors(item.corridorChain[0].corridor, !item.corridorChain[0].isReversed).outTangent;
        const lastOut = getCorridorMouthVectors(item.corridorChain[lastStepIdx].corridor, item.corridorChain[lastStepIdx].isReversed).outTangent;

        const srcLeadPt = computeSafeSocketLeadPt(startPort, item.sDir, rawSrcLeadDist, firstEntryPt);
        const tgtLeadPt = computeSafeSocketLeadPt(endPort, item.tDir, rawTgtLeadDist, lastExitPt);
        const entryPts = srcLeadPt
          ? [startPort, ...buildFallbackPoints(srcLeadPt, firstEntryPt, item.sDir, outTangentToArrivalDir(firstOut))]
          : buildFallbackPoints(startPort, firstEntryPt, item.sDir, outTangentToArrivalDir(firstOut));
        const exitPts = tgtLeadPt
          ? [...buildFallbackPoints(lastExitPt, tgtLeadPt, outTangentToArrivalDir(lastOut), item.tDir), endPort]
          : buildFallbackPoints(lastExitPt, endPort, outTangentToArrivalDir(lastOut), item.tDir);

        const combined: Point[] = [...entryPts];
        anchoredSteps.forEach((stepPts, sIdx) => {
          for (let i = 0; i < stepPts.length - 1; i++) {
            corridorSegments.push({ p1: stepPts[i], p2: stepPts[i + 1] });
          }
          combined.push(...stepPts.slice(1));
          if (sIdx < anchoredSteps.length - 1) {
            const curExit = stepPts[stepPts.length - 1];
            const nextEntry = anchoredSteps[sIdx + 1][0];
            const curOut = getCorridorMouthVectors(item.corridorChain![sIdx].corridor, item.corridorChain![sIdx].isReversed).outTangent;
            const nextOut = getCorridorMouthVectors(item.corridorChain![sIdx + 1].corridor, !item.corridorChain![sIdx + 1].isReversed).outTangent;
            const bridgePts = buildFallbackPoints(
              curExit,
              nextEntry,
              outTangentToArrivalDir(curOut),
              outTangentToArrivalDir(nextOut)
            );
            combined.push(...bridgePts.slice(1));
          }
        });
        combined.push(...exitPts.slice(1));
        points = simplifyCollinear(combined);
      } else {
        const skipLeads = shouldSkipDirectLeadsForStraightGap(
          startPort,
          endPort,
          item.sDir,
          item.tDir,
          rawSrcLeadDist + rawTgtLeadDist
        );
        const srcLeadPt = skipLeads ? null : computeSafeSocketLeadPt(startPort, item.sDir, rawSrcLeadDist, endPort);
        const tgtLeadPt = skipLeads ? null : computeSafeSocketLeadPt(endPort, item.tDir, rawTgtLeadDist, startPort);
        const mid = buildFallbackPoints(srcLeadPt ?? startPort, tgtLeadPt ?? endPort, item.sDir, item.tDir);
        points = simplifyCollinear([
          ...(srcLeadPt ? [startPort] : []),
          ...mid,
          ...(tgtLeadPt ? [endPort] : [])
        ]);
      }

      tempRoutes.push({
        link: item.link,
        source: item.source,
        target: item.target,
        points,
        startPort,
        endPort,
        sDir: item.sDir,
        tDir: item.tDir,
        corridorSegments
      });
    });
  }

  // 5. Calculate offline badge positions next to unique (non-shared, non-corridor) segments
  const BADGE_W = 50;
  const BADGE_H = 20;
  const BADGE_CLEARANCE = 8;

  interface RectBox {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  }

  const rectsOverlap = (a: RectBox, b: RectBox, pad = 0): boolean =>
    a.minX < b.maxX + pad &&
    a.maxX > b.minX - pad &&
    a.minY < b.maxY + pad &&
    a.maxY > b.minY - pad;

  const nodeRects: RectBox[] = nodesList.map((n) => ({
    minX: n.x,
    maxX: n.x + CARD_W,
    minY: n.y,
    maxY: n.y + CARD_H
  }));

  const assignedCorridorCounts = new Map<string, number>();
  linksList.forEach((l) => {
    getLinkCorridorIds(l).forEach((cid) => {
      assignedCorridorCounts.set(cid, (assignedCorridorCounts.get(cid) || 0) + 1);
    });
  });

  const corridorBandObstacles: { p1: Point; p2: Point; tol: number }[] = [];
  const corridorUiRects: RectBox[] = [];

  corridorsList.forEach((corridor) => {
    const wps = corridor.waypoints;
    if (!wps || wps.length < 2) return;
    const assignedCount = assignedCorridorCounts.get(corridor.id) || 0;
    const spacing = Math.max(2, corridor.laneSpacing || 5);
    const bandWidth = Math.max(28, Math.max(0, assignedCount - 1) * spacing + 24);
    const halfBand = bandWidth / 2;

    let longestIdx = 0;
    let longestLen = -1;
    for (let i = 0; i < wps.length - 1; i++) {
      corridorBandObstacles.push({ p1: wps[i], p2: wps[i + 1], tol: halfBand + 4 });
      const segLen = Math.hypot(wps[i + 1].x - wps[i].x, wps[i + 1].y - wps[i].y);
      if (segLen > longestLen) {
        longestLen = segLen;
        longestIdx = i;
      }
    }

    if (longestLen > 1) {
      const segA = wps[longestIdx];
      const segB = wps[longestIdx + 1];
      let angle = Math.atan2(segB.y - segA.y, segB.x - segA.x);
      if (angle >= Math.PI / 2) angle -= Math.PI;
      else if (angle < -Math.PI / 2) angle += Math.PI;

      const cos = Math.abs(Math.cos(angle));
      const sin = Math.abs(Math.sin(angle));

      if (corridor.name) {
        const labelW = Math.max(36, corridor.name.length * 6.5 + 16);
        const labelH = 20;
        const labelDist = halfBand + 11;
        const lx = (segA.x + segB.x) / 2 + Math.sin(angle) * labelDist;
        const ly = (segA.y + segB.y) / 2 - Math.cos(angle) * labelDist;
        const halfAabbW = (cos * labelW + sin * labelH) / 2;
        const halfAabbH = (sin * labelW + cos * labelH) / 2;
        corridorUiRects.push({
          minX: lx - halfAabbW,
          maxX: lx + halfAabbW,
          minY: ly - halfAabbH,
          maxY: ly + halfAabbH
        });
      }

      const oppNormX = -Math.sin(angle);
      const oppNormY = Math.cos(angle);
      const rBadgeW = 54;
      const rBadgeH = 20;
      const projHalf = Math.abs(oppNormX) * (rBadgeW / 2) + Math.abs(oppNormY) * (rBadgeH / 2);
      const badgeDist = halfBand + projHalf + 5;
      const bx = (segA.x + segB.x) / 2 + oppNormX * badgeDist;
      const by = (segA.y + segB.y) / 2 + oppNormY * badgeDist;
      corridorUiRects.push({
        minX: bx - rBadgeW / 2,
        maxX: bx + rBadgeW / 2,
        minY: by - rBadgeH / 2,
        maxY: by + rBadgeH / 2
      });
    }
  });

  const allLinkSegs = tempRoutes.map((r) => {
    const segs: { p1: Point; p2: Point; tol: number }[] = [];
    for (let i = 0; i < r.points.length - 1; i++) {
      segs.push({ p1: r.points[i], p2: r.points[i + 1], tol: 24 });
    }
    return { linkId: r.link.id, segs };
  });

  const placedBadgeRects: RectBox[] = [];

  tempRoutes.forEach((route, linkIdx) => {
    const points = route.points;
    let badgePt: Point;

    if (points.length <= 1) {
      badgePt = points[0] || { x: 0, y: 0 };
    } else {
      const ownCorridorBlockers = route.corridorSegments.map((s) => ({ p1: s.p1, p2: s.p2, tol: 8 }));
      const corridorBlockers = [...ownCorridorBlockers, ...corridorBandObstacles];
      const siblingLinkBlockers: { p1: Point; p2: Point; tol: number }[] = [];
      allLinkSegs.forEach((other) => {
        if (other.linkId !== route.link.id) {
          siblingLinkBlockers.push(...other.segs);
        }
      });

      interface OfflineCandidate {
        segIdx: number;
        segLen: number;
        subLen: number;
        t: number;
        tier: number;
        isDestSeg: boolean;
      }

      const candidates: OfflineCandidate[] = [];
      const lastSegIdx = points.length - 2;

      for (let i = 0; i <= lastSegIdx; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        if (segLen < 8) continue;

        const isDestSeg = i === lastSegIdx;
        const nonCorridor = subtractOverlappingSegments([[0, 1]], p1, p2, corridorBlockers);

        let trimmedNonCorridor = nonCorridor;
        if (i === 0 && segLen > 48) {
          trimmedNonCorridor = subtractIntervalFromList(trimmedNonCorridor, 0, Math.min(0.42, 24 / segLen));
        }
        if (i === lastSegIdx && segLen > 48) {
          trimmedNonCorridor = subtractIntervalFromList(trimmedNonCorridor, Math.max(0.58, 1 - 24 / segLen), 1);
        }

        const uniqueTrimmed = subtractOverlappingSegments(trimmedNonCorridor, p1, p2, siblingLinkBlockers);
        const uniqueUntrimmed = subtractOverlappingSegments(nonCorridor, p1, p2, siblingLinkBlockers);

        const pushIntervals = (intervals: [number, number][], tier: number, minPx: number) => {
          for (const [a, b] of intervals) {
            const subLen = (b - a) * segLen;
            if (subLen < minPx) continue;
            const midT = (a + b) / 2;
            candidates.push({ segIdx: i, segLen, subLen, t: midT, tier, isDestSeg });
            if (subLen >= 40) {
              candidates.push({ segIdx: i, segLen, subLen, t: a + (b - a) * 0.25, tier, isDestSeg });
              candidates.push({ segIdx: i, segLen, subLen, t: a + (b - a) * 0.75, tier, isDestSeg });
            }
          }
        };

        // Tier 0: truly unique, outside corridors & away from port arrowheads
        pushIntervals(uniqueTrimmed, 0, 18);
        // Tier 1: truly unique, outside corridors (short stub fallback)
        pushIntervals(uniqueUntrimmed, 1, 8);
        // Tier 2: outside corridors even if near sibling links (staggered)
        for (const [a, b] of trimmedNonCorridor.length > 0 ? trimmedNonCorridor : nonCorridor) {
          const subLen = (b - a) * segLen;
          if (subLen < 12) continue;
          const frac = linkIdx % 2 === 0 ? 0.35 : 0.65;
          candidates.push({ segIdx: i, segLen, subLen, t: a + (b - a) * frac, tier: 2, isDestSeg });
          candidates.push({ segIdx: i, segLen, subLen, t: a + (b - a) * (1 - frac), tier: 2, isDestSeg });
        }
        // Tier 3: last-resort fallback on segment itself
        candidates.push({
          segIdx: i,
          segLen,
          subLen: segLen,
          t: linkIdx % 2 === 0 ? 0.35 : 0.65,
          tier: 3,
          isDestSeg
        });
      }

      let bestPt: Point | null = null;
      let bestCost = Infinity;
      let bestRect: RectBox | null = null;

      for (const cand of candidates) {
        const p1 = points[cand.segIdx];
        const p2 = points[cand.segIdx + 1];
        const ux = (p2.x - p1.x) / cand.segLen;
        const uy = (p2.y - p1.y) / cand.segLen;
        const ax = p1.x + (p2.x - p1.x) * cand.t;
        const ay = p1.y + (p2.y - p1.y) * cand.t;

        const normals: Point[] = [
          { x: -uy, y: ux },
          { x: uy, y: -ux }
        ];

        for (const n of normals) {
          const projHalf = Math.abs(n.x) * (BADGE_W / 2) + Math.abs(n.y) * (BADGE_H / 2);
          const offsetDist = projHalf + BADGE_CLEARANCE;
          const cx = ax + n.x * offsetDist;
          const cy = ay + n.y * offsetDist;
          const rect: RectBox = {
            minX: cx - BADGE_W / 2,
            maxX: cx + BADGE_W / 2,
            minY: cy - BADGE_H / 2,
            maxY: cy + BADGE_H / 2
          };

          let penalty = 0;
          for (const nr of nodeRects) {
            if (rectsOverlap(rect, nr, 4)) {
              penalty += 10000;
              break;
            }
          }
          for (const pr of placedBadgeRects) {
            if (rectsOverlap(rect, pr, 4)) {
              penalty += 6000;
              break;
            }
          }
          let hitsLink = false;
          for (const linkSegGroup of allLinkSegs) {
            for (const s of linkSegGroup.segs) {
              if (
                clipSegmentToExpandedRect(
                  s.p1,
                  s.p2,
                  rect.minX - 3,
                  rect.maxX + 3,
                  rect.minY - 3,
                  rect.maxY + 3
                )
              ) {
                hitsLink = true;
                break;
              }
            }
            if (hitsLink) break;
          }
          if (hitsLink) penalty += 4000;

          for (const cSeg of corridorBandObstacles) {
            if (
              clipSegmentToExpandedRect(
                cSeg.p1,
                cSeg.p2,
                rect.minX - cSeg.tol,
                rect.maxX + cSeg.tol,
                rect.minY - cSeg.tol,
                rect.maxY + cSeg.tol
              )
            ) {
              penalty += 3000;
              break;
            }
          }
          for (const uir of corridorUiRects) {
            if (rectsOverlap(rect, uir, 3)) {
              penalty += 2000;
              break;
            }
          }

          const sidePref = n.y < -0.5 ? 0 : n.x > 0.5 ? 1 : n.y > 0.5 ? 2 : 3;
          const cost =
            penalty +
            cand.tier * 1000 +
            (cand.isDestSeg ? 0 : 80) -
            Math.min(120, cand.subLen * 0.35) +
            sidePref * 0.5;

          if (cost < bestCost) {
            bestCost = cost;
            bestPt = { x: cx, y: cy };
            bestRect = rect;
          }
        }
      }

      if (bestPt && bestRect) {
        badgePt = bestPt;
        placedBadgeRects.push(bestRect);
      } else {
        badgePt = { x: points[0].x, y: points[0].y - BADGE_H / 2 - BADGE_CLEARANCE };
      }
    }

    resultMap.set(route.link.id, {
      linkId: route.link.id,
      source: route.source,
      target: route.target,
      points: route.points,
      startPort: route.startPort,
      endPort: route.endPort,
      badgePt,
      sDir: route.sDir,
      tDir: route.tDir
    });
  });

  cachedTopologyKey = topologyKey;
  cachedRoutes = resultMap;
  return resultMap;
};

export const getEffectiveContainerOutputEdge = (
  node: ContainerNode,
  nodesList: ContainerNode[],
  linksList: TransferLink[],
  corridorsList: RouteCorridor[] = []
): CardinalEdge => {
  if (node.outputEdge) return node.outputEdge;
  const routes = computeAllLinkRoutes(nodesList, linksList, corridorsList);
  const firstOutgoing = linksList.find((l) => l.sourceId === node.id);
  if (firstOutgoing) {
    const r = routes.get(firstOutgoing.id);
    if (r) return r.sDir;
  }
  return 'E';
};

