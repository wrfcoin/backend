import coap from 'coap';
import type { Server as CoapServer } from 'coap';
import {
  verifyDeviceSignature,
  isRegisteredDevice,
  registerDevice,
} from './device-auth.js';
import type { BatchSigner } from './batch-signer.js';
import type { SensorReading, DeviceRegistration } from './types.js';

export class CoapHandler {
  private server: CoapServer;
  private batchSigner: BatchSigner;
  private port = 5683;

  constructor(batchSigner: BatchSigner) {
    this.batchSigner = batchSigner;
    this.server = coap.createServer();
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.server.on('request', (req, res) => {
      const url = req.url ?? '';
      const method = (req.method ?? 'GET').toUpperCase();

      const handleAsync = async () => {
        if (method === 'POST' && url === '/sensor/data') {
          await this.handleSensorData(req, res);
        } else if (method === 'POST' && url === '/sensor/register') {
          await this.handleRegistration(req, res);
        } else if (method === 'GET' && url === '/health') {
          this.handleHealth(res);
        } else {
          res.code = '4.04';
          res.end(JSON.stringify({ error: 'not found' }));
        }
      };

      handleAsync().catch((err) => {
        console.error('[CoAP] unhandled error:', err);
        res.code = '5.00';
        res.end(JSON.stringify({ error: 'internal server error' }));
      });
    });
  }

  private async handleSensorData(req: any, res: any): Promise<void> {
    let reading: SensorReading;
    try {
      reading = JSON.parse(req.payload.toString()) as SensorReading;
    } catch {
      console.warn('[CoAP] malformed JSON in sensor data request');
      res.code = '4.00';
      res.end(JSON.stringify({ error: 'malformed JSON' }));
      return;
    }

    if (!reading.deviceId) {
      res.code = '4.00';
      res.end(JSON.stringify({ error: 'missing deviceId' }));
      return;
    }

    if (!(await isRegisteredDevice(reading.deviceId))) {
      console.warn(`[CoAP] unregistered device: ${reading.deviceId}`);
      res.code = '4.01';
      res.end(JSON.stringify({ error: 'device not registered' }));
      return;
    }

    if (!(await verifyDeviceSignature(reading))) {
      console.warn(`[CoAP] invalid signature from device: ${reading.deviceId}`);
      res.code = '4.01';
      res.end(JSON.stringify({ error: 'invalid signature' }));
      return;
    }

    this.batchSigner.addReading(reading);
    console.info(`[CoAP] accepted reading from device ${reading.deviceId}`);
    res.code = '2.01';
    res.end(JSON.stringify({ status: 'ok', deviceId: reading.deviceId }));
  }

  private async handleRegistration(req: any, res: any): Promise<void> {
    let registration: DeviceRegistration;
    try {
      registration = JSON.parse(req.payload.toString()) as DeviceRegistration;
    } catch {
      console.warn('[CoAP] malformed JSON in registration request');
      res.code = '4.00';
      res.end(JSON.stringify({ error: 'malformed JSON' }));
      return;
    }

    if (!registration.deviceId || !registration.publicKey || !registration.deviceType) {
      res.code = '4.00';
      res.end(JSON.stringify({ error: 'missing required fields' }));
      return;
    }

    if (await registerDevice(registration)) {
      console.info(`[CoAP] registered device: ${registration.deviceId}`);
      res.code = '2.01';
      res.end(
        JSON.stringify({ status: 'registered', deviceId: registration.deviceId }),
      );
    } else {
      console.warn(`[CoAP] registration failed for device ${registration.deviceId}: invalid signature`);
      res.code = '4.01';
      res.end(JSON.stringify({ error: 'invalid registration signature' }));
    }
  }

  private handleHealth(res: any): void {
    res.code = '2.05';
    res.end(JSON.stringify({ status: 'healthy', protocol: 'coap', port: this.port }));
  }

  /** Start the CoAP server on the given port. */
  listen(port: number): Promise<void> {
    this.port = port;
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        console.info(`[CoAP] server listening on port ${port}`);
        resolve();
      });
    });
  }

  /** Shut down the CoAP server. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }
}
