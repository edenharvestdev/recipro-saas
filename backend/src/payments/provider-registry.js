// Provider-neutral adapter registry (BILLING_PLATFORM_BLUEPRINT.md Part F.5). Real adapters
// (Omise, K SHOP/Kasikorn, ...) register here in a future phase; this phase registers ONLY the
// deterministic mock so the full state-machine/allocation logic has a real interface to drive
// against with zero network calls and zero real credentials.
const { MockProviderAdapter } = require('./mock-adapter');

const registry = {
  MOCK: new MockProviderAdapter(),
};

function getAdapter(provider) {
  const adapter = registry[provider];
  if (!adapter) {
    const e = new Error('PROVIDER_NOT_REGISTERED: ' + provider);
    e.statusCode = 400;
    throw e;
  }
  return adapter;
}

module.exports = { getAdapter, registry };
