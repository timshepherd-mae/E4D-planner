# Simulation Engine Ruleset & Consistency Audit

> **Scope:** Current technical specification of the discrete daily simulation engine (`SimEngine`), notification triggers, visual colour coding, and a consistency audit of missing or unwired elements/triggers.

---

## 1. Execution Model & Daily Pipeline

The simulation runs deterministically as a discrete daily step loop across `day = 0 .. totalDays` (default `totalDays = 30`, numerical epsilon `EPS = 1e-6`).

- **Day 0 (Frozen Baseline):** Captures initial container volumes. All `linkFlows` are `0`, no volumes change, and all containers, transfers, and route corridors are classified as `frozen`.
- **Days 1..30 (Active Simulation):** Each day executes in five sequential stages:

```text
[Stage 0] Resolve Active Calendar Events & Effective Baselines (Containers, Transfers, Routes)
    │
    ▼
[Stage 1] Outbound Source Availability & Pro-Rata Demand Allocation ──► requestedTransfers
    │
    ▼
[Stage 1.5] Route Corridor Calendar Constraints (Blocked & Pro-Rata Combined Cap)
    │
    ▼
[Stage 2] Target Container Blocks, Strict Overflow / Headroom Hold, & Throttleback ──► plannedTransfers
    │
    ▼
[Stage 3] Apply Physical Volume Transfers (with Material bulkOUT / bulkIN Factors)
    │
    ▼
[Stage 4] Classify Visual FlowStatus (Links, Containers, Route Corridors) & Emit SimFrame
```

---

## 2. Driving Logic by Element & Event Type

### 2.1 Container Rules (Baseline)

| Property / Rule | Current Driving Logic |
| :--- | :--- |
| **`status`** (`'active' \| 'maintenance' \| 'blocked'`) | If `'blocked'` or `'maintenance'` (and no active Calendar `'open'` override), halts **both** outbound transfers (Stage 1) and inbound transfers (Stage 2). |
| **Source Stockout** (`currentVolume <= EPS`) | Halts all outbound transfers from that container (`requestedTransfers = 0`). |
| **Multi-Link Outbound Pro-Rata** | Groups all valid outbound links by `sourceId`. If `source.currentVolume < sum(activeLinkRates)`, scales all outbound links pro-rata by `sourceRatio = min(1, availableVol / totalOutboundRate)`. |
| **`allowedMaterials`** | If non-empty on a target container, any inbound link whose source container's `materialType` is not listed is rejected (`requestedTransfers = 0`). |
| **`overflowMode = 'overfill'`** | Uncapped target acceptance. All `requestedTransfers` pass through Stage 2 unthrottled; `target.currentVolume` can exceed `target.capacity`. |
| **`overflowMode = 'strict'` + `strictSubRule = 'throttleback'`** *(default)* | Computes `headroom = max(0, capacity - currentVolume)`. If `totalRequestedForTarget > headroom`, scales all inbound links pro-rata by `throttleFactor = min(1, headroom / totalRequestedForTarget)`. |
| **`overflowMode = 'strict'` + `strictSubRule = 'headroom_hold'`** | Stateful hysteresis latch (`headroomHoldStates`, persists across days): latches ON (halted) when `currentVol >= capacity`; stays halted while `headroom < headroomThreshold` (default `500 m³`, all inbound flows = `0`); releases once `headroom >= headroomThreshold`. While unhalted, passes full `req` if `headroom > 0` else `0` (clamped at `capacity` in Stage 3). |
| **Material Bulking (`bulkOUT` / `bulkIN`)** | Applied in Stage 3 when updating volumes: source removes `transferAmount * bulkOUT` (snaps to `0` if `< EPS`); target adds `transferAmount * bulkIN` (clamped to `capacity` in `strict` mode; uncapped in `overfill` mode). |

### 2.2 Transfer Rules (Baseline)

| Property / Rule | Current Driving Logic |
| :--- | :--- |
| **`dailyRate`** | Base daily transfer demand (`m³/d`). If `<= EPS`, the transfer requests `0` flow. |
| **`rateSchedule`** *(legacy field)* | If defined, selects the rate of the latest entry with `sched.day <= day` before Calendar overrides are evaluated. |
| **Route Corridor Assignment (`corridorIds`)** | A transfer may reference 0, 1, or multiple Route Corridors. In Stage 1.5, it is subject to every corridor it is assigned to (taking the tightest cap). |
| **Priority / Fleet (`priority`, `fleetCount`)** | Stored on the link model, **not currently enforced** by `SimEngine`. |

### 2.3 Calendar Event Rules (Days 1..30)

An event bar is active on `day` when `day >= 1 && startDay <= day && day <= endDay`. Any day along an element's row with **no** event bar defaults to that element's baseline Property Inspector values.

#### Container Events (`targetType = 'container'`)

| Event State | Driving Logic |
| :--- | :--- |
| **`blocked`** | Overrides baseline status. Halts **both** outbound (Stage 1) and inbound (Stage 2) transfers for that container on active days. |
| **`open`** | Overrides static `'blocked'` or `'maintenance'` baseline status, allowing normal inbound/outbound operation on active days. |

#### Transfer Events (`targetType = 'transfer'`)

| Event State | Driving Logic |
| :--- | :--- |
| **`max`** | Sets effective daily rate to `100%` of stated `link.dailyRate` (overriding any `rateSchedule`). |
| **`variable`** | Sets effective daily rate to `max(0, rateValue)` (`m³/d`). Can either reduce below or boost above stated `dailyRate`. |
| **`stopped`** | Forces effective daily rate to `0` and marks the link in `calendarStoppedLinks` (forces Red `blocked` status). |

#### Route Events (`targetType = 'route'`) — Stage 1.5

| Event State | Driving Logic |
| :--- | :--- |
| **`open`** | Unrestricted pass-through (same as baseline default). |
| **`restricted`** | Evaluates `totalCorridorDemand = sum(requestedTransfers)` across all non-blocked links assigned to that corridor. If `rateValue <= EPS`, halts all assigned links (`0`). If `totalCorridorDemand > rateValue`, scales each assigned link **pro-rata** by `ratio = rateValue / totalCorridorDemand`. Links traversing multiple restricted corridors take the tightest (`Math.min`) cap. |
| **`blocked`** | Forces `requestedTransfers = 0` for every transfer assigned to that corridor and marks them in `routeBlockedLinks`. |

---

## 3. Trigger Notifications (`SimFrame.alerts`)

Alerts are deduplicated per day and only emitted when `day > 0`:

| Category | Trigger Condition | Exact Alert Message |
| :--- | :--- | :--- |
| **Container (Baseline Block)** | Source has `status = 'blocked' \| 'maintenance'` (no `'open'` event) | `Day {d}: Source {name} is blocked or under maintenance.` |
| **Container (Baseline Block)** | Target has `status = 'blocked' \| 'maintenance'` (no `'open'` event) | `Day {d}: Target {name} is blocked or under maintenance.` |
| **Container (Calendar Block)** | Source or target has active Calendar `'blocked'` event | `Day {d}: Container {name} is blocked by calendar schedule.` |
| **Container (Stockout)** | Source has `currentVolume <= EPS` at start of day | `Day {d}: Stockout at source {name}.` |
| **Material Mismatch** | `target.allowedMaterials` excludes `source.materialType` | `Day {d}: Material mismatch between {src} ({mat}) and target {tgt}.` |
| **Route (Calendar Blocked)** | Active Route `'blocked'` event (emitted even if 0 links assigned) | `Day {d}: Route {name} is blocked by calendar schedule.` |
| **Route (Restricted to 0)** | Active Route `'restricted'` event with `rateValue <= EPS` | `Day {d}: Route {name} restricted to 0 m³/d (halted).` |
| **Route (Restricted Cap)** | Active Route `'restricted'` event and `totalCorridorDemand > cap` | `Day {d}: Route {name} restricted to {cap} m³/d (transfers throttled pro-rata).` |
| **Headroom Hold** | Target in `strict` + `headroom_hold` and `isHalted === true` | `Day {d}: Target {name} awaiting headroom threshold ({thresh} m³ spare required).` |
| **Capacity Throttleback** | Target in `strict` + `throttleback` and `totalRequested > headroom` | `Day {d}: Target {name} nearing capacity. Transfer rates throttled pro-rata.` |
| **Overfill Exceeded** | Post-Stage 3 `node.currentVolume > node.capacity` (`overfill` mode) | `Day {d}: [OVERFILL] Node {name} exceeded capacity by {excess} m³!` |
| **Strict Capacity Reached** | Post-Stage 3 `node.currentVolume > node.capacity` (`strict` mode) | `Day {d}: Node {name} reached capacity!` *(unreachable — see Section 5)* |

---

## 4. Colour Coding Specification

### 4.1 Simulation Playback Palette (`FlowStatus` → Canvas, Badges, Inspector, Export)

| Colour | Hex | `FlowStatus` | Meaning |
| :--- | :--- | :--- | :--- |
| **Blue** | `#38bdf8` | `'frozen'`, `'starved'`, `'idle'` | Day 0 baseline, disconnected/idle element, empty container, or unable to deliver full rate due to lack of material |
| **Green** | `#22c55e` | `'full'` | Flowing at full expected rate |
| **Amber** | `#f59e0b` | `'restricted'` | Flowing at reduced/throttled rate (target capacity throttleback, route pro-rata cap, or calendar variable rate below stated rate) |
| **Red** | `#ef4444` | `'blocked'` | Halted/blocked (capacity/headroom hold, static maintenance/block, material mismatch, or calendar blocked/stopped) |

### 4.2 Classification Precedence Trees (Day `>= 1`)

#### Transfer Links (`linkStatuses`) — evaluated top-to-bottom

1. Missing source or target → **`frozen`** (Blue)
2. Transfer calendar `'stopped'` OR Route calendar `'blocked'` (or route cap `<= 0`) → **`blocked`** (Red)
3. Transfer calendar `'variable'` with `rateValue <= EPS` → **`blocked`** (Red)
4. Baseline `linkRate <= EPS` → **`frozen`** (Blue)
5. Source or target effectively blocked (static or calendar) → **`blocked`** (Red)
6. `startOfDayVolumes[sourceId] <= EPS` → **`starved`** (Blue)
7. `actualFlow <= EPS` (target full, headroom hold, or material mismatch) → **`blocked`** (Red)
8. Throttled by Route `'restricted'` cap OR throttled by target capacity (`actualFlow < postRouteRequested && source.currentVolume > EPS`) → **`restricted`** (Amber)
9. Transfer calendar `'variable'` with `0 < rateValue < link.dailyRate` and delivering full `rateValue` → **`restricted`** (Amber)
10. `actualFlow >= effectiveLinkRate - EPS` → **`full`** (Green)
11. Otherwise (source ran empty mid-day before meeting rate) → **`starved`** (Blue)

#### Container Nodes (`nodeStatuses`) — evaluated top-to-bottom

1. Effectively blocked (calendar `'blocked'`, or static `'blocked'`/`'maintenance'` without `'open'` override) → **`blocked`** (Red)
2. No connected links → **`frozen`** (Blue)
3. `isAtCapacity` (`strict` & `vol >= cap`) OR `isHalted` (`headroom_hold`) OR `(!isEmpty && any connected link is 'blocked')` → **`blocked`** (Red)
4. `isEmpty` (`vol <= EPS`) → **`starved`** if has outbound links, else **`frozen`** (both Blue)
5. Any connected link is `'restricted'` → **`restricted`** (Amber)
6. Any connected link is `'full'` → **`full`** (Green)
7. Has outbound links → **`starved`** (Blue)
8. Otherwise → **`frozen`** (Blue)

#### Route Corridors (`corridorStatuses`) — evaluated top-to-bottom

1. Route calendar `'blocked'` → **`blocked`** (Red)
2. Route calendar `'restricted'` → **`blocked`** (Red) if any assigned link is `'blocked'` or `rateValue <= EPS`; otherwise **`restricted`** (Amber)
3. No assigned links → **`frozen`** (Blue)
4. Worst-case rollup of assigned `linkStatuses`: `blocked` (Red) > `restricted` (Amber) > `full` (Green) > `starved` (Blue) > `frozen` (Blue)

### 4.3 Container Fill Bar & Calendar Gantt Bar Colours

- **Container Fill Bar (inside canvas box):**
  - Teal `#0d9488`: `excavation`
  - Amber-brown `#b45309`: `stockpile`
  - Slate `#475569`: `null` / `external`
  - Red `#ef4444`: overrides fill bar whenever `liveVol > capacity`
- **Calendar Gantt Bars:**
  - **Red (`#ef4444`):** Container `blocked`, Transfer `stopped`, Transfer `variable (0)`, Route `blocked`
  - **Amber (`#f59e0b`):** Route `restricted`, Transfer `variable` where `0 < rateValue < stated dailyRate`
  - **Green (`#22c55e`):** Container `open`, Route `open`, Transfer `max`, Transfer `variable` where `rateValue >= stated dailyRate`

---

## 5. Consistency Audit: Missing Elements, Triggers & Engine Gaps

### 5.1 Missing or Broken Trigger Notifications

1. **Dead-Code Strict Capacity Alert:** Stage 3 clamps `target.currentVolume = Math.min(target.capacity, ...)`, then Stage 4 checks `if (node.currentVolume > node.capacity)`. As a result, `"Node X reached capacity!"` can **never fire** in `strict` mode (it should detect `>= capacity - EPS` when newly filled or at capacity).
2. **Transfer Calendar Events Emit Zero Alerts:** Container `blocked` and Route `blocked`/`restricted` emit daily alerts, whereas Transfer `stopped` and Transfer `variable` (reduced or boosted) emit **no** notifications in `frame.alerts`.
3. **Partial-Day Source Starvation Has No Alert:** Stockout alerts only trigger when a source begins the day at `0` (`<= EPS`), not on the day a source runs dry mid-day (`0 < availableVol < totalOutboundRate`) and throttles outbound links pro-rata.
4. **Calendar `open` Override & Headroom-Hold Resume Transitions Are Silent:** When a Container `open` event overrides a maintenance/blocked container, or when a `headroom_hold` target regains `headroomThreshold` and resumes accepting transfers, no transition notification is logged.

### 5.2 Flow & Physics Inconsistencies

5. **Bulking Factors (`bulkIN` / `bulkOUT`) Are Ignored During Allocation & Headroom Checks:**
   - Stage 1 checks `availableVol / totalOutboundRate` without `bulkOUT`, and Stage 2 checks `headroom / totalRequestedForTarget` without `bulkIN`.
   - With e.g. `ROCK` (`bulkIN = 1.40`), a strict target with `1,000 m³` headroom accepts `1,000 m³`, multiplies by `1.40` (`1,400 m³`), and silently **discards `400 m³`** via `Math.min(capacity, ...)` while reporting `linkFlows = 1,000`.
6. **Same-Day Outbound Drainage Does Not Free Target Headroom:**
   - Stage 2 computes `headroom = capacity - currentVolume` before Stage 3 subtracts same-day outbound transfers. A full surge stockpile draining `1,200 m³/d` cannot simultaneously receive `1,200 m³/d` on the same day in `strict` mode.
7. **`headroom_hold` Unthrottled Final Fill Day:**
   - While `headroom > 0` and not yet halted, `headroom_hold` passes full `req` without capping to remaining headroom, causing `linkFlows` on the filling day to over-report vs actual volume deposited.
8. **Single Stopped Transfer Turns Parent Container Red (`blocked`):**
   - Container status checks `(!isEmpty && hasBlocked)`. If Container A feeds Links 1 and 2, and Link 2 is `stopped` by a Calendar event while Link 1 flows at 100%, Container A's border turns **Red (`blocked`)** even though the container itself is open and operating.
9. **Overfilled Container Keeps Green Border:**
   - In `overfill` mode, exceeding capacity turns the inner fill bar Red and emits an `[OVERFILL]` alert, but `nodeStatuses` stays **Green (`full`)** because `isAtCapacity` excludes `overfill` nodes.

### 5.3 Schema / UI Elements Unused or Asymmetric in `SimEngine`

10. **Container `type` Semantics Not Implemented:** `excavation`, `stockpile`, `null`, and `external` all execute identical storage physics (`null` junctions do not act as zero-storage pass-through nodes; `external` boundaries do not act as unbounded external sources/sinks).
11. **Baseline Route Limits Missing:** `RouteCorridor` has reserved `maxDailyRate` and `maxFleetCount` fields in the schema, but they are neither editable in the Property Inspector nor enforced as baseline route limits in `SimEngine` (routes currently only throttle via Calendar events).
12. **Static Container `status` & `allowedMaterials` Missing from Inspector:** `SimEngine` and CSV import/export support Container `status` (`active` / `maintenance` / `blocked`) and `allowedMaterials`, but neither field is exposed in the Property Inspector UI.
13. **Unused Capacity & Scheduling Fields:** `ContainerNode.plantCount`, `TransferLink.fleetCount`, `TransferLink.priority` (no priority-ordered allocation vs pro-rata), and `TransferLink.materialId` are stored/exported but unused in `SimEngine`. Legacy `TransferLink.rateSchedule` is evaluated in `SimEngine` without any UI, overlapping with Calendar Transfer events.
14. **Container `restricted` Event Missing:** Routes support `open / restricted / blocked` and Transfers support `max / variable / stopped`, whereas Containers only support `open / blocked` (no container-level throughput cap, e.g., reduced loading plant capacity).
15. **Corridor Daily Telemetry Missing from Export:** `SimFrame.corridorStatuses` is computed daily for canvas badges and Playback Inspector, but `ExportModal` CSV/JSON daily telemetry tables currently only export Containers and Transfers—not daily Route Corridor combined flows and statuses.
