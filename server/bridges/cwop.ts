import { createHash } from "node:crypto";
import { identity } from "./proof.js";
import type { Reading } from "./observations.js";

export type CwopReading = Reading & {
  callsign: string;
  latitude: number;
  longitude: number;
  windMps: number;
  windDirection: number;
  provenance: "unsigned_aprs_reference";
  rewardEligible: false;
};
/** Strict APRS101 uncompressed positioned weather subset. Unsupported forms fail closed. */
export function parseCwop(packet: string, receivedAt: string): CwopReading {
  if (
    Buffer.byteLength(packet) > 512 ||
    /[\r\n\x00]/.test(packet) ||
    !Number.isFinite(Date.parse(receivedAt))
  )
    throw new Error("MALFORMED_APRS");
  const frame =
    /^([A-Z0-9]+(?:-\d{1,2})?)>[A-Z0-9]+(?:,[A-Z0-9*,-]+)*:(.*)$/i.exec(packet);
  if (!frame) throw new Error("MALFORMED_APRS");
  const callsign = identity("aprs", frame[1]).deviceId;
  let body = frame[2],
    observedAt = new Date(receivedAt).toISOString();
  if (body[0] === "@" || body[0] === "/") {
    const time = /^[\/@](\d{2})(\d{2})(\d{2})z/.exec(body);
    if (!time) throw new Error("UNSUPPORTED_APRS_TIME");
    const ref = new Date(receivedAt),
      day = Number(time[1]),
      hour = Number(time[2]),
      minute = Number(time[3]);
    if (day < 1 || day > 31 || hour > 23 || minute > 59)
      throw new Error("MALFORMED_APRS");
    const dates = [-1, 0, 1]
      .map(
        (offset) =>
          new Date(
            Date.UTC(
              ref.getUTCFullYear(),
              ref.getUTCMonth() + offset,
              day,
              hour,
              minute,
            ),
          ),
      )
      .filter((d) => d.getUTCDate() === day);
    dates.sort((a, b) => Math.abs(+a - +ref) - Math.abs(+b - +ref));
    if (!dates.length || Math.abs(+dates[0] - +ref) > 86400000)
      throw new Error("STALE_APRS");
    observedAt = dates[0].toISOString();
    body = body.slice(8);
  } else if (body[0] === "!" || body[0] === "=") body = body.slice(1);
  else throw new Error("UNSUPPORTED_APRS");
  const weather =
    /^(\d{2})(\d{2}\.\d{2})([NS])[/\\](\d{3})(\d{2}\.\d{2})([EW])_(\d{3})\/(\d{3})(?:g\d{3})?t(-\d{2}|\d{3})(?:r\d{3})?(?:p\d{3})?(?:P\d{3})?h(\d{2})b(\d{5})(?:[a-zA-Z][a-zA-Z0-9 ._-]{0,40})?$/.exec(
      body,
    );
  if (!weather) throw new Error("MALFORMED_APRS");
  const [
    ,
    latD,
    latM,
    ns,
    lonD,
    lonM,
    ew,
    direction,
    speed,
    temp,
    humidity,
    pressure,
  ] = weather;
  const lat = Number(latD) + Number(latM) / 60,
    lon = Number(lonD) + Number(lonM) / 60;
  const temperatureC = ((Number(temp) - 32) * 5) / 9,
    pressureHpa = Number(pressure) / 10;
  if (
    Number(latM) >= 60 ||
    Number(lonM) >= 60 ||
    lat > 90 ||
    lon > 180 ||
    Number(direction) > 360 ||
    temperatureC < -100 ||
    temperatureC > 70 ||
    pressureHpa < 300 ||
    pressureHpa > 1200
  )
    throw new Error("MALFORMED_APRS");
  return {
    callsign,
    observedAt,
    latitude: ns === "S" ? -lat : lat,
    longitude: ew === "W" ? -lon : lon,
    temperatureC,
    humidityPct: Number(humidity) || 100,
    pressureHpa,
    windMps: Number(speed) * 0.44704,
    windDirection: Number(direction),
    provenance: "unsigned_aprs_reference",
    rewardEligible: false,
  };
}

export interface AprsReadTransport {
  read(login: string): Promise<readonly string[]>;
}
/** Recorded transport only; there is deliberately no socket implementation tonight. */
export class RecordedAprsTransport implements AprsReadTransport {
  constructor(private readonly packets: readonly string[]) {}
  async read(login: string): Promise<readonly string[]> {
    if (!/^user [A-Z0-9-]+ pass -1 vers WRFReference 1$/.test(login))
      throw new Error("RECEIVE_ONLY_REQUIRED");
    return this.packets;
  }
}
export class CwopReferenceClient {
  private nextPoll = 0;
  private failures = 0;
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly deps: {
      enabled: () => boolean;
      authenticated: () => boolean;
      transport: AprsReadTransport;
      now: () => number;
      ingest: (reading: CwopReading) => Promise<void>;
    },
  ) {}
  async poll(): Promise<{
    accepted: number;
    duplicates: number;
    rejected: number;
  }> {
    const counts = { accepted: 0, duplicates: 0, rejected: 0 };
    if (!this.deps.enabled()) return counts;
    if (!this.deps.authenticated()) throw new Error("AUTH_REQUIRED");
    const now = this.deps.now();
    if (now < this.nextPoll) return counts;
    this.nextPoll = now + 60000;
    try {
      const packets = await this.deps.transport.read(
        "user WRFREF pass -1 vers WRFReference 1",
      );
      for (const [key, expires] of this.seen)
        if (expires <= now) this.seen.delete(key);
      for (const packet of packets.slice(0, 100)) {
        let reading: CwopReading;
        try {
          reading = parseCwop(packet, new Date(now).toISOString());
        } catch {
          counts.rejected++;
          continue;
        }
        // Ignore routing-path differences when de-duplicating retransmissions.
        const key = createHash("sha256")
          .update(
            reading.callsign + ":" + packet.slice(packet.indexOf(":") + 1),
          )
          .digest("hex");
        if (this.seen.has(key)) {
          counts.duplicates++;
          continue;
        }
        if (this.seen.size >= 10000) {
          counts.rejected++;
          continue;
        }
        await this.deps.ingest(reading);
        this.seen.set(key, now + 86400000);
        counts.accepted++;
      }
      this.failures = 0;
      return counts;
    } catch {
      this.failures = Math.min(this.failures + 1, 6);
      this.nextPoll = now + Math.min(3600000, 60000 * 2 ** this.failures);
      throw new Error("APRS_READ_UNAVAILABLE");
    }
  }
}
