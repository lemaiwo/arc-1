# Multi-Destination Mode (SAP_BTP_DESTINATIONS)

One ARC-1 instance serving **several SAP systems**, one MCP endpoint per BTP destination:

```
                                   ARC-1  (one BTP app)
  MCP client ────────────────────►   │  /mcp/S4D  ─► destination S4D  ─► SAP DEV
  (VS Code / Claude / Cursor)        │  /mcp/S4Q  ─► destination S4Q  ─► SAP QA
                                     │  /mcp/S4P  ─► destination S4P  ─► SAP PROD
                                     │  /mcp      ─► default destination (back-compat)
```

Each destination appears as its **own MCP server entry** in the client. There is no
`system` tool parameter — the endpoint *is* the system, so the LLM can never write to
prod because it guessed the wrong system ID. Each system gets its own guardrail
ceiling, feature probe, and object cache.

!!! tip "Multi-destination vs. the Multi-System Hub"
    [`arc-mcp-hub`](multi-system-hub.md) fronts **several ARC-1 instances** with one
    URL and one login, preserving per-user SAP identity per system. Multi-destination
    mode is the lighter alternative when a **single app** should serve several systems
    with a shared MCP auth layer: no hub deployment, no per-system apps, at the cost
    of coarser identity options. The two compose — a hub can front a multi-destination
    instance like any other Streamable-HTTP MCP server.

## Setup

Requirements: `SAP_TRANSPORT=http-streamable`, a **destination service** binding
(plus a **connectivity** instance for on-premise destinations) — the same
prerequisites as [single `SAP_BTP_DESTINATION` mode](btp-destination-setup.md).

```yaml
# mta.yaml / mtaext — module properties
SAP_BTP_DESTINATIONS: S4D,S4Q,S4P    # CSV allowlist; anything else → 404
# SAP_BTP_DESTINATION: S4Q           # optional: pick the default for bare /mcp
                                     # (must be in the list; default = first entry)
```

Endpoints:

| URL | Serves |
|-----|--------|
| `/mcp/S4D`, `/mcp/S4Q`, `/mcp/S4P` | The named destination |
| `/mcp` | The default destination (back-compat — existing clients keep working) |
| anything else under `/mcp/` | 404 with the configured names |

Destinations are resolved **lazily on first request** (the default destination is
resolved eagerly at startup so misconfiguration fails fast). A destination that fails
to resolve returns **502 with the reason** and is retried on the next request — fixing
the destination in the cockpit needs no restart.

## Per-system guardrails

The env-var guardrails in your `mta.yaml` stay the **baseline for every system** —
exactly what they mean today. Two narrowing layers can restrict (never widen) the
baseline per system:

```
baseline   = global SAP_ALLOW_* / SAP_ALLOWED_PACKAGES / SAP_DENY_ACTIONS   (mta.yaml)
per-system = baseline ∩ arc1.* destination properties ∩ SAP_*_<DEST> env pins
effective  = per-system ∩ caller scopes/API-key profile                     (unchanged)
```

**Cockpit — `arc1.*` additional properties on the destination** (no redeploy to change):

| Property | Meaning | Example |
|----------|---------|---------|
| `arc1.allow_writes` | writes on this system | `true` |
| `arc1.allow_data_preview` | table preview | `true` |
| `arc1.allow_free_sql` | free SQL | `false` |
| `arc1.allow_transport_writes` | CTS writes | `true` |
| `arc1.allow_git_writes` | abapGit/gCTS writes | `false` |
| `arc1.allowed_packages` | package allowlist (CSV) | `ZTEAM*,ZCOMMON` |
| `arc1.allowed_transports` | transport allowlist (CSV) | `S4DK9*` |
| `arc1.deny_actions` | per-action denials (CSV) | `SAPWrite.delete` |
| `arc1.pp_destination` | PP destination for this system | `S4D_PP` |

An unknown `arc1.*` property (typo) **fails the destination** instead of being
silently ignored. A destination with no `arc1.*` properties runs with the plain
baseline — existing destinations work unchanged.

**Deploy-time pins — suffixed env vars** (version-controlled, cockpit cannot undo them):

```yaml
SAP_ALLOW_WRITES: true               # baseline: writes may exist somewhere
SAP_ALLOW_WRITES_S4P: false          # pin: prod is read-only, whatever the cockpit says
SAP_ALLOWED_PACKAGES_S4D: "ZTEAM*"   # pin the dev package scope
```

Suffix = destination name uppercased, `-` → `_` (destination `s4-dev` →
`SAP_ALLOW_WRITES_S4_DEV`).

!!! warning "Fail direction"
    No narrowing means *inherit the baseline*. With `SAP_ALLOW_WRITES: true`, every
    listed system is writable until narrowed — pin production in the mtaext rather
    than relying on someone remembering a cockpit property.

## What is per-system vs shared

| Per destination | Shared (instance-wide) |
|-----------------|------------------------|
| Connection (URL, auth, `sap-client`, Cloud Connector location) | MCP auth (API keys, OIDC, XSUAA) |
| Guardrail ceiling (see above) | `ARC1_MAX_CONCURRENT` semaphore |
| Feature probe / system type / tool listing | Rate limits |
| ADT discovery map | Audit sinks (events carry a `destination` field) |
| Object cache (`.arc1-cache-<name>.db`) | Plugins, UI |
| Auth preflight | |

## Principal propagation

`SAP_PP_ENABLED=true` works per destination: the per-user lookup uses the
destination itself, or `arc1.pp_destination` when the PP destination is a separate
entry (the usual BasicAuth + PrincipalPropagation pair, see
[Principal Propagation Setup](principal-propagation-setup.md)). The global
`SAP_BTP_PP_DESTINATION` env var is deliberately **not** used in multi-destination
mode — it names a destination for one system and would leak across endpoints.

## Backwards compatibility

- **No `SAP_BTP_DESTINATIONS`** → nothing changes. Single-destination deployments
  (`SAP_BTP_DESTINATION`, `SAP_URL`, or a service key) behave exactly as before,
  with the endpoint at bare `/mcp`.
- **With `SAP_BTP_DESTINATIONS`** → bare `/mcp` serves the default destination, so
  clients configured before the migration keep working.
- `stdio` transport serves only the default destination (per-destination endpoints
  are an HTTP feature).
- Incompatible with `SAP_BTP_SERVICE_KEY` and cookie auth (both are single-system);
  startup fails fast with a clear error.
- `ARC1_CACHE_WARMUP` is not yet supported in multi-destination mode (skipped with
  a warning).
