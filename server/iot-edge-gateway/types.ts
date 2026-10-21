export interface SensorReading {
  deviceId: string;
  timestamp: number; // Unix ms
  sensorType: string; // 'temperature' | 'humidity' | 'pressure' | 'co2' | 'pm25' | 'pm10' | 'wind_speed' | 'wind_direction' | 'rainfall' | 'uv_index' | 'solar_radiation'
  value: number;
  unit: string;
  location?: { lat: number; lng: number; altitude?: number };
  signature: string; // hex-encoded ed25519 signature over payload
  publicKey: string; // hex-encoded ed25519 public key
}

export interface DeviceRegistration {
  deviceId: string;
  publicKey: string; // hex-encoded ed25519 public key
  deviceType: string;
  manufacturer?: string;
  firmware?: string;
  location?: { lat: number; lng: number };
  signature?: string; // hex-encoded ed25519 signature over registration payload
}

export interface BatchTransaction {
  readings: SensorReading[];
  batchId: string;
  gatewaySignature: string;
  timestamp: number;
  readingCount: number;
}
