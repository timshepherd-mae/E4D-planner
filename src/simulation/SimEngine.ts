import {
  ContainerNode,
  TransferLink,
  RouteCorridor,
  CalendarModel,
  CalendarEvent,
  SimFrame,
  MaterialDefinition,
  FlowStatus,
  OverflowMode,
  StrictSubRule,
  DiversionTrigger,
  LinkRouteSplit,
  getLinkRole,
  getLinkCorridorIds,
  getLinkBackupCorridorIds
} from '../models/types';

export type { OverflowMode, StrictSubRule };

interface LinkMaterialInfo {
  code: string;
  bulkIN: number;
  bulkOUT: number;
}

interface CorridorLimitInfo {
  blocked: boolean;
  rateCap?: number;
  capSource?: 'calendar' | 'baseline';
  fleetCap?: number;
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
    const code =
      link.materialId && link.materialId.trim()
        ? link.materialId.trim().toUpperCase()
        : source.materialType;
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
    const primaryLinksList: TransferLink[] = [];
    const standbyLinksList: TransferLink[] = [];
    const overflowLinksList: TransferLink[] = [];

    this.links.forEach(link => {
      const outList = sourceOutboundLinks.get(link.sourceId) || [];
      outList.push(link);
      sourceOutboundLinks.set(link.sourceId, outList);

      const inList = targetInboundLinks.get(link.targetId) || [];
      inList.push(link);
      targetInboundLinks.set(link.targetId, inList);

      const role = getLinkRole(link);
      if (role === 'standby') standbyLinksList.push(link);
      else if (role === 'overflow') overflowLinksList.push(link);
      else primaryLinksList.push(link);
    });

    for (let day = 0; day <= this.totalDays; day++) {
      const alerts: string[] = [];
      const pushAlert = (msg: string) => {
        if (!alerts.includes(msg)) alerts.push(msg);
      };

      const nodeVolumes: Record<string, number> = {};
      const linkFlows: Record<string, number> = {};
      const corridorFlows: Record<string, number> = {};
      const backupCorridorFlows: Record<string, number> = {};
      const linkRouteSplits: Record<string, LinkRouteSplit> = {};
      const overflowActiveNodes: Record<string, number> = {};
      const standbyActivatedFrom: Record<string, { primaryLinkId: string; divertedFlow: number }> = {};
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
              pushAlert(
                `Day 0: [OVERFILL] Node ${node.name} exceeded capacity by ${Math.round(excess).toLocaleString()} m³!`
              );
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
          backupCorridorFlows[c.id] = 0;
          corridorStatuses[c.id] = 'frozen';
        });

        frames.push({
          day,
          nodeVolumes,
          linkFlows,
          corridorFlows,
          backupCorridorFlows,
          linkRouteSplits,
          overflowActiveNodes,
          standbyActivatedFrom,
          linkStatuses,
          nodeStatuses,
          corridorStatuses,
          alerts
        });
        continue;
      }

      // =========================================================================
      // Stage 0: Active Calendar Events & Effective Link Rates
      // =========================================================================
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

      const getCorridorLimits = (corridor: RouteCorridor): CorridorLimitInfo => {
        const evt = activeRouteEvents.get(corridor.id);
        if (evt?.state === 'blocked') {
          return { blocked: true, rateCap: 0, capSource: 'calendar' };
        }
        if (evt?.state === 'open') {
          return { blocked: false };
        }
        let rateCap: number | undefined;
        let capSource: 'calendar' | 'baseline' | undefined;
        if (evt?.state === 'restricted') {
          rateCap = Math.max(0, Number.isFinite(evt.rateValue) ? (evt.rateValue as number) : 0);
          capSource = 'calendar';
        } else if (
          corridor.maxDailyRate !== undefined &&
          Number.isFinite(corridor.maxDailyRate) &&
          corridor.maxDailyRate >= 0
        ) {
          rateCap = corridor.maxDailyRate;
          capSource = 'baseline';
        }
        const fleetCap =
          corridor.maxFleetCount !== undefined &&
          Number.isFinite(corridor.maxFleetCount) &&
          corridor.maxFleetCount > 0
            ? corridor.maxFleetCount
            : undefined;
        return {
          blocked: rateCap !== undefined && rateCap <= EPS,
          rateCap,
          capSource,
          fleetCap
        };
      };

      // Container Calendar 'open' override & 0-cap alerts
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

      const activeLinkRates = new Map<string, number>();
      const baselineLinkRates = new Map<string, number>();
      const calendarStoppedLinks = new Set<string>();

      this.links.forEach(link => {
        const srcName = this.nodes.get(link.sourceId)?.name || link.sourceId;
        const tgtName = this.nodes.get(link.targetId)?.name || link.targetId;
        const calEvt = activeTransferEvents.get(link.id);
        const role = getLinkRole(link);

        let baseRate = link.dailyRate;
        if (!calEvt && link.rateSchedule && link.rateSchedule.length > 0) {
          const sorted = [...link.rateSchedule].sort((a, b) => a.day - b.day);
          for (const sched of sorted) {
            if (day >= sched.day) {
              baseRate = sched.rate;
            }
          }
        }
        baselineLinkRates.set(link.id, Math.max(0, baseRate));

        let currentRate = baseRate;
        if (calEvt) {
          if (calEvt.state === 'stopped') {
            currentRate = 0;
            calendarStoppedLinks.add(link.id);
            if (role === 'primary') {
              pushAlert(`Day ${day}: Transfer ${srcName} → ${tgtName} stopped by calendar schedule.`);
            }
          } else if (calEvt.state === 'max') {
            currentRate = link.dailyRate;
          } else if (calEvt.state === 'variable') {
            currentRate = Math.max(
              0,
              Number.isFinite(calEvt.rateValue) ? (calEvt.rateValue as number) : link.dailyRate
            );
            if (role === 'primary') {
              if (currentRate <= EPS) {
                pushAlert(
                  `Day ${day}: Transfer ${srcName} → ${tgtName} rate set to 0 m³/d by calendar schedule (stopped).`
                );
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
        }

        activeLinkRates.set(link.id, Math.max(0, currentRate));
      });

      const requestedTransfers = new Map<string, number>();
      const materialMismatchLinks = new Set<string>();
      const sourceStarvedEmptyLinks = new Set<string>();
      const sourceStarvedPartialLinks = new Set<string>();

      this.links.forEach(l => requestedTransfers.set(l.id, 0));

      // =========================================================================
      // Stage 1: Primary Outbound Source Availability (Bulking-Aware + Priority)
      // =========================================================================
      sourceOutboundLinks.forEach((allOutboundLinks, sourceId) => {
        const outboundLinks = allOutboundLinks.filter(l => getLinkRole(l) === 'primary');
        if (outboundLinks.length === 0) return;

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
      // Stage 1.25: Container Calendar 'restricted' Throughput Cap (Primary Links)
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
        ].filter(l => getLinkRole(l) === 'primary');

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
      // Stage 1.5: Route Corridor Constraints + Backup Corridor Spillover (Primary)
      // =========================================================================
      const routeBlockedLinks = new Set<string>();
      const routeRestrictedLinks = new Set<string>();
      const routeThrottledCorridors = new Set<string>();
      const rawRouteSplits = new Map<string, LinkRouteSplit>();
      const preRouteFlows = new Map<string, number>();
      requestedTransfers.forEach((v, id) => preRouteFlows.set(id, v));

      // Pass 1.5A: Primary Corridors
      const primaryRouteAllocated = new Map<string, number>();
      requestedTransfers.forEach((v, id) => primaryRouteAllocated.set(id, v));

      this.corridors.forEach(corridor => {
        const evt = activeRouteEvents.get(corridor.id);
        if (evt?.state !== 'blocked') return;
        pushAlert(`Day ${day}: Route ${corridor.name} is blocked by calendar schedule.`);
        primaryLinksList.forEach(link => {
          if (getLinkCorridorIds(link).includes(corridor.id)) {
            primaryRouteAllocated.set(link.id, 0);
            routeBlockedLinks.add(link.id);
          }
        });
      });

      const postPrimaryRouteCaps = new Map<string, number>();

      this.corridors.forEach(corridor => {
        const limits = getCorridorLimits(corridor);
        const evt = activeRouteEvents.get(corridor.id);
        if (evt?.state === 'blocked') return;

        const corridorLinks: TransferLink[] = [];
        let totalCorridorDemand = 0;

        primaryLinksList.forEach(link => {
          if (routeBlockedLinks.has(link.id)) return;
          if (getLinkCorridorIds(link).includes(corridor.id)) {
            const req = primaryRouteAllocated.get(link.id) ?? 0;
            if (req > EPS) {
              corridorLinks.push(link);
              totalCorridorDemand += req;
            }
          }
        });

        if (limits.rateCap !== undefined) {
          if (limits.rateCap <= EPS) {
            corridorLinks.forEach(link => {
              postPrimaryRouteCaps.set(link.id, 0);
              routeBlockedLinks.add(link.id);
            });
            routeThrottledCorridors.add(corridor.id);
            pushAlert(
              limits.capSource === 'calendar'
                ? `Day ${day}: Route ${corridor.name} restricted to 0 m³/d (halted).`
                : `Day ${day}: Route ${corridor.name} baseline rate cap is 0 m³/d (halted).`
            );
          } else if (totalCorridorDemand > limits.rateCap + EPS) {
            const { allocations } = this.allocateByPriority(
              corridorLinks,
              primaryRouteAllocated,
              limits.rateCap,
              () => 1.0,
              EPS
            );
            routeThrottledCorridors.add(corridor.id);
            corridorLinks.forEach(link => {
              const capped = allocations.get(link.id) ?? 0;
              const existingCap = postPrimaryRouteCaps.get(link.id);
              postPrimaryRouteCaps.set(
                link.id,
                existingCap === undefined ? capped : Math.min(existingCap, capped)
              );
            });
            pushAlert(
              limits.capSource === 'calendar'
                ? `Day ${day}: Route ${corridor.name} restricted to ${Math.round(limits.rateCap).toLocaleString()} m³/d (transfers throttled).`
                : `Day ${day}: Route ${corridor.name} baseline rate cap (${Math.round(limits.rateCap).toLocaleString()} m³/d) reached (transfers throttled).`
            );
          }
        }

        if (limits.fleetCap !== undefined && corridorLinks.length > 0) {
          const totalFleet = corridorLinks.reduce((sum, l) => sum + Math.max(0, l.fleetCount || 0), 0);
          if (totalFleet > limits.fleetCap + EPS) {
            const fleetRatio = limits.fleetCap / totalFleet;
            routeThrottledCorridors.add(corridor.id);
            corridorLinks.forEach(link => {
              const req = primaryRouteAllocated.get(link.id) ?? 0;
              const fleetCapped = req * fleetRatio;
              const existingCap = postPrimaryRouteCaps.get(link.id);
              postPrimaryRouteCaps.set(
                link.id,
                existingCap === undefined ? fleetCapped : Math.min(existingCap, fleetCapped)
              );
            });
            pushAlert(
              `Day ${day}: Route ${corridor.name} fleet cap (${limits.fleetCap} units vs ${totalFleet} assigned) reached (transfers throttled).`
            );
          }
        }
      });

      postPrimaryRouteCaps.forEach((cappedAmount, linkId) => {
        const prevReq = primaryRouteAllocated.get(linkId) ?? 0;
        if (cappedAmount < prevReq - EPS) {
          primaryRouteAllocated.set(linkId, Math.max(0, cappedAmount));
          if (cappedAmount > EPS) {
            routeRestrictedLinks.add(linkId);
          }
        }
      });

      // Track corridor rate & fleet consumption after Pass 1.5A
      const corridorUsedRate = new Map<string, number>();
      const corridorUsedFleet = new Map<string, number>();
      this.corridors.forEach(c => {
        corridorUsedRate.set(c.id, 0);
        corridorUsedFleet.set(c.id, 0);
      });

      primaryLinksList.forEach(link => {
        const alloc = primaryRouteAllocated.get(link.id) ?? 0;
        if (alloc > EPS) {
          getLinkCorridorIds(link).forEach(cid => {
            corridorUsedRate.set(cid, (corridorUsedRate.get(cid) ?? 0) + alloc);
            corridorUsedFleet.set(cid, (corridorUsedFleet.get(cid) ?? 0) + Math.max(0, link.fleetCount || 0));
          });
        }
      });

      // Pass 1.5B: Backup Route Corridor Spillover (Unmet Remainder)
      const detourDemands = new Map<string, number>();
      const detourCandidates: TransferLink[] = [];

      primaryLinksList.forEach(link => {
        const preReq = preRouteFlows.get(link.id) ?? 0;
        const primAlloc = primaryRouteAllocated.get(link.id) ?? 0;
        const unmet = Math.max(0, preReq - primAlloc);
        const backupIds = getLinkBackupCorridorIds(link);
        if (unmet <= EPS || backupIds.length === 0) return;

        // If any assigned backup corridor is blocked/halted, cannot detour via this chain
        const anyBackupBlocked = backupIds.some(cid => {
          const c = this.corridors.get(cid);
          return c ? getCorridorLimits(c).blocked : false;
        });
        if (anyBackupBlocked) return;

        const maxDetour =
          link.backupCorridorRate !== undefined && Number.isFinite(link.backupCorridorRate)
            ? Math.max(0, link.backupCorridorRate)
            : unmet;
        const desiredDetour = Math.min(unmet, maxDetour);
        if (desiredDetour > EPS) {
          detourDemands.set(link.id, desiredDetour);
          detourCandidates.push(link);
        }
      });

      const detourAllocated = new Map<string, number>();
      detourCandidates.forEach(l => detourAllocated.set(l.id, detourDemands.get(l.id) ?? 0));

      if (detourCandidates.length > 0) {
        this.corridors.forEach(corridor => {
          const limits = getCorridorLimits(corridor);
          const linksUsingBackup = detourCandidates.filter(l =>
            getLinkBackupCorridorIds(l).includes(corridor.id)
          );
          if (linksUsingBackup.length === 0) return;

          if (limits.blocked) {
            linksUsingBackup.forEach(l => detourAllocated.set(l.id, 0));
            return;
          }

          if (limits.rateCap !== undefined) {
            const remRate = Math.max(0, limits.rateCap - (corridorUsedRate.get(corridor.id) ?? 0));
            const totalDetourReq = linksUsingBackup.reduce(
              (s, l) => s + (detourAllocated.get(l.id) ?? 0),
              0
            );
            if (totalDetourReq > remRate + EPS) {
              routeThrottledCorridors.add(corridor.id);
              const { allocations } = this.allocateByPriority(
                linksUsingBackup,
                detourAllocated,
                remRate,
                () => 1.0,
                EPS
              );
              linksUsingBackup.forEach(l => {
                const prev = detourAllocated.get(l.id) ?? 0;
                detourAllocated.set(l.id, Math.min(prev, allocations.get(l.id) ?? 0));
              });
            }
          }

          if (limits.fleetCap !== undefined) {
            const remFleet = Math.max(0, limits.fleetCap - (corridorUsedFleet.get(corridor.id) ?? 0));
            const totalDetourFleet = linksUsingBackup.reduce(
              (s, l) => s + ((detourAllocated.get(l.id) ?? 0) > EPS ? Math.max(0, l.fleetCount || 0) : 0),
              0
            );
            if (totalDetourFleet > remFleet + EPS) {
              routeThrottledCorridors.add(corridor.id);
              const ratio = remFleet <= EPS ? 0 : remFleet / totalDetourFleet;
              linksUsingBackup.forEach(l => {
                const prev = detourAllocated.get(l.id) ?? 0;
                detourAllocated.set(l.id, prev * ratio);
              });
            }
          }
        });
      }

      // Combine Primary + Backup Corridor allocations into requestedTransfers
      primaryLinksList.forEach(link => {
        const preReq = preRouteFlows.get(link.id) ?? 0;
        const primAlloc = primaryRouteAllocated.get(link.id) ?? 0;
        const detAlloc = detourAllocated.get(link.id) ?? 0;
        const combined = primAlloc + detAlloc;
        requestedTransfers.set(link.id, combined);

        if (detAlloc > EPS) {
          const backupIds = getLinkBackupCorridorIds(link);
          rawRouteSplits.set(link.id, {
            primaryFlow: primAlloc,
            backupFlow: detAlloc,
            activeBackupCorridorIds: backupIds
          });
          backupIds.forEach(cid => {
            corridorUsedRate.set(cid, (corridorUsedRate.get(cid) ?? 0) + detAlloc);
            corridorUsedFleet.set(cid, (corridorUsedFleet.get(cid) ?? 0) + Math.max(0, link.fleetCount || 0));
          });
          routeBlockedLinks.delete(link.id);
          if (combined < preReq - EPS) {
            routeRestrictedLinks.add(link.id);
          } else {
            routeRestrictedLinks.delete(link.id);
          }
        }
      });

      // Snapshot pre-Stage-2 flows for Primary links
      const preTargetFlows = new Map<string, number>();
      requestedTransfers.forEach((val, id) => preTargetFlows.set(id, val));

      // =========================================================================
      // Stage 2A: Target Capacity, Container Backup ("Transfer-Through"), & Null Junctions
      // =========================================================================
      const workingFlows = new Map<string, number>();
      requestedTransfers.forEach((val, id) => workingFlows.set(id, val));

      const prevHeadroomHoldStates = new Map(this.headroomHoldStates);
      const convergedHoldStates = new Map<string, boolean>();
      const targetBlockedAlertsPending = new Set<string>();

      // Zero out primary links entering a blocked target
      targetInboundLinks.forEach((inboundLinks, targetId) => {
        const target = this.nodes.get(targetId);
        if (!target) return;
        const targetSched = getNodeScheduleState(target);
        if (targetSched.blocked) {
          inboundLinks.forEach(l => {
            if (getLinkRole(l) === 'primary') {
              workingFlows.set(l.id, 0);
            }
          });
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

      // Helper to compute maximum route-eligible capacity for a single contingency link (overflow or standby)
      const computeSingleLinkRouteCapacity = (
        link: TransferLink,
        desiredFlow: number
      ): { totalCap: number; primaryCap: number; backupCap: number; activeBackupIds: string[] } => {
        if (desiredFlow <= EPS) {
          return { totalCap: 0, primaryCap: 0, backupCap: 0, activeBackupIds: [] };
        }
        const primaryIds = getLinkCorridorIds(link);
        const backupIds = getLinkBackupCorridorIds(link);
        const linkFleet = Math.max(0, link.fleetCount || 0);

        const evaluateCorridorSet = (cids: string[], reqFlow: number): number => {
          if (cids.length === 0) return reqFlow;
          let cap = reqFlow;
          for (const cid of cids) {
            const c = this.corridors.get(cid);
            if (!c) continue;
            const limits = getCorridorLimits(c);
            if (limits.blocked) return 0;
            if (limits.rateCap !== undefined) {
              const remRate = Math.max(0, limits.rateCap - (corridorUsedRate.get(cid) ?? 0));
              cap = Math.min(cap, remRate);
            }
            if (limits.fleetCap !== undefined && linkFleet > EPS) {
              const remFleet = Math.max(0, limits.fleetCap - (corridorUsedFleet.get(cid) ?? 0));
              if (remFleet <= EPS) return 0;
              if (linkFleet > remFleet + EPS) {
                cap = Math.min(cap, reqFlow * (remFleet / linkFleet));
              }
            }
          }
          return Math.max(0, cap);
        };

        const primaryCap = evaluateCorridorSet(primaryIds, desiredFlow);
        let backupCap = 0;
        let activeBackupIds: string[] = [];
        const unmet = Math.max(0, desiredFlow - primaryCap);
        if (unmet > EPS && backupIds.length > 0) {
          const detourReq =
            link.backupCorridorRate !== undefined && Number.isFinite(link.backupCorridorRate)
              ? Math.min(unmet, Math.max(0, link.backupCorridorRate))
              : unmet;
          backupCap = evaluateCorridorSet(backupIds, detourReq);
          if (backupCap > EPS) {
            activeBackupIds = backupIds;
          }
        }
        return {
          totalCap: primaryCap + backupCap,
          primaryCap,
          backupCap,
          activeBackupIds
        };
      };

      // Pre-evaluate eligibility and max capacity for every 'overflow' link
      const overflowLinkMaxCap = new Map<string, number>();
      const overflowLinkRouteMeta = new Map<
        string,
        { primaryCap: number; backupCap: number; activeBackupIds: string[] }
      >();
      const overflowTriggeredLinks = new Set<string>();
      const overflowTriggeredNodes = new Set<string>();

      overflowLinksList.forEach(link => {
        const src = this.nodes.get(link.sourceId);
        const tgt = this.nodes.get(link.targetId);
        if (!src || !tgt) {
          overflowLinkMaxCap.set(link.id, 0);
          return;
        }
        if (getNodeScheduleState(src).blocked || getNodeScheduleState(tgt).blocked) {
          overflowLinkMaxCap.set(link.id, 0);
          return;
        }
        const matInfo = this.getLinkMaterial(link, src);
        if (tgt.allowedMaterials && tgt.allowedMaterials.length > 0 && !tgt.allowedMaterials.includes(matInfo.code)) {
          materialMismatchLinks.add(link.id);
          overflowLinkMaxCap.set(link.id, 0);
          return;
        }
        const rate = activeLinkRates.get(link.id) ?? 0;
        if (rate <= EPS) {
          overflowLinkMaxCap.set(link.id, 0);
          return;
        }
        const routeRes = computeSingleLinkRouteCapacity(link, rate);
        overflowLinkMaxCap.set(link.id, routeRes.totalCap);
        overflowLinkRouteMeta.set(link.id, {
          primaryCap: routeRes.primaryCap,
          backupCap: routeRes.backupCap,
          activeBackupIds: routeRes.activeBackupIds
        });
      });

      // Step 2A.1: Seed Container Backup ("Transfer-Through") overflow flows (supports chaining B -> B2 -> B3)
      const MAX_CHAIN_PASSES = 6;
      for (let chainPass = 0; chainPass < MAX_CHAIN_PASSES; chainPass++) {
        let changed = false;

        this.nodes.forEach(node => {
          if (node.type === 'external' || node.type === 'null') return;
          const overflowMode = node.overflowMode || this.defaultOverflowMode;
          if (overflowMode === 'overfill') return;
          if (node.strictSubRule !== 'transfer_through') return;
          if (getNodeScheduleState(node).blocked) return;

          const inbound = targetInboundLinks.get(node.id) || [];
          const outbound = sourceOutboundLinks.get(node.id) || [];
          const overflowOut = outbound.filter(l => getLinkRole(l) === 'overflow');
          if (overflowOut.length === 0) return;

          const inboundDeposit = inbound.reduce((sum, inLink) => {
            const flow = workingFlows.get(inLink.id) ?? 0;
            if (flow <= EPS) return sum;
            const src = this.nodes.get(inLink.sourceId);
            const bulkIn = src ? this.getLinkMaterial(inLink, src).bulkIN : 1.0;
            return sum + flow * bulkIn;
          }, 0);

          if (inboundDeposit <= EPS) return;

          const normalOutboundRemoved = outbound
            .filter(l => getLinkRole(l) !== 'overflow')
            .reduce((sum, outLink) => {
              const flow = workingFlows.get(outLink.id) ?? 0;
              if (flow <= EPS) return sum;
              const { bulkOUT } = this.getLinkMaterial(outLink, node);
              return sum + flow * bulkOUT;
            }, 0);

          const triggerPct = Math.max(1, Math.min(100, node.overflowTriggerPct ?? 100));
          const triggerCap = node.capacity * (triggerPct / 100);
          const startVol = startOfDayVolumes[node.id] ?? 0;
          const projectedVol = Math.max(0, startVol - normalOutboundRemoved) + inboundDeposit;
          const desiredSpillVol = Math.min(inboundDeposit, Math.max(0, projectedVol - triggerCap));

          if (desiredSpillVol <= EPS) return;

          overflowTriggeredNodes.add(node.id);
          overflowOut.forEach(l => overflowTriggeredLinks.add(l.id));

          const capDemands = new Map<string, number>();
          overflowOut.forEach(l => capDemands.set(l.id, overflowLinkMaxCap.get(l.id) ?? 0));

          const { allocations } = this.allocateByPriority(
            overflowOut,
            capDemands,
            desiredSpillVol,
            l => this.getLinkMaterial(l, node).bulkOUT,
            EPS
          );

          overflowOut.forEach(l => {
            const prev = workingFlows.get(l.id) ?? 0;
            const next = Math.max(prev, allocations.get(l.id) ?? 0);
            if (Math.abs(next - prev) > EPS) {
              workingFlows.set(l.id, next);
              changed = true;
            }
          });
        });

        if (!changed) break;
      }

      // Enforce shared corridor caps across simultaneously seeded overflow links if multiple share a corridor
      if (overflowLinksList.some(l => (workingFlows.get(l.id) ?? 0) > EPS)) {
        this.corridors.forEach(corridor => {
          const limits = getCorridorLimits(corridor);
          if (limits.rateCap === undefined) return;
          const activeOvfOnCorridor = overflowLinksList.filter(
            l => (workingFlows.get(l.id) ?? 0) > EPS && getLinkCorridorIds(l).includes(corridor.id)
          );
          if (activeOvfOnCorridor.length <= 1) return;
          const remRate = Math.max(0, limits.rateCap - (corridorUsedRate.get(corridor.id) ?? 0));
          const totalOvf = activeOvfOnCorridor.reduce((s, l) => s + (workingFlows.get(l.id) ?? 0), 0);
          if (totalOvf > remRate + EPS) {
            routeThrottledCorridors.add(corridor.id);
            const { allocations } = this.allocateByPriority(
              activeOvfOnCorridor,
              workingFlows,
              remRate,
              () => 1.0,
              EPS
            );
            activeOvfOnCorridor.forEach(l => {
              workingFlows.set(l.id, Math.min(workingFlows.get(l.id) ?? 0, allocations.get(l.id) ?? 0));
            });
          }
        });
      }

      // Step 2A.2: Fixed-point convergence loop (monotonically non-increasing; converges cleanly)
      const MAX_ITERS = 12;
      for (let iter = 0; iter < MAX_ITERS; iter++) {
        let maxDelta = 0;

        // A. Enforce finite target storage capacity (including same-day outbound drainage & active overflow links)
        targetInboundLinks.forEach((inboundLinks, targetId) => {
          const target = this.nodes.get(targetId);
          if (!target) return;

          const targetSched = getNodeScheduleState(target);
          if (targetSched.blocked) return;

          if (target.type === 'external' || target.type === 'null') return;

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

          // Bulking-aware headroom allocation by priority tier
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

          // For transfer_through containers: if inbound shrunk due to upstream back-pressure,
          // ensure active outbound overflow links never drain container below its triggerCap
          if (subRule === 'transfer_through') {
            const overflowOut = outboundLinks.filter(l => getLinkRole(l) === 'overflow');
            if (overflowOut.length > 0) {
              const currentInboundDeposit = inboundLinks.reduce((sum, inLink) => {
                const flow = workingFlows.get(inLink.id) ?? 0;
                if (flow <= EPS) return sum;
                const src = this.nodes.get(inLink.sourceId);
                return sum + flow * (src ? this.getLinkMaterial(inLink, src).bulkIN : 1.0);
              }, 0);
              const normalOutboundRemoved = outboundLinks
                .filter(l => getLinkRole(l) !== 'overflow')
                .reduce((sum, outLink) => {
                  const flow = workingFlows.get(outLink.id) ?? 0;
                  if (flow <= EPS) return sum;
                  return sum + flow * this.getLinkMaterial(outLink, target).bulkOUT;
                }, 0);

              const triggerPct = Math.max(1, Math.min(100, target.overflowTriggerPct ?? 100));
              const triggerCap = target.capacity * (triggerPct / 100);
              const projectedWithoutOvf = Math.max(0, startVol - normalOutboundRemoved) + currentInboundDeposit;
              const maxAllowedSpill = Math.min(
                currentInboundDeposit,
                Math.max(0, projectedWithoutOvf - triggerCap)
              );

              const currentOvfRemoved = overflowOut.reduce((sum, outLink) => {
                const flow = workingFlows.get(outLink.id) ?? 0;
                return sum + flow * this.getLinkMaterial(outLink, target).bulkOUT;
              }, 0);

              if (currentOvfRemoved > maxAllowedSpill + EPS) {
                const { allocations: clampedOvf } = this.allocateByPriority(
                  overflowOut,
                  workingFlows,
                  maxAllowedSpill,
                  l => this.getLinkMaterial(l, target).bulkOUT,
                  EPS
                );
                overflowOut.forEach(l => {
                  const prev = workingFlows.get(l.id) ?? 0;
                  const next = Math.max(0, clampedOvf.get(l.id) ?? 0);
                  if (Math.abs(prev - next) > EPS) {
                    workingFlows.set(l.id, next);
                    maxDelta = Math.max(maxDelta, Math.abs(prev - next));
                  }
                });
              }
            }
          }
        });

        // B. Balance zero-storage Null Junction pass-through nodes (totalIn === totalOut)
        this.nodes.forEach(node => {
          if (node.type !== 'null') return;
          const inbound = targetInboundLinks.get(node.id) || [];
          const outbound = sourceOutboundLinks.get(node.id) || [];

          const totalIn = inbound.reduce((s, l) => s + (workingFlows.get(l.id) ?? 0), 0);
          const totalOut = outbound.reduce((s, l) => s + (workingFlows.get(l.id) ?? 0), 0);

          if (totalOut > totalIn + EPS) {
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

      // Record route usage & route splits for active overflow links
      overflowLinksList.forEach(link => {
        const flow = workingFlows.get(link.id) ?? 0;
        if (flow <= EPS) return;
        const meta = overflowLinkRouteMeta.get(link.id);
        const primFlow = meta ? Math.min(flow, meta.primaryCap) : flow;
        const backFlow = Math.max(0, flow - primFlow);
        if (primFlow > EPS) {
          getLinkCorridorIds(link).forEach(cid => {
            corridorUsedRate.set(cid, (corridorUsedRate.get(cid) ?? 0) + primFlow);
            corridorUsedFleet.set(cid, (corridorUsedFleet.get(cid) ?? 0) + Math.max(0, link.fleetCount || 0));
          });
        }
        if (backFlow > EPS && meta && meta.activeBackupIds.length > 0) {
          rawRouteSplits.set(link.id, {
            primaryFlow: primFlow,
            backupFlow: backFlow,
            activeBackupCorridorIds: meta.activeBackupIds
          });
          meta.activeBackupIds.forEach(cid => {
            corridorUsedRate.set(cid, (corridorUsedRate.get(cid) ?? 0) + backFlow);
            corridorUsedFleet.set(cid, (corridorUsedFleet.get(cid) ?? 0) + Math.max(0, link.fleetCount || 0));
          });
        }
      });

      // Commit headroom hold states & emit Stage 2A alerts
      const saturatedTransferThroughNodes = new Set<string>();
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

        const primaryInbound = inboundLinks.filter(l => getLinkRole(l) !== 'standby');
        const totalPreTargetDeposit = primaryInbound.reduce((sum, l) => {
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
        } else if (subRule === 'transfer_through') {
          const ovfLinks = outboundLinks.filter(l => getLinkRole(l) === 'overflow');
          const totalOvfFlow = ovfLinks.reduce((s, l) => s + (workingFlows.get(l.id) ?? 0), 0);
          if (totalOvfFlow > EPS) {
            overflowActiveNodes[targetId] = totalOvfFlow;
            const triggerPct = Math.max(1, Math.min(100, target.overflowTriggerPct ?? 100));
            const backupNames = Array.from(
              new Set(
                ovfLinks
                  .filter(l => (workingFlows.get(l.id) ?? 0) > EPS)
                  .map(l => this.nodes.get(l.targetId)?.name || l.targetId)
              )
            ).join(', ');
            pushAlert(
              `Day ${day}: Container ${target.name} reached ${triggerPct}% trigger. Transferring ${Math.round(totalOvfFlow).toLocaleString()} m³/d through to ${backupNames}.`
            );
          }
          const actualInboundDeposit = primaryInbound.reduce((sum, l) => {
            const actual = workingFlows.get(l.id) ?? 0;
            const src = this.nodes.get(l.sourceId);
            const bulkIn = src ? this.getLinkMaterial(l, src).bulkIN : 1.0;
            return sum + actual * bulkIn;
          }, 0);
          if (totalPreTargetDeposit > actualInboundDeposit + EPS) {
            saturatedTransferThroughNodes.add(targetId);
            pushAlert(
              `Day ${day}: Container ${target.name} and overflow backup(s) saturated. Inbound transfers throttled.`
            );
          }
        } else if (subRule === 'throttleback') {
          if (totalPreTargetDeposit > effectiveHeadroom + EPS) {
            pushAlert(`Day ${day}: Target ${target.name} nearing capacity. Transfer rates throttled.`);
          }
        }
      });

      this.nodes.forEach(node => {
        if (!targetInboundLinks.has(node.id)) {
          this.headroomHoldStates.set(node.id, false);
        }
      });

      // =========================================================================
      // Stage 2B: Standby Transfer Link Activation (Spillover Remainder)
      // =========================================================================
      const standbyTriggeredLinks = new Set<string>();

      if (standbyLinksList.length > 0) {
        // Track committed physical deltas & container throughputs from Stage 2A
        const committedRemoved = new Map<string, number>();
        const committedAdded = new Map<string, number>();
        const committedThroughput = new Map<string, number>();

        this.links.forEach(link => {
          const flow = workingFlows.get(link.id) ?? 0;
          if (flow <= EPS) return;
          const src = this.nodes.get(link.sourceId);
          const tgt = this.nodes.get(link.targetId);
          if (src && src.type !== 'null') {
            const { bulkOUT } = this.getLinkMaterial(link, src);
            committedRemoved.set(src.id, (committedRemoved.get(src.id) ?? 0) + flow * bulkOUT);
            committedThroughput.set(src.id, (committedThroughput.get(src.id) ?? 0) + flow);
          }
          if (tgt && tgt.type !== 'null') {
            const { bulkIN } = src ? this.getLinkMaterial(link, src) : { bulkIN: 1.0 };
            committedAdded.set(tgt.id, (committedAdded.get(tgt.id) ?? 0) + flow * bulkIN);
            committedThroughput.set(tgt.id, (committedThroughput.get(tgt.id) ?? 0) + flow);
          }
        });

        // Group standby links by watched primaryLinkId
        const standbysByPrimary = new Map<string, TransferLink[]>();
        standbyLinksList.forEach(sLink => {
          if (!sLink.primaryLinkId || sLink.primaryLinkId === sLink.id) return;
          const watched = this.links.get(sLink.primaryLinkId);
          if (!watched || getLinkRole(watched) === 'standby') return;
          const list = standbysByPrimary.get(watched.id) || [];
          list.push(sLink);
          standbysByPrimary.set(watched.id, list);
        });

        standbysByPrimary.forEach((group, primaryId) => {
          const pLink = this.links.get(primaryId);
          if (!pLink) return;
          const pSrc = this.nodes.get(pLink.sourceId);
          const pTgt = this.nodes.get(pLink.targetId);

          const pCalEvt = activeTransferEvents.get(pLink.id);
          const pBase = baselineLinkRates.get(pLink.id) ?? pLink.dailyRate;
          const pActive = activeLinkRates.get(pLink.id) ?? pBase;
          const pTargetDemand = Math.max(pBase, pActive);
          const pActual = workingFlows.get(pLink.id) ?? 0;
          let remainingShortfall = Math.max(0, pTargetDemand - pActual);
          if (remainingShortfall <= EPS) return;

          const calendarFired =
            calendarStoppedLinks.has(pLink.id) ||
            (pCalEvt?.state === 'variable' && pActive < pLink.dailyRate - EPS);
          const routeFired = routeBlockedLinks.has(pLink.id) || routeRestrictedLinks.has(pLink.id);
          const sourceFired =
            (pSrc ? getNodeScheduleState(pSrc).blocked : false) ||
            sourceStarvedEmptyLinks.has(pLink.id) ||
            sourceStarvedPartialLinks.has(pLink.id);
          const targetFired =
            (pTgt ? getNodeScheduleState(pTgt).blocked : false) ||
            materialMismatchLinks.has(pLink.id) ||
            pActual < (preTargetFlows.get(pLink.id) ?? 0) - EPS;

          // Sort standby links by ascending priority (1 = highest)
          const sortedStandbys = [...group].sort((a, b) => (a.priority ?? 1) - (b.priority ?? 1));

          for (const sLink of sortedStandbys) {
            if (remainingShortfall <= EPS) break;

            const isAlternateSource = sLink.sourceId !== pLink.sourceId;
            const enabledTriggers: DiversionTrigger[] =
              sLink.diversionTriggers && sLink.diversionTriggers.length > 0
                ? sLink.diversionTriggers
                : isAlternateSource
                ? ['route', 'target', 'calendar', 'source']
                : ['route', 'target', 'calendar'];

            const triggerMatched =
              (enabledTriggers.includes('route') && routeFired) ||
              (enabledTriggers.includes('target') && targetFired) ||
              (enabledTriggers.includes('calendar') && calendarFired) ||
              (enabledTriggers.includes('source') && sourceFired);

            if (!triggerMatched) continue;

            standbyTriggeredLinks.add(sLink.id);

            const sSrc = this.nodes.get(sLink.sourceId);
            const sTgt = this.nodes.get(sLink.targetId);
            if (!sSrc || !sTgt) continue;
            if (getNodeScheduleState(sSrc).blocked || getNodeScheduleState(sTgt).blocked) continue;

            const sRate = activeLinkRates.get(sLink.id) ?? 0;
            if (sRate <= EPS) continue;

            const matInfo = this.getLinkMaterial(sLink, sSrc);
            if (
              sTgt.allowedMaterials &&
              sTgt.allowedMaterials.length > 0 &&
              !sTgt.allowedMaterials.includes(matInfo.code)
            ) {
              materialMismatchLinks.add(sLink.id);
              continue;
            }

            // 1. Remaining source stock cap
            let sourceMaxFlow = Infinity;
            if (sSrc.type === 'null') {
              sourceMaxFlow = 0;
            } else if (sSrc.type !== 'external') {
              const remSrcVol = Math.max(
                0,
                (startOfDayVolumes[sSrc.id] ?? 0) - (committedRemoved.get(sSrc.id) ?? 0)
              );
              sourceMaxFlow = matInfo.bulkOUT > EPS ? remSrcVol / matInfo.bulkOUT : 0;
            }

            // 2. Remaining container calendar 'restricted' throughput cap
            let containerCap = Infinity;
            const srcSched = getNodeScheduleState(sSrc);
            if (srcSched.restrictedCap !== undefined) {
              containerCap = Math.min(
                containerCap,
                Math.max(0, srcSched.restrictedCap - (committedThroughput.get(sSrc.id) ?? 0))
              );
            }
            const tgtSched = getNodeScheduleState(sTgt);
            if (tgtSched.restrictedCap !== undefined) {
              containerCap = Math.min(
                containerCap,
                Math.max(0, tgtSched.restrictedCap - (committedThroughput.get(sTgt.id) ?? 0))
              );
            }

            // 3. Remaining target headroom cap
            let targetMaxFlow = Infinity;
            if (sTgt.type === 'null') {
              targetMaxFlow = 0;
            } else if (sTgt.type !== 'external') {
              const tgtOverflow = sTgt.overflowMode || this.defaultOverflowMode;
              if (tgtOverflow !== 'overfill') {
                if (sTgt.strictSubRule === 'headroom_hold' && (this.headroomHoldStates.get(sTgt.id) || false)) {
                  targetMaxFlow = 0;
                } else {
                  const tgtStart = startOfDayVolumes[sTgt.id] ?? 0;
                  const tgtAfterOut = Math.max(0, tgtStart - (committedRemoved.get(sTgt.id) ?? 0));
                  const tgtProjected = tgtAfterOut + (committedAdded.get(sTgt.id) ?? 0);
                  const tgtRemHeadroom = Math.max(0, sTgt.capacity - tgtProjected);
                  targetMaxFlow = matInfo.bulkIN > EPS ? tgtRemHeadroom / matInfo.bulkIN : 0;
                }
              }
            }

            const preRouteDesired = Math.min(
              remainingShortfall,
              sRate,
              sourceMaxFlow,
              containerCap,
              targetMaxFlow
            );
            if (preRouteDesired <= EPS) continue;

            // 4. Route corridor cap (including standby link's own backup corridors if assigned)
            const routeRes = computeSingleLinkRouteCapacity(sLink, preRouteDesired);
            const granted = routeRes.totalCap;
            if (granted <= EPS) continue;

            workingFlows.set(sLink.id, granted);
            remainingShortfall = Math.max(0, remainingShortfall - granted);

            // Deduct committed budgets
            if (sSrc.type !== 'null') {
              committedRemoved.set(sSrc.id, (committedRemoved.get(sSrc.id) ?? 0) + granted * matInfo.bulkOUT);
              committedThroughput.set(sSrc.id, (committedThroughput.get(sSrc.id) ?? 0) + granted);
            }
            if (sTgt.type !== 'null') {
              committedAdded.set(sTgt.id, (committedAdded.get(sTgt.id) ?? 0) + granted * matInfo.bulkIN);
              committedThroughput.set(sTgt.id, (committedThroughput.get(sTgt.id) ?? 0) + granted);
            }
            if (routeRes.primaryCap > EPS) {
              const usedPrim = Math.min(granted, routeRes.primaryCap);
              getLinkCorridorIds(sLink).forEach(cid => {
                corridorUsedRate.set(cid, (corridorUsedRate.get(cid) ?? 0) + usedPrim);
                corridorUsedFleet.set(
                  cid,
                  (corridorUsedFleet.get(cid) ?? 0) + Math.max(0, sLink.fleetCount || 0)
                );
              });
            }
            if (routeRes.backupCap > EPS && routeRes.activeBackupIds.length > 0) {
              rawRouteSplits.set(sLink.id, {
                primaryFlow: routeRes.primaryCap,
                backupFlow: routeRes.backupCap,
                activeBackupCorridorIds: routeRes.activeBackupIds
              });
              routeRes.activeBackupIds.forEach(cid => {
                corridorUsedRate.set(cid, (corridorUsedRate.get(cid) ?? 0) + routeRes.backupCap);
                corridorUsedFleet.set(
                  cid,
                  (corridorUsedFleet.get(cid) ?? 0) + Math.max(0, sLink.fleetCount || 0)
                );
              });
            }

            standbyActivatedFrom[sLink.id] = {
              primaryLinkId: pLink.id,
              divertedFlow: granted
            };

            pushAlert(
              `Day ${day}: Standby transfer ${sSrc.name} → ${sTgt.name} activated (${Math.round(granted).toLocaleString()} m³/d spillover from ${pSrc?.name || pLink.sourceId} → ${pTgt?.name || pLink.targetId}).`
            );
          }
        });
      }

      // Record final planned transfers
      const plannedTransfers = new Map<string, number>();
      this.links.forEach(link => {
        const finalFlow = Math.max(0, workingFlows.get(link.id) ?? 0);
        plannedTransfers.set(link.id, finalFlow);
        linkFlows[link.id] = finalFlow;
      });

      // Reconcile final primary vs backup corridor splits (keep flow on primary route before detour)
      this.links.forEach(link => {
        const actualFlow = plannedTransfers.get(link.id) ?? 0;
        const rawSplit = rawRouteSplits.get(link.id);
        if (!rawSplit || rawSplit.backupFlow <= EPS) return;

        const finalPrimary = Math.min(actualFlow, rawSplit.primaryFlow);
        const finalBackup = Math.max(0, actualFlow - finalPrimary);
        if (finalBackup > EPS) {
          linkRouteSplits[link.id] = {
            primaryFlow: finalPrimary,
            backupFlow: finalBackup,
            activeBackupCorridorIds: rawSplit.activeBackupCorridorIds
          };
          const srcName = this.nodes.get(link.sourceId)?.name || link.sourceId;
          const tgtName = this.nodes.get(link.targetId)?.name || link.targetId;
          const detourNames = rawSplit.activeBackupCorridorIds
            .map(cid => this.corridors.get(cid)?.name || cid)
            .join(' + ');
          pushAlert(
            `Day ${day}: Transfer ${srcName} → ${tgtName} diverted ${Math.round(finalBackup).toLocaleString()} m³/d onto backup route ${detourNames}.`
          );
        }
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

      // Record resulting node volumes & capacity / overfill alerts
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
          const isActivelyTransferringThrough =
            node.strictSubRule === 'transfer_through' &&
            (overflowActiveNodes[node.id] ?? 0) > EPS &&
            !saturatedTransferThroughNodes.has(node.id);
          if (!isActivelyTransferringThrough && (startVol < node.capacity - EPS || hasInboundDemand)) {
            pushAlert(`Day ${day}: Node ${node.name} reached capacity!`);
          }
        }
      });

      // =========================================================================
      // Stage 4: Classify Link, Node, and Route Corridor Visual Flow Statuses
      // =========================================================================
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
        const role = getLinkRole(link);
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
          return;
        }

        // Contingency links (standby & overflow)
        if (role === 'standby' || role === 'overflow') {
          if (actualFlow > EPS) {
            linkStatuses[link.id] = 'diverted';
          } else {
            const wasTriggered =
              role === 'standby' ? standbyTriggeredLinks.has(link.id) : overflowTriggeredLinks.has(link.id);
            if (
              wasTriggered &&
              (calendarStoppedLinks.has(link.id) ||
                sourceBlocked ||
                targetBlocked ||
                materialMismatchLinks.has(link.id) ||
                linkRate <= EPS ||
                actualFlow <= EPS)
            ) {
              linkStatuses[link.id] = 'blocked';
            } else {
              linkStatuses[link.id] = 'idle';
            }
          }
          return;
        }

        // Primary links
        const routeSplit = linkRouteSplits[link.id];
        if (calendarStoppedLinks.has(link.id) || routeBlockedLinks.has(link.id)) {
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
        } else if (routeSplit && routeSplit.backupFlow > EPS) {
          linkStatuses[link.id] = 'diverted';
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

      // Node status classification (ignores dormant 'idle' standby/overflow links; shows 'diverted' for active transfer-through)
      this.nodes.forEach(node => {
        const inbound = targetInboundLinks.get(node.id) || [];
        const outbound = sourceOutboundLinks.get(node.id) || [];
        const connected = [...inbound, ...outbound];
        const activeConnected = connected.filter(l => {
          const role = getLinkRole(l);
          if (role === 'standby' || role === 'overflow') {
            return linkStatuses[l.id] !== 'idle';
          }
          return true;
        });
        const nodeSched = getNodeScheduleState(node);

        if (nodeSched.blocked) {
          nodeStatuses[node.id] = 'blocked';
          return;
        }

        const nodeOverflow = node.overflowMode || this.defaultOverflowMode;
        const isOverfilled =
          node.type !== 'external' && node.type !== 'null' && node.currentVolume > node.capacity + EPS;
        const isTransferringThrough = (overflowActiveNodes[node.id] ?? 0) > EPS;
        const isTransferThroughSaturated = saturatedTransferThroughNodes.has(node.id);
        const isAtCapacity =
          node.type !== 'external' &&
          node.type !== 'null' &&
          nodeOverflow !== 'overfill' &&
          node.capacity > EPS &&
          node.currentVolume >= node.capacity - EPS &&
          !(isTransferringThrough && !isTransferThroughSaturated);
        const isHalted = this.headroomHoldStates.get(node.id) || false;
        const isEmpty = node.type !== 'external' && node.type !== 'null' && node.currentVolume <= EPS;
        const isContainerCalRestricted = nodeSched.restrictedCap !== undefined && nodeSched.restrictedCap > EPS;

        if (isOverfilled || isAtCapacity || isHalted) {
          nodeStatuses[node.id] = 'blocked';
          return;
        }

        if (isTransferringThrough && !isTransferThroughSaturated) {
          nodeStatuses[node.id] = 'diverted';
          return;
        }

        if (activeConnected.length === 0) {
          nodeStatuses[node.id] = isContainerCalRestricted ? 'restricted' : 'frozen';
          return;
        }

        const hasBlocked = activeConnected.some(l => linkStatuses[l.id] === 'blocked');
        const hasRestricted = activeConnected.some(l => linkStatuses[l.id] === 'restricted');
        const hasDiverted = activeConnected.some(l => linkStatuses[l.id] === 'diverted');
        const hasFull = activeConnected.some(l => linkStatuses[l.id] === 'full');
        const hasStarved = activeConnected.some(l => linkStatuses[l.id] === 'starved');
        const hasFlowing = hasFull || hasRestricted || hasDiverted;

        if (hasBlocked && !hasFlowing && !isEmpty) {
          nodeStatuses[node.id] = 'blocked';
        } else if (isContainerCalRestricted || hasRestricted || (hasBlocked && hasFlowing)) {
          nodeStatuses[node.id] = 'restricted';
        } else if (hasDiverted && !hasFull) {
          nodeStatuses[node.id] = 'diverted';
        } else if (node.type === 'null') {
          if (hasFull) nodeStatuses[node.id] = 'full';
          else if (hasDiverted) nodeStatuses[node.id] = 'diverted';
          else if (hasStarved) nodeStatuses[node.id] = 'starved';
          else if (hasBlocked) nodeStatuses[node.id] = 'blocked';
          else nodeStatuses[node.id] = 'frozen';
        } else if (isEmpty) {
          const activeOutbound = outbound.filter(l => getLinkRole(l) === 'primary');
          nodeStatuses[node.id] = activeOutbound.length > 0 ? 'starved' : 'frozen';
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

      // Corridor flows (primary + backup detour flows) & status classification
      this.corridors.forEach(corridor => {
        const routeEvt = activeRouteEvents.get(corridor.id);
        const primaryAssignedLinks = Array.from(this.links.values()).filter(l =>
          getLinkCorridorIds(l).includes(corridor.id)
        );
        const activePrimaryLinks = primaryAssignedLinks.filter(l => {
          const role = getLinkRole(l);
          return role === 'primary' || linkStatuses[l.id] !== 'idle';
        });

        let primaryCorridorFlow = 0;
        primaryAssignedLinks.forEach(l => {
          const split = linkRouteSplits[l.id];
          primaryCorridorFlow += split ? split.primaryFlow : (linkFlows[l.id] ?? 0);
        });

        let detourCorridorFlow = 0;
        Object.values(linkRouteSplits).forEach(split => {
          if (split.backupFlow > EPS && split.activeBackupCorridorIds.includes(corridor.id)) {
            detourCorridorFlow += split.backupFlow;
          }
        });

        corridorFlows[corridor.id] = primaryCorridorFlow + detourCorridorFlow;
        backupCorridorFlows[corridor.id] = detourCorridorFlow;

        const assignedStatuses = activePrimaryLinks.map(l => linkStatuses[l.id] ?? 'frozen');
        const hasBlocked = assignedStatuses.includes('blocked');
        const hasRestricted = assignedStatuses.includes('restricted');
        const hasDiverted = assignedStatuses.includes('diverted') || detourCorridorFlow > EPS;
        const hasFull = assignedStatuses.includes('full');
        const hasStarved = assignedStatuses.includes('starved');
        const hasFlowing = hasFull || hasRestricted || hasDiverted;

        if (routeEvt?.state === 'blocked') {
          corridorStatuses[corridor.id] = 'blocked';
        } else if (routeEvt?.state === 'restricted') {
          if (
            (routeEvt.rateValue !== undefined && routeEvt.rateValue <= EPS) ||
            (assignedStatuses.length > 0 && assignedStatuses.every(s => s === 'blocked') && detourCorridorFlow <= EPS)
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
        } else if (detourCorridorFlow > EPS) {
          corridorStatuses[corridor.id] = 'diverted';
        } else if (activePrimaryLinks.length === 0) {
          corridorStatuses[corridor.id] = 'frozen';
        } else if (hasBlocked && !hasFlowing) {
          corridorStatuses[corridor.id] = 'blocked';
        } else if (hasRestricted || (hasBlocked && hasFlowing)) {
          corridorStatuses[corridor.id] = 'restricted';
        } else if (hasDiverted) {
          corridorStatuses[corridor.id] = 'diverted';
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
        backupCorridorFlows,
        linkRouteSplits,
        overflowActiveNodes,
        standbyActivatedFrom,
        linkStatuses,
        nodeStatuses,
        corridorStatuses,
        alerts
      });
    }

    return frames;
  }
}