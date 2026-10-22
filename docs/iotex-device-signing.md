# IoTeX device and publisher signatures (backend#1240)

Device data, W3bstream events and attestation responses are authenticated with **ed25519**. There is no
simulated path. Operator (`WRFCOIN_OPERATOR_TOKEN`) and IoT-gateway-admin writes are unchanged.

## Keys
- A device or publisher key is a **32-byte ed25519 public key as 64 hex characters** (a `0x` prefix and upper case
  are accepted on input and normalized to lower case). Registration (`POST /api/iotex/devices`, publishers) refuses
  anything else (`400 INVALID_PUBLIC_KEY`), including small-order and non-canonical points. No schema change: the
  column stays `text`. Rows registered earlier with a free-form key can no longer verify; re-register them.
- Signatures are 64 bytes as 128 hex characters, verified strictly (dalek `verify_strict` parity, the same check as
  wallet login).

## The signed message
```
domain || u32le(len)+chain_id || u32le(len)+network_id || u32le(len)+subject_id
       || u32le(len)+timestamp || u32le(len)+nonce || u32le(len)+payload_hash
```
- `domain`: `wrfcoin.iotex.device_data.v1`, `wrfcoin.iotex.w3bstream_event.v1` or `wrfcoin.iotex.attestation.v1`.
  One per kind, so a signature for one kind is worthless for another.
- `chain_id` / `network_id`: the backend's `WRFCOIN_CHAIN_ID` / `WRFCOIN_NETWORK_ID` (set explicitly to `888` / `testnet` after the cut).
- `subject_id`: the device id (`/devices/:id`), the publisher id, or the device id for an attestation.
- `timestamp`: decimal Unix time in **seconds**. The backend refuses anything more than 5 minutes from its clock.
- `nonce`: 8-64 characters of `[A-Za-z0-9._-]`.
- `payload_hash`: lowercase hex SHA-256 of the canonical JSON of the payload (object keys sorted recursively, then
  `JSON.stringify`). Payload is `data` for device data, `{eventType, payload}` for events, `{challenge}` for attestations.
  A payload containing the key `__proto__`, `constructor` or `prototype` at any depth is refused (`400 RESERVED_PAYLOAD_KEY`, no write, no processing) before hashing, so an unsigned member cannot ride on a valid signature.
- `u32le(len)` is the 4-byte little-endian UTF-8 byte length of the field that follows.

## Requests
- `POST /api/iotex/devices/:id/data` `{ data, timestamp, nonce, signature }` with **no operator credentials**: accepted
  only when the signature verifies against the device's registered key. The stored row is `verified: true` and carries the
  signed timestamp. Otherwise `401 DEVICE_SIGNATURE_REQUIRED` and nothing is written or processed.
- **Replay:** a signature is single use per device. A repeat (also in another letter case, and a concurrent duplicate) is
  refused. The check is against the stored rows, so it survives a restart.
- Attestation responses (operator/IoT-admin route) are `{ signature, timestamp, nonce }`. A `publicKey` in the response
  is never trusted: it must equal the registered key, and the signature is checked against the registered key.

For the post-cut chain, verify the owner-published genesis hash
`553a3758386d9631037d7469686acb4a121ced81dcf5cde256e2d05667c5f332` before enabling submissions. This is a placeholder, not
a usable hash. Earlier balances and activation heights are not evidence for
the new genesis.
