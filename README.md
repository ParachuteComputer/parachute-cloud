# Parachute Cloud

Parachute is your own vault that any AI can read and write, and an app that shows you what is in it. **Parachute
Cloud runs it for you**: sign up with an email at [my.parachute.computer](https://my.parachute.computer/console), and
each of your vaults has its address for an AI, `https://my.parachute.computer/vault/<name>/mcp`. Using it and building
on it: [parachute.computer/docs](https://parachute.computer/docs/) (Cloud:
[docs/run/cloud](https://parachute.computer/docs/run/cloud/)). Pricing: [parachute.computer/pricing](https://parachute.computer/pricing/).

This repo is the hosted door, from Open Parachute PBC. The vault engine is the same as on a server of your own
(`@openparachute/core`, from [parachute-core](https://github.com/ParachuteComputer/parachute-core)); this repo runs it
on Cloudflare and adds accounts, sign-in and billing.

## How it runs

- **`workers/vault/`**: one Durable Object per vault, whose SQLite is the vault, behind an edge router: the REST
  routes, the MCP endpoint, live queries, files in R2, export.
- **`workers/identity/`**: the OAuth issuer (`cloud.parachute.computer`), the account pages and `/account/*` API,
  billing (Stripe), and the operators' jobs. Accounts live in D1.
- **`src/`**: the control plane of an earlier design (a machine per person on Fly), dormant since 2026-07. Not
  deployed; kept to harvest from.

The MCP tools and REST routes are held to a server of your own's by a shared test: `scripts/door-parity.sh` runs
parachute-core's door contracts against both workers and compares the answers with a box's.

## Working on it

[CLAUDE.md](CLAUDE.md) has the commands, the deploy and smoke scripts, and the gotchas. Production deploys happen
only from `scripts/deploy-prod.sh` by the people who own the account.

## Licence

AGPL-3.0 ([LICENSE](LICENSE)).
