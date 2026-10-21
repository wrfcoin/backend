/**
 * STAC (SpatioTemporal Asset Catalog) Service
 *
 * Maps WRFCoin weather records to STAC API v1.0.0 compliant objects.
 * Reference: https://stacspec.org / https://github.com/radiantearth/stac-spec
 */

import { routeDurableStore } from '../shared/route-durable-store.js';

// ─── STAC type definitions ─────────────────────────────────────────────────

export interface StacLink {
  rel: string;
  href: string;
  type?: string;
  title?: string;
}

export interface StacCatalog {
  type: 'Catalog';
  id: string;
  title: string;
  description: string;
  stac_version: string;
  conformsTo: string[];
  links: StacLink[];
}

export interface StacSpatialExtent {
  bbox: number[][];
}

export interface StacTemporalExtent {
  interval: (string | null)[][];
}

export interface StacExtent {
  spatial: StacSpatialExtent;
  temporal: StacTemporalExtent;
}

export interface StacCollection {
  type: 'Collection';
  id: string;
  title: string;
  description: string;
  stac_version: string;
  license: string;
  extent: StacExtent;
  links: StacLink[];
  keywords?: string[];
}

export interface StacItemProperties {
  datetime: string;
  [key: string]: unknown;
}

export interface StacAsset {
  href: string;
  type: string;
  title?: string;
  roles?: string[];
}

export interface StacItem {
  type: 'Feature';
  stac_version: string;
  id: string;
  geometry: {
    type: string;
    coordinates: number[];
  } | null;
  bbox: number[] | null;
  properties: StacItemProperties;
  links: StacLink[];
  assets: Record<string, StacAsset>;
  collection: string;
}

export interface StacFeatureCollection {
  type: 'FeatureCollection';
  features: StacItem[];
  numberMatched: number;
  numberReturned: number;
  links: StacLink[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const STAC_VERSION = '1.0.0';
const COLLECTION_ID = 'wrfcoin-weather-readings';
const BASE_PATH = '/api/stac';

// ─── Helpers ────────────────────────────────────────────────────────────────

function weatherRecordToStacItem(record: any, baseUrl: string): StacItem {
  const datetime = record.timestamp || new Date().toISOString();
  const hasCoords = record.latitude != null && record.longitude != null;

  return {
    type: 'Feature',
    stac_version: STAC_VERSION,
    id: record.id,
    geometry: hasCoords
      ? { type: 'Point', coordinates: [record.longitude, record.latitude] }
      : null,
    bbox: hasCoords
      ? [record.longitude, record.latitude, record.longitude, record.latitude]
      : null,
    properties: {
      datetime,
      'wrfcoin:stationId': record.stationId,
      'wrfcoin:temperature': record.temperature,
      'wrfcoin:humidity': record.humidity,
      'wrfcoin:pressure': record.pressure,
      'wrfcoin:windSpeed': record.windSpeed,
      'wrfcoin:windDirection': record.windDirection,
      'wrfcoin:precipitation': record.precipitation,
      'wrfcoin:visibility': record.visibility,
      'wrfcoin:uvIndex': record.uvIndex,
      'wrfcoin:airQuality': record.airQuality,
    },
    links: [
      { rel: 'self', href: `${baseUrl}${BASE_PATH}/collections/${COLLECTION_ID}/items/${record.id}`, type: 'application/geo+json' },
      { rel: 'parent', href: `${baseUrl}${BASE_PATH}/collections/${COLLECTION_ID}`, type: 'application/json' },
      { rel: 'collection', href: `${baseUrl}${BASE_PATH}/collections/${COLLECTION_ID}`, type: 'application/json' },
      { rel: 'root', href: `${baseUrl}${BASE_PATH}`, type: 'application/json' },
    ],
    assets: {
      data: {
        href: `${baseUrl}/api/weather/data?stationId=${record.stationId}`,
        type: 'application/json',
        title: 'Raw weather data via WRFCoin API',
        roles: ['data'],
      },
    },
    collection: COLLECTION_ID,
  };
}

// ─── Service ────────────────────────────────────────────────────────────────

export class StacService {
  getCatalog(baseUrl: string): StacCatalog {
    return {
      type: 'Catalog',
      id: 'wrfcoin-stac-catalog',
      title: 'WRFCoin Weather Data Catalog',
      description:
        'SpatioTemporal Asset Catalog for weather observation data collected via the WRFCoin decentralized network.',
      stac_version: STAC_VERSION,
      conformsTo: [
        'https://api.stacspec.org/v1.0.0/core',
        'https://api.stacspec.org/v1.0.0/collections',
        'https://api.stacspec.org/v1.0.0/item-search',
      ],
      links: [
        { rel: 'self', href: `${baseUrl}${BASE_PATH}`, type: 'application/json' },
        { rel: 'root', href: `${baseUrl}${BASE_PATH}`, type: 'application/json' },
        { rel: 'data', href: `${baseUrl}${BASE_PATH}/collections`, type: 'application/json', title: 'Collections' },
        { rel: 'child', href: `${baseUrl}${BASE_PATH}/collections/${COLLECTION_ID}`, type: 'application/json', title: 'Weather Readings' },
        { rel: 'service-desc', href: `${baseUrl}/api/docs`, type: 'application/json', title: 'API Documentation' },
      ],
    };
  }

  getCollections(baseUrl: string): StacCollection[] {
    return [this.getCollection(COLLECTION_ID, baseUrl)!];
  }

  getCollection(collectionId: string, baseUrl: string): StacCollection | null {
    if (collectionId !== COLLECTION_ID) return null;

    return {
      type: 'Collection',
      id: COLLECTION_ID,
      title: 'WRFCoin Weather Station Readings',
      description:
        'Decentralized weather observations submitted by WRFCoin network participants. ' +
        'Includes temperature, humidity, pressure, wind, precipitation, and air quality data.',
      stac_version: STAC_VERSION,
      license: 'proprietary',
      extent: {
        spatial: { bbox: [[-180, -90, 180, 90]] },
        temporal: { interval: [['2024-01-01T00:00:00Z', null]] },
      },
      links: [
        { rel: 'self', href: `${baseUrl}${BASE_PATH}/collections/${COLLECTION_ID}`, type: 'application/json' },
        { rel: 'root', href: `${baseUrl}${BASE_PATH}`, type: 'application/json' },
        { rel: 'parent', href: `${baseUrl}${BASE_PATH}`, type: 'application/json' },
        { rel: 'items', href: `${baseUrl}${BASE_PATH}/collections/${COLLECTION_ID}/items`, type: 'application/geo+json' },
      ],
      keywords: ['weather', 'wrfcoin', 'decentralized', 'observations', 'climate'],
    };
  }

  async getItems(
    collectionId: string,
    baseUrl: string,
    params: { limit?: number; offset?: number } = {},
  ): Promise<StacFeatureCollection | null> {
    if (collectionId !== COLLECTION_ID) return null;

    const limit = Math.min(params.limit || 100, 1000);
    const offset = params.offset || 0;

    const allRecords: any[] = await routeDurableStore.read(
      (state: any) => Object.values(state.weather.records),
    );

    // Sort by timestamp descending
    allRecords.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

    const paged = allRecords.slice(offset, offset + limit);
    const features = paged.map((r) => weatherRecordToStacItem(r, baseUrl));

    const links: StacLink[] = [
      { rel: 'self', href: `${baseUrl}${BASE_PATH}/collections/${COLLECTION_ID}/items?limit=${limit}&offset=${offset}`, type: 'application/geo+json' },
      { rel: 'root', href: `${baseUrl}${BASE_PATH}`, type: 'application/json' },
      { rel: 'parent', href: `${baseUrl}${BASE_PATH}/collections/${COLLECTION_ID}`, type: 'application/json' },
    ];

    if (offset + limit < allRecords.length) {
      links.push({
        rel: 'next',
        href: `${baseUrl}${BASE_PATH}/collections/${COLLECTION_ID}/items?limit=${limit}&offset=${offset + limit}`,
        type: 'application/geo+json',
      });
    }

    return {
      type: 'FeatureCollection',
      features,
      numberMatched: allRecords.length,
      numberReturned: features.length,
      links,
    };
  }

  async getItem(
    collectionId: string,
    featureId: string,
    baseUrl: string,
  ): Promise<StacItem | null> {
    if (collectionId !== COLLECTION_ID) return null;

    const records: Record<string, any> = await routeDurableStore.read(
      (state: any) => state.weather.records,
    );

    const record = records[featureId];
    if (!record) return null;

    return weatherRecordToStacItem(record, baseUrl);
  }
}

export const stacService = new StacService();
