# Environment Phase 2 Reporting API (`backend#39`)

This API provides ingestion and canonical normalization for:

- soil health intelligence
- ocean current/tide intelligence
- hydrology/flood intelligence

Base path: `/api/environment/reports`

## Endpoints

### `POST /soil/ingest`

Ingest soil health report and normalize to canonical schema.

### `POST /ocean/ingest`

Ingest ocean current/tide report and normalize to canonical schema.

### `POST /hydrology/ingest`

Ingest hydrology report and normalize to canonical schema.

### `GET /reports?domain=<soil|ocean|hydrology>&region=<region>&limit=<n>`

Return canonical normalized outputs across all domains.

### `GET /summary`

Return phase-2 overview including per-domain report totals and policy notes.

### `GET /summary/<domain>`

Return summary for one domain (`soil`, `ocean`, `hydrology`).

### `GET /docs`

Return machine-readable endpoint metadata.

## Canonicalization Notes

- Soil moisture is normalized to fraction (`0..1`).
- Ocean current speed normalized to `m/s`, tide height normalized to `m`, temperature normalized to `C`.
- Hydrology precipitation normalized to `mm`, discharge normalized to `m3/s`, flood stage normalized to `m`.
- Outputs are aggregate/provider-level and privacy-safe (no participant identifiers).
