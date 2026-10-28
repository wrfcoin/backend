/** Shared transport-neutral boundary for inbound observations and alert research. */
export interface SmsGatewayInbound { messageId: string; sender: string; text: string; receivedAt?: string }
export interface SmsPreview { recipientHash: string; eventId: string; text: string; at: number }
export interface SmsSender { record(message: SmsPreview): void }
/** The only alert sender implementation. A hash is deliberately not a dialable address. */
export class DryRunSender implements SmsSender {
  readonly previews: SmsPreview[] = [];
  record(message: SmsPreview): void { this.previews.push(structuredClone(message)); }
}
