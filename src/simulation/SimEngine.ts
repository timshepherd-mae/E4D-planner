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

interface LinkMaterialInfo {
  code: string;
  bulkIN: number;
  bulkOUT: number;
}

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
    this.nodes = new Map(
      nodes.map(n => [
        n.id,
        {
          ...n,
          currentVolume: n.type === 'null' ? 0 : n.currentVolume
        }
      ])
    );
    this.links = new Map(links.map(l => [l.id, { ...l }]));
    this.corridors = new Map(corridors.map(c => [c.id, { ...c }]));
    this.materials = new Map(materials.map(m => [m.code, { ...m }]));
    this.calendar = calendar
      ? { ...calendar, events: (calendar.events || []).map(e => ({ ...e })) }
      : undefined;
    this.totalDays = totalDays;
    this.defaultOverflowMode = overflowMode;
  }

  private getLinkMaterial(link: TransferLink, source: ContainerNode): LinkMaterialInfo {
    const code = (link.materialId && link.materialId.trim()) ? link.materialId.trim().toUpperCase() : source.materialType;
    const mat = this.materials.get(code);
    return {
      code,
      bulkIN: mat ? mat.bulkIN : 1.0,
      bulkOUT: mat ? mat.bulkOUT : 1.0
    };
  }

  /**
   * Allocates a scalar budget across competing links ordered by ascending priority
   * (lower numeric priority = higher precedence; default 1). Links sharing the same
   * priority tier split remaining budget pro-rata by their weighted demand.
   */
  private allocateByPriority(
    links: TransferLink[],
    demands: Map<string, number>,
    budget: number,
    costFactorFn: (link: TransferLink) => number,
    eps: number
  ): { allocations: Map<string, number>; wasThrottled: boolean } {
    const allocations = new Map<string, number>();
    let wasThrottled = false;

    const tiers = new Map<number, TransferLink[]>();
    for (const link of links) {
      const p = Number.isFinite(link.priority) ? (link.priority as number) : 1;
      const list = tiers.get(p) || [];
      list.push(link);
      tiers.set(p, list);
    }

    const sortedPriorities = Array.from(tiers.keys()).sort((a, b) => a - b);
    let remaining = Math.max(0, budget);

    for (const p of sortedPriorities) {
      const tierLinks = tiers.get(p) || [];
      let tierCost = 0;

      for (const link of tierLinks) {
        const demand = Math.max(0, demands.get(link.id) ?? 0);
        const factor = Math.max(0, costFactorFn(link));
        if (demand > eps && factor > eps) {
          tierCost += demand * factor;
        }
      }

      if (tierCost <= eps) {
        for (const link of tierLinks) {
          allocations.set(link.id, Math.max(0, demands.get(link.id) ?? 0));
        }
        continue;
      }

      if (remaining >= tierCost - eps) {
        for (const link of tierLinks) {
          allocations.set(link.id, Math.max(0, demands.get(link.id) ?? 0));
        }
        remaining = Math.max(0, remaining - tierCost);
      } else if (remaining > eps) {
        const ratio = remaining / tierCost;
        for (const link of tierLinks) {
          const demand = Math.max(0, demands.get(link.id) ?? 0);
          const factor = Math.max(0, costFactorFn(link));
          if (demand > eps && factor > eps) {
            const granted = demand * ratio;
            allocations.set(link.id, granted);
            if (granted < demand - eps) wasThrottled = true;
          } else {
            allocations.set(link.id, demand);
          }
        }
        remaining = 0;
      } else {
        for (const link of tierLinks) {
          const demand = Math.max(0, demands.get(link.id) ?? 0);
          const factor = Math.max(0, costFactorFn(link));
          if (demand > eps && factor > eps) {
            allocations.set(link.id, 0);
            wasThrottled = true;
          } else {
            allocations.set(link.id, demand);
          }
        }
      }
    }

    return { allocations, wasThrottled };
  }

  public runSimulation(): SimFrame[] {
    const frames: SimFrame[] = [];
    const EPS = 1e-6;
    this.headroomHoldStates.clear();

    const allEvents = this.calendar?.events || [];

    // Pre-index adjacency for fast daily lookups
    const sourceOutboundLinks = new Map<string, TransferLink[]>();
    const targetInboundLinks = new Map<string, TransferLink[]>();
    this.links.forEach(link => {
      const outList = sourceOutboundLinks.get(link.sourceId) || [];
      outList.push(link);
      sourceOutboundLinks.set(link.sourceId, outList);

      const inList = targetInboundLinks.get(link.targetId) || [];
      inList.push(link);
      targetInboundLinks.set(link.targetId, inList);
    });

    for (let day = 0; day <= this.totalDays; day++) {
      const alerts: string[] = [];
      const pushAlert = (msg: string) => {
        if (!alerts.includes(msg)) alerts.push(msg);
      };

      const nodeVolumes: Record<string, number> = {};
      const linkFlows: Record<string, number> = {};
      const corridorFlows: Record<string, number> = {};
      const linkStatuses: Record<string, FlowStatus> = {};
      const nodeStatuses: Record<string, FlowStatus> = {};
      const corridorStatuses: Record<string, FlowStatus> = {};

      // Snapshot start-of-day volumes
      const startOfDayVolumes: Record<string, number> = {};
      this.nodes.forEach(n => {
        startOfDayVolumes[n.id] = n.type === 'null' ? 0 : n.currentVolume;
      });

      // Day 0: Frozen baseline
      if (day === 0) {
        this.nodes.forEach(node => {
          const vol = node.type === 'null' ? 0 : node.currentVolume;
          nodeVolumes[node.id] = vol;
          nodeStatuses[node.id] = 'frozen';
          if (node.type !== 'external' && node.type !== 'null' && vol > node.capacity + EPS) {
            const excess = vol - node.capacity;
            const targetOverflowMode = node.overflowMode || this.defaultOverflowMode;
            if (targetOverflowMode === 'overfill') {
              pushAlert(`Day 0: [OVERFILL] Node ${node.name} exceeded capacity by ${Math.round(excess).toLocaleString()} m³!`);
            } else {
              pushAlert(`Day 0: Node ${node.name} reached capacity!`);
            }
          }
        });
        this.links.forEach(l => {
          linkFlows[l.id] = 0;
          linkStatuses[l.id] = 'frozen';
        });
        this.corridors.forEach(c => {
          corridorFlows[c.id] = 0;
          corridorStatuses[c.id] = 'frozen';
        });

        frames.push({
          day,
          nodeVolumes,
          linkFlows,
          corridorFlows,
          linkStatuses,
          nodeStatuses,
          corridorStatuses,
          alerts
        });
        continue;
      }

      // Resolve active calendar events for this simulation day (Days 1..totalDays)
      const activeContainerEvents = new Map<string, CalendarEvent>();
      const activeTransferEvents = new Map<string, CalendarEvent>();
      const activeRouteEvents = new Map<string, CalendarEvent>();

      if (allEvents.length > 0) {
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

      // Helper to determine whether a container is effectively blocked or restricted on this day
      const getNodeScheduleState = (
        node: ContainerNode
      ): { blocked: boolean; byCalendar: boolean; restrictedCap?: number; openedOverride: boolean } => {
        const calEvt = activeContainerEvents.get(node.id);
        if (calEvt) {
          if (calEvt.state === 'blocked') {
            return { blocked: true, byCalendar: true, openedOverride: false };
          }
          if (calEvt.state === 'restricted') {
            const cap = Math.max(0, Number.isFinite(calEvt.rateValue) ? (calEvt.rateValue as number) : 0);
            if (cap <= EPS) {
              return { blocked: true, byCalendar: true, restrictedCap: 0, openedOverride: false };
            }
            return { blocked: false, byCalendar: false, restrictedCap: cap, openedOverride: false };
          }
          if (calEvt.state === 'open') {
            const wasStaticallyBlocked = node.status === 'blocked' || node.status === 'maintenance';
            return { blocked: false, byCalendar: false, openedOverride: wasStaticallyBlocked };
          }
        }
        return {
          blocked: node.status === 'blocked' || node.status === 'maintenance',
          byCalendar: false,
          openedOverride: false
        };
      };

      // Emit Container Calendar 'open' override alerts and blocked-zero restricted alerts
      this.nodes.forEach(node => {
        const sched = getNodeScheduleState(node);
        if (sched.openedOverride) {
          pushAlert(
            `Day ${day}: Container ${node.name} opened by calendar override (static status: ${node.status}).`
          );
        }
        if (sched.blocked && sched.restrictedCap === 0) {
          pushAlert(`Day ${day}: Container ${node.name} restricted to 0 m³/d by calendar schedule (halted).`);
        }
      });

      // Resolve effective daily target rate per transfer link (Calendar overrides stated rate & legacy schedule)
      const activeLinkRates = new Map<string, number>();
      const calendarStoppedLinks = new Set<string>();

      this.links.forEach(link => {
        const srcName = this.nodes.get(link.sourceId)?.name || link.sourceId;
        const tgtName = this.nodes.get(link.targetId)?.name || link.targetId;
        const calEvt = activeTransferEvents.get(link.id);

        let currentRate = link.dailyRate;
        if (!calEvt && link.rateSchedule && link.rateSchedule.length > 0) {
          const sorted = [...link.rateSchedule].sort((a, b) => a.day - b.day);
          for (const sched of sorted) {
            if (day >= sched.day) {
              currentRate = sched.rate;
            }
          }
        }

        if (calEvt) {
          if (calEvt.state === 'stopped') {
            currentRate = 0;
            calendarStoppedLinks.add(link.id);
            pushAlert(`Day ${day}: Transfer ${srcName} → ${tgtName} stopped by calendar schedule.`);
          } else if (calEvt.state === 'max') {
            currentRate = link.dailyRate;
          } else if (calEvt.state === 'variable') {
            currentRate = Math.max(0, Number.isFinite(calEvt.rateValue) ? (calEvt.rateValue as number) : link.dailyRate);
            if (currentRate <= EPS) {
              pushAlert(`Day ${day}: Transfer ${srcName} → ${tgtName} rate set to 0 m³/d by calendar schedule (stopped).`);
            } else if (currentRate < link.dailyRate - EPS) {
              pushAlert(
                `Day ${day}: Transfer ${srcName} → ${tgtName} rate reduced to ${Math.round(currentRate).toLocaleString()} m³/d by calendar schedule.`
              );
            } else if (currentRate > link.dailyRate + EPS) {
              pushAlert(
                `Day ${day}: Transfer ${srcName} → ${tgtName} rate boosted to ${Math.round(currentRate).toLocaleString()} m³/d by calendar schedule.`
              );
            }
          }
        }

        activeLinkRates.set(link.id, Math.max(0, currentRate));
      });

      const requestedTransfers = new Map<string, number>();
      const materialMismatchLinks = new Set<string>();
      const sourceStarvedEmptyLinks = new Set<string>();
      const sourceStarvedPartialLinks = new Set<string>();

      // Initialize all links to 0
      this.links.forEach(l => requestedTransfers.set(l.id, 0));

      // =========================================================================
      // Stage 1: Outbound Source Availability (Bulking-Aware + Priority-Tiered)
      // =========================================================================
      sourceOutboundLinks.forEach((outboundLinks, sourceId) => {
        const source = this.nodes.get(sourceId);
        if (!source) return;

        const sourceSched = getNodeScheduleState(source);
        if (sourceSched.blocked) {
          outboundLinks.forEach(l => requestedTransfers.set(l.id, 0));
          if (sourceSched.restrictedCap !== 0) {
            pushAlert(
              sourceSched.byCalendar
                ? `Day ${day}: Container ${source.name} is blocked by calendar schedule.`
                : `Day ${day}: Source ${source.name} is blocked or under maintenance.`
            );
          }
          return;
        }

        // Validate target existence & material compatibility first
        const validLinks: TransferLink[] = [];
        const demands = new Map<string, number>();

        outboundLinks.forEach(link => {
          const target = this.nodes.get(link.targetId);
          if (!target) {
            requestedTransfers.set(link.id, 0);
            return;
          }

          const matInfo = this.getLinkMaterial(link, source);
          if (target.allowedMaterials && target.allowedMaterials.length > 0) {
            if (!target.allowedMaterials.includes(matInfo.code)) {
              requestedTransfers.set(link.id, 0);
              materialMismatchLinks.add(link.id);
              pushAlert(
                `Day ${day}: Material mismatch between ${source.name} (${matInfo.code}) and target ${target.name}.`
              );
              return;
            }
          }

          const rate = activeLinkRates.get(link.id) ?? link.dailyRate;
          if (rate <= EPS) {
            requestedTransfers.set(link.id, 0);
            return;
          }

          validLinks.push(link);
          demands.set(link.id, rate);
        });

        if (validLinks.length === 0) return;

        // Container type semantics:
        // - 'external': unbounded source (never starves)
        // - 'null': zero-storage pass-through (demands pass forward and balance against same-day inflow in Stage 2)
        // - 'excavation' / 'stockpile': finite storage depleted by bulkOUT
        if (source.type === 'external' || source.type === 'null') {
          validLinks.forEach(link => {
            requestedTransfers.set(link.id, demands.get(link.id) ?? 0);
          });
          return;
        }

        const availableVol = startOfDayVolumes[source.id] ?? 0;
        if (availableVol <= EPS) {
          validLinks.forEach(link => {
            requestedTransfers.set(link.id, 0);
            sourceStarvedEmptyLinks.add(link.id);
          });
          pushAlert(`Day ${day}: Stockout at source ${source.name}.`);
          return;
        }

        const requiredSourceVol = validLinks.reduce((sum, link) => {
          const rate = demands.get(link.id) ?? 0;
          const { bulkOUT } = this.getLinkMaterial(link, source);
          return sum + rate * bulkOUT;
        }, 0);

        const { allocations, wasThrottled } = this.allocateByPriority(
          validLinks,
          demands,
          availableVol,
          link => this.getLinkMaterial(link, source).bulkOUT,
          EPS
        );

        validLinks.forEach(link => {
          const granted = allocations.get(link.id) ?? 0;
          const rate = demands.get(link.id) ?? 0;
          requestedTransfers.set(link.id, granted);
          if (granted < rate - EPS) {
            sourceStarvedPartialLinks.add(link.id);
          }
        });

        if (wasThrottled && requiredSourceVol > availableVol + EPS) {
          pushAlert(
            `Day ${day}: Source ${source.name} low stock (${Math.round(availableVol).toLocaleString()} m³ available vs ${Math.round(requiredSourceVol).toLocaleString()} m³ required). Outbound transfers throttled.`
          );
        }
      });

      // =========================================================================
      // Stage 1.25: Container Calendar 'restricted' Throughput Cap
      // =========================================================================
      const containerRestrictedLinks = new Set<string>();
      const postContainerCaps = new Map<string, number>();

      this.nodes.forEach(node => {
        const sched = getNodeScheduleState(node);
        if (sched.restrictedCap === undefined || sched.restrictedCap <= EPS) return;

        const cap = sched.restrictedCap;
        const connected = [
          ...(sourceOutboundLinks.get(node.id) || []),
          ...(targetInboundLinks.get(node.id) || [])
        ];
        // Deduplicate in case of self-loop
        const uniqueConnected = Array.from(new Map(connected.map(l => [l.id, l])).values()).filter(
          l => (requestedTransfers.get(l.id) ?? 0) > EPS
        );

        const totalThroughput = uniqueConnected.reduce(
          (sum, l) => sum + (requestedTransfers.get(l.id) ?? 0),
          0
        );

        if (totalThroughput > cap + EPS) {
          const { allocations } = this.allocateByPriority(
            uniqueConnected,
            requestedTransfers,
            cap,
            () => 1.0,
            EPS
          );
          uniqueConnected.forEach(link => {
            const capped = allocations.get(link.id) ?? 0;
            const prev = postContainerCaps.get(link.id);
            postContainerCaps.set(link.id, prev === undefined ? capped : Math.min(prev, capped));
          });
          pushAlert(
            `Day ${day}: Container ${node.name} throughput restricted to ${Math.round(cap).toLocaleString()} m³/d by calendar schedule.`
          );
        }
      });

      postContainerCaps.forEach((cappedAmount, linkId) => {
        const prevReq = requestedTransfers.get(linkId) ?? 0;
        if (cappedAmount < prevReq - EPS) {
          requestedTransfers.set(linkId, Math.max(0, cappedAmount));
          if (cappedAmount > EPS) {
            containerRestrictedLinks.add(linkId);
          }
        }
      });

      // =========================================================================
      // Stage 1.5: Route Corridor Constraints (Calendar + Baseline Rate & Fleet Caps)
      // =========================================================================
      const routeBlockedLinks = new Set<string>();
      const routeRestrictedLinks = new Set<string>();
      const routeThrottledCorridors = new Set<string>();

      // First apply route 'blocked' calendar events
      this.corridors.forEach(corridor => {
        const evt = activeRouteEvents.get(corridor.id);
        if (evt?.state !== 'blocked') return;
        pushAlert(`Day ${day}: Route ${corridor.name} is blocked by calendar schedule.`);
        this.links.forEach(link => {
          if (getLinkCorridorIds(link).includes(corridor.id)) {
            requestedTransfers.set(link.id, 0);
            routeBlockedLinks.add(link.id);
          }
        });
      });

      // Next evaluate effective rate caps & fleet caps across all corridors (tightest cap wins per link)
      const postRouteCaps = new Map<string, number>();

      this.corridors.forEach(corridor => {
        const evt = activeRouteEvents.get(corridor.id);
        if (evt?.state === 'blocked') return;

        // Determine active daily rate cap:
        // - Calendar 'open' explicitly lifts baseline caps
        // - Calendar 'restricted' uses event rateValue
        // - No active event falls back to corridor.maxDailyRate if defined
        let effectiveRateCap: number | undefined;
        let capSource: 'calendar' | 'baseline' | undefined;

        if (evt?.state === 'open') {
          effectiveRateCap = undefined;
        } else if (evt?.state === 'restricted') {
          effectiveRateCap = Math.max(0, Number.isFinite(evt.rateValue) ? (evt.rateValue as number) : 0);
          capSource = 'calendar';
        } else if (
          corridor.maxDailyRate !== undefined &&
          Number.isFinite(corridor.maxDailyRate) &&
          corridor.maxDailyRate >= 0
        ) {
          effectiveRateCap = corridor.maxDailyRate;
          capSource = 'baseline';
        }

        const corridorLinks: TransferLink[] = [];
        let totalCorridorDemand = 0;

        this.links.forEach(link => {
          if (routeBlockedLinks.has(link.id)) return;
          if (getLinkCorridorIds(link).includes(corridor.id)) {
            const req = requestedTransfers.get(link.id) ?? 0;
            if (req > EPS) {
              corridorLinks.push(link);
              totalCorridorDemand += req;
            }
          }
        });

        // Rate cap enforcement
        if (effectiveRateCap !== undefined) {
          if (effectiveRateCap <= EPS) {
            corridorLinks.forEach(link => {
              postRouteCaps.set(link.id, 0);
              routeBlockedLinks.add(link.id);
            });
            routeThrottledCorridors.add(corridor.id);
            pushAlert(
              capSource === 'calendar'
                ? `Day ${day}: Route ${corridor.name} restricted to 0 m³/d (halted).`
                : `Day ${day}: Route ${corridor.name} baseline rate cap is 0 m³/d (halted).`
            );
          } else if (totalCorridorDemand > effectiveRateCap + EPS) {
            const { allocations } = this.allocateByPriority(
              corridorLinks,
              requestedTransfers,
              effectiveRateCap,
              () => 1.0,
              EPS
            );
            routeThrottledCorridors.add(corridor.id);
            corridorLinks.forEach(link => {
              const capped = allocations.get(link.id) ?? 0;
              const existingCap = postRouteCaps.get(link.id);
              postRouteCaps.set(link.id, existingCap === undefined ? capped : Math.min(existingCap, capped));
            });
            pushAlert(
              capSource === 'calendar'
                ? `Day ${day}: Route ${corridor.name} restricted to ${Math.round(effectiveRateCap).toLocaleString()} m³/d (transfers throttled).`
                : `Day ${day}: Route ${corridor.name} baseline rate cap (${Math.round(effectiveRateCap).toLocaleString()} m³/d) reached (transfers throttled).`
            );
          }
        }

        // Baseline fleet count cap enforcement (skipped if Calendar 'open' explicitly overrides)
        if (
          evt?.state !== 'open' &&
          corridor.maxFleetCount !== undefined &&
          Number.isFinite(corridor.maxFleetCount) &&
          corridor.maxFleetCount > 0 &&
          corridorLinks.length > 0
        ) {
          const totalFleet = corridorLinks.reduce((sum, l) => sum + Math.max(0, l.fleetCount || 0), 0);
          if (totalFleet > corridor.maxFleetCount + EPS) {
            const fleetRatio = corridor.maxFleetCount / totalFleet;
            routeThrottledCorridors.add(corridor.id);
            corridorLinks.forEach(link => {
              const req = requestedTransfers.get(link.id) ?? 0;
              const fleetCapped = req * fleetRatio;
              const existingCap = postRouteCaps.get(link.id);
              postRouteCaps.set(
                link.id,
                existingCap === undefined ? fleetCapped : Math.min(existingCap, fleetCapped)
              );
            });
            pushAlert(
              `Day ${day}: Route ${corridor.name} fleet cap (${corridor.maxFleetCount} units vs ${totalFleet} assigned) reached (transfers throttled).`
            );
          }
        }
      });

      postRouteCaps.forEach((cappedAmount, linkId) => {
        const prevReq = requestedTransfers.get(linkId) ?? 0;
        if (cappedAmount < prevReq - EPS) {
          requestedTransfers.set(linkId, Math.max(0, cappedAmount));
          if (cappedAmount > EPS) {
            routeRestrictedLinks.add(linkId);
          }
        }
      });

      // Snapshot pre-Stage-2 flows so Step 4 can accurately tell downstream/null throttling apart from upstream limits
      const preTargetFlows = new Map<string, number>();
      requestedTransfers.forEach((val, id) => preTargetFlows.set(id, val));

      // =========================================================================
      // Stage 2: Target Capacity, Bulking-Aware Headroom, Same-Day Outbound Drainage,
      //          Headroom Hold Hysteresis, Priority Tiers, and Null Junction Balancing
      // =========================================================================
      const workingFlows = new Map<string, number>();
      requestedTransfers.forEach((val, id) => workingFlows.set(id, val));

      // Snapshot prior day's headroom hold states before iterating
      const prevHeadroomHoldStates = new Map(this.headroomHoldStates);
      const convergedHoldStates = new Map<string, boolean>();
      const targetBlockedAlertsPending = new Set<string>();

      // First zero out any links entering a blocked target
      targetInboundLinks.forEach((inboundLinks, targetId) => {
        const target = this.nodes.get(targetId);
        if (!target) return;
        const targetSched = getNodeScheduleState(target);
        if (targetSched.blocked) {
          inboundLinks.forEach(l => workingFlows.set(l.id, 0));
          if (targetSched.restrictedCap !== 0) {
            targetBlockedAlertsPending.add(targetId);
          }
        }
      });

      targetBlockedAlertsPending.forEach(targetId => {
        const target = this.nodes.get(targetId);
        if (!target) return;
        const targetSched = getNodeScheduleState(target);
        pushAlert(
          targetSched.byCalendar
            ? `Day ${day}: Container ${target.name} is blocked by calendar schedule.`
            : `Day ${day}: Target ${target.name} is blocked or under maintenance.`
        );
      });

      // Fixed-point convergence loop (monotonically non-increasing flows; converges in 1–4 passes)
      const MAX_ITERS = 8;
      for (let iter = 0; iter < MAX_ITERS; iter++) {
        let maxDelta = 0;

        // A. Enforce finite target storage capacity (accounting for same-day outbound drainage & bulkIN)
        targetInboundLinks.forEach((inboundLinks, targetId) => {
          const target = this.nodes.get(targetId);
          if (!target) return;

          const targetSched = getNodeScheduleState(target);
          if (targetSched.blocked) return;

          // External boundaries are unbounded sinks; Null junctions are balanced in Step B below
          if (target.type === 'external' || target.type === 'null') return;

          const overflowMode = target.overflowMode || this.defaultOverflowMode;
          if (overflowMode === 'overfill') return;

          const subRule = target.strictSubRule || 'throttleback';
          const headroomThreshold = target.headroomThreshold ?? 500;
          const startVol = startOfDayVolumes[targetId] ?? 0;

          // Same-day outbound drainage frees physical space inside the container
          const outboundLinks = sourceOutboundLinks.get(targetId) || [];
          const outboundRemoved = outboundLinks.reduce((sum, outLink) => {
            const flow = workingFlows.get(outLink.id) ?? 0;
            if (flow <= EPS) return sum;
            const { bulkOUT } = this.getLinkMaterial(outLink, target);
            return sum + flow * bulkOUT;
          }, 0);

          const effectiveStartVol = Math.max(0, startVol - outboundRemoved);
          const effectiveHeadroom = Math.max(0, target.capacity - effectiveStartVol);

          const wasHalted = prevHeadroomHoldStates.get(targetId) || false;
          let isHalted = wasHalted;
          if (subRule === 'headroom_hold') {
            if (wasHalted) {
              isHalted = effectiveHeadroom < headroomThreshold - EPS;
            } else if (startVol >= target.capacity - EPS) {
              isHalted = effectiveHeadroom < headroomThreshold - EPS;
            }
          } else {
            isHalted = false;
          }
          convergedHoldStates.set(targetId, isHalted);

          if (subRule === 'headroom_hold' && isHalted) {
            inboundLinks.forEach(link => {
              const prev = workingFlows.get(link.id) ?? 0;
              if (prev > EPS) {
                workingFlows.set(link.id, 0);
                maxDelta = Math.max(maxDelta, prev);
              }
            });
            return;
          }

          // Bulking-aware headroom allocation by priority tier (both 'throttleback' and 'headroom_hold' final fill day)
          const { allocations } = this.allocateByPriority(
            inboundLinks,
            workingFlows,
            effectiveHeadroom,
            link => {
              const src = this.nodes.get(link.sourceId);
              return src ? this.getLinkMaterial(link, src).bulkIN : 1.0;
            },
            EPS
          );

          inboundLinks.forEach(link => {
            const prev = workingFlows.get(link.id) ?? 0;
            const next = Math.max(0, allocations.get(link.id) ?? 0);
            if (Math.abs(prev - next) > EPS) {
              workingFlows.set(link.id, next);
              maxDelta = Math.max(maxDelta, Math.abs(prev - next));
            }
          });
        });

        // B. Balance zero-storage Null Junction pass-through nodes (totalIn === totalOut)
        this.nodes.forEach(node => {
          if (node.type !== 'null') return;
          const inbound = targetInboundLinks.get(node.id) || [];
          const outbound = sourceOutboundLinks.get(node.id) || [];

          const totalIn = inbound.reduce((s, l) => s + (workingFlows.get(l.id) ?? 0), 0);
          const totalOut = outbound.reduce((s, l) => s + (workingFlows.get(l.id) ?? 0), 0);

          if (totalOut > totalIn + EPS) {
            // Outbound demand exceeds same-day inflow -> cap outbound to totalIn
            const { allocations } = this.allocateByPriority(outbound, workingFlows, totalIn, () => 1.0, EPS);
            outbound.forEach(link => {
              const prev = workingFlows.get(link.id) ?? 0;
              const next = Math.max(0, allocations.get(link.id) ?? 0);
              if (Math.abs(prev - next) > EPS) {
                workingFlows.set(link.id, next);
                maxDelta = Math.max(maxDelta, Math.abs(prev - next));
              }
            });
          } else if (totalIn > totalOut + EPS) {
            // Inbound supply exceeds downstream acceptance -> back-pressure inbound to totalOut
            const { allocations } = this.allocateByPriority(inbound, workingFlows, totalOut, () => 1.0, EPS);
            inbound.forEach(link => {
              const prev = workingFlows.get(link.id) ?? 0;
              const next = Math.max(0, allocations.get(link.id) ?? 0);
              if (Math.abs(prev - next) > EPS) {
                workingFlows.set(link.id, next);
                maxDelta = Math.max(maxDelta, Math.abs(prev - next));
              }
            });
          }
        });

        if (maxDelta <= EPS) break;
      }

      // Commit headroom hold states & emit post-convergence Stage 2 alerts
      targetInboundLinks.forEach((inboundLinks, targetId) => {
        const target = this.nodes.get(targetId);
        if (!target || target.type === 'external' || target.type === 'null') return;
        const targetSched = getNodeScheduleState(target);
        if (targetSched.blocked) return;

        const overflowMode = target.overflowMode || this.defaultOverflowMode;
        if (overflowMode === 'overfill') return;

        const subRule = target.strictSubRule || 'throttleback';
        const headroomThreshold = target.headroomThreshold ?? 500;
        const startVol = startOfDayVolumes[targetId] ?? 0;
        const outboundLinks = sourceOutboundLinks.get(targetId) || [];
        const outboundRemoved = outboundLinks.reduce((sum, outLink) => {
          const flow = workingFlows.get(outLink.id) ?? 0;
          if (flow <= EPS) return sum;
          const { bulkOUT } = this.getLinkMaterial(outLink, target);
          return sum + flow * bulkOUT;
        }, 0);
        const effectiveHeadroom = Math.max(0, target.capacity - Math.max(0, startVol - outboundRemoved));

        const wasHalted = prevHeadroomHoldStates.get(targetId) || false;
        const isHalted = convergedHoldStates.get(targetId) || false;
        this.headroomHoldStates.set(targetId, isHalted);

        const totalPreTargetDeposit = inboundLinks.reduce((sum, l) => {
          const pre = preTargetFlows.get(l.id) ?? 0;
          const src = this.nodes.get(l.sourceId);
          const bulkIn = src ? this.getLinkMaterial(l, src).bulkIN : 1.0;
          return sum + pre * bulkIn;
        }, 0);

        if (subRule === 'headroom_hold') {
          if (wasHalted && !isHalted) {
            pushAlert(
              `Day ${day}: Target ${target.name} headroom threshold satisfied (${Math.round(effectiveHeadroom).toLocaleString()} m³ spare). Resuming inbound transfers.`
            );
          }
          if (isHalted) {
            pushAlert(
              `Day ${day}: Target ${target.name} awaiting headroom threshold (${headroomThreshold} m³ spare required).`
            );
          } else if (totalPreTargetDeposit > effectiveHeadroom + EPS) {
            pushAlert(
              `Day ${day}: Target ${target.name} reached capacity on fill day. Final inbound flow capped to available headroom.`
            );
          }
        } else if (subRule === 'throttleback') {
          if (totalPreTargetDeposit > effectiveHeadroom + EPS) {
            pushAlert(`Day ${day}: Target ${target.name} nearing capacity. Transfer rates throttled.`);
          }
        }
      });

      // Also update headroom hold state for nodes that might have no inbound links (keep clean)
      this.nodes.forEach(node => {
        if (!targetInboundLinks.has(node.id)) {
          this.headroomHoldStates.set(node.id, false);
        }
      });

      // Record final planned transfers
      const plannedTransfers = new Map<string, number>();
      this.links.forEach(link => {
        const finalFlow = Math.max(0, workingFlows.get(link.id) ?? 0);
        plannedTransfers.set(link.id, finalFlow);
        linkFlows[link.id] = finalFlow;
      });

      // =========================================================================
      // Stage 3: Apply Physical Transfers (Order-Independent Simultaneous Delta)
      // =========================================================================
      const nodeTotalRemoved = new Map<string, number>();
      const nodeTotalAdded = new Map<string, number>();

      this.links.forEach(link => {
        const source = this.nodes.get(link.sourceId);
        const target = this.nodes.get(link.targetId);
        const transferAmount = plannedTransfers.get(link.id) ?? 0;

        if (source && target && transferAmount > EPS) {
          const { bulkIN, bulkOUT } = this.getLinkMaterial(link, source);

          if (source.type !== 'null') {
            nodeTotalRemoved.set(
              source.id,
              (nodeTotalRemoved.get(source.id) ?? 0) + transferAmount * bulkOUT
            );
          }

          if (target.type !== 'null') {
            nodeTotalAdded.set(
              target.id,
              (nodeTotalAdded.get(target.id) ?? 0) + transferAmount * bulkIN
            );
          }
        }
      });

      this.nodes.forEach(node => {
        if (node.type === 'null') {
          node.currentVolume = 0;
          return;
        }
        const removed = nodeTotalRemoved.get(node.id) ?? 0;
        const added = nodeTotalAdded.get(node.id) ?? 0;
        if (removed <= EPS && added <= EPS) return;

        const afterDepletion = Math.max(0, node.currentVolume - removed);
        const nextVol = afterDepletion + added;
        const targetOverflowMode = node.overflowMode || this.defaultOverflowMode;
        const finalVol =
          node.type === 'external' || targetOverflowMode === 'overfill'
            ? nextVol
            : Math.min(node.capacity, nextVol);

        node.currentVolume = finalVol < EPS ? 0 : finalVol;
      });

      // Record resulting node volumes & capacity / overfill alerts (fixes strict capacity dead-code alert)
      this.nodes.forEach(node => {
        const vol = node.type === 'null' ? 0 : node.currentVolume;
        nodeVolumes[node.id] = vol;

        if (node.type === 'external' || node.type === 'null') return;

        const targetOverflowMode = node.overflowMode || this.defaultOverflowMode;
        if (targetOverflowMode === 'overfill') {
          if (vol > node.capacity + EPS) {
            const excess = vol - node.capacity;
            pushAlert(
              `Day ${day}: [OVERFILL] Node ${node.name} exceeded capacity by ${Math.round(excess).toLocaleString()} m³!`
            );
          }
        } else if (node.capacity > EPS && vol >= node.capacity - EPS) {
          const startVol = startOfDayVolumes[node.id] ?? 0;
          const inboundLinks = targetInboundLinks.get(node.id) || [];
          const hasInboundDemand = inboundLinks.some(l => (preTargetFlows.get(l.id) ?? 0) > EPS);
          if (startVol < node.capacity - EPS || hasInboundDemand) {
            pushAlert(`Day ${day}: Node ${node.name} reached capacity!`);
          }
        }
      });

      // =========================================================================
      // Stage 4: Classify Link, Node, and Route Corridor Visual Flow Statuses
      // =========================================================================
      // Helper to determine if a null junction has starved supply
      const isNullSourceStarved = (nullNodeId: string): boolean => {
        const inbound = targetInboundLinks.get(nullNodeId) || [];
        if (inbound.length === 0) return true;
        return inbound.every(inLink => {
          const src = this.nodes.get(inLink.sourceId);
          if (!src) return true;
          if (src.type === 'external') return false;
          if (src.type === 'null') return (linkFlows[inLink.id] ?? 0) <= EPS;
          return (startOfDayVolumes[src.id] ?? 0) <= EPS;
        });
      };

      // Link status classification
      this.links.forEach(link => {
        const source = this.nodes.get(link.sourceId);
        const target = this.nodes.get(link.targetId);
        const linkRate = activeLinkRates.get(link.id) ?? link.dailyRate;
        const actualFlow = linkFlows[link.id] ?? 0;
        const preTargetFlow = preTargetFlows.get(link.id) ?? 0;
        const startVol = startOfDayVolumes[link.sourceId] ?? 0;
        const transferCalEvt = activeTransferEvents.get(link.id);
        const sourceBlocked = source ? getNodeScheduleState(source).blocked : false;
        const targetBlocked = target ? getNodeScheduleState(target).blocked : false;

        if (!source || !target) {
          linkStatuses[link.id] = 'frozen';
        } else if (calendarStoppedLinks.has(link.id) || routeBlockedLinks.has(link.id)) {
          linkStatuses[link.id] = 'blocked';
        } else if (transferCalEvt?.state === 'variable' && linkRate <= EPS) {
          linkStatuses[link.id] = 'blocked';
        } else if (linkRate <= EPS) {
          linkStatuses[link.id] = 'frozen';
        } else if (sourceBlocked || targetBlocked || materialMismatchLinks.has(link.id)) {
          linkStatuses[link.id] = 'blocked';
        } else if (source.type !== 'external' && source.type !== 'null' && startVol <= EPS) {
          linkStatuses[link.id] = 'starved';
        } else if (actualFlow <= EPS) {
          if (source.type === 'null' && isNullSourceStarved(source.id)) {
            linkStatuses[link.id] = 'starved';
          } else {
            linkStatuses[link.id] = 'blocked';
          }
        } else if (
          routeRestrictedLinks.has(link.id) ||
          containerRestrictedLinks.has(link.id) ||
          actualFlow < preTargetFlow - EPS
        ) {
          linkStatuses[link.id] = 'restricted';
        } else if (
          transferCalEvt?.state === 'variable' &&
          linkRate < link.dailyRate - EPS &&
          actualFlow >= linkRate - EPS
        ) {
          linkStatuses[link.id] = 'restricted';
        } else if (actualFlow >= linkRate - EPS) {
          linkStatuses[link.id] = 'full';
        } else if (sourceStarvedPartialLinks.has(link.id) || sourceStarvedEmptyLinks.has(link.id)) {
          linkStatuses[link.id] = 'starved';
        } else {
          linkStatuses[link.id] = 'restricted';
        }
      });

      // Node status classification (fixes sibling-link Red cascade & Overfill Red border)
      this.nodes.forEach(node => {
        const inbound = targetInboundLinks.get(node.id) || [];
        const outbound = sourceOutboundLinks.get(node.id) || [];
        const connected = [...inbound, ...outbound];
        const nodeSched = getNodeScheduleState(node);

        if (nodeSched.blocked) {
          nodeStatuses[node.id] = 'blocked';
          return;
        }

        const nodeOverflow = node.overflowMode || this.defaultOverflowMode;
        const isOverfilled =
          node.type !== 'external' && node.type !== 'null' && node.currentVolume > node.capacity + EPS;
        const isAtCapacity =
          node.type !== 'external' &&
          node.type !== 'null' &&
          nodeOverflow !== 'overfill' &&
          node.capacity > EPS &&
          node.currentVolume >= node.capacity - EPS;
        const isHalted = this.headroomHoldStates.get(node.id) || false;
        const isEmpty = node.type !== 'external' && node.type !== 'null' && node.currentVolume <= EPS;
        const isContainerCalRestricted = nodeSched.restrictedCap !== undefined && nodeSched.restrictedCap > EPS;

        if (isOverfilled || isAtCapacity || isHalted) {
          nodeStatuses[node.id] = 'blocked';
          return;
        }

        if (connected.length === 0) {
          nodeStatuses[node.id] = isContainerCalRestricted ? 'restricted' : 'frozen';
          return;
        }

        const hasBlocked = connected.some(l => linkStatuses[l.id] === 'blocked');
        const hasRestricted = connected.some(l => linkStatuses[l.id] === 'restricted');
        const hasFull = connected.some(l => linkStatuses[l.id] === 'full');
        const hasStarved = connected.some(l => linkStatuses[l.id] === 'starved');
        const hasFlowing = hasFull || hasRestricted;

        if (hasBlocked && !hasFlowing && !isEmpty) {
          nodeStatuses[node.id] = 'blocked';
        } else if (isContainerCalRestricted || hasRestricted || (hasBlocked && hasFlowing)) {
          nodeStatuses[node.id] = 'restricted';
        } else if (node.type === 'null') {
          if (hasFull) nodeStatuses[node.id] = 'full';
          else if (hasStarved) nodeStatuses[node.id] = 'starved';
          else if (hasBlocked) nodeStatuses[node.id] = 'blocked';
          else nodeStatuses[node.id] = 'frozen';
        } else if (isEmpty) {
          nodeStatuses[node.id] = outbound.length > 0 ? 'starved' : 'frozen';
        } else if (hasFull) {
          nodeStatuses[node.id] = 'full';
        } else if (outbound.length > 0 && hasStarved) {
          nodeStatuses[node.id] = 'starved';
        } else if (hasBlocked) {
          nodeStatuses[node.id] = 'blocked';
        } else {
          nodeStatuses[node.id] = 'frozen';
        }
      });

      // Corridor flows & status classification
      this.corridors.forEach(corridor => {
        const routeEvt = activeRouteEvents.get(corridor.id);
        const assignedLinks = Array.from(this.links.values()).filter(l =>
          getLinkCorridorIds(l).includes(corridor.id)
        );
        const assignedStatuses = assignedLinks.map(l => linkStatuses[l.id] ?? 'frozen');
        corridorFlows[corridor.id] = assignedLinks.reduce((sum, l) => sum + (linkFlows[l.id] ?? 0), 0);

        const hasBlocked = assignedStatuses.includes('blocked');
        const hasRestricted = assignedStatuses.includes('restricted');
        const hasFull = assignedStatuses.includes('full');
        const hasStarved = assignedStatuses.includes('starved');
        const hasFlowing = hasFull || hasRestricted;

        if (routeEvt?.state === 'blocked') {
          corridorStatuses[corridor.id] = 'blocked';
        } else if (routeEvt?.state === 'restricted') {
          if (
            (routeEvt.rateValue !== undefined && routeEvt.rateValue <= EPS) ||
            (assignedStatuses.length > 0 && assignedStatuses.every(s => s === 'blocked'))
          ) {
            corridorStatuses[corridor.id] = 'blocked';
          } else {
            corridorStatuses[corridor.id] = 'restricted';
          }
        } else if (routeThrottledCorridors.has(corridor.id)) {
          if (
            corridor.maxDailyRate !== undefined &&
            corridor.maxDailyRate <= EPS &&
            routeEvt?.state !== 'open'
          ) {
            corridorStatuses[corridor.id] = 'blocked';
          } else {
            corridorStatuses[corridor.id] = 'restricted';
          }
        } else if (assignedLinks.length === 0) {
          corridorStatuses[corridor.id] = 'frozen';
        } else if (hasBlocked && !hasFlowing) {
          corridorStatuses[corridor.id] = 'blocked';
        } else if (hasRestricted || (hasBlocked && hasFlowing)) {
          corridorStatuses[corridor.id] = 'restricted';
        } else if (hasFull) {
          corridorStatuses[corridor.id] = 'full';
        } else if (hasStarved) {
          corridorStatuses[corridor.id] = 'starved';
        } else {
          corridorStatuses[corridor.id] = 'frozen';
        }
      });

      frames.push({
        day,
        nodeVolumes,
        linkFlows,
        corridorFlows,
        linkStatuses,
        nodeStatuses,
        corridorStatuses,
        alerts
      });
    }

    return frames;
  }
}