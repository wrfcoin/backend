# WRFCoin Backend

The WRFCoin backend is the Node.js and TypeScript API layer connecting the testnet website and mobile clients to wallets, weather stations and the core4 chain.

## Public testnet

The public testnet opened on **2026-10-22**.

This is a test network. It may be reset without notice. Balances and tokens have no monetary value. No migration to mainnet is promised or implied. Please attach no production bridges, exchange listings or irreplaceable assets.

[Website](https://wrfcoin.com) ·
[Quickstart](https://github.com/wrfcoin/docs/blob/main/testnet/quickstart.md) ·
[Testnet support](https://github.com/wrfcoin/testnet-support) ·
[Security policy](SECURITY.md)

## Try it

1. Open the [WRFCoin website](https://wrfcoin.com) to watch the chain: block height, the weather map and the block explorer.
2. Follow the [quickstart](https://github.com/wrfcoin/docs/blob/main/testnet/quickstart.md) to set up a wallet and claim testnet WRF from the faucet.
3. Read the [facts page](https://github.com/wrfcoin/docs/blob/main/testnet/facts.md) for what the testnet does and does not offer.
4. To run the API locally, see [Run the API with Docker](#run-the-api-with-docker).
5. Ask for help or report bugs at [testnet-support](https://github.com/wrfcoin/testnet-support); report vulnerabilities privately through the [security policy](SECURITY.md).

## What works today

The main API implements:

- Wallet challenge/login and token refresh, including ed25519 authentication for first-party wallets.
- Wallet balance and send routes backed by core4, rather than a separate wallet server.
- Weather station registration and weather commitment/reveal ingestion.
- Blockchain read routes for the website and clients.
- Faucet onboarding with explicit [testnet disclaimers](docs/api/faucet-disclaimer.md).

The [public endpoint allowlist](https://github.com/wrfcoin/infra/blob/main/testnet/PUBLIC_ENDPOINTS.md)
describes the edge configuration, route authentication and default-off reads. It is not a live availability report: an implemented backend route is not automatically exposed publicly. Station ingestion also depends on the selected provider, credentials and operator configuration.

## Planned and experimental

Additional provider ingestion and optional compute, storage, cross-chain and AI services are not a promise of live testnet capability. The repository includes experimental services and development stubs; a healthy stub does not establish a working integration. Production bridges and assets of monetary value are outside this testnet.

## Run the API with Docker

Use Docker with a dedicated local network named `wrfcoin-dev`. Provision PostgreSQL 15+ and Redis 7+ on that network, apply the schema with `npm run db:migrate` using the [development setup](CONTRIBUTING.md), and prepare an untracked `backend.local.env` with your own database, Redis, authentication and core4 settings. Use container-reachable service URLs; container localhost is not the host or the chain node. Never use shared testnet credentials for local development.

```bash
git clone https://github.com/wrfcoin/backend.git
cd backend
docker build --target main-api -t wrfcoin-backend:local .
docker run --rm --network wrfcoin-dev --env-file backend.local.env -e PORT=4001 -p 127.0.0.1:4001:4001 wrfcoin-backend:local
```

The explicit `main-api` target selects the API rather than the Dockerfile's final ingestion-service stage. This runs the API only; it does not provision a chain, database or public edge. For a full operator deployment, start with the [infra public deployment examples](https://github.com/wrfcoin/infra/blob/main/testnet/PUBLIC_DEPLOYMENT_EXAMPLES.md).

For development without Docker, use Node.js 24, `npm ci`, `npm run db:migrate` and `npm run dev` after configuring your local services. [CONTRIBUTING.md](CONTRIBUTING.md) lists type checks, builds and tests; database-backed tests require their documented services.

## Repository map

| Path | Contents |
| --- | --- |
| `server/` | Main API, routes and service integrations |
| `shared/` | Shared schema and contracts |
| `drizzle/` | Database migrations |
| `microservices/` | Additional service implementations; deployment varies |
| `__tests__/` | API and contract tests |

Contributions follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

Licensed under either [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.

---

_Note: issue and pull-request numbers mentioned in this repository refer to a private archive that predates this public repository; they are not links into this repo._
