import { CardinalEdge, ContainerNode, TransferLink, SimFrame, MaterialDefinition, RouteCorridor, Point, getLinkCorridorIds } from '../models/types';
import { SimEngine, OverflowMode, StrictSubRule } from '../simulation/SimEngine';

export class CanvasViewModel {
  private nodes: ContainerNode[];
  private links: TransferLink[];
  private corridors: RouteCorridor[] = [];
  private materials: MaterialDefinition[];
  private frames: SimFrame[] = [];
  private currentFrameIndex: number = 0;
  private isPlayback: boolean = false;
  private overflowMode: OverflowMode = 'strict';

  constructor() {
    this.materials = [
      { code: 'TOPS', name: 'Topsoil', bulkIN: 1.20, bulkOUT: 0.95 },
      { code: 'CLAY', name: 'Stiff Clay', bulkIN: 1.25, bulkOUT: 0.90 },
      { code: 'ROCK', name: 'Solid Rock', bulkIN: 1.40, bulkOUT: 0.80 },
      { code: 'SAND', name: 'Clean Sand', bulkIN: 1.10, bulkOUT: 1.00 }
    ];

    this.nodes = [
      {
        id: 'node-1',
        name: 'Source Cut A',
        type: 'excavation',
        x: 120,
        y: 260,
        capacity: 50000,
        currentVolume: 42000,
        materialType: 'CLAY',
        plantCount: 4,
        overflowMode: 'strict',
        strictSubRule: 'throttleback',
        headroomThreshold: 500,
        status: 'active',
        notes: 'Primary clay excavation face. Haul routes prioritized to Buffer B.'
      },
      {
        id: 'node-2',
        name: 'Buffer Stockpile B',
        type: 'stockpile',
        x: 440,
        y: 160,
        capacity: 30000,
        currentVolume: 12500,
        materialType: 'CLAY',
        plantCount: 2,
        overflowMode: 'strict',
        strictSubRule: 'headroom_hold',
        headroomThreshold: 7500,
        status: 'active',
        notes: 'Intermediate surge stockpile with active CAT excavator.'
      },
      {
        id: 'node-3',
        name: 'Processing Plant C',
        type: 'external',
        x: 740,
        y: 280,
        capacity: 100000,
        currentVolume: 65000,
        materialType: 'CLAY',
        plantCount: 6,
        overflowMode: 'strict',
        strictSubRule: 'throttleback',
        headroomThreshold: 500,
        status: 'active',
        notes: 'Main processing and crushing hopper facility.'
      },
      {
        id: 'node-1793348480587',
        name: 'New Container 4',
        type: 'excavation',
        x: 120,
        y: 352,
        capacity: 50000,
        currentVolume: 30000,
        materialType: 'CLAY',
        plantCount: 4,
        overflowMode: 'strict',
        strictSubRule: 'throttleback',
        headroomThreshold: 500,
        status: 'active',
        notes: 'Primary clay excavation face. Haul routes prioritized to Buffer B.'
      },
      {
        id: 'node-1793348494431',
        name: 'New Container 5',
        type: 'excavation',
        x: 120,
        y: 444,
        capacity: 50000,
        currentVolume: 12500,
        materialType: 'CLAY',
        plantCount: 4,
        overflowMode: 'strict',
        strictSubRule: 'throttleback',
        headroomThreshold: 500,
        status: 'active',
        notes: 'Primary clay excavation face. Haul routes prioritized to Buffer B.'
      }
    ];

    this.links = [
      {
        id: 'link-1',
        sourceId: 'node-1',
        targetId: 'node-2',
        dailyRate: 1500,
        fleetCount: 5,
        priority: 1,
        notes: 'Direct internal route; 5 articulated units assigned.'
      },
      {
        id: 'link-2',
        sourceId: 'node-2',
        targetId: 'node-3',
        dailyRate: 1200,
        fleetCount: 4,
        priority: 1,
        notes: 'Crusher feed line; continuous material flow.'
      },
      {
        id: 'link-1793348520208',
        sourceId: 'node-1793348494431',
        targetId: 'node-2',
        dailyRate: 1000,
        fleetCount: 3,
        priority: 1,
        notes: ''
      },
      {
        id: 'link-1793348529412',
        sourceId: 'node-1793348480587',
        targetId: 'node-2',
        dailyRate: 1000,
        fleetCount: 3,
        priority: 1,
        notes: ''
      }
    ];

    this.recalculateSimulation();
  }

  public getMaterials(): MaterialDefinition[] { return this.materials; }
  
  public addMaterial(material: MaterialDefinition): void {
    this.materials.push(material);
    this.recalculateSimulation();
  }

  public updateMaterial(index: number, field: keyof MaterialDefinition, value: any): void {
    if (this.materials[index]) {
      (this.materials[index] as any)[field] = value;
      this.recalculateSimulation();
    }
  }

  public removeMaterial(code: string): void {
    this.materials = this.materials.filter(m => m.code !== code);
    this.recalculateSimulation();
  }

  public setOverflowMode(mode: OverflowMode): void {
    this.overflowMode = mode;
    this.recalculateSimulation();
  }

  public getOverflowMode(): OverflowMode {
    return this.overflowMode;
  }

  public applyGlobalPreset(mode: OverflowMode, subRule: StrictSubRule = 'throttleback'): void {
    this.nodes.forEach(node => {
      node.overflowMode = mode;
      node.strictSubRule = subRule;
    });
    this.recalculateSimulation();
  }

  public setMaterials(materials: MaterialDefinition[]): void {
    this.materials = materials;
    this.recalculateSimulation();
  }

  public loadModel(
    nodes: ContainerNode[],
    links: TransferLink[],
    materials?: MaterialDefinition[],
    corridors?: RouteCorridor[]
  ): void {
    if (materials && materials.length > 0) {
      this.materials = materials;
    }
    const validNodeIds = new Set(nodes.map(n => n.id));
    this.nodes = nodes;
    this.links = links
      .filter(l => validNodeIds.has(l.sourceId) && validNodeIds.has(l.targetId))
      .map(l => {
        const ids = getLinkCorridorIds(l);
        const copy: TransferLink = { ...l };
        delete copy.corridorId;
        if (ids.length > 0) copy.corridorIds = ids;
        else delete copy.corridorIds;
        return copy;
      });
    this.corridors = corridors ? corridors.map(c => ({ ...c, waypoints: c.waypoints.map(p => ({ ...p })) })) : [];
    this.currentFrameIndex = 0;
    this.recalculateSimulation();
  }

  public recalculateSimulation(): void {
    const engine = new SimEngine(this.nodes, this.links, this.materials, 30, this.overflowMode);
    this.frames = engine.runSimulation();
  }

  public getNodes(): ContainerNode[] { return this.nodes; }
  public getLinks(): TransferLink[] { return this.links; }
  public getCorridors(): RouteCorridor[] { return this.corridors; }
  public getFrames(): SimFrame[] { return this.frames; }
  public getCurrentFrame(): SimFrame { return this.frames[this.currentFrameIndex] || this.frames[0]; }
  
  public setFrameIndex(index: number): void {
    if (index >= 0 && index < this.frames.length) {
      this.currentFrameIndex = index;
    }
  }

  public setPlayback(val: boolean): void {
    this.isPlayback = val;
    if (val) {
      this.recalculateSimulation();
      this.currentFrameIndex = 0;
    }
  }

  public getPlayback(): boolean { return this.isPlayback; }

  public addNode(node: ContainerNode): void {
    this.nodes.push(node);
    this.recalculateSimulation();
  }

  public removeNode(id: string): void {
    this.nodes = this.nodes.filter(n => n.id !== id);
    this.links = this.links.filter(l => l.sourceId !== id && l.targetId !== id);
    this.recalculateSimulation();
  }

  public addLink(link: TransferLink): void {
    this.links.push(link);
    this.recalculateSimulation();
  }

  public removeLink(id: string): void {
    this.links = this.links.filter(l => l.id !== id);
    this.recalculateSimulation();
  }

  public updateNodePosition(id: string, x: number, y: number): void {
    const node = this.nodes.find(n => n.id === id);
    if (node) {
      node.x = x;
      node.y = y;
    }
  }

  public updateNode(id: string, updates: Partial<ContainerNode>): void {
    const node = this.nodes.find(n => n.id === id);
    if (node) {
      Object.assign(node, updates);
      this.recalculateSimulation();
    }
  }

  public setNodeOutputEdge(id: string, outputEdge?: CardinalEdge): void {
    const node = this.nodes.find(n => n.id === id);
    if (node) {
      if (outputEdge) node.outputEdge = outputEdge;
      else delete node.outputEdge;
    }
  }

  public updateNodes(filterFn: (node: ContainerNode) => boolean, updates: Partial<ContainerNode>): void {
    this.nodes.forEach(node => {
      if (filterFn(node)) {
        Object.assign(node, updates);
      }
    });
    this.recalculateSimulation();
  }

  public updateLink(id: string, updates: Partial<TransferLink>): void {
    const link = this.links.find(l => l.id === id);
    if (link) {
      Object.assign(link, updates);
      this.recalculateSimulation();
    }
  }

  public addCorridor(corridor: RouteCorridor): void {
    this.corridors.push(corridor);
  }

  public removeCorridor(id: string): void {
    this.corridors = this.corridors.filter(c => c.id !== id);
    this.links.forEach(l => {
      const nextIds = getLinkCorridorIds(l).filter(cid => cid !== id);
      delete l.corridorId;
      if (nextIds.length > 0) l.corridorIds = nextIds;
      else delete l.corridorIds;
    });
  }

  public updateCorridor(id: string, updates: Partial<RouteCorridor>): void {
    const corridor = this.corridors.find(c => c.id === id);
    if (corridor) {
      Object.assign(corridor, updates);
    }
  }

  public updateCorridorWaypoint(id: string, index: number, pt: Point): void {
    const corridor = this.corridors.find(c => c.id === id);
    if (corridor && corridor.waypoints[index]) {
      corridor.waypoints[index] = { x: pt.x, y: pt.y };
    }
  }

  public insertCorridorWaypoint(id: string, insertIndex: number, pt: Point): void {
    const corridor = this.corridors.find(c => c.id === id);
    if (corridor && insertIndex >= 1 && insertIndex <= corridor.waypoints.length - 1) {
      corridor.waypoints.splice(insertIndex, 0, { x: pt.x, y: pt.y });
    }
  }

  public removeCorridorWaypoint(id: string, index: number): boolean {
    const corridor = this.corridors.find(c => c.id === id);
    if (!corridor || corridor.waypoints.length <= 2) return false;
    if (index >= 0 && index < corridor.waypoints.length) {
      corridor.waypoints.splice(index, 1);
      return true;
    }
    return false;
  }

  public toggleLinkCorridor(linkId: string, corridorId: string, assign: boolean): void {
    const link = this.links.find(l => l.id === linkId);
    if (!link) return;
    const current = getLinkCorridorIds(link);
    const next = assign
      ? current.includes(corridorId)
        ? current
        : [...current, corridorId]
      : current.filter(id => id !== corridorId);
    delete link.corridorId;
    if (next.length > 0) link.corridorIds = next;
    else delete link.corridorIds;
  }

  public addLinksToCorridors(corridorIds: string[], linkIds: string[]): number {
    const targetLinkSet = new Set(linkIds);
    let addedCount = 0;
    this.links.forEach(link => {
      if (!targetLinkSet.has(link.id)) return;
      const current = getLinkCorridorIds(link);
      const next = [...current];
      let changed = false;
      corridorIds.forEach(corridorId => {
        if (!next.includes(corridorId)) {
          next.push(corridorId);
          addedCount++;
          changed = true;
        }
      });
      if (changed) {
        delete link.corridorId;
        link.corridorIds = next;
      }
    });
    return addedCount;
  }

  public unlinkLinksFromCorridors(linkIds: string[], specificCorridorIds?: string[]): number {
    const targetSet = new Set(linkIds);
    const specificSet = specificCorridorIds && specificCorridorIds.length > 0 ? new Set(specificCorridorIds) : null;
    let count = 0;
    this.links.forEach(link => {
      if (!targetSet.has(link.id)) return;
      const current = getLinkCorridorIds(link);
      if (current.length === 0) return;

      const next = specificSet ? current.filter(id => !specificSet.has(id)) : [];
      if (next.length !== current.length) {
        count++;
        delete link.corridorId;
        if (next.length > 0) link.corridorIds = next;
        else delete link.corridorIds;
      }
    });
    return count;
  }

  public clearCorridorLinks(corridorIds: string[]): number {
    const corridorSet = new Set(corridorIds);
    let count = 0;
    this.links.forEach(link => {
      const current = getLinkCorridorIds(link);
      const next = current.filter(id => !corridorSet.has(id));
      if (next.length !== current.length) {
        count += current.length - next.length;
        delete link.corridorId;
        if (next.length > 0) link.corridorIds = next;
        else delete link.corridorIds;
      }
    });
    return count;
  }
}