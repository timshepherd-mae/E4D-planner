# Simulation Engine Ruleset & Consistency Audit

> **Scope:** Technical specification of the discrete daily simulation engine (`SimEngine`), notification triggers, visual colour coding, and resolution status of all Section 5 consistency amendments.

---

## 1. Execution Model & Daily Pipeline

The simulation runs deterministically as a discrete daily step loop across `day = 0 .. totalDays` (default `totalDays = 30`, numerical epsilon `EPS = 1e-6`).

- **Day 0 (Frozen Baseline):** Captures initial container volumes (`0` for `null` junctions). All `linkFlows` and `corridorFlows` are `0`, no volumes change, and all containers, transfers, and route corridors are classified as `frozen`.
- **Days 1..30 (Active Simulation):** Each day executes in six sequential stages:

```text
[Stage 0] Resolve Active Calendar Events, Schedule Override Alerts & Effective Link Rates
    │
    ▼
[Stage 1] Outbound Source Availability (Primary Links: Bulking-Aware bulkOUT + Priority Tiers)
    │
    ▼
[Stage 1.25] Container Calendar 'restricted' Throughput Cap (Priority-Tiered Combined Cap)
    │
    ▼
[Stage 1.5A] Primary Route Corridor Constraints (Calendar Blocked/Restricted + Baseline Caps)
    │
    ▼
[Stage 1.5B] Backup Route Corridor Spillover (Unmet Primary Route Remainder → backupCorridorIds)
    │
    ▼
[Stage 2A] Container Backup ("Transfer-Through") & Target Capacity / Null-Junction Fixed-Point Solver
           (Configurable overflowTriggerPct, Explicit 'overflow' Links, Multi-Hop Chaining,
            Backup Saturation Fallback to Throttleback, Same-Day Drainage, Headroom Hold)
    │
    ▼
[Stage 2B] Standby Transfer Link Activation (Priority-Ordered Spillover Remainder per primaryLinkId)
    │
    ▼
[Stage 3] Apply Simultaneous Order-Independent Physical Volume Transfers & Overfill/Capacity Alerts
    │
    ▼
[Stage 4] Reconcile Route Splits, Populate corridorFlows/backupCorridorFlows, Classify FlowStatus & Emit SimFrame
```

---

## 2. Driving Logic by Element & Event Type

### 2.1 Container Rules (Baseline)

| Property / Rule | Current Driving Logic |
| :--- | :--- |
| **`type = 'excavation' \| 'stockpile'`** | Finite-capacity storage container governed by stockout, bulking (`bulkOUT` / `bulkIN`), and overflow rules. |
| **`type = 'null'`** | Zero-storage pass-through junction (`currentVolume` locked to `0`). Matches same-day inbound supply directly to outbound demand (`totalIn === totalOut`) via fixed-point convergence, back-pressuring upstream when downstream cannot accept flow. |
| **`type = 'external'`** | Unbounded external boundary. Supplies outbound demand without stockout and absorbs inbound flow without capacity throttling, headroom hold, or overfill blocking (still tracks cumulative volume for graphing). |
| **`status`** (`'active' \| 'maintenance' \| 'blocked'`) | Editable in Property Inspector. If `'blocked'` or `'maintenance'` (and no active Calendar `'open'` override), halts **both** outbound (Stage 1) and inbound (Stage 2) transfers. |
| **Source Stockout & Partial Starvation** | If `availableVol <= EPS`, halts outbound links (`starved`). If `0 < availableVol < sum(rate * bulkOUT)`, allocates available volume by link `priority` tier (pro-rata within ties) using `bulkOUT` and emits a low-stock alert. |
| **`allowedMaterials`** | Editable in Property Inspector & persisted in CSV/JSON. If non-empty on a target container, rejects any inbound link whose effective material (`link.materialId || source.materialType`) is not listed. |
| **Same-Day Outbound Drainage** | For storage targets, `effectiveHeadroom = max(0, capacity - max(0, startVol - outboundRemoved))` where `outboundRemoved = sum(outboundFlow * bulkOUT)`. A full surge stockpile draining outbound frees equivalent same-day space for inbound deposits. |
| **`overflowMode = 'overfill'`** | Uncapped target acceptance. All `requestedTransfers` pass through Stage 2 unthrottled; `target.currentVolume` can exceed `target.capacity`, turning both the fill bar and container border Red (`blocked`) and emitting `[OVERFILL]`. |
| **`overflowMode = 'strict'` + `strictSubRule = 'throttleback'`** *(default)* | Allocates `effectiveHeadroom` across inbound links by `priority` tier (pro-rata within ties) weighted by `bulkIN`, guaranteeing `sum(flow * bulkIN) <= effectiveHeadroom` with zero discarded volume. |
| **`overflowMode = 'strict'` + `strictSubRule = 'headroom_hold'`** | Stateful hysteresis latch (`headroomHoldStates`): latches ON when `startVol >= capacity - EPS` and `effectiveHeadroom < headroomThreshold`; stays halted (`0` inbound) while `effectiveHeadroom < headroomThreshold`; releases once `effectiveHeadroom >= headroomThreshold - EPS` and emits a resume notification. On the final fill day (unhalted), inbound flow is capped to `effectiveHeadroom` (bulking-aware) so `linkFlows` matches deposited volume. |
| **`overflowMode = 'strict'` + `strictSubRule = 'transfer_through'`** | **Container Backup ("Transfer-Through"):** Configured with `overflowTriggerPct` (`1–100`, default `100`). Whenever `inboundDeposit > 0` and projected end-of-day volume exceeds `triggerCap = capacity * (overflowTriggerPct / 100)`, passes the surplus through connected outbound `linkRole = 'overflow'` links (ordered by `priority`, respecting `bulkOUT`/`bulkIN`, route caps, and backup target headroom; supports chaining `B → B2 → B3`). Never drains static stock when inbound is `0`, never pulls volume below `triggerCap`, and gracefully falls back to `throttleback` with an alert if backup containers saturate. Backup containers drain via normal outbound links. |
| **Material Bulking (`bulkOUT` / `bulkIN`)** | Looked up via `link.materialId || source.materialType`. Enforced during Stage 1 (`bulkOUT`), Stage 2 (`bulkIN` & same-day `bulkOUT`), Stage 2B (`bulkOUT`/`bulkIN`), and Stage 3 physical volume mutations (skipped for `null` junction storage). |

### 2.2 Transfer Rules (Baseline & Diversions)

| Property / Rule | Current Driving Logic |
| :--- | :--- |
| **`linkRole`** (`'primary' \| 'standby' \| 'overflow'`) | Defaults to `'primary'`. `'standby'` links remain dormant (`0` flow, `'idle'`) until their watched `primaryLinkId` delivers less than planned due to an enabled trigger; `'overflow'` links remain dormant until their source container activates `transfer_through`. |
| **`primaryLinkId` & `diversionTriggers`** *(Standby Links)* | Watches a non-standby primary link. Enabled triggers (`'route'`, `'target'`, `'calendar'`, `'source'`) activate priority-ordered spillover for only the unmet remainder `max(0, primaryExpected - primaryDelivered)`, capped by the standby link's `dailyRate`, source stock, route corridor residual capacity, and target headroom. Supports both same-source and alternate-source diversions. |
| **`backupCorridorIds` & `backupCorridorRate`** *(Backup Route Detour)* | When a link's primary corridor(s) block or cap flow in Stage 1.5A, Stage 1.5B automatically routes the unmet spillover remainder (`preRouteFlow - primaryRouteFlow`, optionally capped by `backupCorridorRate`) through `backupCorridorIds`, respecting each backup corridor's residual rate & fleet capacity. |
| **`dailyRate`** | Base daily transfer demand (`m³/d`). If `<= EPS`, the transfer requests `0` flow (`frozen`). |
| **`priority`** | Editable in Property Inspector (default `1`; lower number = higher precedence). Governs scarcity allocation in Stage 1 (source stock), Stage 1.25 (container cap), Stage 1.5A/B (primary & backup route rate caps), Stage 2A (target headroom, overflow priority, & null junction balancing), and Stage 2B (standby activation order). Links sharing a priority tier split remaining budget pro-rata. |
| **`materialId`** | Optional material override editable in Property Inspector. Overrides `source.materialType` for `allowedMaterials` validation and `bulkIN`/`bulkOUT` lookup. |
| **`fleetCount`** | Editable in Property Inspector. Enforced against assigned Route Corridor `maxFleetCount` caps in Stage 1.5. |
| **`rateSchedule`** *(legacy fallback)* | Evaluated only when no Calendar Transfer event is active on `day`. |
| **Route Corridor Assignment (`corridorIds`)** | A transfer may reference 0, 1, or multiple primary Route Corridors (and separate `backupCorridorIds` for spillover detours). |

### 2.3 Route Corridor Rules (Baseline)

| Property / Rule | Current Driving Logic |
| :--- | :--- |
| **`maxDailyRate`** | Optional baseline combined daily rate cap (`m³/d`) editable in Property Inspector and exported/imported in CSV/JSON. Enforced on days without an active Route Calendar event (priority-tiered, pro-rata within ties). |
| **`maxFleetCount`** | Optional baseline combined fleet unit limit editable in Property Inspector and exported/imported in CSV/JSON. If combined `fleetCount` of active assigned transfers exceeds `maxFleetCount`, scales assigned transfers pro-rata by `maxFleetCount / totalFleet`. |

### 2.4 Calendar Event Rules (Days 1..30)

An event bar is active on `day` when `day >= 1 && startDay <= day && day <= endDay`. Any day without an event bar falls back to the element's baseline Property Inspector settings.

#### Container Events (`targetType = 'container'`)

| Event State | Driving Logic |
| :--- | :--- |
| **`open`** | Overrides static `'blocked'` or `'maintenance'` baseline status, allowing normal inbound/outbound operation and emitting an override alert. |
| **`restricted`** | Caps combined inbound & outbound transfer throughput through the container to `max(0, rateValue)` (`m³/d`), allocated by priority tier (pro-rata within ties). If `rateValue <= EPS`, halts the container (`blocked`). |
| **`blocked`** | Overrides baseline status. Halts **both** outbound (Stage 1) and inbound (Stage 2) transfers on active days. |

#### Transfer Events (`targetType = 'transfer'`)

| Event State | Driving Logic |
| :--- | :--- |
| **`max`** | Sets effective daily rate to `100%` of stated `link.dailyRate`. |
| **`variable`** | Sets effective daily rate to `max(0, rateValue)` (`m³/d`), emitting daily reduced/boosted/zero-rate alerts. |
| **`stopped`** | Forces effective daily rate to `0`, marks the link in `calendarStoppedLinks` (Red `blocked`), and emits a daily stopped alert. |

#### Route Events (`targetType = 'route'`) — Stage 1.5

| Event State | Driving Logic |
| :--- | :--- |
| **`open`** | Explicitly lifts baseline `maxDailyRate` and `maxFleetCount` caps on active days. |
| **`restricted`** | Overrides baseline rate cap with `max(0, rateValue)` (`m³/d`) split by priority tier (pro-rata within ties). If `rateValue <= EPS`, halts all assigned links (`0`). |
| **`blocked`** | Forces `requestedTransfers = 0` for every transfer assigned to that corridor and marks them in `routeBlockedLinks`. |

---

## 3. Trigger Notifications (`SimFrame.alerts`)

Alerts are deduplicated per day and emitted for every rule transition or constraint activation:

| Category | Trigger Condition | Exact Alert Message |
| :--- | :--- | :--- |
| **Container (Baseline Block)** | Source or target has `status = 'blocked' \| 'maintenance'` (no `'open'` override) | `Day {d}: Source/Target {name} is blocked or under maintenance.` |
| **Container (Calendar Block)** | Active Container `'blocked'` event | `Day {d}: Container {name} is blocked by calendar schedule.` |
| **Container (Calendar Open Override)** | Active Container `'open'` event overrides static `blocked` / `maintenance` | `Day {d}: Container {name} opened by calendar override (static status: {status}).` |
| **Container (Calendar Restricted)** | Active Container `'restricted'` event caps combined throughput (or `<= 0`) | `Day {d}: Container {name} throughput restricted to {cap} m³/d by calendar schedule.` (or `...restricted to 0 m³/d by calendar schedule (halted).`) |
| **Container (Stockout)** | Storage source has `startVol <= EPS` with valid outbound demand | `Day {d}: Stockout at source {name}.` |
| **Container (Partial-Day Starvation)** | Storage source has `0 < availableVol < requiredSourceVol` | `Day {d}: Source {name} low stock ({avail} m³ available vs {req} m³ required). Outbound transfers throttled.` |
| **Material Mismatch** | `target.allowedMaterials` excludes effective link material | `Day {d}: Material mismatch between {src} ({mat}) and target {tgt}.` |
| **Transfer (Calendar Stopped)** | Active Transfer `'stopped'` event | `Day {d}: Transfer {src} → {tgt} stopped by calendar schedule.` |
| **Transfer (Calendar Variable)** | Active Transfer `'variable'` event sets rate to `0`, `< dailyRate`, or `> dailyRate` | `Day {d}: Transfer {src} → {tgt} rate [set to 0 / reduced to {r} / boosted to {r}] m³/d by calendar schedule.` |
| **Route (Calendar Blocked)** | Active Route `'blocked'` event | `Day {d}: Route {name} is blocked by calendar schedule.` |
| **Route (Calendar / Baseline Rate Cap)** | Active Route `'restricted'` event or baseline `maxDailyRate` throttles or halts assigned links | `Day {d}: Route {name} restricted to {cap} m³/d (transfers throttled).` / `...baseline rate cap ({cap} m³/d) reached (transfers throttled).` |
| **Route (Baseline Fleet Cap)** | Combined active `fleetCount > corridor.maxFleetCount` | `Day {d}: Route {name} fleet cap ({max} units vs {total} assigned) reached (transfers throttled).` |
| **Headroom Hold (Awaiting)** | Target in `strict` + `headroom_hold` and `isHalted === true` | `Day {d}: Target {name} awaiting headroom threshold ({thresh} m³ spare required).` |
| **Headroom Hold (Resumed)** | Target transitions from `isHalted === true` to `false` | `Day {d}: Target {name} headroom threshold satisfied ({spare} m³ spare). Resuming inbound transfers.` |
| **Headroom Hold (Final Fill Cap)** | Unhalted `headroom_hold` target caps final fill day to `effectiveHeadroom` | `Day {d}: Target {name} reached capacity on fill day. Final inbound flow capped to available headroom.` |
| **Capacity Throttleback** | Target in `strict` + `throttleback` and `totalPreTargetDeposit > effectiveHeadroom` | `Day {d}: Target {name} nearing capacity. Transfer rates throttled.` |
| **Strict Capacity Reached** | Post-Stage 3 `strict` storage node has `vol >= capacity - EPS` (newly reached or full against demand) | `Day {d}: Node {name} reached capacity!` |
| **Overfill Exceeded** | Post-Stage 3 `overfill` storage node has `vol > capacity + EPS` | `Day {d}: [OVERFILL] Node {name} exceeded capacity by {excess} m³!` |
| **Backup Route Detour** | Primary corridor blocked/capped and `backupCorridorIds` carries spillover flow | `Day {d}: Transfer {src} → {tgt} detoured {vol} m³/d via backup route {routes}.` |
| **Standby Transfer Spillover** | Standby link activates to carry unmet primary remainder | `Day {d}: Standby transfer {src} → {tgt} activated ({vol} m³/d spillover from {pSrc} → {pTgt}).` |
| **Transfer-Through Active** | `transfer_through` container passes surplus through `overflow` link(s) | `Day {d}: Container {name} transfer-through active ({vol} m³/d overflow to backup).` |
| **Transfer-Through Saturated** | Both primary container (100%) and overflow backup capacity saturate, falling back to `throttleback` | `Day {d}: Container {name} and backup overflow saturated. Upstream transfers throttled.` |

---

## 4. Colour Coding Specification

### 4.1 Simulation Playback Palette (`FlowStatus` → Canvas, Badges, Inspector, Export)

| Colour | Hex | `FlowStatus` | Meaning |
| :--- | :--- | :--- | :--- |
| **Blue** | `#38bdf8` | `'frozen'`, `'starved'` | Day 0 baseline, disconnected element, empty container, or unable to deliver full rate due to lack of material |
| **Green** | `#22c55e` | `'full'` | Flowing at full expected rate |
| **Violet** | `#a855f7` | `'diverted'` | Active standby transfer diversion, backup route corridor detour, or container transfer-through overflow |
| **Amber** | `#f59e0b` | `'restricted'` | Flowing at reduced/throttled rate (target capacity throttleback, container/route cap, partial sibling link block, or reduced calendar variable rate) |
| **Red** | `#ef4444` | `'blocked'` | Halted/blocked (strict capacity/headroom hold, overfill exceeded, static maintenance/block, material mismatch, or calendar blocked/stopped) |
| **Slate** | `#64748b` | `'idle'` | Dormant standby/overflow transfer link (excluded from parent container status rollups so inactive backups never falsely tint containers Amber/Red) |

### 4.2 Classification Precedence Trees (Day `>= 1`)

#### Transfer Links (`linkStatuses`) — evaluated top-to-bottom

1. Missing source or target → **`frozen`** (Blue)
2. Transfer calendar `'stopped'` OR Route `'blocked'` (or cap `<= 0`) → **`blocked`** (Red)
3. Transfer calendar `'variable'` with `rateValue <= EPS` → **`blocked`** (Red)
4. Baseline `linkRate <= EPS` → **`frozen`** (Blue)
5. Source or target effectively blocked OR material mismatch → **`blocked`** (Red)
6. Storage source (`excavation`/`stockpile`) has `startVol <= EPS` → **`starved`** (Blue)
7. `actualFlow <= EPS` → **`starved`** (Blue) if source is a starved `null` junction, else **`blocked`** (Red)
8. Throttled by Route cap, Container `'restricted'` cap, or Stage 2 target/null capacity (`actualFlow < preTargetFlow - EPS`) → **`restricted`** (Amber)
9. Transfer calendar `'variable'` with `0 < rateValue < link.dailyRate` delivering full `rateValue` → **`restricted`** (Amber)
10. `actualFlow >= effectiveLinkRate - EPS` → **`full`** (Green)
11. Partial-day source starvation → **`starved`** (Blue)

#### Container Nodes (`nodeStatuses`) — evaluated top-to-bottom

1. Effectively blocked (calendar `'blocked'`, calendar `'restricted'` with `0`, or static `'blocked'`/`'maintenance'` without `'open'` override) → **`blocked`** (Red)
2. `isOverfilled` (`vol > capacity + EPS` on storage node) OR `isAtCapacity` (`strict` storage node `vol >= capacity - EPS`) OR `isHalted` (`headroom_hold`) → **`blocked`** (Red)
3. No connected links → **`restricted`** (Amber) if active Container `'restricted'` event, else **`frozen`** (Blue)
4. `hasBlocked && !hasFlowing && !isEmpty` (all active connected flows blocked) → **`blocked`** (Red)
5. Active Container `'restricted'` event OR `hasRestricted` OR `(hasBlocked && hasFlowing)` (partially blocked while sibling links still flow) → **`restricted`** (Amber)
6. `type === 'null'` → `full` > `starved` > `blocked` > `frozen`
7. `isEmpty` (`vol <= EPS` on storage node) → **`starved`** if has outbound links, else **`frozen`** (Blue)
8. `hasFull` → **`full`** (Green)
9. `outbound.length > 0 && hasStarved` → **`starved`** (Blue)
10. `hasBlocked` → **`blocked`** (Red), else **`frozen`** (Blue)

#### Route Corridors (`corridorStatuses`) — evaluated top-to-bottom

1. Route calendar `'blocked'` → **`blocked`** (Red)
2. Route calendar `'restricted'` → **`blocked`** (Red) if `rateValue <= EPS` or all assigned links are `'blocked'`; otherwise **`restricted`** (Amber)
3. Baseline `maxDailyRate` or `maxFleetCount` actively throttling → **`blocked`** if `maxDailyRate === 0`, else **`restricted`** (Amber)
4. No assigned links → **`frozen`** (Blue)
5. All assigned active flows blocked (`hasBlocked && !hasFlowing`) → **`blocked`** (Red)
6. Any `'restricted'` OR partial block while sibling assigned links flow (`hasBlocked && hasFlowing`) → **`restricted`** (Amber)
7. `hasFull` → **`full`** (Green) > `hasStarved` → **`starved`** (Blue) > **`frozen`** (Blue)

### 4.3 Container Fill Bar & Calendar Gantt Bar Colours

- **Container Fill Bar (inside canvas box):**
  - Teal `#0d9488`: `excavation`
  - Amber-brown `#b45309`: `stockpile`
  - Slate `#475569`: `null` / `external`
  - Red `#ef4444`: overrides fill bar whenever `liveVol > capacity` on non-`external` storage nodes
- **Calendar Gantt Bars:**
  - **Red (`#ef4444`):** Container `blocked`, Container `restricted (0)`, Transfer `stopped`, Transfer `variable (0)`, Route `blocked`, Route `restricted (0)`
  - **Amber (`#f59e0b`):** Container `restricted (>0)`, Route `restricted (>0)`, Transfer `variable` where `0 < rateValue < stated dailyRate`
  - **Green (`#22c55e`):** Container `open`, Route `open`, Transfer `max`, Transfer `variable` where `rateValue >= stated dailyRate`

---

## 5. Consistency Amendments Checklist (All Implemented)

### 5.1 Trigger Notifications
1. **[DONE] Strict Capacity Alert Fixed:** Detects `vol >= capacity - EPS` for strict storage nodes (newly filled or full against active inbound demand) and emits `Node {name} reached capacity!`.
2. **[DONE] Transfer Calendar Event Alerts:** Transfer `stopped` and `variable` (zero, reduced, or boosted) emit daily notifications in `SimFrame.alerts`.
3. **[DONE] Partial-Day Source Starvation Alert:** Emits low-stock alert whenever `0 < availableVol < requiredSourceVol`.
4. **[DONE] Calendar `open` Override & `headroom_hold` Resume Alerts:** Emits notifications when a Container `open` event overrides static `blocked`/`maintenance`, and when a `headroom_hold` target regains `headroomThreshold` and resumes accepting transfers.

### 5.2 Flow & Physics Consistency
5. **[DONE] Bulking-Aware Allocation & Headroom:** Stage 1 (`bulkOUT`) and Stage 2 (`bulkIN`) account for material bulking factors using `link.materialId || source.materialType`, preventing silent mass loss during strict clamping.
6. **[DONE] Same-Day Outbound Drainage Frees Target Headroom:** Storage targets compute `effectiveHeadroom = capacity - max(0, startVol - outboundRemoved)` inside the fixed-point Stage 2 solver.
7. **[DONE] `headroom_hold` Final Fill Day Capped:** Unhalted `headroom_hold` targets cap final fill-day inflows to `effectiveHeadroom` (bulking-aware) so `linkFlows` matches deposited volume.
8. **[DONE] Single Stopped Sibling Link Does Not Cascade Red to Parent Container:** An open container with both flowing and blocked links now classifies as Amber (`restricted`) rather than Red (`blocked`).
9. **[DONE] Overfilled Container Border Matches Fill Bar:** Exceeding capacity in `overfill` mode classifies `nodeStatuses` as Red (`blocked`) and displays `"Overfill Exceeded Capacity"` in Playback Telemetry.

### 5.3 Schema, UI & Export Symmetry
10. **[DONE] Container `type` Semantics Implemented:** `null` acts as a zero-storage pass-through junction (`totalIn === totalOut`); `external` acts as an unbounded source/sink.
11. **[DONE] Baseline Route Limits (`maxDailyRate`, `maxFleetCount`):** Editable in Route Corridor Inspector, shown in Calendar `BASE` column, enforced in Stage 1.5, and persisted in CSV/JSON import/export.
12. **[DONE] Static Container `status` & `allowedMaterials` Exposed:** Editable in Container Inspector and round-tripped in CSV/JSON export & import.
13. **[DONE] Priority-Tiered Allocation, Material Override & Fleet Enforcement:** `TransferLink.priority` and `TransferLink.materialId` are editable in Transfer Inspector and enforced across all allocation stages; `fleetCount` is enforced against corridor `maxFleetCount`; legacy `rateSchedule` acts strictly as fallback when no Calendar Transfer event is active.
14. **[DONE] Container Calendar `'restricted'` Event State:** Added `'restricted'` throughput cap (`rateValue` m³/d) across `types.ts`, `SimEngine.ts`, `CalendarGantt.tsx`, `PropertyInspector.tsx`, and CSV/JSON import/export.
15. **[DONE] Corridor Daily Telemetry in Exports:** `SimFrame.corridorFlows` and `corridorStatuses` are exported in `SIMULATION DAILY CORRIDOR FLOWS`, `SIMULATION DIAGNOSTIC SUMMARY` (`Route` rows), and JSON `dailyFrames[].corridors`.
