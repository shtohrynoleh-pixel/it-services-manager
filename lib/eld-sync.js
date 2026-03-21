// ELD Integration — Samsara & Motive vehicle sync
const https = require('https');

function apiGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'GET', headers, timeout: 15000 };
    const req = (parsed.protocol === 'https:' ? https : require('http')).request(opts, (res) => {
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

async function syncSamsara(db, integration) {
  const headers = { 'Authorization': 'Bearer ' + integration.api_key, 'Accept': 'application/json' };
  const baseUrl = integration.base_url || 'https://api.samsara.com';

  try {
    const res = await apiGet(baseUrl + '/fleet/vehicles', headers);
    if (res.status !== 200) throw new Error('Samsara API error: ' + res.status);

    const vehicles = res.data.data || res.data.vehicles || [];
    let synced = 0;

    for (const v of vehicles) {
      const extId = String(v.id);
      const name = v.name || '';
      const make = v.make || '';
      const model = v.model || '';
      const year = v.year || null;
      const vin = v.vin || '';
      const plate = v.licensePlate || '';
      const status = v.vehicleStatus || 'unknown';

      // Location data
      const loc = v.gps || {};
      const lat = loc.latitude || null;
      const lng = loc.longitude || null;
      const speed = loc.speedMilesPerHour || null;
      const locStr = loc.reverseGeo ? loc.reverseGeo.formattedLocation : null;

      const existing = db.prepare('SELECT id FROM eld_vehicles WHERE integration_id = ? AND external_id = ?').get(integration.id, extId);
      if (existing) {
        db.prepare("UPDATE eld_vehicles SET name=?, make=?, model=?, year=?, vin=?, license_plate=?, status=?, last_location=?, last_lat=?, last_lng=?, last_speed=?, raw_data=?, last_updated=datetime('now') WHERE id=?").run(
          name, make, model, year, vin, plate, status, locStr, lat, lng, speed, JSON.stringify(v), existing.id
        );
      } else {
        db.prepare("INSERT INTO eld_vehicles (company_id, integration_id, external_id, name, make, model, year, vin, license_plate, status, last_location, last_lat, last_lng, last_speed, raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          integration.company_id, integration.id, extId, name, make, model, year, vin, plate, status, locStr, lat, lng, speed, JSON.stringify(v)
        );
      }
      synced++;
    }

    // Also fetch GPS locations
    try {
      const locRes = await apiGet(baseUrl + '/fleet/vehicles/locations', headers);
      if (locRes.status === 200) {
        const locations = locRes.data.data || locRes.data || [];
        for (const loc of locations) {
          const vId = String(loc.id);
          const gps = loc.location || loc.gps || {};
          const lat = gps.latitude || null;
          const lng = gps.longitude || null;
          const speed = gps.speedMilesPerHour || gps.speed || null;
          const locStr = gps.reverseGeo ? gps.reverseGeo.formattedLocation : null;
          if (lat && lng) {
            try {
              db.prepare("UPDATE eld_vehicles SET last_lat=?, last_lng=?, last_speed=?, last_location=?, last_updated=datetime('now') WHERE integration_id=? AND external_id=?").run(
                lat, lng, speed, locStr, integration.id, vId
              );
            } catch(e2) {}
          }
        }
      }
    } catch(e2) { /* GPS fetch failed, not critical */ }

    db.prepare("UPDATE eld_integrations SET last_sync = datetime('now'), last_error = NULL WHERE id = ?").run(integration.id);
    return { ok: true, synced, provider: 'samsara' };
  } catch(e) {
    db.prepare("UPDATE eld_integrations SET last_error = ? WHERE id = ?").run(e.message, integration.id);
    return { ok: false, error: e.message, provider: 'samsara' };
  }
}

async function syncMotive(db, integration) {
  const headers = { 'X-API-Key': integration.api_key, 'Accept': 'application/json' };
  const baseUrl = integration.base_url || 'https://api.keeptruckin.com';

  try {
    const res = await apiGet(baseUrl + '/v1/vehicles', headers);
    if (res.status !== 200) throw new Error('Motive API error: ' + res.status);

    const vehicles = res.data.vehicles || res.data.data || [];
    let synced = 0;

    for (const item of vehicles) {
      const v = item.vehicle || item;
      const extId = String(v.id);
      const name = v.number || v.name || '';
      const make = v.make || '';
      const model = v.model || '';
      const year = v.year || null;
      const vin = v.vin || '';
      const plate = v.license_plate_number || '';
      const status = v.status || 'unknown';
      const odometer = v.current_odometer || null;
      const fuelPct = v.fuel_level_percent || null;

      const loc = v.current_location || {};
      const lat = loc.lat || null;
      const lng = loc.lon || loc.lng || null;
      const locStr = loc.description || [loc.city, loc.state].filter(Boolean).join(', ') || null;
      const driverName = v.current_driver ? (v.current_driver.first_name + ' ' + v.current_driver.last_name) : null;

      const existing = db.prepare('SELECT id FROM eld_vehicles WHERE integration_id = ? AND external_id = ?').get(integration.id, extId);
      if (existing) {
        db.prepare("UPDATE eld_vehicles SET name=?, make=?, model=?, year=?, vin=?, license_plate=?, status=?, odometer=?, fuel_pct=?, last_location=?, last_lat=?, last_lng=?, driver_name=?, raw_data=?, last_updated=datetime('now') WHERE id=?").run(
          name, make, model, year, vin, plate, status, odometer, fuelPct, locStr, lat, lng, driverName, JSON.stringify(v), existing.id
        );
      } else {
        db.prepare("INSERT INTO eld_vehicles (company_id, integration_id, external_id, name, make, model, year, vin, license_plate, status, odometer, fuel_pct, last_location, last_lat, last_lng, driver_name, raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
          integration.company_id, integration.id, extId, name, make, model, year, vin, plate, status, odometer, fuelPct, locStr, lat, lng, driverName, JSON.stringify(v)
        );
      }
      synced++;
    }

    db.prepare("UPDATE eld_integrations SET last_sync = datetime('now'), last_error = NULL WHERE id = ?").run(integration.id);
    return { ok: true, synced, provider: 'motive' };
  } catch(e) {
    db.prepare("UPDATE eld_integrations SET last_error = ? WHERE id = ?").run(e.message, integration.id);
    return { ok: false, error: e.message, provider: 'motive' };
  }
}

async function syncIntegration(db, integration) {
  if (integration.provider === 'samsara') return syncSamsara(db, integration);
  if (integration.provider === 'motive') return syncMotive(db, integration);
  return { ok: false, error: 'Unknown provider: ' + integration.provider };
}

module.exports = { syncIntegration, syncSamsara, syncMotive };
