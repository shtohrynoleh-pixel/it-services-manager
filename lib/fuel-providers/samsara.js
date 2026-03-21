// Samsara fuel provider adapter
const FuelProviderBase = require('./base');

class SamsaraFuelProvider extends FuelProviderBase {
  constructor(db, integration, decryptedSecrets) {
    super(db, integration, decryptedSecrets);
    this.token = typeof decryptedSecrets === 'string' ? decryptedSecrets : (decryptedSecrets.token || decryptedSecrets.api_key || '');
    this.baseUrl = integration.base_url || 'https://api.samsara.com';
    this.headers = { 'Authorization': 'Bearer ' + this.token, 'Accept': 'application/json' };
  }

  async testConnection() {
    try {
      const res = await this._apiGet(this.baseUrl + '/fleet/vehicles?limit=1', this.headers);
      if (res.status === 401) return { ok: false, message: 'Invalid API token — check your Samsara key' };
      if (res.status !== 200) return { ok: false, message: 'API error: HTTP ' + res.status };
      const vehicles = res.data.data || res.data.vehicles || [];
      const pagination = res.data.pagination || {};
      return { ok: true, message: 'Connected successfully', vehicleCount: pagination.total || vehicles.length };
    } catch(e) {
      return { ok: false, message: 'Connection failed: ' + e.message };
    }
  }

  async syncAssets() {
    let synced = 0, mapped = 0;
    try {
      let hasMore = true;
      let cursor = null;

      while (hasMore) {
        const url = this.baseUrl + '/fleet/vehicles?limit=100' + (cursor ? '&after=' + cursor : '');
        const res = await this._apiGet(url, this.headers);
        if (res.status !== 200) throw new Error('API error: ' + res.status);

        const vehicles = res.data.data || [];
        for (const v of vehicles) {
          const result = this._upsertAssetMap(String(v.id), v.name || '', v.vin || '');
          synced++;
          if (result.internal_vehicle_id) mapped++;
        }

        // Pagination
        const pagination = res.data.pagination || {};
        if (pagination.hasNextPage && pagination.endCursor) {
          cursor = pagination.endCursor;
        } else {
          hasMore = false;
        }
      }

      this._updateStatus('connected', null);
      return { ok: true, synced, mapped };
    } catch(e) {
      this._updateStatus('error', e.message);
      return { ok: false, error: e.message };
    }
  }

  async fetchDailyMetrics(dateFrom, dateTo) {
    let totalRecords = 0;
    try {
      // Get all mapped assets
      const assets = this.db.prepare('SELECT * FROM fuel_provider_asset_map WHERE integration_id = ? AND internal_vehicle_id IS NOT NULL').all(this.integration.id);
      if (assets.length === 0) return { ok: true, records: 0, message: 'No mapped vehicles' };

      // For each vehicle, fetch stats
      for (const asset of assets) {
        try {
          // Samsara Vehicle Stats History endpoint
          const startMs = new Date(dateFrom + 'T00:00:00Z').getTime();
          const endMs = new Date(dateTo + 'T23:59:59Z').getTime();

          // Try fuel + engine data
          const statsUrl = this.baseUrl + '/fleet/vehicles/' + asset.provider_vehicle_id + '/stats/history' +
            '?startTime=' + new Date(dateFrom + 'T00:00:00Z').toISOString() +
            '&endTime=' + new Date(dateTo + 'T23:59:59Z').toISOString() +
            '&types=obdOdometerMeters,fuelPercent,engineStates';

          const statsRes = await this._apiGet(statsUrl, this.headers);

          if (statsRes.status === 200) {
            // Process odometer readings into daily miles
            const odometerPoints = (statsRes.data.obdOdometerMeters || []).map(p => ({
              time: p.time, value: p.value ? p.value / 1609.34 : 0 // meters to miles
            }));

            // Group by date
            const dailyData = {};
            const fromDate = new Date(dateFrom);
            const toDate = new Date(dateTo);
            for (let d = new Date(fromDate); d <= toDate; d.setDate(d.getDate() + 1)) {
              dailyData[d.toISOString().slice(0,10)] = { miles: 0, odometerStart: null, odometerEnd: null };
            }

            // Calculate daily miles from odometer readings
            if (odometerPoints.length >= 2) {
              odometerPoints.forEach(p => {
                const dateKey = p.time ? p.time.substring(0, 10) : null;
                if (dateKey && dailyData[dateKey]) {
                  if (dailyData[dateKey].odometerStart === null) dailyData[dateKey].odometerStart = p.value;
                  dailyData[dateKey].odometerEnd = p.value;
                }
              });

              Object.keys(dailyData).forEach(date => {
                const dd = dailyData[date];
                if (dd.odometerStart !== null && dd.odometerEnd !== null) {
                  dd.miles = Math.max(0, dd.odometerEnd - dd.odometerStart);
                }
              });
            }

            // Try fuel consumption from Samsara fuel reports
            try {
              const fuelUrl = this.baseUrl + '/fleet/reports/vehicles/fuel-energy' +
                '?startDate=' + dateFrom + '&endDate=' + dateTo +
                '&vehicleIds=' + asset.provider_vehicle_id;
              const fuelRes = await this._apiGet(fuelUrl, this.headers);
              if (fuelRes.status === 200 && fuelRes.data.data) {
                fuelRes.data.data.forEach(entry => {
                  const vehicle = entry.vehicle || {};
                  const fuelData = entry.fuelEnergyData || entry;
                  const dateKey = entry.date || entry.startDate;
                  if (dateKey && dailyData[dateKey]) {
                    dailyData[dateKey].gallons = (fuelData.fuelConsumedGallons || fuelData.fuelUsedGallons || 0);
                  }
                });
              }
            } catch(e2) {}

            // Try idling data
            try {
              const idleUrl = this.baseUrl + '/fleet/reports/vehicles/idling' +
                '?startDate=' + dateFrom + '&endDate=' + dateTo +
                '&vehicleIds=' + asset.provider_vehicle_id;
              const idleRes = await this._apiGet(idleUrl, this.headers);
              if (idleRes.status === 200 && idleRes.data.data) {
                idleRes.data.data.forEach(entry => {
                  const dateKey = entry.date || entry.startDate;
                  if (dateKey && dailyData[dateKey]) {
                    dailyData[dateKey].idleHours = (entry.idleDurationMs || 0) / 3600000;
                    dailyData[dateKey].idleGallons = entry.idleFuelConsumedGallons || 0;
                  }
                });
              }
            } catch(e2) {}

            // Store daily records
            Object.keys(dailyData).forEach(date => {
              const dd = dailyData[date];
              if (dd.miles > 0 || dd.gallons > 0) {
                this._upsertDailyMeasurement(asset.internal_vehicle_id, date, {
                  miles: Math.round(dd.miles * 10) / 10,
                  gallons: Math.round((dd.gallons || 0) * 100) / 100,
                  idleHours: Math.round((dd.idleHours || 0) * 100) / 100,
                  idleGallons: Math.round((dd.idleGallons || 0) * 100) / 100,
                  odometerStart: dd.odometerStart ? Math.round(dd.odometerStart) : null,
                  odometerEnd: dd.odometerEnd ? Math.round(dd.odometerEnd) : null,
                  providerVehicleId: asset.provider_vehicle_id,
                  raw: null
                });
                totalRecords++;
              }
            });
          }
        } catch(vehicleErr) {
          console.error('  Samsara fetch error for vehicle ' + asset.provider_vehicle_id + ':', vehicleErr.message);
        }
      }

      this._updateStatus('connected', null);
      return { ok: true, records: totalRecords };
    } catch(e) {
      this._updateStatus('error', e.message);
      return { ok: false, error: e.message };
    }
  }
}

module.exports = SamsaraFuelProvider;
