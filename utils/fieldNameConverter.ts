/**
 * Advanced TypeScript Field Name Converter
 * Provides type-safe conversions between database and application field formats
 */

// Import JavaScript fieldConverter with proper typing.
//
// backend#992: this wrapper delegated to `fieldConverter.snakeToCamel` /
// `.camelToSnake`, which `./fieldConverter.js` does not export — it exports
// `dbToApp` / `appToDb`. Every call therefore threw
// `TypeError: fieldConverter.snakeToCamel is not a function`. The failure was
// invisible to typecheck and to any "does it export X?" check, because the
// wrapper's own exports were present and correctly typed; only *calling* them
// failed. Callers that wrap the call in try/catch (e.g. FilePermissionService
// .getFileById) turned it into a null return, which then surfaced as a wrong
// answer — FILE_NOT_FOUND for a file that exists — rather than as an error.
//
// Do not "fix" this by pointing at `./fieldNameConverter.js`: that sibling
// module's `snakeToCamel` takes a STRING, while every caller here passes an
// OBJECT. `dbToApp` / `appToDb` are the object-level conversions this wrapper
// has always meant.
const fieldConverter = require('./fieldConverter');

// Define comprehensive type interfaces for database and application objects
interface DatabaseObject {
  [key: string]: any;
}

interface ApplicationObject {
  [key: string]: any;
}

// Advanced generic type for field conversion with proper inference
type ConvertFields<T> = T extends DatabaseObject
  ? ApplicationObject
  : T extends ApplicationObject
    ? DatabaseObject
    : T;

/**
 * Convert snake_case database fields to camelCase application fields
 * @param dbObject - Database object with snake_case field names
 * @returns Typed application object with camelCase field names
 */
export function snakeToCamel<T = any>(
  dbObject: DatabaseObject
): ConvertFields<T> {
  if (!dbObject) return null as any;
  return fieldConverter.dbToApp(dbObject) as ConvertFields<T>;
}

/**
 * Convert camelCase application fields to snake_case database fields
 * @param appObject - Application object with camelCase field names
 * @returns Typed database object with snake_case field names
 */
export function camelToSnake<T = any>(
  appObject: ApplicationObject
): ConvertFields<T> {
  if (!appObject) return null as any;
  return fieldConverter.appToDb(appObject) as ConvertFields<T>;
}

// Define specific type interfaces for common database entities
export interface DatabaseSubmission {
  submission_id: string;
  data_type: string;
  submitter_id: string;
  device_type: string;
  device_id: string;
  sensor_accuracy: number;
  battery_level: number;
  signal_strength: number;
  maintenance_status: string;
  firmware_version: string;
  measurements: any;
  latitude: number;
  longitude: number;
  elevation: number;
  location_description: string;
  validation_state: string;
  visibility: string;
  submission_timestamp: Date;
  metadata: any;
}

export interface ApplicationSubmission {
  submissionId: string;
  dataType: string;
  submitterId: string;
  deviceType: string;
  deviceId: string;
  sensorAccuracy: number;
  batteryLevel: number;
  signalStrength: number;
  maintenanceStatus: string;
  firmwareVersion: string;
  measurements: any;
  latitude: number;
  longitude: number;
  elevation: number;
  locationDescription: string;
  validationState: string;
  visibility: string;
  submissionTimestamp: Date;
  metadata: any;
}

// Type-safe converter functions with specific types
export function databaseToApplication(
  dbSubmission: DatabaseSubmission
): ApplicationSubmission {
  return snakeToCamel(dbSubmission) as ApplicationSubmission;
}

export function applicationToDatabase(
  appSubmission: ApplicationSubmission
): DatabaseSubmission {
  return camelToSnake(appSubmission) as DatabaseSubmission;
}

// Export the enhanced field converter
export const fieldNameConverter = {
  snakeToCamel,
  camelToSnake,
  databaseToApplication,
  applicationToDatabase,
};

export default fieldNameConverter;
