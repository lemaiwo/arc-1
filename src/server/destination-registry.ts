/**
 * Multi-destination mode (SAP_BTP_DESTINATIONS): one ARC-1 instance, one MCP
 * endpoint per BTP destination (`/mcp/<name>`).
 *
 * The registry lazily initializes a per-destination runtime on first request:
 * it resolves the destination via the BTP Destination Service, applies the
 * per-system guardrail policy, and owns per-destination state (config clone,
 * Cloud Connector proxy, object cache, auth preflight + feature probe).
 *
 * Guardrail semantics (docs/multi-destination-evaluation.md §6.4):
 *
 *   baseline   = global SAP_ALLOW_* / SAP_ALLOWED_PACKAGES / SAP_DENY_ACTIONS
 *   per-system = baseline ∩ arc1.* destination properties ∩ SAP_*_<DEST> env vars
 *
 * Narrowing only — a destination property or per-destination env var can
 * RESTRICT the deployed baseline but never grant beyond it. A destination with
 * no `arc1.*` properties runs with the baseline unchanged (back-compat, §6.5).
 * Intersection reuses `deriveUserSafetyFromProfile` — the exact semantics the
 * per-caller (API-key profile) narrowing already uses.
 */

import type { BTPConfig, BTPProxyConfig } from '@arc-mcp/xsuaa-auth/btp';
import { deriveUserSafetyFromProfile, type SafetyConfig } from '../adt/safety.js';
import type { CachingLayer } from '../cache/caching-layer.js';
import { parseDenyActions, validateDenyActions } from './deny-actions.js';
import { authLibLogger, logger } from './logger.js';
// Type-only import — erased at runtime, so no import cycle with server.ts.
import type { StartupAuthPreflightResult } from './server.js';
import type { ServerConfig } from './types.js';

/** Destination names become URL path segments, cache-file suffixes, and env-var suffixes. */
export const DESTINATION_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Parse the SAP_BTP_DESTINATIONS CSV allowlist.
 * Returns undefined when unset/empty; throws on invalid or duplicate names.
 */
export function parseDestinationsList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  if (names.length === 0) return undefined;
  for (const name of names) {
    if (!DESTINATION_NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid destination name '${name}' in SAP_BTP_DESTINATIONS: names may only contain letters, digits, '_' and '-' ` +
          '(they are used as URL path segments and cache-file suffixes).',
      );
    }
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`Duplicate destination name '${name}' in SAP_BTP_DESTINATIONS.`);
    }
    seen.add(name);
  }
  return names;
}

/** Per-destination policy: a partial safety narrowing + non-safety extras. */
export interface DestinationPolicy {
  safety: Partial<SafetyConfig>;
  /** `arc1.pp_destination` — PP destination override for this system. */
  ppDestination?: string;
}

const ARC1_BOOL_PROPS: Record<string, keyof SafetyConfig> = {
  'arc1.allow_writes': 'allowWrites',
  'arc1.allow_data_preview': 'allowDataPreview',
  'arc1.allow_free_sql': 'allowFreeSQL',
  'arc1.allow_transport_writes': 'allowTransportWrites',
  'arc1.allow_git_writes': 'allowGitWrites',
};

const ARC1_LIST_PROPS: Record<string, 'allowedPackages' | 'allowedTransports'> = {
  'arc1.allowed_packages': 'allowedPackages',
  'arc1.allowed_transports': 'allowedTransports',
};

const ARC1_DENY_PROP = 'arc1.deny_actions';
const ARC1_PP_PROP = 'arc1.pp_destination';

function parseBoolProp(key: string, value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  throw new Error(`Destination property '${key}' must be 'true' or 'false', got '${value}'.`);
}

function parseCsvProp(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse `arc1.*` additional properties from a resolved destination into a policy.
 * Unknown `arc1.*` keys fail the destination (typo → fail closed, not silently ignored).
 */
export function parseDestinationPolicyProperties(props: Record<string, unknown>): DestinationPolicy {
  const safety: Partial<SafetyConfig> = {};
  let ppDestination: string | undefined;
  for (const [key, rawValue] of Object.entries(props)) {
    if (!key.startsWith('arc1.')) continue;
    const value = String(rawValue ?? '');
    if (key in ARC1_BOOL_PROPS) {
      safety[ARC1_BOOL_PROPS[key]] = parseBoolProp(key, value) as never;
    } else if (key in ARC1_LIST_PROPS) {
      safety[ARC1_LIST_PROPS[key]] = parseCsvProp(value);
    } else if (key === ARC1_DENY_PROP) {
      const patterns = parseDenyActions(value);
      validateDenyActions(patterns);
      safety.denyActions = patterns;
    } else if (key === ARC1_PP_PROP) {
      const name = value.trim();
      if (!DESTINATION_NAME_PATTERN.test(name)) {
        throw new Error(`Destination property '${ARC1_PP_PROP}' has an invalid destination name '${value}'.`);
      }
      ppDestination = name;
    } else {
      throw new Error(
        `Unknown '${key}' destination property. Known arc1.* properties: ` +
          `${[...Object.keys(ARC1_BOOL_PROPS), ...Object.keys(ARC1_LIST_PROPS), ARC1_DENY_PROP, ARC1_PP_PROP].join(', ')}.`,
      );
    }
  }
  return { safety, ppDestination };
}

/** Env-var suffix for a destination name: uppercased, '-' folded to '_'. */
export function destinationEnvSuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

const ENV_BOOL_OVERRIDES: Record<string, keyof SafetyConfig> = {
  SAP_ALLOW_WRITES: 'allowWrites',
  SAP_ALLOW_DATA_PREVIEW: 'allowDataPreview',
  SAP_ALLOW_FREE_SQL: 'allowFreeSQL',
  SAP_ALLOW_TRANSPORT_WRITES: 'allowTransportWrites',
  SAP_ALLOW_GIT_WRITES: 'allowGitWrites',
};

const ENV_LIST_OVERRIDES: Record<string, 'allowedPackages' | 'allowedTransports'> = {
  SAP_ALLOWED_PACKAGES: 'allowedPackages',
  SAP_ALLOWED_TRANSPORTS: 'allowedTransports',
};

/**
 * Parse deploy-time per-destination env overrides (`SAP_ALLOW_WRITES_<DEST>`, …).
 * Same narrowing-only semantics as `arc1.*` properties; env wins the intersection,
 * so a deploy-time pin can never be undone from the cockpit.
 */
export function parseDestinationEnvOverrides(env: NodeJS.ProcessEnv, name: string): Partial<SafetyConfig> {
  const suffix = `_${destinationEnvSuffix(name)}`;
  const safety: Partial<SafetyConfig> = {};
  for (const [prefix, field] of Object.entries(ENV_BOOL_OVERRIDES)) {
    const raw = env[`${prefix}${suffix}`];
    if (raw !== undefined) {
      safety[field] = parseBoolProp(`${prefix}${suffix}`, raw) as never;
    }
  }
  for (const [prefix, field] of Object.entries(ENV_LIST_OVERRIDES)) {
    const raw = env[`${prefix}${suffix}`];
    if (raw !== undefined) {
      safety[field] = parseCsvProp(raw);
    }
  }
  const denyRaw = env[`SAP_DENY_ACTIONS${suffix}`];
  if (denyRaw !== undefined) {
    const patterns = parseDenyActions(denyRaw);
    validateDenyActions(patterns);
    safety.denyActions = patterns;
  }
  return safety;
}

/** Insert the destination suffix before the cache file extension: `.arc1-cache.db` → `.arc1-cache-S4D.db`. */
export function destinationCacheFile(baseFile: string, name: string): string {
  const dot = baseFile.lastIndexOf('.');
  // Treat a leading dot (hidden file, no extension) as no extension.
  if (dot > 0 && baseFile[dot - 1] !== '/') {
    return `${baseFile.slice(0, dot)}-${name}${baseFile.slice(dot)}`;
  }
  return `${baseFile}-${name}`;
}

function safetyBaseline(config: ServerConfig): SafetyConfig {
  return {
    allowWrites: config.allowWrites,
    allowDataPreview: config.allowDataPreview,
    allowFreeSQL: config.allowFreeSQL,
    allowTransportWrites: config.allowTransportWrites,
    allowGitWrites: config.allowGitWrites,
    allowedPackages: [...config.allowedPackages],
    allowedTransports: [...config.allowedTransports],
    denyActions: [...config.denyActions],
  };
}

/**
 * Build the per-destination ServerConfig: base config + destination connection
 * + narrowed guardrails. Exported for unit testing.
 */
export function buildDestinationConfig(
  baseConfig: ServerConfig,
  name: string,
  destination: {
    URL: string;
    User?: string;
    Password?: string;
    'sap-client'?: string;
  },
  properties: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const policy = parseDestinationPolicyProperties(properties);
  const envOverrides = parseDestinationEnvOverrides(env, name);

  const sapClient = destination['sap-client'] ?? baseConfig.client;
  if (sapClient && !/^\d{3}$/.test(sapClient)) {
    throw new Error(
      `Destination '${name}' has invalid sap-client '${sapClient}': must be a 3-digit SAP client (000-999).`,
    );
  }

  // baseline ∩ arc1.* properties ∩ per-destination env pins — narrowing only.
  const narrowed = deriveUserSafetyFromProfile(
    deriveUserSafetyFromProfile(safetyBaseline(baseConfig), policy.safety),
    envOverrides,
  );

  return {
    ...baseConfig,
    url: destination.URL,
    username: destination.User ?? '',
    password: destination.Password ?? '',
    client: sapClient,
    destinationName: name,
    ppDestinationName: policy.ppDestination,
    cacheFile: destinationCacheFile(baseConfig.cacheFile, name),
    ...narrowed,
  };
}

/** Per-destination runtime state, initialized lazily on first request. */
export interface DestinationRuntime {
  name: string;
  config: ServerConfig;
  btpProxy?: BTPProxyConfig;
  cachingLayer?: CachingLayer;
  startupAuthPreflightPromise: Promise<StartupAuthPreflightResult>;
  startupProbePromise: Promise<void>;
}

export interface DestinationRegistryOptions {
  baseConfig: ServerConfig;
  btpConfig: BTPConfig;
  /** Allowlist from SAP_BTP_DESTINATIONS — only these names resolve. */
  names: string[];
  /** Injected from server.ts to avoid an import cycle. */
  createCachingLayer: (config: ServerConfig) => Promise<CachingLayer | undefined>;
  runStartupAuthPreflight: (config: ServerConfig, btpProxy?: BTPProxyConfig) => Promise<StartupAuthPreflightResult>;
  runStartupProbe: (config: ServerConfig, btpProxy?: BTPProxyConfig) => Promise<void>;
  /** Called when the auth preflight blocks — clears the feature cache for the destination. */
  onProbeBlocked: (name: string) => void;
}

/**
 * Lazily-initialized map of destination name → runtime.
 *
 * Initialization is memoized per name so concurrent first requests share one
 * resolution. A FAILED initialization is NOT memoized — the next request
 * retries, so a transient Destination Service error or a fixed-up destination
 * doesn't require a restart.
 */
export class DestinationRegistry {
  private readonly runtimes = new Map<string, Promise<DestinationRuntime>>();
  private readonly resolved: DestinationRuntime[] = [];

  constructor(private readonly opts: DestinationRegistryOptions) {}

  /** Runtimes that finished initializing (sync — for shutdown cache cleanup). */
  resolvedRuntimes(): DestinationRuntime[] {
    return [...this.resolved];
  }

  /** True when `name` is on the SAP_BTP_DESTINATIONS allowlist. */
  has(name: string): boolean {
    return this.opts.names.includes(name);
  }

  get names(): string[] {
    return [...this.opts.names];
  }

  /**
   * Get (or lazily initialize) the runtime for an allowlisted destination.
   * Returns undefined for names not on the allowlist. Throws when
   * initialization fails (destination unresolvable, invalid policy, …).
   */
  async getRuntime(name: string): Promise<DestinationRuntime | undefined> {
    if (!this.has(name)) return undefined;
    let promise = this.runtimes.get(name);
    if (!promise) {
      promise = this.initRuntime(name);
      this.runtimes.set(name, promise);
      promise.catch(() => {
        // Don't memoize failures — let the next request retry.
        if (this.runtimes.get(name) === promise) {
          this.runtimes.delete(name);
        }
      });
    }
    return promise;
  }

  private async initRuntime(name: string): Promise<DestinationRuntime> {
    const { lookupDestination, createConnectivityProxy } = await import('@arc-mcp/xsuaa-auth/btp');

    const destination = await lookupDestination(this.opts.btpConfig, name, authLibLogger);
    const properties = destination as unknown as Record<string, unknown>;

    const config = buildDestinationConfig(this.opts.baseConfig, name, destination, properties);

    let btpProxy: BTPProxyConfig | undefined;
    if (destination.ProxyType === 'OnPremise') {
      btpProxy = createConnectivityProxy(this.opts.btpConfig, destination.CloudConnectorLocationId) ?? undefined;
    }

    const cachingLayer = await this.opts.createCachingLayer(config);

    // Same startup sequencing as single-destination mode: preflight first; a
    // blocking auth failure skips the feature probe (avoids a burst of failing
    // requests with bad credentials).
    const startupAuthPreflightPromise = this.opts.runStartupAuthPreflight(config, btpProxy);
    const startupProbePromise = (async () => {
      const preflight = await startupAuthPreflightPromise;
      if (preflight.blocking) {
        this.opts.onProbeBlocked(name);
        return;
      }
      await this.opts.runStartupProbe(config, btpProxy);
    })();

    logger.info('Destination runtime initialized', {
      destination: name,
      proxyType: destination.ProxyType,
      hasProxy: !!btpProxy,
      client: config.client,
      allowWrites: config.allowWrites,
      allowDataPreview: config.allowDataPreview,
      allowFreeSQL: config.allowFreeSQL,
      allowTransportWrites: config.allowTransportWrites,
      allowGitWrites: config.allowGitWrites,
      allowedPackages: config.allowedPackages,
      allowedTransports: config.allowedTransports,
      denyActions: config.denyActions,
      ppDestination: config.ppDestinationName,
      cacheFile: config.cacheFile,
    });

    const runtime: DestinationRuntime = {
      name,
      config,
      btpProxy,
      cachingLayer,
      startupAuthPreflightPromise,
      startupProbePromise,
    };
    this.resolved.push(runtime);
    return runtime;
  }
}
