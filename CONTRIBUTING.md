# Contributing to WRFCoin Backend

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) and report vulnerabilities
privately using [SECURITY.md](SECURITY.md).

## Development

Use the Node.js version required by [package.json](package.json) (Node 24).
PostgreSQL 15+ and Redis 7+ are needed for database-backed development; use
isolated local services and synthetic data.

```bash
git clone https://github.com/wrfcoin/backend.git
cd backend
npm ci
npx tsc --noEmit
npm run build
npm run lint
npm test -- --maxWorkers=2
```

The build includes runtime-layout checks. Some integration tests require local
services or an isolated core4 API; report skipped coverage explicitly. The
[CI workflow](.github/workflows/ci.yml) records service setup and required test
environment variables. Never point development tests at the shared live testnet.

For local API development, configure the documented environment template with
your own local values, then use `npm run db:migrate` and `npm run dev` as described
in [README.md](README.md). Never commit environment values or credentials.

## Pull requests

Search existing issues and PRs, fork the repository, and create a focused branch
from current `main`. Add regression tests for changed behavior, update docs, and
run the relevant checks above. Open a PR against `main` with `Refs #N`, a clear
explanation, exact validation results, and any limitations. Address review
feedback; maintainers handle admission and merging.

Do not attach private keys, recovery phrases, personal locations, or private
operator details. Use sanitized logs and synthetic test fixtures.

## License

Contributions are licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE),
at the recipient's option.
