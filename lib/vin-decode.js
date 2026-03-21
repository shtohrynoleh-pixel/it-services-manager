// VIN Decoder using NHTSA vPIC API (free, no key needed)
const https = require('https');

function apiGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

async function decodeVIN(db, vin) {
  if (!vin || vin.length < 11) return { ok: false, error: 'Invalid VIN — must be at least 11 characters' };

  vin = vin.trim().toUpperCase();

  // Check cache first
  try {
    const cached = db.prepare('SELECT * FROM fuel_vin_cache WHERE vin = ?').get(vin);
    if (cached) {
      return { ok: true, cached: true, data: {
        make: cached.make, model: cached.model, year: cached.year,
        body_class: cached.body_class, fuel_type: cached.fuel_type,
        engine: cached.engine, gvwr: cached.gvwr, drive_type: cached.drive_type,
        raw: cached.raw_json ? JSON.parse(cached.raw_json) : null
      }};
    }
  } catch(e) {}

  // Call NHTSA vPIC API
  try {
    const url = 'https://vpic.nhtsa.dot.gov/api/vehicles/decodevinvalues/' + encodeURIComponent(vin) + '?format=json';
    const response = await apiGet(url);

    if (!response || !response.Results || response.Results.length === 0) {
      return { ok: false, error: 'No results from NHTSA' };
    }

    const r = response.Results[0];

    // Check for error
    if (r.ErrorCode && r.ErrorCode !== '0' && !r.Make) {
      return { ok: false, error: r.ErrorText || 'VIN decode failed' };
    }

    const data = {
      make: r.Make || null,
      model: r.Model || null,
      year: r.ModelYear ? parseInt(r.ModelYear) : null,
      body_class: r.BodyClass || null,
      fuel_type: r.FuelTypePrimary || null,
      engine: [r.EngineConfiguration, r.DisplacementL ? r.DisplacementL + 'L' : null, r.EngineCylinders ? r.EngineCylinders + ' cyl' : null, r.EngineHP ? r.EngineHP + ' HP' : null].filter(Boolean).join(' · ') || null,
      gvwr: r.GVWR || null,
      drive_type: r.DriveType || null
    };

    // Cache the result
    try {
      db.prepare('INSERT OR REPLACE INTO fuel_vin_cache (vin, make, model, year, body_class, fuel_type, engine, gvwr, drive_type, raw_json) VALUES (?,?,?,?,?,?,?,?,?,?)').run(
        vin, data.make, data.model, data.year, data.body_class, data.fuel_type, data.engine, data.gvwr, data.drive_type, JSON.stringify(r)
      );
    } catch(e) {}

    return { ok: true, cached: false, data };
  } catch(e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { decodeVIN };
