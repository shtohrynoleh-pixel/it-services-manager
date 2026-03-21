# Fuel Incentive Module — Operations Guide

## Setup

### 1. Environment
Add to `.env`:
```
FUEL_ENCRYPTION_KEY=your-random-secret-key-here
```
Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### 2. Enable for a Company
1. Go to Company → Modules → enable "Fleet Management"
2. Go to Company → Fuel tab → Config → Enable program
3. Set: billing mode, split percentages, baseline window, fuel price, minimum miles

### 3. Connect Provider
1. Go to Fuel → Integrations → Connect (Samsara or Motive)
2. Paste API token (encrypted at rest via AES-256-GCM)
3. Click "Test" to verify connection
4. Click "Sync Vehicles" to pull asset list
5. Map any unmapped vehicles manually

### 4. Set Up Groups
1. Go to Fuel → Groups
2. Create groups (e.g., "Sleepers", "Daycabs")
3. Assign trucks and drivers to groups

### 5. Backfill Historical Data
1. Go to Fuel → Integrations
2. Select backfill period (7-90 days)
3. Click "Backfill" — fetches daily miles, gallons, idle from provider

### 6. Compute Baselines
1. Go to Fuel → Computed Baselines
2. Click "Recompute All Groups"
3. Verify baseline MPG makes sense for each group

### 7. Set Targets
1. Go to Fuel → Targets
2. Create group policies with target MPG and KPI bonus
3. Optional: add driver overrides for specific drivers

---

## Running a Period

### Monthly Workflow:
1. **Create period**: Fuel → Periods → Create (defaults to current month)
2. **Sync latest data**: Integrations → Backfill last 7 days (catches any gaps)
3. **Calculate**: Periods → Calculate button
   - Engine processes each driver: miles, MPG, eligibility, savings, split
   - Config snapshot stored (immutable after approval)
4. **Review**: Periods → View Ledger
   - Check each driver's calculation
   - Click info icon (ℹ) for full explanation
5. **Approve**: Periods → Approve
   - Ledger becomes immutable
   - No recalculation possible
6. **Export**: Ledger → Export CSV
   - Download for payroll processing
7. **Close**: Periods → Close
   - Final seal

### Re-calculation Rules:
- **Open**: can calculate freely
- **Calculated**: can recalculate (clears and rebuilds)
- **Approved**: IMMUTABLE — no recalculation
- Corrections after approval → use Adjustments (applied to next period)

---

## CSV Export
- Headers: driver_name, status, total_miles, total_gallons, actual_mpg, baseline_mpg, target_mpg, savings_gallons, savings_usd, driver_share_usd, kpi_bonus_usd, driver_payout
- Export event logged in audit with totals verification

---

## Ceiling Switch
After each period calculation, the system checks:
- Has any group exceeded baseline by ≥0.3 MPG for 3+ consecutive periods?
- If yes: billing_mode automatically switches from 'performance' to 'subscription'
- In subscription mode: platform_fee = $0
- Switch is logged in audit + fuel_ceiling_log table
- Switch is one-way (manual revert possible via config)

---

## Troubleshooting

### "No measurements" for a driver
1. Check: is the driver assigned to a vehicle in Fleet?
2. Check: is the vehicle mapped in Fuel → Integrations?
3. Check: has a backfill been run for the date range?
4. Check: Reports → Data Freshness tab

### Integration shows "error"
1. Check the error message on the integration card
2. Verify API token is still valid in Samsara/Motive dashboard
3. Re-test connection
4. Check audit log for detailed error messages

### Baseline shows 0
1. Need measurements first — run a backfill
2. Need trucks assigned to the group
3. Run "Recompute" after data is available

### Driver payout is $0 but they drove
- Below minimum miles? Check config min_miles_qualify
- MPG below baseline? No savings = no payout
- Not in a group? Must be assigned to fuel group
- No target set? KPI bonus requires a target policy

---

## Data Model

```
fuel_config (per company)
  └─ fuel_groups (equipment classes)
       ├─ fuel_truck_group_map → fleet_vehicles
       └─ fuel_driver_group_map → company_users
  └─ fuel_integrations (Samsara, Motive)
       └─ fuel_provider_asset_map (provider ↔ internal)
  └─ fuel_measurements_daily (the raw data)
  └─ fuel_baseline_snapshots (computed MPG baselines)
  └─ fuel_target_policies (group targets)
  └─ fuel_target_overrides (driver overrides)
  └─ fuel_payout_periods (monthly cycles)
       └─ fuel_payout_ledgers (per driver per period)
  └─ fuel_payout_adjustments (post-approval corrections)
  └─ fuel_audit_log (everything)
  └─ fuel_vin_cache (NHTSA decode cache)
  └─ fuel_ceiling_log (billing mode switches)
```
