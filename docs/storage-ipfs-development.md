# IPFS storage development

Storage operations use the real IPFS-only storage-providers daemon and self-hosted Kubo. The backend storage-networks/NAS simulation files are retired; do not substitute a mock server.

The client defaults to http://storage-node:7001; WRFCOIN_STORAGE_NODE_URL can point to a developer-operated loopback daemon. The reviewed infra/docker/docker-compose.storage.yml is the local daemon/Kubo stack. Testnet uses the disabled ipfs-storage profile only after explicit owner enablement. GET /health returns503 when Kubo is absent. POST /api/store uploads JSON/base64 and returns an acknowledged CID; GET /api/retrieve/ipfs:CID retrieves bytes. Never point development tests at live hosts.

The retirement is prerequisite-dependent on reviewed real wiring and the coordinated infra bundle/full-profile/edge inventory removal. No paid providers or remote pinning services are part of this path.
