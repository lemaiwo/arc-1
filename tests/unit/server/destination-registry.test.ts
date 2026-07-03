import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildDestinationConfig,
  DestinationRegistry,
  destinationCacheFile,
  destinationEnvSuffix,
  parseDestinationEnvOverrides,
  parseDestinationPolicyProperties,
  parseDestinationsList,
} from '../../../src/server/destination-registry.js';
import { DEFAULT_CONFIG } from '../../../src/server/types.js';

const lookupDestination = vi.fn();
const createConnectivityProxy = vi.fn();
vi.mock('@arc-mcp/xsuaa-auth/btp', () => ({
  lookupDestination: (...args: unknown[]) => lookupDestination(...args),
  createConnectivityProxy: (...args: unknown[]) => createConnectivityProxy(...args),
}));

const BTP_CONFIG = {
  destinationUrl: 'https://destination.example',
  destinationClientId: 'client',
  destinationSecret: 'secret',
  xsuaaUrl: 'https://uaa.example',
} as never;

describe('parseDestinationsList', () => {
  it('parses a CSV list with trimming', () => {
    expect(parseDestinationsList(' S4D, S4Q ,S4P ')).toEqual(['S4D', 'S4Q', 'S4P']);
  });

  it('returns undefined for unset or empty input', () => {
    expect(parseDestinationsList(undefined)).toBeUndefined();
    expect(parseDestinationsList('')).toBeUndefined();
    expect(parseDestinationsList(' , ')).toBeUndefined();
  });

  it('rejects invalid destination names (URL/path safety)', () => {
    expect(() => parseDestinationsList('S4D,../etc')).toThrow(/Invalid destination name/);
    expect(() => parseDestinationsList('S4 D')).toThrow(/Invalid destination name/);
  });

  it('rejects duplicates', () => {
    expect(() => parseDestinationsList('S4D,S4Q,S4D')).toThrow(/Duplicate destination name 'S4D'/);
  });
});

describe('parseDestinationPolicyProperties', () => {
  it('parses boolean, list, deny-action and pp properties', () => {
    const policy = parseDestinationPolicyProperties({
      Name: 'S4D',
      URL: 'https://s4d.example',
      'arc1.allow_writes': 'true',
      'arc1.allow_data_preview': 'FALSE',
      'arc1.allowed_packages': 'ZTEAM*, ZCOMMON',
      'arc1.deny_actions': 'SAPWrite.delete',
      'arc1.pp_destination': 'S4D_PP',
    });
    expect(policy.safety).toEqual({
      allowWrites: true,
      allowDataPreview: false,
      allowedPackages: ['ZTEAM*', 'ZCOMMON'],
      denyActions: ['SAPWrite.delete'],
    });
    expect(policy.ppDestination).toBe('S4D_PP');
  });

  it('ignores non-arc1 destination properties', () => {
    const policy = parseDestinationPolicyProperties({ URL: 'x', 'sap-client': '200', WebIDEEnabled: 'true' });
    expect(policy.safety).toEqual({});
    expect(policy.ppDestination).toBeUndefined();
  });

  it('fails closed on unknown arc1.* keys (typos)', () => {
    expect(() => parseDestinationPolicyProperties({ 'arc1.alow_writes': 'true' })).toThrow(
      /Unknown 'arc1.alow_writes' destination property/,
    );
  });

  it('rejects non-boolean values for boolean properties', () => {
    expect(() => parseDestinationPolicyProperties({ 'arc1.allow_writes': 'X' })).toThrow(/must be 'true' or 'false'/);
  });
});

describe('parseDestinationEnvOverrides / destinationEnvSuffix', () => {
  it('folds hyphens to underscores and uppercases', () => {
    expect(destinationEnvSuffix('s4-dev')).toBe('S4_DEV');
  });

  it('reads only suffixed vars for the destination', () => {
    const env = {
      SAP_ALLOW_WRITES: 'true', // global baseline — NOT an override
      SAP_ALLOW_WRITES_S4P: 'false',
      SAP_ALLOWED_PACKAGES_S4P: 'ZPROD*',
      SAP_DENY_ACTIONS_S4P: 'SAPQuery',
      SAP_ALLOW_WRITES_S4D: 'true',
    };
    expect(parseDestinationEnvOverrides(env, 'S4P')).toEqual({
      allowWrites: false,
      allowedPackages: ['ZPROD*'],
      denyActions: ['SAPQuery'],
    });
    expect(parseDestinationEnvOverrides(env, 'S4Q')).toEqual({});
  });
});

describe('destinationCacheFile', () => {
  it('inserts the destination before the extension', () => {
    expect(destinationCacheFile('.arc1-cache.db', 'S4D')).toBe('.arc1-cache-S4D.db');
    expect(destinationCacheFile('/data/cache.db', 'S4D')).toBe('/data/cache-S4D.db');
  });

  it('appends when there is no extension', () => {
    expect(destinationCacheFile('/data/.cache', 'S4D')).toBe('/data/.cache-S4D');
  });
});

describe('buildDestinationConfig', () => {
  const base = {
    ...DEFAULT_CONFIG,
    allowWrites: true,
    allowDataPreview: true,
    allowedPackages: ['Z*'],
    client: '100',
  };
  const dest = { URL: 'https://s4d.example', User: 'TECH_USER', Password: 'secret', 'sap-client': '200' };

  it('takes connection fields from the destination', () => {
    const cfg = buildDestinationConfig(base, 'S4D', dest, {}, {});
    expect(cfg.url).toBe('https://s4d.example');
    expect(cfg.username).toBe('TECH_USER');
    expect(cfg.password).toBe('secret');
    expect(cfg.client).toBe('200');
    expect(cfg.destinationName).toBe('S4D');
    expect(cfg.cacheFile).toBe('.arc1-cache-S4D.db');
  });

  it('keeps the mta.yaml baseline when no arc1.* properties are set (back-compat §6.5)', () => {
    const cfg = buildDestinationConfig(base, 'S4D', dest, {}, {});
    expect(cfg.allowWrites).toBe(true);
    expect(cfg.allowDataPreview).toBe(true);
    expect(cfg.allowedPackages).toEqual(['Z*']);
  });

  it('narrows but never grants beyond the baseline', () => {
    const readOnlyBase = { ...base, allowWrites: false };
    // arc1.allow_writes=true cannot enable writes when the deployed baseline denies them
    const cfg = buildDestinationConfig(readOnlyBase, 'S4D', dest, { 'arc1.allow_writes': 'true' }, {});
    expect(cfg.allowWrites).toBe(false);
    // ...but it can restrict an allowing baseline
    const cfg2 = buildDestinationConfig(base, 'S4P', dest, { 'arc1.allow_writes': 'false' }, {});
    expect(cfg2.allowWrites).toBe(false);
  });

  it('intersects package allowlists (disjoint → deny all)', () => {
    const cfg = buildDestinationConfig(base, 'S4D', dest, { 'arc1.allowed_packages': 'ZTEAM*' }, {});
    expect(cfg.allowedPackages).toEqual(['ZTEAM*']);
    const disjoint = buildDestinationConfig(base, 'S4D', dest, { 'arc1.allowed_packages': 'YOTHER*' }, {});
    // Disjoint lists deny everything — the sentinel matches no real package name.
    expect(disjoint.allowedPackages).toEqual(['__ARC1_DENY_ALL__']);
  });

  it('env pins intersect after destination properties (deploy-time pin wins)', () => {
    const cfg = buildDestinationConfig(
      base,
      'S4P',
      dest,
      { 'arc1.allow_writes': 'true' },
      { SAP_ALLOW_WRITES_S4P: 'false' },
    );
    expect(cfg.allowWrites).toBe(false);
  });

  it('maps arc1.pp_destination to ppDestinationName', () => {
    const cfg = buildDestinationConfig(base, 'S4D', dest, { 'arc1.pp_destination': 'S4D_PP' }, {});
    expect(cfg.ppDestinationName).toBe('S4D_PP');
  });

  it('rejects an invalid sap-client on the destination', () => {
    expect(() => buildDestinationConfig(base, 'S4D', { ...dest, 'sap-client': '20' }, {}, {})).toThrow(
      /invalid sap-client '20'/,
    );
  });

  it('unions deny actions from baseline and destination', () => {
    const denyBase = { ...base, denyActions: ['SAPManage.flp_*'] };
    const cfg = buildDestinationConfig(denyBase, 'S4D', dest, { 'arc1.deny_actions': 'SAPWrite.delete' }, {});
    expect(cfg.denyActions).toEqual(['SAPManage.flp_*', 'SAPWrite.delete']);
  });
});

describe('DestinationRegistry', () => {
  const runtimeDeps = {
    createCachingLayer: vi.fn(async () => undefined),
    runStartupAuthPreflight: vi.fn(async () => ({ blocking: false }) as never),
    runStartupProbe: vi.fn(async () => {}),
    onProbeBlocked: vi.fn(),
  };

  function makeRegistry(names = ['S4D', 'S4P']) {
    return new DestinationRegistry({
      baseConfig: { ...DEFAULT_CONFIG, allowWrites: true },
      btpConfig: BTP_CONFIG,
      names,
      ...runtimeDeps,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    lookupDestination.mockResolvedValue({
      Name: 'S4D',
      URL: 'https://s4d.example',
      Authentication: 'BasicAuthentication',
      ProxyType: 'Internet',
      User: 'TECH',
      Password: 'pw',
    });
  });

  it('returns undefined for names not on the allowlist', async () => {
    const registry = makeRegistry();
    expect(await registry.getRuntime('OTHER')).toBeUndefined();
    expect(lookupDestination).not.toHaveBeenCalled();
  });

  it('memoizes initialization — concurrent requests share one lookup', async () => {
    const registry = makeRegistry();
    const [a, b] = await Promise.all([registry.getRuntime('S4D'), registry.getRuntime('S4D')]);
    expect(a).toBe(b);
    expect(lookupDestination).toHaveBeenCalledTimes(1);
    expect(a?.config.url).toBe('https://s4d.example');
    expect(a?.config.destinationName).toBe('S4D');
  });

  it('does not memoize failures — the next request retries', async () => {
    const registry = makeRegistry();
    lookupDestination.mockRejectedValueOnce(new Error('Destination Service returned HTTP 404'));
    await expect(registry.getRuntime('S4D')).rejects.toThrow(/404/);
    const runtime = await registry.getRuntime('S4D');
    expect(runtime?.config.url).toBe('https://s4d.example');
    expect(lookupDestination).toHaveBeenCalledTimes(2);
  });

  it('creates a Cloud Connector proxy for OnPremise destinations with the location ID', async () => {
    lookupDestination.mockResolvedValue({
      Name: 'S4P',
      URL: 'http://internal.host',
      Authentication: 'BasicAuthentication',
      ProxyType: 'OnPremise',
      CloudConnectorLocationId: 'SCC_EU',
      User: 'TECH',
      Password: 'pw',
    });
    const proxy = { host: 'proxy.example', port: 20003 };
    createConnectivityProxy.mockReturnValue(proxy);
    const registry = makeRegistry();
    const runtime = await registry.getRuntime('S4P');
    expect(createConnectivityProxy).toHaveBeenCalledWith(BTP_CONFIG, 'SCC_EU');
    expect(runtime?.btpProxy).toBe(proxy);
  });

  it('skips the feature probe when the auth preflight blocks', async () => {
    runtimeDeps.runStartupAuthPreflight.mockResolvedValueOnce({ blocking: true } as never);
    const registry = makeRegistry();
    const runtime = await registry.getRuntime('S4D');
    await runtime?.startupProbePromise;
    expect(runtimeDeps.onProbeBlocked).toHaveBeenCalledWith('S4D');
    expect(runtimeDeps.runStartupProbe).not.toHaveBeenCalled();
  });

  it('tracks resolved runtimes for shutdown cleanup', async () => {
    const registry = makeRegistry();
    expect(registry.resolvedRuntimes()).toEqual([]);
    await registry.getRuntime('S4D');
    expect(registry.resolvedRuntimes()).toHaveLength(1);
  });
});
