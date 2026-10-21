# IoT and AI/ML network availability

Refs #1431; builds on #1173 and merged #1249.

The existing sidecars have no third-party network clients. Their network-facing
endpoints return HTTP **503** with this stable envelope:

```json
{"success":false,"unavailable":true,"reason":"No third-party IoT network client is wired.","error":{"code":"SIDECAR_UNAVAILABLE","message":"No third-party IoT network client is wired.","capability":"iot.networks"}}
```

| Endpoint | Capability |
| --- | --- |
| `GET /api/iot/networks` | `iot.networks` |
| `GET /api/iot/networks/:network` | `iot.network` |
| `GET /api/iot/stream/:network` | `iot.stream` |
| `GET /api/aiml/networks/status` | `aiml.networks.status` |
| `GET /api/ai/networks` | `ai.networks` |
| `GET /api/ai/networks/:network` | `ai.network` |

`POST /api/aiml/image/classify` also returns `503 SIDECAR_UNAVAILABLE`
(capability `aiml.image.classify`) when no registered image model produces valid
ONNX output. Hash-derived weather labels have been removed. Successful ONNX
classification retains HTTP 200; malformed uploads retain HTTP 400.

Unknown network keys retain HTTP 404. Refusal bodies contain no catalog,
network metrics, deployments or stream data. Callers should treat the error
code as unavailable and render that state without substituting metrics.

## Mounted surfaces and sources

Source inventory at backend `c6266e26` plus this change; compose/build inventory
from infra `4d9f09a53fcfb9de1f37465f4d18db84976a01b7`. These are configuration facts, not live-host probes.

| Entrypoint / mount | Source and response |
| --- | --- |
| `enhanced_unified_api_optimized.ts` | Does not mount `/api/iot`, `/api/ai` or `/api/aiml`; the sidecars have separate listeners. `/api/sensors` uses `sensor-ingest-routes`; `/api/iotex` uses the DB-backed IoTeX router. Those are separate capabilities. |
| `iot_sensor_networks_server.js` (3002) | Three network endpoints above: 503. `POST /api/iot/data` and `GET /api/iot/data/:network`: actual bounded in-memory intake/readback, no quality score or reward claim. `/api/iot/metrics`: actual readings held, explicit process scope and unavailable remote fields. No persistence or chain settlement implied. |
| `ai_ml_networks_server_impl.js` (6001) | Three network endpoints above: 503. Model CRUD and `/api/ai/networks/:network/models`: actual local registry; the network key is a label. Inference: registered local model, ONNX when the runtime executes it; statistical fallback explicitly labelled otherwise. Inference lookup/list and `/api/ai/metrics`: actual process records/counters. Ensemble routes: submitted rounds/results and local scoring. Advisory routes: rule evaluation of submitted measurements/alerts (or weather-service polling), not third-party AI execution. Image classification requires successful ONNX output; absent/runtime-failing/empty/invalid output returns 503. |
| `ai_ml_networks_server.ts` | Compatibility entrypoint importing the same JS implementation. |
| `unified_api_server.ts` | Legacy entrypoint mounts `routes/aiml-routes.js`, whose predictions/training are synthetic. This entrypoint is not selected by package start/dev or the current testnet image bundle; do not expose that router as a real AI source. |

Infra `infra/docker/esbuild-backend.sh` bundles the two JS sidecars to
`dist/iot_sensor.cjs` and `dist/ai_ml_networks_server.cjs`.
`testnet/docker-compose.testnet.yml` includes IoT in the base compose and AI/ML
under the optional `full` profile. The primary API does not proxy their routes.
The older service-registry statement that both sidecars require `full` is stale.

## Validation and delivery

The real Express apps are exercised with loopback HTTP requests. Tests replace
telemetry/logging, CORS setup and external persistence/runtime dependencies;
handlers and the refusal responder execute unchanged. Tests cover every changed
route, unknown-network 404s, IoT intake/readback and local registry/inference
positive controls. The ONNX-label control uses a fake runtime; it is not proof
that a real model or deployed sidecar ran.

This changes response status/body for the six network endpoints and removes the image-classification fallback. Other local-data
routes keep their contracts. No new sidecar/provider, environment switch,
migration, consensus feature or schedule. Deployment requires a backend image
rebuild by the owner; this work performs no deployment or live call.
