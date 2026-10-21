/**
 * AI Provider TypeScript Interface
 * Addresses backend#91: Replace runtime error AI provider interface with TypeScript types
 *
 * Defines the contract all AI providers must implement. Providers that don't support
 * a capability should declare it as false in their capabilities object rather than
 * throwing runtime errors.
 */

export interface AICapabilities {
  textGeneration: boolean;
  chatCompletion: boolean;
  weatherAnalysis: boolean;
  blockchainAnalysis: boolean;
  imageGeneration: boolean;
  imageAnalysis: boolean;
  audioTranscription: boolean;
}

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  [key: string]: unknown;
}

export interface CompletionResult {
  text: string;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  fallback?: boolean;
  originalProvider?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResult {
  message: ChatMessage;
  model?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  fallback?: boolean;
  originalProvider?: string;
  [key: string]: unknown;
}

export interface IAIProvider {
  name: string;
  description: string;
  version: string;
  capabilities: AICapabilities;
  initialized: boolean;

  initialize(): Promise<boolean>;
  isReady(): boolean;
  getInfo(): { name: string; description: string; version: string; capabilities: AICapabilities; initialized: boolean };

  generateCompletion(prompt: string, options?: CompletionOptions): Promise<CompletionResult>;
  generateChatCompletion(messages: ChatMessage[], options?: CompletionOptions): Promise<ChatCompletionResult>;
  analyzeWeatherData(data: unknown, query: string, options?: CompletionOptions): Promise<unknown>;
  analyzeBlockchainData(data: unknown, query: string, options?: CompletionOptions): Promise<unknown>;
  generateImage(prompt: string, options?: CompletionOptions): Promise<unknown>;
  analyzeImage(imageData: Buffer | string, prompt: string, options?: CompletionOptions): Promise<unknown>;
  transcribeAudio(audioData: Buffer | string, options?: CompletionOptions): Promise<unknown>;
}

/** Map of capability name to the method it guards */
const CAPABILITY_METHOD_MAP: Record<string, keyof AICapabilities> = {
  analyzeWeatherData: 'weatherAnalysis',
  analyzeBlockchainData: 'blockchainAnalysis',
  generateImage: 'imageGeneration',
  analyzeImage: 'imageAnalysis',
  transcribeAudio: 'audioTranscription',
  generateCompletion: 'textGeneration',
  generateChatCompletion: 'chatCompletion',
};

/**
 * Check if a provider supports a given method before calling it.
 * Throws a descriptive error if the capability is not supported.
 */
export function assertCapability(provider: IAIProvider, method: string): void {
  const capability = CAPABILITY_METHOD_MAP[method];
  if (!capability) return; // unknown method — no capability gate

  if (!provider.capabilities[capability]) {
    throw new Error(
      `Provider "${provider.name}" does not support ${capability}. ` +
      `Supported capabilities: ${Object.entries(provider.capabilities)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(', ')}`
    );
  }
}
