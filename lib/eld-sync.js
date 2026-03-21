// ELD Integration — Samsara & Motive vehicle + trailer sync
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

function upsertEldVehicle(db, integration, extId, data) {
  const existing = db.prepare('SELECT id FROM eld_vehicles WHERE integration_id = ? AND external_id = ?').get(integration.id, extId);
  if (existing) {
    db.prepare("UPDATE eld_vehicles SET name=?, make=?, model=?, year=?, vin=?, license_plate=?, status=?, asset_type=?, odometer=?, fuel_pct=?, last_location=?, last_lat=?, last_lng=?, last_speed=?, driver_name=?, raw_data=?, last_updated=datetime('now') WHERE id=?").run(
      data.name, data.make, data.model, data.year, data.vin, data.plate, data.status, data.assetType || 'vehicle',
      data.odometer, data.fuelPct, data.locStr, data.lat, data.lng, data.speed, data.driverName, data.raw, existing.id
    );
    return existing.id;
  } else {
    const r = db.prepare("INSERT INTO eld_vehicles (company_id, integration_id, external_id, name, make, model, year, vin, license_plate, status, asset_type, odometer, fuel_pct, last_location, last_lat, last_lng, last_speed, driver_name, raw_data) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
      integration.company_id, integration.id, extId, data.name, data.make, data.model, data.year, data.vin, data.plate, data.status, data.assetType || 'vehicle',
      data.odometer, data.fuelPct, data.locStr, data.lat, data.lng, data.speed, data.driverName, data.raw
    );
    return r.lastInsertRowid;
  }
}

async function syncSamsara(db, integration) {
  const headers = { 'Authorization': 'Bearer ' + integration.api_key, 'Accept': 'application/json' };
  const baseUrl = integration.base_url || 'https://api.samsara.com';
  let synced = 0;

  try {
    // 1. Vehicles
    const vRes = await apiGet(baseUrl + '/fleet/vehicles', headers);
    if (vRes.status === 200) {
      const vehicles = vRes.data.data || vRes.data.vehicles || [];
      for (const v of vehicles) {
        const gps = v.gps || {};
        upsertEldVehicle(db, integration, String(v.id), {
          name: v.name || '', make: v.make || '', model: v.model || '', year: v.year || null,
          vin: v.vin || '', plate: v.licensePlate || '', status: v.vehicleStatus || 'unknown',
          assetType: 'vehicle', odometer: null, fuelPct: null,
          lat: gps.latitude || null, lng: gps.longitude || null,
          speed: gps.speedMilesPerHour || null,
          locStr: gps.reverseGeo ? gps.reverseGeo.formattedLocation : null,
          driverName: null, raw: JSON.stringify(v)
        });
        synced++;
      }
    }

    // 2. Vehicle locations (separate endpoint for GPS)
    try {
      const locRes = await apiGet(baseUrl + '/fleet/vehicles/locations', headers);
      if (locRes.status === 200) {
        const locations = locRes.data.data || locRes.data || [];
        for (const loc of locations) {
          const gps = loc.location || loc.gps || {};
          const lat = gps.latitude || null;
          const lng = gps.longitude || null;
          if (lat && lng) {
            try {
              db.prepare("UPDATE eld_vehicles SET last_lat=?, last_lng=?, last_speed=?, last_location=?, last_updated=datetime('now') WHERE integration_id=? AND external_id=?").run(
                lat, lng, gps.speedMilesPerHour || gps.speed || null,
                gps.reverseGeo ? gps.reverseGeo.formattedLocation : null,
                integration.id, String(loc.id)
              );
            } catch(e2) {}
          }
        }
      }
    } catch(e2) {}

    // 3. Trailers
    try {
      const tRes = await apiGet(baseUrl + '/fleet/trailers', headers);
      if (tRes.status === 200) {
        const trailers = tRes.data.data || tRes.data.trailers || [];
        for (const t of trailers) {
          const gps = t.gps || {};
          upsertEldVehicle(db, integration, 'trailer-' + String(t.id), {
            name: t.name || '', make: t.make || '', model: t.model || '', year: t.year || null,
            vin: t.vin || '', plate: t.licensePlate || '', status: t.trailerStatus || 'unknown',
            assetType: 'trailer', odometer: null, fuelPct: null,
            lat: gps.latitude || null, lng: gps.longitude || null, speed: null,
            locStr: gps.reverseGeo ? gps.reverseGeo.formattedLocation : null,
            driverName: null, raw: JSON.stringify(t)
          });
          synced++;
        }
      }
    } catch(e2) { console.log('Samsara trailers endpoint not available'); }

    // 4. Assets (generic tracked assets)
    try {
      const aRes = await apiGet(baseUrl + '/industrial/assets', headers);
      if (aRes.status === 200) {
        const assets = aRes.data.data || [];
        for (const a of assets) {
          const loc = a.location || {};
          upsertEldVehicle(db, integration, 'asset-' + String(a.id), {
            name: a.name || '', make: '', model: '', year: null,
            vin: '', plate: '', status: 'active', assetType: 'asset',
            odometer: null, fuelPct: null,
            lat: loc.latitude || null, lng: loc.longitude || null, speed: null,
            locStr: null, driverName: null, raw: JSON.stringify(a)
          });
          synced++;
        }
      }
    } catch(e2) {}

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
  let synced = 0;

  try {
    // 1. Vehicles
    const vRes = await apiGet(baseUrl + '/v1/vehicles', headers);
    if (vRes.status === 200) {
      const vehicles = vRes.data.vehicles || vRes.data.data || [];
      for (const item of vehicles) {
        const v = item.vehicle || item;
        const loc = v.current_location || {};
        upsertEldVehicle(db, integration, String(v.id), {
          name: v.number || v.name || '', make: v.make || '', model: v.model || '', year: v.year || null,
          vin: v.vin || '', plate: v.license_plate_number || '', status: v.status || 'unknown',
          assetType: 'vehicle', odometer: v.current_odometer || null, fuelPct: v.fuel_level_percent || null,
          lat: loc.lat || null, lng: loc.lon || loc.lng || null, speed: null,
          locStr: loc.description || [loc.city, loc.state].filter(Boolean).join(', ') || null,
          driverName: v.current_driver ? (v.current_driver.first_name + ' ' + v.current_driver.last_name) : null,
          raw: JSON.stringify(v)
        });
        synced++;
      }
    }

    // 2. Assets / Trailers
    try {
      const aRes = await apiGet(baseUrl + '/v1/assets', headers);
      if (aRes.status === 200) {
        const assets = aRes.data.assets || aRes.data.data || [];
        for (const item of assets) {
          const a = item.asset || item;
          const loc = a.current_location || {};
          upsertEldVehicle(db, integration, 'asset-' + String(a.id), {
            name: a.name || a.number || '', make: a.make || '', model: a.model || '', year: a.year || null,
            vin: a.vin || '', plate: '', status: a.status || 'active',
            assetType: a.asset_type === 'trailer' ? 'trailer' : 'asset',
            odometer: null, fuelPct: null,
            lat: loc.lat || null, lng: loc.lon || loc.lng || null, speed: null,
            locStr: loc.description || null, driverName: null, raw: JSON.stringify(a)
          });
          synced++;
        }
      }
    } catch(e2) { console.log('Motive assets endpoint not available'); }

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
