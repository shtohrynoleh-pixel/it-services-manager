// Motive (KeepTruckin) fuel provider adapter
const FuelProviderBase = require('./base');

class MotiveFuelProvider extends FuelProviderBase {
  constructor(db, integration, decryptedSecrets) {
    super(db, integration, decryptedSecrets);
    this.token = typeof decryptedSecrets === 'string' ? decryptedSecrets : (decryptedSecrets.token || decryptedSecrets.api_key || '');
    this.baseUrl = integration.base_url || 'https://api.keeptruckin.com';
    this.headers = { 'X-API-Key': this.token, 'Accept': 'application/json' };
  }

  async testConnection() {
    try {
      const res = await this._apiGet(this.baseUrl + '/v1/vehicles?per_page=1', this.headers);
      if (res.status === 401 || res.status === 403) return { ok: false, message: 'Invalid API key — check your Motive key' };
      if (res.status !== 200) return { ok: false, message: 'API error: HTTP ' + res.status };
      const vehicles = res.data.vehicles || res.data.data || [];
      const pagination = res.data.pagination || {};
      return { ok: true, message: 'Connected to Motive', vehicleCount: pagination.total || vehicles.length };
    } catch(e) {
      return { ok: false, message: 'Connection failed: ' + e.message };
    }
  }

  async syncAssets() {
    let synced = 0, mapped = 0;
    try {
      let page = 1;
      let hasMore = true;

      while (hasMore) {
        // Sync vehicles
        const res = await this._apiGet(this.baseUrl + '/v1/vehicles?per_page=100&page_no=' + page, this.headers);
        if (res.status !== 200) throw new Error('Vehicles API error: ' + res.status);

        const vehicles = res.data.vehicles || res.data.data || [];
        if (vehicles.length === 0) { hasMore = false; break; }

        for (const item of vehicles) {
          const v = item.vehicle || item;
          const result = this._upsertAssetMap(
            String(v.id),
            v.number || v.name || '',
            v.vin || ''
          );
          synced++;
          if (result.internal_vehicle_id) mapped++;
        }

        // Check pagination
        const pagination = res.data.pagination || {};
        if (pagination.has_next_page || vehicles.length === 100) { page++; }
        else { hasMore = false; }
      }

      // Also sync drivers
      try {
        let driverPage = 1;
        let driverMore = true;
        while (driverMore) {
          const dRes = await this._apiGet(this.baseUrl + '/v1/users?per_page=100&page_no=' + driverPage + '&role=driver', this.headers);
          if (dRes.status !== 200) break;
          const drivers = dRes.data.users || dRes.data.data || [];
          if (drivers.length === 0) break;
          // Store driver mapping in the same asset map with prefix
          for (const item of drivers) {
            const d = item.user || item;
            this._upsertDriverMap(String(d.id), (d.first_name || '') + ' ' + (d.last_name || ''), d.email);
          }
          if (drivers.length < 100) driverMore = false;
          else driverPage++;
        }
      } catch(e2) { /* driver sync optional */ }

      this._updateStatus('connected', null);
      return { ok: true, synced, mapped };
    } catch(e) {
      this._updateStatus('error', e.message);
      return { ok: false, error: e.message };
    }
  }

  // Driver mapping helper
  _upsertDriverMap(providerDriverId, name, email) {
    try {
      const existing = this.db.prepare('SELECT id FROM fuel_provider_asset_map WHERE integration_id = ? AND provider_vehicle_id = ?').get(this.integration.id, 'driver-' + providerDriverId);
      if (!existing) {
        // Auto-map by name
        let internalId = null;
        if (name && name.trim()) {
          const driver = this.db.prepare('SELECT id FROM company_users WHERE company_id = ? AND name = ?').get(this.companyId, name.trim());
          if (driver) internalId = driver.id;
        }
        this.db.prepare('INSERT INTO fuel_provider_asset_map (company_id, integration_id, provider_vehicle_id, provider_vehicle_name, internal_driver_id, mapped_by) VALUES (?,?,?,?,?,?)').run(
          this.companyId, this.integration.id, 'driver-' + providerDriverId, name, internalId, internalId ? 'auto-name' : 'unmapped'
        );
      }
    } catch(e) {}
  }

  async fetchDailyMetrics(dateFrom, dateTo) {
    let totalRecords = 0;
    try {
      const assets = this.db.prepare('SELECT * FROM fuel_provider_asset_map WHERE integration_id = ? AND internal_vehicle_id IS NOT NULL AND provider_vehicle_id NOT LIKE ?').all(this.integration.id, 'driver-%');
      if (assets.length === 0) return { ok: true, records: 0, message: 'No mapped vehicles' };

      // Method 1: Try IFTA trip reports (has mileage data)
      try {
        const iftaRes = await this._apiGet(
          this.baseUrl + '/v1/ifta/trip_reports?start_date=' + dateFrom + '&end_date=' + dateTo + '&per_page=1000',
          this.headers
        );
        if (iftaRes.status === 200) {
          const trips = iftaRes.data.ifta_trip_reports || iftaRes.data.data || [];
          // Group by vehicle+date
          const dailyMap = {};
          for (const item of trips) {
            const trip = item.ifta_trip_report || item;
            const vehicleId = String(trip.vehicle_id || (trip.vehicle && trip.vehicle.id));
            const date = (trip.start_date || trip.date || '').substring(0, 10);
            if (!vehicleId || !date) continue;
            const key = vehicleId + ':' + date;
            if (!dailyMap[key]) dailyMap[key] = { vehicleId, date, miles: 0, gallons: 0 };
            dailyMap[key].miles += (trip.distance_miles || trip.total_miles || 0);
            dailyMap[key].gallons += (trip.fuel_gallons || trip.fuel_consumed || 0);
          }

          // Store
          for (const key of Object.keys(dailyMap)) {
            const d = dailyMap[key];
            const asset = assets.find(a => a.provider_vehicle_id === d.vehicleId);
            if (!asset) continue;
            this._upsertDailyMeasurement(asset.internal_vehicle_id, d.date, {
              miles: Math.round(d.miles * 10) / 10,
              gallons: Math.round(d.gallons * 100) / 100,
              providerVehicleId: d.vehicleId
            });
            totalRecords++;
          }
        }
      } catch(iftaErr) {
        console.log('  Motive IFTA not available, trying vehicle stats...');
      }

      // Method 2: Fallback — vehicle-by-vehicle odometer readings
      if (totalRecords === 0) {
        for (const asset of assets) {
          try {
            // Get vehicle locations/stats for date range
            const statsRes = await this._apiGet(
              this.baseUrl + '/v1/vehicles/' + asset.provider_vehicle_id + '?include=odometer',
              this.headers
            );
            if (statsRes.status === 200) {
              const v = statsRes.data.vehicle || statsRes.data;
              const currentOdo = v.current_odometer || v.odometer || null;
              // Without historical odometer, we can only store current
              if (currentOdo) {
                this._upsertDailyMeasurement(asset.internal_vehicle_id, dateTo, {
                  miles: 0, // We don't have daily breakdown
                  odometerEnd: currentOdo,
                  providerVehicleId: asset.provider_vehicle_id
                });
                totalRecords++;
              }
            }
          } catch(vErr) {}
        }
      }

      // Method 3: Try fuel purchases
      try {
        const fuelRes = await this._apiGet(
          this.baseUrl + '/v1/fuel_purchases?start_date=' + dateFrom + '&end_date=' + dateTo + '&per_page=500',
          this.headers
        );
        if (fuelRes.status === 200) {
          const purchases = fuelRes.data.fuel_purchases || fuelRes.data.data || [];
          for (const item of purchases) {
            const fp = item.fuel_purchase || item;
            const vehicleId = String(fp.vehicle_id || (fp.vehicle && fp.vehicle.id) || '');
            const date = (fp.date || fp.purchased_at || '').substring(0, 10);
            const gallons = fp.gallons || fp.quantity || 0;
            if (!vehicleId || !date || !gallons) continue;
            const asset = assets.find(a => a.provider_vehicle_id === vehicleId);
            if (!asset) continue;
            // Add gallons to existing record
            const existing = this.db.prepare('SELECT id, gallons FROM fuel_measurements_daily WHERE company_id = ? AND vehicle_id = ? AND date = ? AND provider = ?').get(
              this.companyId, asset.internal_vehicle_id, date, 'motive'
            );
            if (existing) {
              const newGallons = (existing.gallons || 0) + gallons;
              const miles = this.db.prepare('SELECT miles FROM fuel_measurements_daily WHERE id = ?').get(existing.id);
              const newMpg = newGallons > 0 ? ((miles ? miles.miles : 0) / newGallons) : 0;
              this.db.prepare('UPDATE fuel_measurements_daily SET gallons = ?, mpg = ? WHERE id = ?').run(
                Math.round(newGallons * 100) / 100, Math.round(newMpg * 100) / 100, existing.id
              );
            }
          }
        }
      } catch(fuelErr) {}

      // Method 4: Try idle time
      try {
        const idleRes = await this._apiGet(
          this.baseUrl + '/v1/driver_performance_events?event_types=idle&start_date=' + dateFrom + '&end_date=' + dateTo + '&per_page=500',
          this.headers
        );
        if (idleRes.status === 200) {
          const events = idleRes.data.driver_performance_events || idleRes.data.data || [];
          const idleByVehicleDate = {};
          for (const item of events) {
            const evt = item.driver_performance_event || item;
            const vehicleId = String(evt.vehicle_id || '');
            const date = (evt.start_time || evt.date || '').substring(0, 10);
            const duration = evt.duration_seconds || evt.idle_duration || 0;
            if (!vehicleId || !date) continue;
            const key = vehicleId + ':' + date;
            if (!idleByVehicleDate[key]) idleByVehicleDate[key] = 0;
            idleByVehicleDate[key] += duration;
          }
          // Update existing daily records with idle data
          for (const key of Object.keys(idleByVehicleDate)) {
            const [vehicleId, date] = key.split(':');
            const asset = assets.find(a => a.provider_vehicle_id === vehicleId);
            if (!asset) continue;
            const idleHours = Math.round(idleByVehicleDate[key] / 36) / 100; // seconds to hours
            try {
              this.db.prepare('UPDATE fuel_measurements_daily SET idle_hours = ? WHERE company_id = ? AND vehicle_id = ? AND date = ? AND provider = ?').run(
                idleHours, this.companyId, asset.internal_vehicle_id, date, 'motive'
              );
            } catch(e2) {}
          }
        }
      } catch(idleErr) {}

      this._updateStatus('connected', null);
      return { ok: true, records: totalRecords };
    } catch(e) {
      this._updateStatus('error', e.message);
      return { ok: false, error: e.message };
    }
  }
}

module.exports = MotiveFuelProvider;
