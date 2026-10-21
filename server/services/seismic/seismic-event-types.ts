export type UsgsEarthquakeFeed = 'significant' | '4.5' | '2.5' | 'all';
export type UsgsEarthquakeWindow = 'hour' | 'day' | 'week';
export type UsgsAlertLevel = 'green' | 'yellow' | 'orange' | 'red';

export interface SeismicEventLocation {
  latitude: number;
  longitude: number;
  depthKm: number;
  place?: string;
}

export interface SeismicEventSourceMetadata {
  endpoint: string;
  sourceUrl: string;
  feed: UsgsEarthquakeFeed;
  window: UsgsEarthquakeWindow;
  detailUrl?: string;
  eventUrl?: string;
  significance?: number;
  status?: string;
  updatedAt?: string;
  title?: string;
  eventType?: string;
}

export interface SeismicEvent {
  observationId: string;
  dedupeKey: string;
  category: 'Seismic';
  source: 'USGS';
  eventId: string;
  occurredAt: string;
  ingestedAt: string;
  location: SeismicEventLocation;
  magnitude: number;
  magnitudeType?: string;
  feltReports?: number;
  maxIntensity?: number;
  tsunamiWarning: boolean;
  alertLevel?: UsgsAlertLevel;
  sourceMetadata: SeismicEventSourceMetadata;
}

export interface UsgsEarthquakePollResult {
  feed: UsgsEarthquakeFeed;
  window: UsgsEarthquakeWindow;
  pollIntervalMs: number;
  rawEvents: number;
  ingestedEvents: number;
  duplicateEvents: number;
  events: SeismicEvent[];
}

export interface UsgsEarthquakeMetrics {
  pollIntervalMs: number;
  pollAttempts: number;
  pollSuccesses: number;
  pollFailures: number;
  parseFailures: number;
  ingestedEvents: number;
  duplicateEvents: number;
  recentLatencyMs: number | null;
  lastPollAt: string | null;
  lastFeed: UsgsEarthquakeFeed | null;
  lastWindow: UsgsEarthquakeWindow | null;
}
