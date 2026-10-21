/**
 * Wrfcoin Data-Aware Block Structure
 *
 * This file defines the schema for data-aware blocks that are specialized for
 * meteorological and computational data in the Wrfcoin blockchain.
 */

// Types of data that can be stored in a data-aware block
export enum DataBlockType {
  WEATHER_FORECAST = 'weather_forecast',
  CLIMATE_SIMULATION = 'climate_simulation',
  AIR_QUALITY = 'air_quality',
  SENSOR_COLLECTION = 'sensor_collection',
  COMPUTATIONAL_RESULT = 'computational_result',
}

// Data storage providers where the full dataset is stored
export enum DataStorageProvider {
  IPFS = 'ipfs',
  FILECOIN = 'filecoin',
  ARWEAVE = 'arweave',
  STORJ = 'storj',
  LOCAL = 'local', // For testnet or data stored directly on chain
}

// Geographic reference system types
export enum GeoReferenceSystem {
  WGS84 = 'wgs84', // Standard lat/long
  UTM = 'utm', // Universal Transverse Mercator
  MGRS = 'mgrs', // Military Grid Reference System
  OSGB36 = 'osgb36', // British National Grid
  LAMBERT = 'lambert', // Lambert Conformal Conic
  CUSTOM = 'custom', // Custom projection (must be documented)
}

// Format for forecast metadata timestamps
export type TimestampRange = {
  start: string; // ISO 8601 format
  end?: string; // ISO 8601 format (optional for ongoing forecasts)
  interval?: number; // Time resolution in seconds
  temporal_resolution: string; // Human-readable (e.g., "1 hour", "3 days")
};

// Geographical bounding box
export type BoundingBox = {
  reference_system: GeoReferenceSystem;
  min_x: number; // Minimum longitude or x coordinate
  min_y: number; // Minimum latitude or y coordinate
  max_x: number; // Maximum longitude or x coordinate
  max_y: number; // Maximum latitude or y coordinate
  min_z?: number; // Minimum altitude/height (optional)
  max_z?: number; // Maximum altitude/height (optional)
  spatial_resolution: string; // Human-readable (e.g., "1km", "500m")
};

// Dataset parameters/variables included
export type DataParameter = {
  name: string; // Name of parameter (e.g., "temperature", "wind_speed")
  unit: string; // Unit of measurement (e.g., "celsius", "m/s")
  scale_factor?: number; // Optional scaling factor for raw data
  offset?: number; // Optional offset for raw data
  precision?: number; // Decimal precision of data
  min_value?: number; // Minimum valid value
  max_value?: number; // Maximum valid value
  description?: string; // Human-readable description
};

// Data processing information
export type DataProcessing = {
  model_name: string; // Name of model used (e.g., "GFS", "ECMWF", "WRF")
  model_version: string; // Version of model
  processor_id?: string; // ID of the node that processed the data
  processing_date: string; // ISO 8601 date when processing occurred
  input_dataset_hashes?: string[]; // References to input datasets
  configuration_hash?: string; // Hash of model configuration
  validation_metrics?: Record<string, number>; // Validation statistics if available
};

// Quality information
export type QualityInfo = {
  accuracy?: number; // Overall accuracy metric (0-1)
  confidence?: number; // Confidence level (0-1)
  validation_method?: string; // Method used for validation
  quality_flags?: string[]; // Any quality flags applied to the data
  review_status: 'unreviewed' | 'peer_reviewed' | 'validated';
  data_gaps?: string[]; // Description of any gaps in the data
};

// References to sensor submissions
export type SensorSubmissions = {
  merkle_root: string; // Merkle root of all sensor data hashes
  count: number; // Number of sensor submissions
  submission_hashes: string[]; // Hashes of individual submissions (limited to recent)
  sensor_types: string[]; // Types of sensors used
  verification_status: 'pending' | 'partial' | 'verified';
};

// Data storage reference
export type DataStorageReference = {
  provider: DataStorageProvider;
  reference: string; // IPFS hash, Filecoin deal ID, Arweave transaction, etc.
  size_bytes: number; // Size of the dataset in bytes
  format: string; // Format of the stored data (e.g., "netcdf", "csv", "json")
  encryption?: {
    // Optional encryption info
    algorithm: string; // Encryption algorithm used
    public_key_hash: string; // Hash of the public key used
  };
  fallback_references?: DataStorageReference[]; // Backup storage locations
};

// Access control for the data
export type AccessControl = {
  license: string; // License under which data is shared
  owner_address: string; // Blockchain address of data owner
  is_public: boolean; // Whether the data is publicly accessible
  access_price?: number; // Cost to access the data (if not public)
  restricted_until?: string; // Date until which access is restricted
  allowed_addresses?: string[]; // Addresses with special access rights
};

// Pruning policy for this data block
export type PruningPolicy = {
  retention_period?: string; // ISO 8601 duration for full retention
  reduced_after?: string; // When to switch to reduced retention
  reduced_retention: {
    // What to keep after reduction
    keep_metadata: boolean;
    keep_summary: boolean;
    keep_extremes: boolean;
  };
  permanent_storage?: boolean; // Whether this should never be pruned
  archive_reference?: DataStorageReference; // Where archived data is stored
};

// The complete data-aware block header structure
export type DataAwareBlockHeader = {
  version: number; // Schema version for future upgrades
  block_id: string; // Unique identifier for this block
  parent_block_id: string; // Reference to parent block
  data_type: DataBlockType; // Type of data contained
  creator_address: string; // Address that created this block
  creation_timestamp: string; // When this block was created

  // Forecast-specific metadata
  forecast_metadata: {
    time_range: TimestampRange;
    spatial_extent: BoundingBox;
    parameters: DataParameter[];
    processing: DataProcessing;
    quality: QualityInfo;
  };

  // Sensor data references
  sensor_data?: SensorSubmissions;

  // Storage information
  storage: DataStorageReference;

  // Access control
  access: AccessControl;

  // Data management
  pruning: PruningPolicy;

  // For future extensibility
  extensions: Record<string, any>;
};

// A data block contains the header plus the actual transactions
export type DataAwareBlock = {
  header: DataAwareBlockHeader;
  transactions: string[]; // Transaction IDs included in this block
  hash: string; // Hash of the entire block
  signature: string; // Signature from the block creator
  nonce: number; // Mining nonce
  timestamp: string; // ISO 8601 timestamp
  difficulty: number; // Mining difficulty when block was created
  size_bytes: number; // Total size of the block in bytes

  // Summary data that's preserved even after pruning
  data_summary?: {
    min_values: Record<string, number>;
    max_values: Record<string, number>;
    mean_values: Record<string, number>;
    anomaly_indices?: number[]; // Indices of notable anomalies
  };
};

// Extended block for checkpoint blocks that summarize multiple data blocks
export type CheckpointBlock = DataAwareBlock & {
  checkpoint_level: number; // Level in the checkpoint hierarchy
  summarized_blocks: string[]; // IDs of blocks this checkpoint summarizes
  period_start: string; // Start of the period this checkpoint covers
  period_end: string; // End of the period this checkpoint covers
  system_state_hash: string; // Hash of the system state at this checkpoint
  rollup_transactions: string[]; // High-value transactions preserved in the rollup
};
