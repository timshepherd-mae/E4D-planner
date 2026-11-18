import { AvoidLib, type Avoid, type ConnDirFlags, type ShapeRef } from 'libavoid-js';
import { getLinkCorridorIds, type ContainerNode, type Point, type RouteCorridor, type TransferLink } from '../../models/types';

export type { Point };

export interface ComputedRoute {
  linkId: string;
  source: ContainerNode;
  target: ContainerNode;
  points: Point[];
  startPort: Point;
  endPort: Point;
  badgePt: Point;
}

type CardinalDirection = 'N' | 'S' | 'E' | 'W';

interface PortOption {
  point: Point;
  dir: CardinalDirection;
}

const CARD_W = 120;
const CARD_H = 80;
const LANE_SPACING = 12;

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
  target: ContainerNode
): { sDir: CardinalDirection; tDir: CardinalDirection } => {
  const srcPorts = getCardinalPorts(source);
  const tgtPorts = getCardinalPorts(target);

  const srcCenter = { x: source.x + CARD_W / 2, y: source.y + CARD_H / 2 };
  const tgtCenter = { x: target.x + CARD_W / 2, y: target.y + CARD_H / 2 };
  const dx = Math.abs(tgtCenter.x - srcCenter.x);
  const dy = Math.abs(tgtCenter.y - srcCenter.y);

  let bestScore = -Infinity;
  let bestFaces: { sDir: CardinalDirection; tDir: CardinalDirection } = {
    sDir: dx >= dy ? (tgtCenter.x >= srcCenter.x ? 'E' : 'W') : (tgtCenter.y >= srcCenter.y ? 'S' : 'N'),
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
          const primaryMatch = sIsVert ? dy >= dx : dx >= dy;
          const manhattanDist =
            Math.abs(bend.x - s.point.x) +
            Math.abs(bend.y - s.point.y) +
            Math.abs(t.point.x - bend.x) +
            Math.abs(t.point.y - bend.y);
          score = 200 + (primaryMatch ? 30 : 0) - manhattanDist * 0.05;
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

const isSegmentSharedInCorridor = (
  segA: { p1: Point; p2: Point },
  currentLinkId: string,
  allRoutes: { linkId: string; points: Point[] }[]
): boolean => {
  const isVertA = Math.abs(segA.p1.x - segA.p2.x) < 0.5;
  const isHorizA = Math.abs(segA.p1.y - segA.p2.y) < 0.5;
  const lenA = Math.hypot(segA.p2.x - segA.p1.x, segA.p2.y - segA.p1.y);
  if (lenA < 5) return false;

  for (const other of allRoutes) {
    if (other.linkId === currentLinkId) continue;
    for (let j = 0; j < other.points.length - 1; j++) {
      const segB = { p1: other.points[j], p2: other.points[j + 1] };
      const isVertB = Math.abs(segB.p1.x - segB.p2.x) < 0.5;
      const isHorizB = Math.abs(segB.p1.y - segB.p2.y) < 0.5;

      if (isVertA && isVertB) {
        const dx = Math.abs(segA.p1.x - segB.p1.x);
        if (dx <= 24) {
          const minY1 = Math.min(segA.p1.y, segA.p2.y);
          const maxY1 = Math.max(segA.p1.y, segA.p2.y);
          const minY2 = Math.min(segB.p1.y, segB.p2.y);
          const maxY2 = Math.max(segB.p1.y, segB.p2.y);
          const overlap = Math.min(maxY1, maxY2) - Math.max(minY1, minY2);
          if (overlap >= 25) return true;
        }
      } else if (isHorizA && isHorizB) {
        const dy = Math.abs(segA.p1.y - segB.p1.y);
        if (dy <= 24) {
          const minX1 = Math.min(segA.p1.x, segA.p2.x);
          const maxX1 = Math.max(segA.p1.x, segA.p2.x);
          const minX2 = Math.min(segB.p1.x, segB.p2.x);
          const maxX2 = Math.max(segB.p1.x, segB.p2.x);
          const overlap = Math.min(maxX1, maxX2) - Math.max(minX1, minX2);
          if (overlap >= 25) return true;
        }
      }
    }
  }
  return false;
};

const computeTopologyKey = (
  nodesList: ContainerNode[],
  linksList: TransferLink[],
  corridorsList: RouteCorridor[]
): string => {
  const nodeKey = nodesList.map((n) => `${n.id}:${n.x},${n.y}`).join('|');
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

      const sDir = selectBestSourceFaceTowardPoint(source, entryHint);
      const tDir = selectBestTargetFaceFromPoint(exitHint, target);
      validLinks.push({ link, source, target, sDir, tDir, corridorChain });
    } else {
      const { sDir, tDir } = selectBestCardinalFaces(source, target);
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
            const mouthAtt: MouthAttachment = !assign.isReversed
              ? {
                  stepKey: key,
                  role: 'entry',
                  mouthPt: entryPt,
                  lanePerp: (entryPt.x - baseStart.x) * sideNormStart.x + (entryPt.y - baseStart.y) * sideNormStart.y,
                  portPerp: (approachPt.x - baseStart.x) * sideNormStart.x + (approachPt.y - baseStart.y) * sideNormStart.y
                }
              : {
                  stepKey: key,
                  role: 'entry',
                  mouthPt: entryPt,
                  lanePerp: (entryPt.x - baseEnd.x) * sideNormEnd.x + (entryPt.y - baseEnd.y) * sideNormEnd.y,
                  portPerp: (approachPt.x - baseEnd.x) * sideNormEnd.x + (approachPt.y - baseEnd.y) * sideNormEnd.y
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
            const mouthAtt: MouthAttachment = !assign.isReversed
              ? {
                  stepKey: key,
                  role: 'exit',
                  mouthPt: exitPt,
                  lanePerp: (exitPt.x - baseEnd.x) * sideNormEnd.x + (exitPt.y - baseEnd.y) * sideNormEnd.y,
                  portPerp: (departurePt.x - baseEnd.x) * sideNormEnd.x + (departurePt.y - baseEnd.y) * sideNormEnd.y
                }
              : {
                  stepKey: key,
                  role: 'exit',
                  mouthPt: exitPt,
                  lanePerp: (exitPt.x - baseStart.x) * sideNormStart.x + (exitPt.y - baseStart.y) * sideNormStart.y,
                  portPerp: (departurePt.x - baseStart.x) * sideNormStart.x + (departurePt.y - baseStart.y) * sideNormStart.y
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
          const anchor = computeSafeStaggeredAnchor(att.mouthPt, outTangent, idx * STAGGER_STEP);
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
    if (group.length === 1) {
      const only = group[0];
      if (only.role === 'source') srcLaneOffsets.set(only.linkId, 0);
      else tgtLaneOffsets.set(only.linkId, 0);
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
  });

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
    corridorWaypointsSet: Set<string>;
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

      let nextPinClassId = 1;
      const pendingConnectors: {
        item: LinkWithFaces;
        startPort: Point;
        endPort: Point;
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

        const srcShape = shapeMap.get(item.source.id);
        const tgtShape = shapeMap.get(item.target.id);

        if (!srcShape || !tgtShape || item.source.id === item.target.id) {
          pendingConnectors.push({
            item,
            startPort,
            endPort,
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
          const firstEntryDirs = getPointEndDirs(
            firstEntryPt,
            firstOutTangent,
            startPort,
            entryAlongsideSet.has(firstEntryKey)
          );

          const lastStepIdx = totalSteps - 1;
          const lastStepMeta = item.corridorChain[lastStepIdx];
          const lastStep = anchoredSteps[lastStepIdx];
          const lastExitPt = lastStep[lastStep.length - 1];
          const lastOutTangent = getCorridorMouthVectors(lastStepMeta.corridor, lastStepMeta.isReversed).outTangent;
          const lastExitKey = makeStepKey(item.link.id, lastStepIdx);
          const lastExitDirs = getPointEndDirs(
            lastExitPt,
            lastOutTangent,
            endPort,
            exitAlongsideSet.has(lastExitKey)
          );

          const entryConn = router.addConnector(
            { shape: srcShape, pin: srcPinId },
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
            { shape: tgtShape, pin: tgtPinId }
          );

          pendingConnectors.push({
            item,
            startPort,
            endPort,
            anchoredSteps,
            directConn: null,
            entryConn,
            bridgeConns,
            exitConn
          });
        } else {
          const directConn = router.addConnector(
            { shape: srcShape, pin: srcPinId },
            { shape: tgtShape, pin: tgtPinId }
          );
          pendingConnectors.push({
            item,
            startPort,
            endPort,
            directConn,
            entryConn: null,
            bridgeConns: [],
            exitConn: null
          });
        }
      });

      router.processTransaction();

      pendingConnectors.forEach(({ item, startPort, endPort, anchoredSteps, directConn, entryConn, bridgeConns, exitConn }) => {
        const corridorWaypointsSet = new Set<string>();
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
            entryPts = r.length >= 2 ? r : buildFallbackPoints(startPort, firstEntryPt, item.sDir, outTangentToArrivalDir(firstOut));
          } else {
            entryPts = buildFallbackPoints(startPort, firstEntryPt, item.sDir, outTangentToArrivalDir(firstOut));
          }

          let exitPts: Point[];
          if (exitConn && exitConn.hasValidRoute()) {
            const r = exitConn.displayRoute().map((p) => ({ x: p.x, y: p.y }));
            exitPts = r.length >= 2 ? r : buildFallbackPoints(lastExitPt, endPort, outTangentToArrivalDir(lastOut), item.tDir);
          } else {
            exitPts = buildFallbackPoints(lastExitPt, endPort, outTangentToArrivalDir(lastOut), item.tDir);
          }

          const combined: Point[] = [...entryPts];
          anchoredSteps.forEach((stepPts, sIdx) => {
            for (let i = 0; i < stepPts.length - 1; i++) {
              corridorWaypointsSet.add(
                `${Math.round(stepPts[i].x)},${Math.round(stepPts[i].y)}->${Math.round(stepPts[i + 1].x)},${Math.round(stepPts[i + 1].y)}`
              );
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
            points = routePts.length >= 2 ? simplifyCollinear(routePts) : buildFallbackPoints(startPort, endPort, item.sDir, item.tDir);
          } else {
            points = buildFallbackPoints(startPort, endPort, item.sDir, item.tDir);
          }
        }

        tempRoutes.push({
          link: item.link,
          source: item.source,
          target: item.target,
          points,
          startPort,
          endPort,
          corridorWaypointsSet
        });
      });
    } finally {
      router.delete();
    }
  } else {
    validLinks.forEach((item) => {
      const srcOffset = srcLaneOffsets.get(item.link.id) || 0;
      const tgtOffset = tgtLaneOffsets.get(item.link.id) || 0;
      const startPort = getPortWithLaneOffset(item.source, item.sDir, srcOffset);
      const endPort = getPortWithLaneOffset(item.target, item.tDir, tgtOffset);
      const corridorWaypointsSet = new Set<string>();

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

        const entryPts = buildFallbackPoints(startPort, firstEntryPt, item.sDir, outTangentToArrivalDir(firstOut));
        const exitPts = buildFallbackPoints(lastExitPt, endPort, outTangentToArrivalDir(lastOut), item.tDir);

        const combined: Point[] = [...entryPts];
        anchoredSteps.forEach((stepPts, sIdx) => {
          for (let i = 0; i < stepPts.length - 1; i++) {
            corridorWaypointsSet.add(
              `${Math.round(stepPts[i].x)},${Math.round(stepPts[i].y)}->${Math.round(stepPts[i + 1].x)},${Math.round(stepPts[i + 1].y)}`
            );
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
        points = buildFallbackPoints(startPort, endPort, item.sDir, item.tDir);
      }

      tempRoutes.push({
        link: item.link,
        source: item.source,
        target: item.target,
        points,
        startPort,
        endPort,
        corridorWaypointsSet
      });
    });
  }

  // 5. Calculate badge positions away from shared corridors & tight route corridor trunks
  const allRouteSummaries = tempRoutes.map((r) => ({ linkId: r.link.id, points: r.points }));

  tempRoutes.forEach((route, linkIdx) => {
    const points = route.points;
    let badgePt: Point;

    if (points.length <= 1) {
      badgePt = points[0] || { x: 0, y: 0 };
    } else if (points.length === 2) {
      badgePt = {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2
      };
    } else {
      interface SegCandidate {
        index: number;
        p1: Point;
        p2: Point;
        length: number;
        isShared: boolean;
        inCorridor: boolean;
      }

      const segments: SegCandidate[] = [];
      for (let i = 0; i < points.length - 1; i++) {
        const p1 = points[i];
        const p2 = points[i + 1];
        const length = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const segKey = `${Math.round(p1.x)},${Math.round(p1.y)}->${Math.round(p2.x)},${Math.round(p2.y)}`;
        const inCorridor = route.corridorWaypointsSet.has(segKey);
        const isShared = inCorridor || isSegmentSharedInCorridor({ p1, p2 }, route.link.id, allRouteSummaries);
        segments.push({ index: i, p1, p2, length, isShared, inCorridor });
      }

      const destSeg = segments[segments.length - 1];
      if (!destSeg.isShared && !destSeg.inCorridor && destSeg.length >= 35) {
        badgePt = {
          x: (destSeg.p1.x + destSeg.p2.x) / 2,
          y: (destSeg.p1.y + destSeg.p2.y) / 2
        };
      } else {
        const unshared = segments
          .filter((s) => !s.isShared && !s.inCorridor && s.length >= 30)
          .sort((a, b) => b.length - a.length)[0];

        if (unshared) {
          badgePt = {
            x: (unshared.p1.x + unshared.p2.x) / 2,
            y: (unshared.p1.y + unshared.p2.y) / 2
          };
        } else {
          const exteriorLongest = segments
            .filter((s) => !s.inCorridor && s.length >= 16)
            .sort((a, b) => b.length - a.length)[0];
          const chosen = exteriorLongest || segments.slice().sort((a, b) => b.length - a.length)[0];
          if (chosen) {
            const t = linkIdx % 2 === 0 ? 0.35 : 0.65;
            badgePt = {
              x: chosen.p1.x + (chosen.p2.x - chosen.p1.x) * t,
              y: chosen.p1.y + (chosen.p2.y - chosen.p1.y) * t
            };
          } else {
            badgePt = { x: points[0].x, y: points[0].y };
          }
        }
      }
    }

    resultMap.set(route.link.id, {
      linkId: route.link.id,
      source: route.source,
      target: route.target,
      points: route.points,
      startPort: route.startPort,
      endPort: route.endPort,
      badgePt
    });
  });

  cachedTopologyKey = topologyKey;
  cachedRoutes = resultMap;
  return resultMap;
};

