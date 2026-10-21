import { Aedes } from 'aedes';
import type { AedesPublishPacket } from 'aedes';
import type { Client } from 'aedes';
import { createServer, type Server as NetServer } from 'node:net';
import {
  verifyDeviceSignature,
  isRegisteredDevice,
  registerDevice,
} from './device-auth.js';
import type { BatchSigner } from './batch-signer.js';
import type { SensorReading, DeviceRegistration } from './types.js';

export class MqttHandler {
  readonly aedes: Aedes;
  private server: NetServer | null = null;
  private batchSigner: BatchSigner;

  constructor(batchSigner: BatchSigner) {
    this.aedes = new Aedes();
    this.batchSigner = batchSigner;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.aedes.on('publish', (packet: AedesPublishPacket, client: Client | null) => {
      // Ignore internal/system topics and messages without a client
      if (!client) return;

      const topic = packet.topic;

      // Sensor data: wrfcoin/sensor/{deviceId}/data
      const dataMatch = topic.match(/^wrfcoin\/sensor\/([^/]+)\/data$/);
      if (dataMatch) {
        this.handleSensorData(dataMatch[1], packet, client).catch((err) => {
          console.error('[MQTT] error handling sensor data:', err);
        });
        return;
      }

      // Device registration: wrfcoin/sensor/{deviceId}/register
      const registerMatch = topic.match(/^wrfcoin\/sensor\/([^/]+)\/register$/);
      if (registerMatch) {
        this.handleRegistration(registerMatch[1], packet, client).catch((err) => {
          console.error('[MQTT] error handling registration:', err);
        });
        return;
      }
    });

    this.aedes.on('client', (client: Client) => {
      console.info(`[MQTT] client connected: ${client.id}`);
    });

    this.aedes.on('clientDisconnect', (client: Client) => {
      console.info(`[MQTT] client disconnected: ${client.id}`);
    });
  }

  private async handleSensorData(
    topicDeviceId: string,
    packet: AedesPublishPacket,
    client: Client,
  ): Promise<void> {
    let reading: SensorReading;
    try {
      reading = JSON.parse(packet.payload.toString()) as SensorReading;
    } catch {
      console.warn(`[MQTT] malformed JSON from client ${client.id} on topic ${packet.topic}`);
      this.publishAck(topicDeviceId, {
        status: 'error',
        reason: 'malformed JSON',
      });
      return;
    }

    // Use the deviceId from the topic if not in payload
    if (!reading.deviceId) {
      reading.deviceId = topicDeviceId;
    }

    if (!(await isRegisteredDevice(reading.deviceId))) {
      console.warn(`[MQTT] unregistered device: ${reading.deviceId}`);
      this.publishAck(topicDeviceId, {
        status: 'error',
        reason: 'device not registered',
      });
      return;
    }

    if (!(await verifyDeviceSignature(reading))) {
      console.warn(`[MQTT] invalid signature from device: ${reading.deviceId}`);
      this.publishAck(topicDeviceId, {
        status: 'error',
        reason: 'invalid signature',
      });
      return;
    }

    this.batchSigner.addReading(reading);
    console.info(`[MQTT] accepted reading from device ${reading.deviceId}`);
    this.publishAck(topicDeviceId, { status: 'ok', deviceId: reading.deviceId });
  }

  private async handleRegistration(
    topicDeviceId: string,
    packet: AedesPublishPacket,
    _client: Client,
  ): Promise<void> {
    let registration: DeviceRegistration;
    try {
      registration = JSON.parse(packet.payload.toString()) as DeviceRegistration;
    } catch {
      console.warn(`[MQTT] malformed registration JSON on topic ${packet.topic}`);
      return;
    }

    if (!registration.deviceId) {
      registration.deviceId = topicDeviceId;
    }

    if (await registerDevice(registration)) {
      console.info(`[MQTT] registered device: ${registration.deviceId}`);
      this.publishAck(topicDeviceId, {
        status: 'registered',
        deviceId: registration.deviceId,
      });
    } else {
      console.warn(`[MQTT] registration failed for device ${registration.deviceId}: invalid signature`);
      this.publishAck(topicDeviceId, {
        status: 'error',
        reason: 'invalid registration signature',
      });
    }
  }

  private publishAck(deviceId: string, payload: Record<string, unknown>): void {
    const topic = `wrfcoin/sensor/${deviceId}/ack`;
    this.aedes.publish(
      {
        topic,
        payload: Buffer.from(JSON.stringify(payload)),
        cmd: 'publish',
        qos: 0,
        dup: false,
        retain: false,
      } as AedesPublishPacket,
      () => {},
    );
  }

  /** Start the MQTT broker on the given port. */
  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(this.aedes.handle);
      this.server.on('error', reject);
      this.server.listen(port, () => {
        console.info(`[MQTT] broker listening on port ${port}`);
        resolve();
      });
    });
  }

  /** Number of currently connected clients. */
  get connectionCount(): number {
    return this.aedes.connectedClients;
  }

  /** Shut down the MQTT broker. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.aedes.close(() => resolve());
        });
      } else {
        this.aedes.close(() => resolve());
      }
    });
  }
}
