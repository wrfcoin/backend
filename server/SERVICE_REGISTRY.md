# Server service guide

## Service Registry

These are source entrypoints and their documented default ports. Availability depends on configured dependencies.

| Service | Port | File |
|---|---|---|
| Enhanced Unified API | 3001 default | `enhanced_unified_api_optimized.ts` |
| Governance | 8000 | `governance_server.js` |
| Weather Earnings | 8001 | `enhanced_weather_rewards.ts` |
| Node Discovery | 9010 HTTP / 9002 WS default | `easy_node_discovery.js` |
| Leaderboard | main-api (`/api/weather/leaderboard`) | `routes/weather-leaderboard-routes.ts` |
| Forecasters | main-api (`/api/forecasters`) | `routes/forecasters-routes.ts` |
| Weekly forecast competition | main-api (`/api/competitions`) | `routes/competition-routes.ts` |
| Cross-Chain Protocol | 3000 | `cross_chain_protocol_server.js` |
| Cross-Chain API | main-api (`/api/cross-chain`) | `routes/cross-chain.ts` |
| Compute Networks | 6000 | `compute_networks_server.ts` |
| AI/ML Networks | 6001 | `ai_ml_networks_server.ts` |
| IoT Networks | 3002 | `iot_sensor_networks_server.js` |
| Operator profile | main-api (`/api/operators`) | `routes/operator-profile-routes.ts` |
| Internet Computer (ICP) | main-api (`/api/icp`) | `routes/internet-computer-routes.ts` |
| Satellite (GOES) ingestion | main-api (`/api/ingestion/satellite-goes/*`) + compute (6000) | `routes/satellite-ingestion-routes.ts` |
| USGS earthquake ingestion | main-api (`/api/ingestion/usgs-earthquake/*`) + compute (6000) | `routes/usgs-earthquake-ingestion-routes.ts` |
| USGS water ingestion | main-api (`/api/ingestion/usgs-water/*`) + compute (6000) | `routes/usgs-water-ingestion-routes.ts` |
| NRCS soil ingestion | main-api (`/api/ingestion/nrcs-soil/*`) + compute (6000) | `routes/nrcs-soil-ingestion-routes.ts` |
| SMS ingest (Twilio) | main-api (`/api/sms/ingest`) | `routes/sms-ingest-routes.ts` |
| OpenForis API and monitoring | not mounted | `routes/openforis-routes.ts` |
| IoTeX / W3bstream devices | main-api (`/api/iotex`) | `routes/iotex.js` |

---

## Unmounted by owner ruling

Login is wallet-based. The following routers remain unmounted; a new owner decision is required before enabling them:

- `mfa-routes`
- `webauthn-routes`
- `session-routes`
- `oauth-routes`
- `security-admin-routes`
