# Parachute Cloud

`@openparachute/cloud` — the control plane for **Open Parachute PBC's** managed cloud offering. Pay Parachute, get a working stack: a Fly Machine running `parachute-hub` with Tier 1 spokes (`vault`, `scribe`, `notes`) pre-installed on a bind-mounted volume, reachable at `<you>.parachute.computer`.

This repo is **provisioning + billing + per-VM lifecycle**. It is *not* a vault, not a hub, not a runtime. The hub running on each user's machine handles user auth, vault management, and everything user-data-shaped. The control plane never sees user notes.

User-facing README is the right intro for prospective customers. This file is for agents and humans working *on* the control plane itself.

## Mental model

> **One Fly Machine per user. Hub running on the machine. Vault/scribe/notes as installed modules on a bind-mounted volume. Scale-to-zero default. ~$5/mo target unit cost.**

The cloud product is the managed *operator* of the existing self-hosted stack — same `parachute-hub`, same `parachute-vault`, same `parachute-scribe`, same `parachute-notes`. We don't fork them, we don't reimplement them. We provision the VM, bake the image, run the bootstrap, hand back a URL, and bill for it.

paraclaw is **Tier 2** — separate machine, opt-in, runs on the user's own dev box federated to their cloud hub. Out of scope for Phases 0–3.

## Architecture sketch

```
       parachute.computer/cloud           Stripe                 Anthropic OAuth
              │                              │                          │
              ▼                              ▼                          ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │  parachute-cloud (control plane, this repo)                           │
   │  - signup webhook → provision VM                                      │
   │  - Stripe checkout / portal / webhook → tier enforcement              │
   │  - operator dashboard (per-VM status, billing portal link)            │
   │  - admin CLI (provision / destroy / list)                             │
   │  - never sees user data; only metadata (tenant id, VM handle, plan)   │
   └─────────────────────────┬─────────────────────────────────────────────┘
                             │ provider API
                             ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │  Fly Machine (one per user — `<you>.parachute.computer`)            │
   │  ┌────────────────────────────────────────────────────────────────┐ │
   │  │  /data (bind-mounted volume, persistent across restarts)        │ │
   │  │    ~/.parachute/                                                │ │
   │  │    ├── hub/         parachute-hub state, OAuth keys             │ │
   │  │    ├── vault/       SQLite DBs + attachments                    │ │
   │  │    ├── scribe/      audio cache, transcription state            │ │
   │  │    └── notes/       PWA static bundle                           │ │
   │  └────────────────────────────────────────────────────────────────┘ │
   │  parachute-hub (long-running daemon, 1939) — owns auth + portal     │
   │  parachute-vault (1940) — data plane                                │
   │  parachute-scribe (1942) — transcription                            │
   │  parachute-notes — static PWA served by hub                         │
   └─────────────────────────────────────────────────────────────────────┘
```

The signup → working URL flow (Phase 2-(a) — Stripe Checkout in front of provision):

1. User signs up at `parachute.computer/cloud` (separate repo: `parachute.computer` site). Site POSTs `{email, tier?}` to control-plane `POST /api/signup`.
2. `signup/handler.ts` inserts an `accounts` row as `pending_provision` and mints a Stripe Checkout session via `billing/checkout.ts`. `client_reference_id = tenantId` carries the row across the Stripe round-trip; `subscription_data.metadata.tenant_id` carries it onto the subscription for future lifecycle webhooks. Response is `{tenantId, checkoutUrl, checkoutSessionId}`. **Signup never touches Fly.**
3. The user pays in the hosted Checkout. Stripe sends `checkout.session.completed` to `POST /api/billing/webhook` (signature-verified against the raw body via `webhooks.constructEventAsync` + subtle-crypto).
4. `billing/webhook.ts` looks up the row by `client_reference_id`, persists `stripe_customer_id` + `stripe_subscription_id`, then calls `orchestrateProvision` — which talks to the provider abstraction to provision a Fly Machine on the pre-baked Parachute image.
5. First boot runs `bootstrap.ts` — installs the configured modules onto `/data`, drops a marker, hub comes up, calls `POST /api/internal/provision-complete` with the per-tenant secret embedded at machine-create time.
6. DNS is updated: `<chosen-subdomain>.parachute.computer` → Fly machine.
7. User receives an email with their URL + first-boot setup link.

Phase 3 expands `billing/webhook.ts` to also handle subscription-lifecycle events (renewal, payment_failed, customer.subscription.deleted, dunning) by switching on `event.type`. The Phase-2 webhook ignores those (acks 200) so Stripe stops retrying them while we're not listening.

## Tier 1 vs Tier 2

| Tier | Modules | Where it runs | In scope for cloud Phase 0–3? |
|---|---|---|---|
| **Tier 1** | `vault`, `scribe`, `notes` | One Fly Machine per user, hub on the same machine | Yes — this is the cloud product |
| **Tier 2** | `paraclaw` | User's own dev machine, federated to their cloud hub | No — separate motion later |

Tier 1 is the personal-knowledge layer; it lives entirely on Parachute infra. Tier 2 is the agent layer; the user runs it where they code, and it federates back to their cloud hub for identity + memory.

## Critical rule: do not duplicate vault/hub logic here

The hub is in [`parachute-hub`](../parachute-hub). The vault engine is in [`parachute-vault`](../parachute-vault). The transcription pipeline is in [`parachute-scribe`](../parachute-scribe). The PWA is in [`parachute-notes`](../parachute-notes).

This repo:

- **Provisions** VMs via a provider abstraction (Fly first, others later).
- **Bills** users via Stripe.
- **Tracks** per-tenant state (which VM, which plan, which subdomain).
- **Operates** the fleet (admin CLI, operator dashboard, migrations between providers).

This repo does **not**:

- Implement OAuth, JWKS, or vault auth — `parachute-hub` does that on each user's machine.
- Read or write user notes — vault + scribe handle their own data on the user's volume.
- Embed any vault schema, MCP tool, or wikilink logic.
- Run a multi-tenant runtime — every tenant gets their own VM.

Drift between this control plane and the hub is how the cloud product becomes a fork instead of an operator. Resist it. If a feature feels like it belongs on the hub, PR it upstream.

## Billing posture (sketch)

Stripe everything. Subscription = Tier 1 VM. Webhook updates per-tenant state. Tier enforcement is policy, not runtime — if a user downgrades, the control plane resizes / suspends / migrates the VM; the hub on the machine has no idea about pricing tiers and doesn't need to.

No Clerk. Identity lives in the user's own hub-as-OAuth-issuer; the hub is the IDP for everything inside the user's machine. The signup surface (`parachute.computer/cloud`) federates to Anthropic/Google/email for *Parachute Computer account creation*, then the provisioned hub takes over identity for the user's data plane. See cloud-shape doc §8.3 for the Anthropic-OAuth flagship.

## Provider abstraction

`src/provider/provider-client.ts` defines the `ProviderClient` interface (lifted in Phase 1 from `parachute-hub/src/deploy/provider-client.ts`):

```ts
interface ProviderClient {
  validateToken(): Promise<void>;
  provisionMachine(opts: ProvisionOpts): Promise<ProvisionResult>;
  destroyMachine(handle: MachineHandle): Promise<void>;
  listMachines(appName: string): Promise<MachineSummary[]>;
  tailLogs(handle: MachineHandle): AsyncIterable<LogLine>;
  sshExec(handle: MachineHandle, cmd: string[]): Promise<SshResult>;
}
```

(`ProvisionResult` includes `flyAppName`, `instanceId`, and the volume id; the control plane persists `flyAppName` + `flyMachineId` on the accounts row.)

Implementations:

- `FlyClient` — Phase 1, lifted from `parachute-hub/src/deploy/fly-client.ts`. Talks the Fly Machines API.
- `RenderClient` — Phase 4+, stubbed for now.

Per cloud-shape doc §8.5: provider is an **implementation detail**. Users never see "Fly" in any UI. If we move to Render or Hetzner, the user's URL and bill are unchanged.

## File layout (post-scaffold)

```
src/
├── provider/
│   ├── provider-client.ts    interface + types (lifted in Phase 1)
│   ├── fly-client.ts         Fly Machines API impl (lifted in Phase 1)
│   └── render-client.ts      stub for later
├── billing/
│   ├── stripe-client.ts      Workers-compat factory (fetch http + subtle-crypto)
│   ├── checkout.ts           Stripe Checkout session creation (called from signup)
│   ├── webhook.ts            POST /api/billing/webhook (sig-verify + checkout.session.completed → orchestrate)
│   └── tiers.ts              tier definitions + lifecycle policy (Phase 3)
├── signup/
│   ├── handler.ts            POST /api/signup (validate + insert row + mint checkout)
│   ├── orchestrate.ts        called from billing/webhook.ts: provision + bootstrap-env wiring
│   └── provision-complete.ts POST /api/internal/provision-complete (VM callback)
├── dashboard/
│   └── index.ts              operator dashboard (per-VM status)
├── cli/
│   └── admin.ts              admin CLI (provision / destroy / list)
└── bootstrap.ts              first-boot script (lifted in Phase 1)
```

Skeleton stubs land in this Phase 0 PR. Concrete implementations land in Phases 1–3.

## Phasing (planned)

- **Phase 0** — wipe + scaffold (this PR). No runtime.
- **Phase 1** — lift `FlyClient` + `bootstrap.ts` from `parachute-hub`. Concrete provisioner.
- **Phase 2** — signup flow + Fly provision orchestration end-to-end.
- **Phase 3** — Stripe billing + tier enforcement.
- **Phase 4** — web sign-up surface at `parachute.computer/cloud` (separate repo).

## Hybrid runtime

Two runtimes, deliberately:

- **Cloudflare Worker (control plane)** — the HTTP surface (`src/server.ts` and friends) runs on Workers. Hono for routing, D1 for tenant state, Drizzle for the schema. `wrangler dev` locally, `wrangler deploy` to ship. This is what answers `POST /api/signup`, the Stripe webhook, the `provision-complete` callback from the VM, and the operator dashboard.
- **Bun on the Fly Machine (per-tenant runtime)** — `src/bootstrap.ts` is the first-boot script that lands inside the deploy image and runs on Bun on the user's VM. It uses `node:fs` / `node:os` and never gets imported by the Worker. Tests for it run in `bun test` on a dev machine.

Don't mix them: Worker code can't import bootstrap, bootstrap can't import Worker handlers. Per-tenant state lives on the Fly volume; control-plane state lives in D1. The control plane never reads user data — only metadata (tenant id, VM handle, plan, lifecycle status).

## Reference: cloud-shape doc

The architectural rationale for this whole shape — why Fly over Workers, why hub-and-spokes, why VM-per-user, why Anthropic OAuth flagship — is in `parachute-vault/docs/design/2026-04-29-parachute-cloud-shape.md` (vault PR #199, branch `docs/cloud-shape-research`). Section 8 (V3) is the active deliverable; sections 1–7 are historical.

Read it before any architectural decision.

## Naming

- Domain: `parachute.computer`
- npm scope: `@openparachute/` (this package: `@openparachute/cloud`)
- Public surface: `parachute.computer/cloud` (signup) — lives in the `parachute.computer` site repo
- Per-tenant URL: `<you>.parachute.computer`
- Control-plane host: TBD (likely `cloud.parachute.computer` or `admin.parachute.computer`)

## License

AGPL-3.0.
