import {
  ContainerNode,
  TransferLink,
  RouteCorridor,
  CalendarModel,
  CalendarEvent,
  SimFrame,
  MaterialDefinition,
  FlowStatus,
  getLinkCorridorIds
} from '../models/types';

export type OverflowMode = 'strict' | 'overfill';
export type StrictSubRule = 'throttleback' | 'headroom_hold';

export class SimEngine {
  private nodes: Map<string, ContainerNode>;
  private links: Map<string, TransferLink>;
  private corridors: Map<string, RouteCorridor>;
  private materials: Map<string, MaterialDefinition>;
  private calendar?: CalendarModel;
  private totalDays: number;
  private defaultOverflowMode: OverflowMode;
  private headroomHoldStates: Map<string, boolean> = new Map();

  constructor(
    nodes: ContainerNode[],
    links: TransferLink[],
    materials: MaterialDefinition[] = [],
    totalDays: number = 30,
    overflowMode: OverflowMode = 'strict',
    corridors: RouteCorridor[] = [],
    calendar?: CalendarModel
  ) {
    this.nodes = new Map(nodes.map(n => [n.id, { ...n }]));
    this.links = new Map(links.map(l => [l.id, { ...l }]));
    this.corridors = new Map(corridors.map(c => [c.id, { ...c }]));
    this.materials = new Map(materials.map(m => [m.code, { ...m }]));
    this.calendar = calendar
      ? { ...calendar, events: (calendar.events || []).map(e => ({ ...e })) }
      : undefined;
    this.totalDays = totalDays;
    this.defaultOverflowMode = overflowMode;
  }

  public runSimulation(): SimFrame[] {
    const frames: SimFrame[] = [];
    const EPS = 1e-6;
    this.headroomHoldStates.clear();

    const allEvents = this.calendar?.events || [];

    for (let day = 0; day <= this.totalDays; day++) {
      const alerts: string[] = [];
      const nodeVolumes: Record<string, number> = {};
      const linkFlows: Record<string, number> = {};

      // Snapshot start-of-day volumes to accurately classify source starvation vs capacity blocks
      const startOfDayVolumes: Record<string, number> = {};
      this.nodes.forEach(n => {
        startOfDayVolumes[n.id] = n.currentVolume;
      });

      // Resolve active calendar events for this simulation day (Day 0 is always frozen baseline)
      const activeContainerEvents = new Map<string, CalendarEvent>();
      const activeTransferEvents = new Map<string, CalendarEvent>();
      const activeRouteEvents = new Map<string, CalendarEvent>();

      if (day >= 1 && allEvents.length > 0) {
        for (const evt of allEvents) {
          if (day >= evt.startDay && day <= evt.endDay) {
            if (evt.targetType === 'container') {
              activeContainerEvents.set(evt.targetId, evt);
            } else if (evt.targetType === 'transfer') {
              activeTransferEvents.set(evt.targetId, evt);
            } else if (evt.targetType === 'route') {
              activeRouteEvents.set(evt.targetId, evt);
            }
          }
        }
      }

      // Helper to determine whether a container is effectively blocked on this day
      const isNodeEffectivelyBlocked = (node: ContainerNode): { blocked: boolean; byCalendar: boolean } => {
        const calEvt = activeContainerEvents.get(node.id);
        if (calEvt) {
          if (calEvt.state === 'blocked') return { blocked: true, byCalendar: true };
          if (calEvt.state === 'open') return { blocked: false, byCalendar: false };
        }
        return {
          blocked: node.status === 'blocked' || node.status === 'maintenance',
          byCalendar: false
        };
      };

      // Resolve effective daily target rate per transfer link (Calendar overrides stated rate)
      const activeLinkRates: Map<string, number> = new Map();
      const calendarStoppedLinks = new Set<string>();

      this.links.forEach(link => {
        let currentRate = link.dailyRate;
        if (link.rateSchedule && link.rateSchedule.length > 0) {
          const sorted = [...link.rateSchedule].sort((a, b) => a.day - b.day);
          for (const sched of sorted) {
            if (day >= sched.day) {
              currentRate = sched.rate;
            }
          }
        }

        const calEvt = activeTransferEvents.get(link.id);
        if (calEvt) {
          if (calEvt.state === 'stopped') {
            currentRate = 0;
            calendarStoppedLinks.add(link.id);
          } else if (calEvt.state === 'max') {
            currentRate = link.dailyRate;
          } else if (calEvt.state === 'variable') {
            currentRate = Math.max(0, Number.isFinite(calEvt.rateValue) ? (calEvt.rateValue as number) : link.dailyRate);
          }
        }

        activeLinkRates.set(link.id, currentRate);
      });

      const plannedTransfers: Map<string, number> = new Map();
      const requestedTransfers: Map<string, number> = new Map();

      // Step 1: Outbound source availability and allocation
      // Group links by source to ensure multi-link sources don't create phantom material
      const sourceOutboundLinks: Map<string, TransferLink[]> = new Map();
      this.links.forEach(link => {
        const list = sourceOutboundLinks.get(link.sourceId) || [];
        list.push(link);
        sourceOutboundLinks.set(link.sourceId, list);
      });

      sourceOutboundLinks.forEach((outboundLinks, sourceId) => {
        const source = this.nodes.get(sourceId);
        if (!source) {
          outboundLinks.forEach(l => requestedTransfers.set(l.id, 0));
          return;
        }

        const sourceBlockState = isNodeEffectivelyBlocked(source);
        if (sourceBlockState.blocked) {
          outboundLinks.forEach(l => requestedTransfers.set(l.id, 0));
          if (day > 0) {
            const msg = sourceBlockState.byCalendar
              ? `Day ${day}: Container ${source.name} is blocked by calendar schedule.`
              : `Day ${day}: Source ${source.name} is blocked or under maintenance.`;
            if (!alerts.includes(msg)) alerts.push(msg);
          }
          return;
        }

        if (source.currentVolume <= EPS) {
          outboundLinks.forEach(l => requestedTransfers.set(l.id, 0));
          if (day > 0 && !alerts.includes(`Day ${day}: Stockout at source ${source.name}.`)) {
            alerts.push(`Day ${day}: Stockout at source ${source.name}.`);
          }
          return;
        }

        let totalOutboundRate = 0;
        const validLinks: TransferLink[] = [];

        outboundLinks.forEach(link => {
          const target = this.nodes.get(link.targetId);
          if (!target) {
            requestedTransfers.set(link.id, 0);
            return;
          }

          if (target.allowedMaterials && target.allowedMaterials.length > 0) {
            if (!target.allowedMaterials.includes(source.materialType)) {
              requestedTransfers.set(link.id, 0);
              if (day > 0 && !alerts.includes(`Day ${day}: Material mismatch between ${source.name} (${source.materialType}) and target ${target.name}.`)) {
                alerts.push(`Day ${day}: Material mismatch between ${source.name} (${source.materialType}) and target ${target.name}.`);
              }
              return;
            }
          }

          const rate = activeLinkRates.get(link.id) ?? link.dailyRate;
          if (rate <= EPS) {
            requestedTransfers.set(link.id, 0);
            return;
          }
          totalOutboundRate += rate;
          validLinks.push(link);
        });

        // If source material is less than total outbound demand, share pro-rata
        const availableVol = source.currentVolume;
        if (totalOutboundRate > 0) {
          const sourceRatio = Math.min(1.0, availableVol / totalOutboundRate);
          validLinks.forEach(link => {
            const rate = activeLinkRates.get(link.id) ?? link.dailyRate;
            requestedTransfers.set(link.id, rate * sourceRatio);
          });
        }
      });

      // Step 1.5: Route corridor calendar constraints (blocked & restricted pro-rata combined cap)
      const routeBlockedLinks = new Set<string>();
      const routeRestrictedLinks = new Set<string>();
      const routeThrottledCorridors = new Set<string>();

      if (day >= 1 && activeRouteEvents.size > 0) {
        // First apply route 'blocked' events
        activeRouteEvents.forEach((evt, corridorId) => {
          if (evt.state !== 'blocked') return;
          const corridorName = this.corridors.get(corridorId)?.name || corridorId;
          const msg = `Day ${day}: Route ${corridorName} is blocked by calendar schedule.`;
          if (!alerts.includes(msg)) alerts.push(msg);

          this.links.forEach(link => {
            if (getLinkCorridorIds(link).includes(corridorId)) {
              requestedTransfers.set(link.id, 0);
              routeBlockedLinks.add(link.id);
            }
          });
        });

        // Next evaluate route 'restricted' combined-cap pro-rata throttling
        // Compute tightest cap per link across any restricted corridors it uses
        const postRouteCaps = new Map<string, number>();
        activeRouteEvents.forEach((evt, corridorId) => {
          if (evt.state !== 'restricted') return;
          const corridorName = this.corridors.get(corridorId)?.name || corridorId;
          const cap = Math.max(0, Number.isFinite(evt.rateValue) ? (evt.rateValue as number) : 0);

          const corridorLinks: TransferLink[] = [];
          let totalCorridorDemand = 0;
          this.links.forEach(link => {
            if (routeBlockedLinks.has(link.id)) return;
            if (getLinkCorridorIds(link).includes(corridorId)) {
              const req = requestedTransfers.get(link.id) || 0;
              if (req > EPS) {
                corridorLinks.push(link);
                totalCorridorDemand += req;
              }
            }
          });

          if (cap <= EPS) {
            corridorLinks.forEach(link => {
              postRouteCaps.set(link.id, 0);
              routeBlockedLinks.add(link.id);
            });
            routeThrottledCorridors.add(corridorId);
            const msg = `Day ${day}: Route ${corridorName} restricted to 0 m³/d (halted).`;
            if (!alerts.includes(msg)) alerts.push(msg);
          } else if (totalCorridorDemand > cap + EPS) {
            const ratio = cap / totalCorridorDemand;
            routeThrottledCorridors.add(corridorId);
            corridorLinks.forEach(link => {
              const req = requestedTransfers.get(link.id) || 0;
              const capped = req * ratio;
              const existingCap = postRouteCaps.get(link.id);
              postRouteCaps.set(link.id, existingCap === undefined ? capped : Math.min(existingCap, capped));
            });
            const msg = `Day ${day}: Route ${corridorName} restricted to ${Math.round(cap).toLocaleString()} m³/d (transfers throttled pro-rata).`;
            if (!alerts.includes(msg)) alerts.push(msg);
          }
        });

        postRouteCaps.forEach((cappedAmount, linkId) => {
          const prevReq = requestedTransfers.get(linkId) || 0;
          if (cappedAmount < prevReq - EPS) {
            requestedTransfers.set(linkId, Math.max(0, cappedAmount));
            if (cappedAmount > EPS) {
              routeRestrictedLinks.add(linkId);
            }
          }
        });
      }

      // Step 2: Target capacity constraints, target calendar blocks, and throttling
      const targetInflows: Map<string, TransferLink[]> = new Map();
      this.links.forEach(link => {
        const target = this.nodes.get(link.targetId);
        if (target) {
          const list = targetInflows.get(link.targetId) || [];
          list.push(link);
          targetInflows.set(link.targetId, list);
        }
      });

      targetInflows.forEach((inboundLinks, targetId) => {
        const target = this.nodes.get(targetId);
        if (!target) return;

        // If target container is blocked (via calendar or static status), halt all inbound transfers
        const targetBlockState = isNodeEffectivelyBlocked(target);
        if (targetBlockState.blocked) {
          inboundLinks.forEach(link => {
            plannedTransfers.set(link.id, 0);
            linkFlows[link.id] = 0;
          });
          if (day > 0) {
            const msg = targetBlockState.byCalendar
              ? `Day ${day}: Container ${target.name} is blocked by calendar schedule.`
              : `Day ${day}: Target ${target.name} is blocked or under maintenance.`;
            if (!alerts.includes(msg)) alerts.push(msg);
          }
          return;
        }

        const overflowMode = target.overflowMode || this.defaultOverflowMode;
        const subRule = target.strictSubRule || 'throttleback';
        const headroomThreshold = target.headroomThreshold ?? 500;

        const currentVol = target.currentVolume;
        const capacity = target.capacity;
        const headroom = Math.max(0, capacity - currentVol);

        let isHalted = this.headroomHoldStates.get(targetId) || false;

        if (overflowMode === 'strict' && subRule === 'headroom_hold') {
          if (currentVol >= capacity) {
            isHalted = true;
          } else if (isHalted && headroom < headroomThreshold) {
            isHalted = true;
          } else if (isHalted && headroom >= headroomThreshold) {
            isHalted = false;
          }
          this.headroomHoldStates.set(targetId, isHalted);
        }

        let totalRequestedForTarget = 0;
        inboundLinks.forEach(link => {
          totalRequestedForTarget += (requestedTransfers.get(link.id) || 0);
        });

        if (overflowMode === 'overfill') {
          inboundLinks.forEach(link => {
            const req = requestedTransfers.get(link.id) || 0;
            plannedTransfers.set(link.id, (day === 0) ? 0 : req);
            linkFlows[link.id] = (day === 0) ? 0 : req;
          });
        } else {
          if (subRule === 'headroom_hold' && isHalted) {
            inboundLinks.forEach(link => {
              plannedTransfers.set(link.id, 0);
              linkFlows[link.id] = 0;
            });
            if (day > 0) {
              const alertMsg = `Day ${day}: Target ${target.name} awaiting headroom threshold (${headroomThreshold} m³ spare required).`;
              if (!alerts.includes(alertMsg)) alerts.push(alertMsg);
            }
          } else {
            const allowableHeadroom = headroom;
            const throttleFactor = totalRequestedForTarget > 0
              ? Math.min(1.0, allowableHeadroom / totalRequestedForTarget)
              : 1.0;

            inboundLinks.forEach(link => {
              const req = requestedTransfers.get(link.id) || 0;
              const actual = (subRule === 'throttleback') ? (req * throttleFactor) : (headroom > 0 ? req : 0);
              plannedTransfers.set(link.id, (day === 0) ? 0 : Math.max(0, actual));
              linkFlows[link.id] = (day === 0) ? 0 : Math.max(0, actual);
            });

            if (day > 0 && totalRequestedForTarget > allowableHeadroom && subRule === 'throttleback') {
              const alertMsg = `Day ${day}: Target ${target.name} nearing capacity. Transfer rates throttled pro-rata.`;
              if (!alerts.includes(alertMsg)) alerts.push(alertMsg);
            }
          }
        }
      });

      // Step 3: Apply physical transfers
      if (day > 0) {
        this.links.forEach(link => {
          const source = this.nodes.get(link.sourceId);
          const target = this.nodes.get(link.targetId);
          const transferAmount = plannedTransfers.get(link.id) || 0;

          if (source && target && transferAmount > 0) {
            const mat = this.materials.get(source.materialType);
            const bulkOut = mat ? mat.bulkOUT : 1.0;
            const bulkIn = mat ? mat.bulkIN : 1.0;

            const volumeRemoved = transferAmount * bulkOut;
            const remainingSource = source.currentVolume - volumeRemoved;
            source.currentVolume = remainingSource < EPS ? 0 : remainingSource;

            const volumeAdded = transferAmount * bulkIn;
            const targetOverflowMode = target.overflowMode || this.defaultOverflowMode;
            target.currentVolume = targetOverflowMode === 'overfill'
              ? target.currentVolume + volumeAdded
              : Math.min(target.capacity, target.currentVolume + volumeAdded);
          }
        });
      }

      // Record resulting node volumes & capacity alerts
      this.nodes.forEach(node => {
        nodeVolumes[node.id] = node.currentVolume;
        if (node.currentVolume > node.capacity) {
          const excess = node.currentVolume - node.capacity;
          const targetOverflowMode = node.overflowMode || this.defaultOverflowMode;
          const alertMsg = targetOverflowMode === 'overfill'
            ? `Day ${day}: [OVERFILL] Node ${node.name} exceeded capacity by ${Math.round(excess).toLocaleString()} m³!`
            : `Day ${day}: Node ${node.name} reached capacity!`;
          if (!alerts.includes(alertMsg)) {
            alerts.push(alertMsg);
          }
        }
      });

      // Step 4: Classify Link, Node, and Route Corridor visual flow statuses:
      // Blue: Day 0 (frozen) + empty containers + lack of material
      // Green: flowing at full rate
      // Amber: flowing at restricted rate (downstream throttleback, route cap, or reduced variable transfer rate)
      // Red: blocked from sending/receiving (capacity, maintenance, or calendar blocked/stopped)
      const linkStatuses: Record<string, FlowStatus> = {};
      const nodeStatuses: Record<string, FlowStatus> = {};
      const corridorStatuses: Record<string, FlowStatus> = {};

      if (day === 0) {
        this.links.forEach(l => { linkStatuses[l.id] = 'frozen'; });
        this.nodes.forEach(n => { nodeStatuses[n.id] = 'frozen'; });
        this.corridors.forEach(c => { corridorStatuses[c.id] = 'frozen'; });
      } else {
        // Link status classification
        this.links.forEach(link => {
          const source = this.nodes.get(link.sourceId);
          const target = this.nodes.get(link.targetId);
          const linkRate = activeLinkRates.get(link.id) ?? link.dailyRate;
          const actualFlow = linkFlows[link.id] ?? 0;
          const requestedFlow = requestedTransfers.get(link.id) ?? 0;
          const startVol = startOfDayVolumes[link.sourceId] ?? 0;
          const transferCalEvt = activeTransferEvents.get(link.id);
          const sourceBlocked = source ? isNodeEffectivelyBlocked(source).blocked : false;
          const targetBlocked = target ? isNodeEffectivelyBlocked(target).blocked : false;

          if (!source || !target) {
            linkStatuses[link.id] = 'frozen';
          } else if (calendarStoppedLinks.has(link.id) || routeBlockedLinks.has(link.id)) {
            linkStatuses[link.id] = 'blocked';
          } else if (transferCalEvt?.state === 'variable' && linkRate <= EPS) {
            linkStatuses[link.id] = 'blocked';
          } else if (linkRate <= EPS) {
            linkStatuses[link.id] = 'frozen';
          } else if (sourceBlocked || targetBlocked) {
            linkStatuses[link.id] = 'blocked';
          } else if (startVol <= EPS) {
            // Source was already empty at start of day (blue)
            linkStatuses[link.id] = 'starved';
          } else if (actualFlow <= EPS) {
            // Blocked from sending/receiving due to capacity issues, headroom hold, or material mismatch (red)
            linkStatuses[link.id] = 'blocked';
          } else if (
            routeRestrictedLinks.has(link.id) ||
            (actualFlow < requestedFlow - EPS && source.currentVolume > EPS)
          ) {
            // Flowing at restricted rate due to route corridor cap or downstream capacity throttling (amber)
            linkStatuses[link.id] = 'restricted';
          } else if (
            transferCalEvt?.state === 'variable' &&
            linkRate < link.dailyRate - EPS &&
            actualFlow >= linkRate - EPS
          ) {
            // Flowing at calendar-reduced variable rate (amber)
            linkStatuses[link.id] = 'restricted';
          } else if (actualFlow >= linkRate - EPS) {
            // Flowing at full rate (green)
            linkStatuses[link.id] = 'full';
          } else {
            // Source lacked material / ran empty before meeting daily rate (blue)
            linkStatuses[link.id] = 'starved';
          }
        });

        // Node status classification
        this.nodes.forEach(node => {
          const inbound = Array.from(this.links.values()).filter(l => l.targetId === node.id);
          const outbound = Array.from(this.links.values()).filter(l => l.sourceId === node.id);
          const connected = [...inbound, ...outbound];
          const nodeBlockState = isNodeEffectivelyBlocked(node);

          if (nodeBlockState.blocked) {
            nodeStatuses[node.id] = 'blocked';
            return;
          }

          if (connected.length === 0) {
            nodeStatuses[node.id] = 'frozen';
            return;
          }

          const nodeOverflow = node.overflowMode || this.defaultOverflowMode;
          const isHalted = this.headroomHoldStates.get(node.id) || false;
          const isAtCapacity = nodeOverflow !== 'overfill' && node.currentVolume >= node.capacity;
          const isEmpty = node.currentVolume <= EPS;

          const hasBlocked = connected.some(l => linkStatuses[l.id] === 'blocked');
          const hasRestricted = connected.some(l => linkStatuses[l.id] === 'restricted');
          const hasFull = connected.some(l => linkStatuses[l.id] === 'full');

          if (isAtCapacity || isHalted || (!isEmpty && hasBlocked)) {
            nodeStatuses[node.id] = 'blocked';
          } else if (isEmpty) {
            nodeStatuses[node.id] = outbound.length > 0 ? 'starved' : 'frozen';
          } else if (hasRestricted) {
            nodeStatuses[node.id] = 'restricted';
          } else if (hasFull) {
            nodeStatuses[node.id] = 'full';
          } else if (outbound.length > 0) {
            nodeStatuses[node.id] = 'starved';
          } else {
            nodeStatuses[node.id] = 'frozen';
          }
        });

        // Corridor status classification
        this.corridors.forEach(corridor => {
          const routeEvt = activeRouteEvents.get(corridor.id);
          const assignedLinks = Array.from(this.links.values()).filter(l =>
            getLinkCorridorIds(l).includes(corridor.id)
          );
          const assignedStatuses = assignedLinks.map(l => linkStatuses[l.id] ?? 'frozen');

          if (routeEvt?.state === 'blocked') {
            corridorStatuses[corridor.id] = 'blocked';
          } else if (routeEvt?.state === 'restricted') {
            if (assignedStatuses.includes('blocked') || (routeEvt.rateValue !== undefined && routeEvt.rateValue <= EPS)) {
              corridorStatuses[corridor.id] = 'blocked';
            } else {
              corridorStatuses[corridor.id] = 'restricted';
            }
          } else if (assignedLinks.length === 0) {
            corridorStatuses[corridor.id] = 'frozen';
          } else if (assignedStatuses.includes('blocked')) {
            corridorStatuses[corridor.id] = 'blocked';
          } else if (assignedStatuses.includes('restricted')) {
            corridorStatuses[corridor.id] = 'restricted';
          } else if (assignedStatuses.includes('full')) {
            corridorStatuses[corridor.id] = 'full';
          } else if (assignedStatuses.includes('starved')) {
            corridorStatuses[corridor.id] = 'starved';
          } else {
            corridorStatuses[corridor.id] = 'frozen';
          }
        });
      }

      frames.push({ day, nodeVolumes, linkFlows, linkStatuses, nodeStatuses, corridorStatuses, alerts });
    }

    return frames;
  }
}