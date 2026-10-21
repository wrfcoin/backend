/**
 * Wrfcoin Data-Aware Block Structure
 *
 * This file defines the schema for data-aware blocks that are specialized for
 * meteorological and computational data in the Wrfcoin blockchain.
 */

// Types of data that can be stored in a data-aware block
const DataBlockType = {
  WEATHER_FORECAST: 'weather_forecast',
  CLIMATE_SIMULATION: 'climate_simulation',
  AIR_QUALITY: 'air_quality',
  SENSOR_COLLECTION: 'sensor_collection',
  COMPUTATIONAL_RESULT: 'computational_result',
};

// Data storage providers where the full dataset is stored
const DataStorageProvider = {
  IPFS: 'ipfs',
  FILECOIN: 'filecoin',
  ARWEAVE: 'arweave',
  STORJ: 'storj',
  LOCAL: 'local', // For testnet or data stored directly on chain
};

// Geographic reference system types
const GeoReferenceSystem = {
  WGS84: 'wgs84', // Standard lat/long
  UTM: 'utm', // Universal Transverse Mercator
  MGRS: 'mgrs', // Military Grid Reference System
  OSGB36: 'osgb36', // British National Grid
  LAMBERT: 'lambert', // Lambert Conformal Conic
  CUSTOM: 'custom', // Custom projection (must be documented)
};

module.exports = {
  DataBlockType,
  DataStorageProvider,
  GeoReferenceSystem,
};
