# Parachute Cloud

The managed cloud offering from **Open Parachute PBC**. Pay us, get a working Parachute stack — your own URL at `<you>.parachute.computer`, your hub running, your vault waiting, your transcription pipeline attached. Sixty seconds from sign-up to writing.

> **Status:** Phase 0 scaffold. Nothing is deployed yet. The product surface lives at [`parachute.computer/cloud`](https://parachute.computer/cloud) (when it exists); this repo is the control plane that provisions and bills.

## What you get

A dedicated VM with the full Tier 1 Parachute stack pre-installed:

- **`parachute-hub`** — your portal, your OAuth issuer, your service catalog at `<you>.parachute.computer`.
- **`parachute-vault`** — your knowledge vault. Notes, tags, wikilinks, MCP tools. Same engine as self-hosted.
- **`parachute-scribe`** — voice transcription. Same engine as self-hosted.
- **`parachute-notes`** — the PWA. Capture from your phone, keep working offline.

Same code as the open-source self-hosted distribution. We just operate it for you.

## Who it's for

People who want Parachute working without having to install Bun, run a daemon, manage a Tailscale tunnel, or babysit a VPS. You sign up, you pay, you write. We run the machine.

If you'd rather run it yourself: [`parachute-hub`](https://github.com/ParachuteComputer/parachute-hub) is the right starting point — same code, free forever, AGPL-3.0.

## Pricing (working draft)

Pricing not finalized. Working sketch from the cloud-shape design doc:

| Tier | Price | What you get |
|---|---|---|
| **Starter** | ~$15/mo | Tier 1 stack, scribe metered |
| **Pro** | ~$30/mo | Larger scribe quota, custom domain |

Final numbers land before public launch.

## What's not in the cloud (Tier 2)

`paraclaw` — the Parachute distribution of Claude Code with vault integration — runs on **your own dev machine** and federates back to your cloud hub for identity and memory. It's the "agent layer," distinct from the "personal-knowledge layer" that runs in the cloud. See the [`paraclaw`](https://github.com/ParachuteComputer/paraclaw) repo when it's public.

## How it works (for the curious)

The control plane in this repo provisions a Fly Machine per tenant, runs a first-boot bootstrap that installs the configured modules onto a bind-mounted persistent volume, points DNS at the machine, and hands you a URL. Stripe handles billing; Anthropic OAuth (or email/password / Google / GitHub) handles signup.

The provider underneath is an implementation detail. You see "Parachute Computer." We see Fly today, possibly something else tomorrow. Migrations between providers are our job, not yours.

Architectural rationale lives in `parachute-vault/docs/design/2026-04-29-parachute-cloud-shape.md`.

## License

AGPL-3.0.
