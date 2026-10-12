import { useConfigStore, CONFIG_STORE_KEY } from '../../src/canvas/stores/use-config-store';
import { requestGeneration } from '../../src/canvas/services/api/image';
import { secureChannel } from '../../src/canvas/services/secure-credentials';

export async function verifyCredentialBrowserFlow() {
  if (location.hostname !== '127.0.0.1' || location.port === '5174') throw Error('Isolated browser required');
  const fixture = await (await fetch('/__qa/seed')).json();
  const state = useConfigStore.getState();
  const channel = { ...state.config.channels[0], apiFormat: 'openai' as const, baseUrl: fixture.endpoint, apiKey: fixture.secret,
    models: [{ name: 'gpt-image-1', capability: 'image' as const }] };
  const config = { ...state.config, baseUrl: fixture.endpoint, apiKey: fixture.secret, apiFormat: 'openai' as const,
    channels: [channel], model: channel.id + '::gpt-image-1', imageModel: channel.id + '::gpt-image-1', count: '1' };
  useConfigStore.setState({ config });
  const source = localStorage.getItem(CONFIG_STORE_KEY)!;
  const response = await fetch('/local-app/credentials/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ configRecord: source }) });
  const prepared = await response.json();
  if (!response.ok || !prepared.prepared || JSON.stringify(prepared).includes(fixture.secret) || localStorage.getItem(CONFIG_STORE_KEY) !== source) throw Error('Prepare verification failed');
  const next = JSON.parse(source);
  for (const change of prepared.changes) {
    if (change.path[0] !== 'state' || change.path[1] !== 'config') throw Error('Unexpected test migration path');
    let target = next;
    for (const segment of change.path) target = target[segment];
    target.baseUrl = change.baseUrl; target.apiKey = change.credentialRef;
  }
  // QA only: no production caller or startup migration is registered.
  useConfigStore.setState({ config: next.state.config });
  if (localStorage.getItem(CONFIG_STORE_KEY)?.includes(fixture.secret)) throw Error('Browser persistence still contains raw key');
  const images = await requestGeneration(useConfigStore.getState().config, 'qa synthetic generation');
  if (images.length !== 1 || !images[0].dataUrl.startsWith('data:image/png;base64,')) throw Error('Image response failed');
  const status = await (await fetch('/__qa/result')).json();
  if (!status.credentialMatched || status.requests !== 1 || !status.encryptedRecoveryVerified) throw Error('Native backend proof incomplete');
  const secured = await secureChannel(channel);
  useConfigStore.setState({ config: { ...config, channels: [secured], baseUrl: secured.baseUrl, apiKey: secured.apiKey } });
  if (localStorage.getItem(CONFIG_STORE_KEY)?.includes(fixture.secret)) throw Error('New credential entry persisted plaintext');
  const newImages = await requestGeneration(useConfigStore.getState().config, 'qa secure new entry');
  if (newImages.length !== 1) throw Error('Secure new entry request failed');
  const after = await (await fetch('/__qa/result')).json();
  if (!after.credentialMatched || after.requests !== 2) throw Error('New entry native proof incomplete');
  return { ok: true, actualZustandPersistence: true, nativeKeychain: true, browserStoredReferenceOnly: true,
    actualImageApiClient: true, backendCredentialMatched: true, imageReturned: true, encryptedRecoveryVerified: true,
    userDataTouched: false, paidApiRequests: 0, productionMigrationEnabled: false };
}
