// Base provider adapter interface
class FuelProviderBase {
  constructor(db, integration, decryptedSecrets) {
    this.db = db;
    this.integration = integration;
    this.companyId = integration.company_id;
    this.secrets = decryptedSecrets;
  }

  // Test if the connection works — returns { ok, message, vehicleCount }
  async testConnection() { throw new Error('Not implemented'); }

  // Sync vehicle list from provider → fuel_provider_asset_map
  async syncAssets() { throw new Error('Not implemented'); }

  // Fetch daily metrics for a date range → fuel_measurements_daily
  // dateFrom/dateTo: 'YYYY-MM-DD' strings
  async fetchDailyMetrics(dateFrom, dateTo) { throw new Error('Not implemented'); }

  // Helper: HTTP GET with JSON response
  _apiGet(url, headers) {
    const https = require('https');
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const opts = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers, timeout: 20000 };
      const req = https.request(opts, (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch(e) { resolve({ status: res.statusCode, data: body }); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    });
  }

  // Helper: upsert asset map
  _upsertAssetMap(providerVehicleId, providerName, providerVin) {
    const existing = this.db.prepare('SELECT id, internal_vehicle_id FROM fuel_provider_asset_map WHERE integration_id = ? AND provider_vehicle_id = ?').get(this.integration.id, providerVehicleId);
    if (existing) {
      this.db.prepare('UPDATE fuel_provider_asset_map SET provider_vehicle_name = ?, provider_vin = ? WHERE id = ?').run(providerName, providerVin, existing.id);
      return existing;
    }
    // Try auto-map by VIN
    let internalId = null;
    if (providerVin) {
      const truck = this.db.prepare('SELECT id FROM fleet_vehicles WHERE company_id = ? AND vin = ?').get(this.companyId, providerVin);
      if (truck) internalId = truck.id;
    }
    // Try auto-map by unit number / name
    if (!internalId && providerName) {
      const truck = this.db.prepare('SELECT id FROM fleet_vehicles WHERE company_id = ? AND unit_number = ?').get(this.companyId, providerName);
      if (truck) internalId = truck.id;
    }
    const r = this.db.prepare('INSERT INTO fuel_provider_asset_map (company_id, integration_id, provider_vehicle_id, provider_vehicle_name, provider_vin, internal_vehicle_id, mapped_by) VALUES (?,?,?,?,?,?,?)').run(
      this.companyId, this.integration.id, providerVehicleId, providerName, providerVin, internalId, internalId ? 'auto-vin' : 'unmapped'
    );
    return { id: r.lastInsertRowid, internal_vehicle_id: internalId };
  }

  // Helper: upsert daily measurement
  _upsertDailyMeasurement(vehicleId, date, data) {
    const existing = this.db.prepare('SELECT id FROM fuel_measurements_daily WHERE company_id = ? AND vehicle_id = ? AND date = ? AND provider = ?').get(
      this.companyId, vehicleId, date, this.integration.provider
    );
    const mpg = data.gallons > 0 ? (data.miles / data.gallons) : 0;
    if (existing) {
      this.db.prepare('UPDATE fuel_measurements_daily SET miles=?, gallons=?, mpg=?, idle_hours=?, idle_gallons=?, odometer_start=?, odometer_end=?, raw_data=? WHERE id=?').run(
        data.miles||0, data.gallons||0, Math.round(mpg*100)/100, data.idleHours||0, data.idleGallons||0, data.odometerStart||null, data.odometerEnd||null, data.raw||null, existing.id
      );
    } else {
      this.db.prepare('INSERT INTO fuel_measurements_daily (company_id, integration_id, vehicle_id, driver_id, date, miles, gallons, mpg, idle_hours, idle_gallons, odometer_start, odometer_end, provider, provider_vehicle_id, raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        this.companyId, this.integration.id, vehicleId, data.driverId||null, date, data.miles||0, data.gallons||0, Math.round(mpg*100)/100, data.idleHours||0, data.idleGallons||0, data.odometerStart||null, data.odometerEnd||null, this.integration.provider, data.providerVehicleId||null, data.raw||null
      );
    }
  }

  // Update integration status
  _updateStatus(status, error) {
    this.db.prepare("UPDATE fuel_integrations SET status = ?, last_sync_at = datetime('now'), last_error = ? WHERE id = ?").run(status, error||null, this.integration.id);
  }
}

module.exports = FuelProviderBase;
