// Provider factory
const { decrypt } = require('../crypto');
const SamsaraFuelProvider = require('./samsara');
const MotiveFuelProvider = require('./motive');

function getProvider(db, integration) {
  const secrets = decrypt(integration.encrypted_secrets);
  if (!secrets) throw new Error('Failed to decrypt integration secrets');

  let parsed;
  try { parsed = JSON.parse(secrets); } catch(e) { parsed = secrets; }

  switch (integration.provider) {
    case 'samsara':
      return new SamsaraFuelProvider(db, integration, parsed);
    case 'motive':
      return new MotiveFuelProvider(db, integration, parsed);
    default:
      throw new Error('Unknown provider: ' + integration.provider);
  }
}

module.exports = { getProvider };
