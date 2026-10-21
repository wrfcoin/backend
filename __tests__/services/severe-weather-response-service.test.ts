import fs from 'fs';
import path from 'path';
import {
  SevereWeatherResponseService,
} from '../../server/services/weather/severe-weather-response-service.js';

function fixture(name: string): any {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../fixtures/weather', name), 'utf8')
  );
}

describe('SevereWeatherResponseService', () => {
  it('classifies alerts and tracks dedupe/update/expire lifecycle in memory', async () => {
    const locationA = fixture('nws-alerts-location-a.json');
    const locationB = fixture('nws-alerts-location-b.json');
    const updated = fixture('nws-alerts-updated.json');
    const empty = fixture('nws-alerts-empty.json');

    let phase = 0;
    const nwsApiService = {
      getAlerts: jest.fn(async (latitude: number) => {
        if (phase === 0) {
          return latitude > 35 ? locationA : locationB;
        }
        if (phase === 1) {
          return updated;
        }
        return empty;
      }),
    };

    let nowMs = Date.parse('2026-03-05T12:10:00Z');
    const publisher = jest.fn();

    const service = new SevereWeatherResponseService({
      nwsApiService: nwsApiService as any,
      locations: [
        { id: 'midwest', latitude: 41.88, longitude: -87.63 },
        { id: 'gulf', latitude: 29.76, longitude: -95.36 },
      ],
      nowFn: () => new Date(nowMs),
      publisher,
    });

    const callback = jest.fn();
    const unsubscribe = service.onEvent(callback);

    const first = await service.pollNow();
    expect(first.fetchedAlerts).toBe(4);
    expect(first.dedupedAlerts).toBe(3);
    expect(first.newAlerts).toBe(3);
    expect(first.updatedAlerts).toBe(0);
    expect(first.expiredAlerts).toBe(0);
    expect(service.getActiveAlerts()).toHaveLength(3);

    const tornado = service.getActiveAlerts().find(alert => alert.id.includes('tornado-warning'));
    const redFlag = service.getActiveAlerts().find(alert => alert.id.includes('red-flag-watch'));
    const hurricane = service.getActiveAlerts().find(alert => alert.id.includes('hurricane-watch'));
    expect(tornado?.type).toBe('tornado');
    expect(tornado?.severityClass).toBe('warning');
    expect(redFlag?.type).toBe('wildfire_red_flag');
    expect(redFlag?.severityClass).toBe('watch');
    expect(hurricane?.type).toBe('hurricane');
    expect(hurricane?.severityClass).toBe('watch');

    phase = 1;
    nowMs += 10 * 60 * 1000;

    const second = await service.pollNow();
    expect(second.newAlerts).toBe(1);
    expect(second.updatedAlerts).toBe(2);
    expect(second.expiredAlerts).toBe(1);
    expect(service.getActiveAlerts()).toHaveLength(3);

    const flood = service.getActiveAlerts().find(alert => alert.id.includes('flood-warning'));
    expect(flood?.type).toBe('flood');
    expect(flood?.severityClass).toBe('warning');

    const historyAfterSecond = service.getAlertHistory(50);
    expect(historyAfterSecond.filter(entry => entry.lifecycle === 'new')).toHaveLength(4);
    expect(historyAfterSecond.filter(entry => entry.lifecycle === 'updated')).toHaveLength(2);
    expect(historyAfterSecond.filter(entry => entry.lifecycle === 'expired')).toHaveLength(1);

    phase = 2;
    nowMs += 35 * 60 * 1000;
    unsubscribe();

    const third = await service.pollNow();
    expect(third.expiredAlerts).toBe(3);
    expect(service.getActiveAlerts()).toHaveLength(0);
    expect(service.getAlertHistory(100).filter(entry => entry.lifecycle === 'expired')).toHaveLength(4);

    expect(publisher).toHaveBeenCalledTimes(10);
    expect(callback).toHaveBeenCalledTimes(7);
    expect(nwsApiService.getAlerts).toHaveBeenCalledTimes(6);
  });

  it('uses default 2-minute poll interval and supports start/stop scheduler', async () => {
    jest.useFakeTimers();
    try {
      const nwsApiService = {
        getAlerts: jest.fn(async () => fixture('nws-alerts-empty.json')),
      };

      const service = new SevereWeatherResponseService({
        nwsApiService: nwsApiService as any,
        locations: [{ latitude: 39.82, longitude: -98.57 }],
      });

      expect(service.getPollIntervalMs()).toBe(120000);

      service.startPolling();
      await jest.advanceTimersByTimeAsync(120000);
      expect(nwsApiService.getAlerts).toHaveBeenCalledTimes(1);

      service.stopPolling();
      await jest.advanceTimersByTimeAsync(240000);
      expect(nwsApiService.getAlerts).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
