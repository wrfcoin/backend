import http from 'node:http';
import { BatchSigner } from './batch-signer.js';
import { MqttHandler } from './mqtt-handler.js';
import { CoapHandler } from './coap-handler.js';
import { RTL433Handler } from './rtl433-handler.js';
import { registeredDeviceCount } from './device-auth.js';

const MQTT_PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const COAP_PORT = parseInt(process.env.COAP_PORT || '5683', 10);
const GATEWAY_HTTP_PORT = parseInt(process.env.GATEWAY_HTTP_PORT || '5684', 10);

export class IoTEdgeGateway {
  private batchSigner: BatchSigner;
  private mqttHandler: MqttHandler;
  private coapHandler: CoapHandler;
  private rtl433Handler: RTL433Handler;
  private httpServer: http.Server | null = null;

  constructor() {
    this.batchSigner = new BatchSigner();
    this.mqttHandler = new MqttHandler(this.batchSigner);
    this.coapHandler = new CoapHandler(this.batchSigner);
    // RTL433Handler receives MQTT messages from the same broker as MqttHandler
    this.rtl433Handler = new RTL433Handler(this.mqttHandler.aedes);
  }

  /** Start all gateway services: MQTT, CoAP, HTTP health, and batch signer. */
  async start(): Promise<void> {
    // Start batch signer interval
    this.batchSigner.start();

    // Start MQTT broker
    await this.mqttHandler.listen(MQTT_PORT);

    // Start CoAP server
    await this.coapHandler.listen(COAP_PORT);

    // Start HTTP health endpoint
    await this.startHttpHealth();

    console.info('[Gateway] IoT Edge Gateway started');
    console.info(`[Gateway]   MQTT  -> port ${MQTT_PORT}`);
    console.info(`[Gateway]   CoAP  -> port ${COAP_PORT}`);
    console.info(`[Gateway]   HTTP  -> port ${GATEWAY_HTTP_PORT}`);
  }

  private startHttpHealth(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
          const health = {
            status: 'healthy',
            mqtt: {
              port: MQTT_PORT,
              connections: this.mqttHandler.connectionCount,
            },
            coap: {
              port: COAP_PORT,
            },
            batchSigner: {
              pendingReadings: this.batchSigner.pendingCount,
              lastFlush: this.batchSigner.lastFlushTime,
            },
            registeredDevices: registeredDeviceCount(),
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(health));
        } else {
          res.writeHead(404);
          res.end('Not Found');
        }
      });

      this.httpServer.listen(GATEWAY_HTTP_PORT, () => {
        console.info(`[Gateway] HTTP health endpoint on port ${GATEWAY_HTTP_PORT}`);
        resolve();
      });
    });
  }

  /** Graceful shutdown: flush remaining readings, close all servers. */
  async shutdown(): Promise<void> {
    console.info('[Gateway] shutting down...');

    // Stop accepting new readings via interval
    this.batchSigner.stop();

    // Flush any remaining buffered readings
    const lastBatch = await this.batchSigner.flush();
    if (lastBatch) {
      console.info(
        `[Gateway] flushed ${lastBatch.readingCount} remaining readings on shutdown`,
      );
    }

    // Close servers in parallel
    await Promise.all([
      this.mqttHandler.close(),
      this.coapHandler.close(),
      new Promise<void>((resolve) => {
        if (this.httpServer) {
          this.httpServer.close(() => resolve());
        } else {
          resolve();
        }
      }),
    ]);

    console.info('[Gateway] shutdown complete');
  }
}

// When run directly as a script, start the gateway
const isMainModule =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('gateway.ts') ||
    process.argv[1].endsWith('gateway.js'));

if (isMainModule) {
  const gateway = new IoTEdgeGateway();

  gateway.start().catch((err) => {
    console.error('[Gateway] failed to start:', err);
    process.exit(1);
  });

  const onSignal = () => {
    gateway.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}
