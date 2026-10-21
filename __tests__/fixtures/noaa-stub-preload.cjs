/**
 * Test-only preload for the booted live entrypoint (anonymous-get harness):
 * when WRFCOIN_TEST_NOAA_STUB=1, the NOAA services answer from canned data
 * instead of calling api.weather.gov / NCEI, so the weather routes run their
 * real handlers (and the real observation transform) end to end with no
 * external request.
 *
 * The canned answers have the real methods' shapes (noaa-nws-api-service.js,
 * noaa-data-service.js), including the methods that echo the CALLER's
 * coordinates (getForecast's location) and the real third-party text fields
 * (textDescription, rawMessage, detailedForecast, alert areaDesc and
 * description). That upstream text carries DIFFERENT coordinates
 * (UPSTREAM_TEXT_PAIR), never the caller's: the scope ruling (backend#1397)
 * is that third-party NWS prose is public data and passes through unchanged,
 * while the caller's own coordinates must never appear anywhere at full
 * precision. Station lists carry exact (obviously fake) numeric coordinates
 * and station names that carry the upstream pair.
 */
const path = require('path');

const UPSTREAM_TEXT_PAIR = '30.555555,-40.444444';

if (process.env.WRFCOIN_TEST_NOAA_STUB === '1') {
  const root = path.join(__dirname, '../..');
  const NOAAWeatherService = require(path.join(root, 'server/services/noaa-nws-api-service'));
  const NOAADataService = require(path.join(root, 'server/services/noaa-data-service'));
  const W = NOAAWeatherService.prototype;
  const D = NOAADataService.prototype;
  const station = (id) => ({
    id,
    // Third-party text: an NWS station name carries the upstream pair, never the caller's.
    name: `Fake station ${id} at ${UPSTREAM_TEXT_PAIR}`,
    latitude: 10.123456,
    longitude: -20.987654,
    distance: 1.5,
  });

  // getCurrentObservations' real return shape (values already converted).
  W.getCurrentObservations = async () => ({
    stationId: 'FAKE1',
    stale: false,
    timestamp: new Date().toISOString(),
    temperature: { value: 11.1, unitCode: 'wmoUnit:degC' },
    relativeHumidity: { value: 50, unitCode: 'wmoUnit:percent' },
    barometricPressure: { value: 100050, unitCode: 'wmoUnit:Pa' },
    seaLevelPressure: { value: 100100, unitCode: 'wmoUnit:Pa' },
    windSpeed: { value: 5, unitCode: 'wmoUnit:km_h-1' },
    rawMessage: `FAKE1 011200Z AUTO near ${UPSTREAM_TEXT_PAIR} 00000KT 10SM CLR`,
    textDescription: `Clear near ${UPSTREAM_TEXT_PAIR}`,
  });
  // transformToWRFCoinFormat is NOT stubbed: the real transform runs.
  const forecast = async (latitude, longitude) => ({
    // The real getForecast echoes the caller's coordinates here.
    location: { latitude, longitude },
    periods: [
      {
        number: 1,
        // backend#1397 r5: an NWS period label with a number in it passes through unchanged.
        name: 'Tonight 1.e-3',
        temperature: 11,
        shortForecast: 'Clear',
        detailedForecast: `Clear near ${UPSTREAM_TEXT_PAIR}, light wind.`,
      },
    ],
  });
  W.getForecast = forecast;
  W.getHourlyForecast = forecast;
  W.getAlerts = async () => ({
    count: 1,
    alerts: [
      {
        id: 'urn:oid:fake.alert.1',
        areaDesc: `Fake County near ${UPSTREAM_TEXT_PAIR}`,
        headline: 'Fake advisory',
        description: `Fake advisory for the area around ${UPSTREAM_TEXT_PAIR}.`,
      },
    ],
  });
  W.getNearbyStations = async () => ({ stations: [station('FAKE1')] });
  D.findStationsNearLocation = async () => ({ stations: [station('FAKE2')] });
  D.getHistoricalData = async () => ({ results: [{ date: '2026-09-30', datatype: 'TMAX', value: 21, latitude: 10.123456, longitude: -20.987654 }] });
  D.transformToWRFCoinFormat = (raw) => (raw.results || []).map((r) => ({ ...r, location: { lat: r.latitude, lng: r.longitude } }));
}

module.exports = { UPSTREAM_TEXT_PAIR };
