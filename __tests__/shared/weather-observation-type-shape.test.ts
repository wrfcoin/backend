/**
 * Type-shape regression test for WeatherObservation generated binding.
 *
 * Verifies that the ts-rs generated type includes radio_metadata so that
 * observations sourced via SDR/Zigbee/LoRa retain their provenance data
 * instead of having it silently stripped on deserialization. (issue #492)
 */

import type { WeatherObservation } from '../../shared/generated-types/index.js';
import type { RadioSourceMetadata } from '../../shared/generated-types/index.js';
import type { RadioSourceType } from '../../shared/generated-types/index.js';

describe('WeatherObservation generated type shape (issue #492)', () => {
  it('accepts a full observation with radio_metadata populated', () => {
    const meta: RadioSourceMetadata = {
      source_type: 'Sdr' as RadioSourceType,
      frequency_mhz: 433.92,
      signal_strength_dbm: -65,
      protocol: 'Oregon Scientific v3',
      raw_packet_hash: 'deadbeef',
    };

    const obs: WeatherObservation = {
      temperature_c: 21.3,
      humidity_percent: 58.0,
      pressure_hpa: 1013.25,
      wind_speed_ms: 3.1,
      wind_direction_deg: 270,
      precipitation_mm: 0,
      dewpoint_c: 12.4,
      visibility_m: 10000,
      radio_metadata: meta,
    };

    expect(obs.radio_metadata).not.toBeNull();
    expect(obs.radio_metadata?.source_type).toBe('Sdr');
    expect(obs.radio_metadata?.frequency_mhz).toBe(433.92);
    expect(obs.radio_metadata?.protocol).toBe('Oregon Scientific v3');
  });

  it('accepts a full observation with radio_metadata null (non-radio sensor)', () => {
    const obs: WeatherObservation = {
      temperature_c: 15.0,
      humidity_percent: 70.0,
      pressure_hpa: 1008.0,
      wind_speed_ms: 5.2,
      wind_direction_deg: 90,
      precipitation_mm: 2.4,
      dewpoint_c: 9.5,
      visibility_m: 8000,
      radio_metadata: null,
    };

    expect(obs.radio_metadata).toBeNull();
  });

  it('accepts a full observation with radio_metadata omitted (serde default)', () => {
    const obs: WeatherObservation = {
      temperature_c: 15.0,
      humidity_percent: 70.0,
      pressure_hpa: 1008.0,
      wind_speed_ms: 5.2,
      wind_direction_deg: 90,
      precipitation_mm: 2.4,
      dewpoint_c: 9.5,
      visibility_m: 8000,
    };

    expect(obs.radio_metadata).toBeUndefined();
  });

  it('RadioSourceType covers all expected transport variants', () => {
    // 'Satellite' (NOAA APT and similar downlinks) is chain vocabulary since
    // core4#1808; regenerated from core4 in backend#1174.
    // Exhaustive at the type level: a missing or extra variant is a type error
    // under a direct type-check of this file.
    const variants: Record<RadioSourceType, true> = { Sdr: true, Satellite: true, Zigbee: true, LoRa: true };
    const types = Object.keys(variants) as RadioSourceType[];
    expect(types).toEqual(['Sdr', 'Satellite', 'Zigbee', 'LoRa']);
  });

  it('RadioSourceMetadata optional fields accept null values', () => {
    const sparse: RadioSourceMetadata = {
      source_type: 'LoRa',
      frequency_mhz: null,
      signal_strength_dbm: null,
      protocol: null,
      raw_packet_hash: null,
    };

    expect(sparse.source_type).toBe('LoRa');
    expect(sparse.frequency_mhz).toBeNull();
  });
});
