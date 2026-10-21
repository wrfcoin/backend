/**
 * In-memory MobileStationStore for tests: same atomic semantics the Postgres
 * store gives (one transaction rolled back on error, UNIQUE owner, single-use nonce).
 */
import type {
  MobileStationStore,
  MobileStationTx,
  NonceRow,
  RegistrationRow,
} from '../../server/services/mobile-station-registration-service';

export class FakeStore implements MobileStationStore {
  nonces = new Map<string, NonceRow>();
  registrations = new Map<string, RegistrationRow>(); // key: owner_address
  stations = new Map<string, { owner: string }>(); // weather_stations rows by station_id
  // Models pg_advisory_xact_lock: per-wallet mutex held until the transaction ends.
  private walletLocks = new Map<string, Promise<void>>();
  async withTransaction<T>(fn: (tx: MobileStationTx) => Promise<T>): Promise<T> {
    const releases: Array<() => void> = [];
    try {
      return await this.runTransaction(fn, releases);
    } finally {
      for (const release of releases) release();
    }
  }
  private async runTransaction<T>(fn: (tx: MobileStationTx) => Promise<T>, releases: Array<() => void>): Promise<T> {
    const snapshot = {
      nonces: new Map([...this.nonces].map(([k, v]) => [k, { ...v }])),
      registrations: new Map(this.registrations),
      stations: new Map(this.stations),
    };
    const tx: MobileStationTx = {
      lockWallet: async (owner) => {
        const previous = this.walletLocks.get(owner) ?? Promise.resolve();
        let release!: () => void;
        const mine = new Promise<void>((resolve) => { release = resolve; });
        this.walletLocks.set(owner, previous.then(() => mine));
        releases.push(release);
        await previous;
      },
      pruneExpiredNonces: async (owner, nowSec) => {
        for (const [k, n] of this.nonces) {
          if (n.ownerAddress === owner && n.expiresAt <= nowSec) this.nonces.delete(k);
        }
      },
      findRegistrationByOwner: async (owner) => this.registrations.get(owner) ?? null,
      countLiveNonces: async (owner, nowSec) =>
        [...this.nonces.values()].filter(
          (n) => n.ownerAddress === owner && !n.consumed && n.expiresAt > nowSec
        ).length,
      insertNonce: async (row) => {
        this.nonces.set(row.nonce, { ...row, consumed: false });
      },
      getNonceForUpdate: async (nonce) => this.nonces.get(nonce) ?? null,
      consumeNonce: async (nonce) => {
        this.nonces.get(nonce)!.consumed = true;
      },
      upsertWeatherStation: async (stationId, owner) => {
        const existing = this.stations.get(stationId);
        if (existing && existing.owner !== owner) return false;
        this.stations.set(stationId, { owner });
        return true;
      },
      insertRegistration: async (row) => {
        for (const r of this.registrations.values()) {
          if (r.ownerAddress === row.ownerAddress) throw new Error('unique violation');
        }
        this.registrations.set(row.ownerAddress, row);
      },
      rotateCollectKey: async (owner, next) => {
        const row = this.registrations.get(owner)!;
        this.registrations.set(owner, { ...row, ...next });
      },
    };
    try {
      return await fn(tx);
    } catch (error) {
      this.nonces = snapshot.nonces;
      this.registrations = snapshot.registrations;
      this.stations = snapshot.stations;
      throw error;
    }
  }
}

