// OpenTelemetry must be initialized before other imports for auto-instrumentation
import { initializeOTel } from '../utils/otel-setup.js';
void initializeOTel().catch(() => {});

/**
 * Wrfcoin Model Context Protocol (MCP) Server
 *
 * This server implements the Model Context Protocol for AI-enhanced
 * operations in the Wrfcoin network, based on the specification at
 * https://github.com/modelcontextprotocol
 *
 * The MCP server enables:
 * - Context-aware model interactions with blockchain data
 * - Privacy-preserving AI inference
 * - Model validation and verification
 * - Cross-model interoperability
 */

import express, { Express, Request, Response } from 'express';
import bodyParser from 'body-parser';
import { randomBytes, createHash } from 'crypto';
import http from 'http';
import WebSocket from 'ws';
import * as WebSocketNS from 'ws';
import { appLogger as logger } from '../utils/logger.js';

// MCP Protocol Types
export interface MCPConfig {
  port: number;
  enableWebSocketAPI: boolean;
  enableContextProviders: boolean;
  defaultModelVersion: string;
  timeoutMs: number;
  maxContextSize: number;
}

export interface MCPModel {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  contextTypes: string[];
}

export interface MCPContext {
  id?: string;
  type: string;
  data?: any;
  dynamic?: boolean;
  providerId?: string;
  parameters?: Record<string, any>;
  loaded?: boolean;
  timestamp?: number;
}

export interface MCPSession {
  id: string;
  modelId: string;
  model: MCPModel;
  contexts: MCPContext[];
  messages: MCPMessage[];
  metadata: Record<string, any>;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  clientId?: string;
}

export interface MCPMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface MCPProvider {
  id: string;
  name: string;
  description: string;
  contextTypes: string[];
}

export interface MCPQueryOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface MCPQueryResult {
  modelId: string;
  query: string;
  sessionId: string;
  result: string;
  metadata: {
    processingTime: number;
    contextTypes: string[];
    modelVersion: string;
    timestamp: number;
  };
}

export interface MCPChatResult {
  content: string;
  metadata: {
    processingTime: number;
    contextTypes: string[];
    modelVersion: string;
    timestamp: number;
  };
}

// Import MCP components
const modelRegistry = require('./modelRegistry');
const contextProvider = require('./contextProvider');
const dataProcessor = require('./dataProcessor');
const validator = require('./validator');

export class MCPServer {
  public config: MCPConfig;
  public sessions: Map<string, MCPSession>;
  public models: Map<string, MCPModel>;
  public contextProviders: Map<string, MCPProvider>;
  public app: Express;
  public server: http.Server;
  public wss?: WebSocketNS.WebSocketServer;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: Partial<MCPConfig> = {}) {
    this.config = {
      port: Number(process.env.MCP_PORT) || 5005,
      enableWebSocketAPI: true,
      enableContextProviders: true,
      defaultModelVersion: 'v1',
      timeoutMs: 60000,
      maxContextSize: 16384,
      ...config,
    };

    this.sessions = new Map();
    this.models = new Map();
    this.contextProviders = new Map();

    this.app = express();
    this.server = http.createServer(this.app);

    if (this.config.enableWebSocketAPI) {
      this.wss = new WebSocketNS.WebSocketServer({ server: this.server, path: '/mcp-ws' });
    }

    // Configure middleware
    this.app.use(bodyParser.json({ limit: '10mb' }));

    // Initialize components
    this.initializeModels();
    this.initializeContextProviders();
    this.initRoutes();

    if (this.config.enableWebSocketAPI) {
      this.initWebSocketHandlers();
    }

    logger.info(
      `[MCPServer] Initialized with config: ${JSON.stringify(this.config)}`
    );
  }

  /**
   * Initialize available models
   */
  async initializeModels() {
    try {
      const registeredModels = await modelRegistry.listModels();

      for (const model of registeredModels) {
        this.models.set(model.id, model);
      }

      logger.info(`[MCPServer] Initialized ${this.models.size} models`);
    } catch (error) {
      logger.error(
        `[MCPServer] Failed to initialize models: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Initialize context providers
   */
  async initializeContextProviders() {
    if (!this.config.enableContextProviders) {
      logger.info('[MCPServer] Context providers disabled');
      return;
    }

    try {
      const providers = await contextProvider.listProviders();

      for (const provider of providers) {
        this.contextProviders.set(provider.id, provider);
      }

      logger.info(
        `[MCPServer] Initialized ${this.contextProviders.size} context providers`
      );
    } catch (error) {
      logger.error(
        `[MCPServer] Failed to initialize context providers: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Initialize HTTP routes for the MCP server
   */
  initRoutes() {
    // Health check endpoint
    this.app.get('/health', (req: Request, res: Response) => {
      return res.status(200).json({
        status: 'healthy',
        activeModels: this.models.size,
        activeSessions: this.sessions.size,
        contextProviders: this.contextProviders.size,
      });
    });

    // List available models
    this.app.get('/models', (req: Request, res: Response) => {
      const modelList = Array.from(this.models.values()).map(model => ({
        id: model.id,
        name: model.name,
        version: model.version,
        capabilities: model.capabilities,
        contextTypes: model.contextTypes,
      }));

      return res.status(200).json({ models: modelList });
    });

    // Get model details
    this.app.get('/models/:modelId', (req: Request, res: Response) => {
      const { modelId } = req.params;
      const model = this.models.get(modelId);

      if (!model) {
        return res.status(404).json({ error: 'Model not found' });
      }

      return res.status(200).json(model);
    });

    // Process a model query with context
    this.app.post('/query', async (req: Request, res: Response) => {
      try {
        const { modelId, query, contexts = [], options = {} } = req.body;

        if (!modelId || !query) {
          return res
            .status(400)
            .json({ error: 'Missing required parameters: modelId and query' });
        }

        const model = this.models.get(modelId);
        if (!model) {
          return res.status(404).json({ error: 'Model not found' });
        }

        // Generate a session ID for tracking
        const sessionId = randomBytes(16).toString('hex');

        // Process the query with context enrichment
        const result = await this.processModelQuery(
          sessionId,
          model,
          query,
          contexts,
          options
        );

        return res.status(200).json(result);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(`[MCPServer] Query processing error: ${errorMessage}`);
        return res
          .status(500)
          .json({ error: 'Query processing failed', details: errorMessage });
      }
    });

    // Create a new session
    this.app.post('/sessions', async (req: Request, res: Response) => {
      try {
        const { modelId, metadata = {} } = req.body;

        if (!modelId) {
          return res
            .status(400)
            .json({ error: 'Missing required parameter: modelId' });
        }

        const model = this.models.get(modelId);
        if (!model) {
          return res.status(404).json({ error: 'Model not found' });
        }

        // Generate a session ID
        const sessionId = randomBytes(16).toString('hex');

        // Initialize session
        const session: MCPSession = {
          id: sessionId,
          modelId,
          model,
          contexts: [],
          messages: [],
          metadata,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          expiresAt: Date.now() + this.config.timeoutMs,
        };

        this.sessions.set(sessionId, session);

        logger.info(
          `[MCPServer] Created session: ${sessionId} for model ${modelId}`
        );

        return res.status(201).json({
          sessionId,
          modelId,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(`[MCPServer] Session creation error: ${errorMessage}`);
        return res
          .status(500)
          .json({ error: 'Session creation failed', details: errorMessage });
      }
    });

    // Add a message to a session
    this.app.post(
      '/sessions/:sessionId/messages',
      async (req: Request, res: Response) => {
        try {
          const { sessionId } = req.params;
          const { role, content, contexts = [] } = req.body;

          if (!role || !content) {
            return res
              .status(400)
              .json({ error: 'Missing required parameters: role and content' });
          }

          const session = this.sessions.get(sessionId);
          if (!session) {
            return res.status(404).json({ error: 'Session not found' });
          }

          // Add message to session
          const message: MCPMessage = {
            id: randomBytes(8).toString('hex'),
            role: role as 'user' | 'assistant' | 'system',
            content,
            timestamp: Date.now(),
          };

          session.messages.push(message);

          // Add any new contexts
          if (contexts.length > 0) {
            session.contexts = [...session.contexts, ...contexts];
          }

          session.updatedAt = Date.now();

          logger.info(
            `[MCPServer] Added message to session ${sessionId}: ${message.id}`
          );

          // Generate response for user messages
          let response: MCPChatResult | null = null;
          if (role === 'user') {
            response = await this.processModelChat(session, content, contexts);

            // Add response to session messages
            if (response) {
              const responseMessage: MCPMessage = {
                id: randomBytes(8).toString('hex'),
                role: 'assistant',
                content: response.content,
                timestamp: Date.now(),
              };

              session.messages.push(responseMessage);
            }
          }

          return res.status(200).json({
            messageId: message.id,
            sessionId,
            message,
            response,
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger.error(`[MCPServer] Message processing error: ${errorMessage}`);
          return res
            .status(500)
            .json({
              error: 'Message processing failed',
              details: errorMessage,
            });
        }
      }
    );

    // Get session details
    this.app.get('/sessions/:sessionId', (req: Request, res: Response) => {
      const { sessionId } = req.params;
      const session = this.sessions.get(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Return session without internal details
      return res.status(200).json({
        sessionId: session.id,
        modelId: session.modelId,
        messages: session.messages.length,
        contexts: session.contexts.length,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        expiresAt: session.expiresAt,
      });
    });

    // Get session messages
    this.app.get(
      '/sessions/:sessionId/messages',
      (req: Request, res: Response) => {
        const { sessionId } = req.params;
        const session = this.sessions.get(sessionId);

        if (!session) {
          return res.status(404).json({ error: 'Session not found' });
        }

        return res.status(200).json({
          sessionId,
          messages: session.messages,
        });
      }
    );

    // Delete a session
    this.app.delete('/sessions/:sessionId', (req: Request, res: Response) => {
      const { sessionId } = req.params;

      if (!this.sessions.has(sessionId)) {
        return res.status(404).json({ error: 'Session not found' });
      }

      this.sessions.delete(sessionId);
      logger.info(`[MCPServer] Deleted session: ${sessionId}`);

      return res.status(204).end();
    });

    // List context providers
    this.app.get('/context-providers', (req: Request, res: Response) => {
      if (!this.config.enableContextProviders) {
        return res
          .status(403)
          .json({ error: 'Context providers are disabled' });
      }

      const providerList = Array.from(this.contextProviders.values()).map(
        provider => ({
          id: provider.id,
          name: provider.name,
          description: provider.description,
          contextTypes: provider.contextTypes,
        })
      );

      return res.status(200).json({ providers: providerList });
    });

    // Get context from specific provider
    this.app.post('/context', async (req: Request, res: Response) => {
      try {
        if (!this.config.enableContextProviders) {
          return res
            .status(403)
            .json({ error: 'Context providers are disabled' });
        }

        const { providerId, type, parameters = {} } = req.body;

        if (!providerId || !type) {
          return res
            .status(400)
            .json({
              error: 'Missing required parameters: providerId and type',
            });
        }

        const provider = this.contextProviders.get(providerId);
        if (!provider) {
          return res.status(404).json({ error: 'Context provider not found' });
        }

        if (!provider.contextTypes.includes(type)) {
          return res
            .status(400)
            .json({ error: `Provider does not support context type: ${type}` });
        }

        // Fetch context from provider
        const context = await contextProvider.getContext(
          providerId,
          type,
          parameters
        );

        return res.status(200).json({
          providerId,
          type,
          context,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(`[MCPServer] Context fetching error: ${errorMessage}`);
        return res
          .status(500)
          .json({ error: 'Context fetching failed', details: errorMessage });
      }
    });

    // Execute blockchain operation
    this.app.post('/execute', async (req: Request, res: Response) => {
      try {
        const { operation, parameters = {}, sessionId } = req.body;

        if (!operation) {
          return res
            .status(400)
            .json({ error: 'Missing required parameter: operation' });
        }

        // Check session if provided
        if (sessionId && !this.sessions.has(sessionId)) {
          return res.status(404).json({ error: 'Session not found' });
        }

        // Execute operation
        const result = await dataProcessor.executeOperation(
          operation,
          parameters,
          sessionId
        );

        return res.status(200).json({
          operation,
          result,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(`[MCPServer] Operation execution error: ${errorMessage}`);
        return res
          .status(500)
          .json({ error: 'Operation execution failed', details: errorMessage });
      }
    });
  }

  /**
   * Initialize WebSocket handlers for real-time MCP communication
   */
  initWebSocketHandlers() {
    this.wss?.on('connection', (ws, req) => {
      const clientId = randomBytes(16).toString('hex');
      logger.info(`[MCPServer] WebSocket client connected: ${clientId}`);

      ws.on('message', async message => {
        try {
          const data = JSON.parse(message.toString());

          switch (data.type) {
            case 'query':
              const { modelId, query, contexts = [], options = {} } = data;

              if (!modelId || !query) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Missing required parameters: modelId and query',
                  })
                );
                break;
              }

              const model = this.models.get(modelId);
              if (!model) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Model not found',
                  })
                );
                break;
              }

              // Generate a session ID for tracking
              const sessionId = randomBytes(16).toString('hex');

              try {
                // Process the query with context enrichment
                const result = await this.processModelQuery(
                  sessionId,
                  model,
                  query,
                  contexts,
                  options
                );

                ws.send(
                  JSON.stringify({
                    type: 'query_response',
                    sessionId,
                    result,
                  })
                );
              } catch (error) {
                const errorMessage =
                  error instanceof Error ? error.message : String(error);
                logger.error(
                  `[MCPServer] WebSocket query processing error: ${errorMessage}`
                );
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Query processing failed',
                    details: errorMessage,
                  })
                );
              }
              break;

            case 'create_session':
              const { modelId: sessionModelId, metadata = {} } = data;

              if (!sessionModelId) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Missing required parameter: modelId',
                  })
                );
                break;
              }

              const sessionModel = this.models.get(sessionModelId);
              if (!sessionModel) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Model not found',
                  })
                );
                break;
              }

              // Generate a session ID
              const wsSessionId = randomBytes(16).toString('hex');

              // Initialize session
              const session = {
                id: wsSessionId,
                modelId: sessionModelId,
                model: sessionModel,
                contexts: [],
                messages: [],
                metadata,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                expiresAt: Date.now() + this.config.timeoutMs,
                clientId,
              };

              this.sessions.set(wsSessionId, session);

              logger.info(
                `[MCPServer] Created WebSocket session: ${wsSessionId} for model ${sessionModelId}`
              );

              ws.send(
                JSON.stringify({
                  type: 'session_created',
                  sessionId: wsSessionId,
                  modelId: sessionModelId,
                  createdAt: session.createdAt,
                  expiresAt: session.expiresAt,
                })
              );
              break;

            case 'send_message':
              const {
                sessionId: messageSessionId,
                role,
                content,
                contexts: messageContexts = [],
              } = data;

              if (!messageSessionId || !role || !content) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message:
                      'Missing required parameters: sessionId, role, and content',
                  })
                );
                break;
              }

              const messageSession = this.sessions.get(messageSessionId);
              if (!messageSession) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Session not found',
                  })
                );
                break;
              }

              // Add message to session
              const message: MCPMessage = {
                id: randomBytes(8).toString('hex'),
                role: role as 'user' | 'assistant' | 'system',
                content,
                timestamp: Date.now(),
              };

              messageSession.messages.push(message);

              // Add any new contexts
              if (messageContexts.length > 0) {
                messageSession.contexts = [
                  ...messageSession.contexts,
                  ...messageContexts,
                ];
              }

              messageSession.updatedAt = Date.now();

              logger.info(
                `[MCPServer] Added WebSocket message to session ${messageSessionId}: ${message.id}`
              );

              // Generate response for user messages
              if (role === 'user') {
                try {
                  const response = await this.processModelChat(
                    messageSession,
                    content,
                    messageContexts
                  );

                  // Add response to session messages
                  if (response) {
                    const responseMessage: MCPMessage = {
                      id: randomBytes(8).toString('hex'),
                      role: 'assistant',
                      content: response.content,
                      timestamp: Date.now(),
                    };

                    messageSession.messages.push(responseMessage);

                    ws.send(
                      JSON.stringify({
                        type: 'message_response',
                        sessionId: messageSessionId,
                        messageId: message.id,
                        response,
                      })
                    );
                  }
                } catch (error) {
                  const errorMessage =
                    error instanceof Error ? error.message : String(error);
                  logger.error(
                    `[MCPServer] WebSocket message processing error: ${errorMessage}`
                  );
                  ws.send(
                    JSON.stringify({
                      type: 'error',
                      message: 'Message processing failed',
                      details: errorMessage,
                    })
                  );
                }
              } else {
                ws.send(
                  JSON.stringify({
                    type: 'message_confirmed',
                    sessionId: messageSessionId,
                    messageId: message.id,
                  })
                );
              }
              break;

            case 'get_context':
              if (!this.config.enableContextProviders) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Context providers are disabled',
                  })
                );
                break;
              }

              const { providerId, contextType, parameters = {} } = data;

              if (!providerId || !contextType) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message:
                      'Missing required parameters: providerId and contextType',
                  })
                );
                break;
              }

              const wsProvider = this.contextProviders.get(providerId);
              if (!wsProvider) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Context provider not found',
                  })
                );
                break;
              }

              if (!wsProvider.contextTypes.includes(contextType)) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: `Provider does not support context type: ${contextType}`,
                  })
                );
                break;
              }

              try {
                // Fetch context from provider
                const context = await contextProvider.getContext(
                  providerId,
                  contextType,
                  parameters
                );

                ws.send(
                  JSON.stringify({
                    type: 'context_response',
                    providerId,
                    contextType,
                    context,
                  })
                );
              } catch (error) {
                const errorMessage =
                  error instanceof Error ? error.message : String(error);
                logger.error(
                  `[MCPServer] WebSocket context fetching error: ${errorMessage}`
                );
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Context fetching failed',
                    details: errorMessage,
                  })
                );
              }
              break;

            default:
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'Unknown message type',
                })
              );
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          logger.error(`[MCPServer] WebSocket message error: ${errorMessage}`);
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Failed to process message',
              details: errorMessage,
            })
          );
        }
      });

      ws.on('close', () => {
        logger.info(`[MCPServer] WebSocket client disconnected: ${clientId}`);

        // Clean up client sessions
        for (const [sessionId, session] of this.sessions.entries()) {
          if (session.clientId === clientId) {
            this.sessions.delete(sessionId);
            logger.info(
              `[MCPServer] Cleaned up session ${sessionId} for disconnected client`
            );
          }
        }
      });

      // Set up ping-pong to keep connection alive
      (ws as any).isAlive = true;
      ws.on('pong', () => {
        (ws as any).isAlive = true;
      });
    });

    // WebSocket heartbeat
    setInterval(() => {
      this.wss?.clients.forEach(ws => {
        if ((ws as any).isAlive === false) return ws.terminate();

        (ws as any).isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  /**
   * Process a model query with context
   */
  async processModelQuery(
    sessionId: string,
    model: MCPModel,
    query: string,
    contexts: MCPContext[],
    options: MCPQueryOptions
  ): Promise<MCPQueryResult> {
    try {
      logger.info(
        `[MCPServer] Processing query with model ${model.id}, session ${sessionId}`
      );

      // Validate the model can handle the context types
      for (const context of contexts) {
        if (!model.contextTypes.includes(context.type)) {
          throw new Error(
            `Model ${model.id} does not support context type: ${context.type}`
          );
        }

        // Validate context data
        const isValid = await validator.validateContext(context);
        if (!isValid) {
          throw new Error(`Invalid context data for type: ${context.type}`);
        }
      }

      // Enrich contexts with dynamically-loaded data if needed
      const enrichedContexts = await this.enrichContexts(contexts);

      // Process the query
      const result = await dataProcessor.processQuery(
        model.id,
        query,
        enrichedContexts,
        options
      );

      logger.info(
        `[MCPServer] Query processed successfully for session ${sessionId}`
      );

      return {
        modelId: model.id,
        query,
        sessionId,
        result: result.content,
        metadata: {
          processingTime: result.processingTime,
          contextTypes: enrichedContexts.map(ctx => ctx.type),
          modelVersion: model.version,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`[MCPServer] Query processing error: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Process a chat message in a session
   */
  async processModelChat(
    session: MCPSession,
    message: string,
    contexts: MCPContext[]
  ): Promise<MCPChatResult> {
    try {
      logger.info(
        `[MCPServer] Processing chat message for session ${session.id}`
      );

      // Combine existing session contexts with new contexts
      const combinedContexts = [...session.contexts];

      // Add new contexts if not already present
      for (const context of contexts) {
        if (
          !combinedContexts.some(
            ctx => ctx.type === context.type && ctx.id === context.id
          )
        ) {
          // Validate context data
          const isValid = await validator.validateContext(context);
          if (isValid) {
            combinedContexts.push(context);
          } else {
            logger.warn(
              `[MCPServer] Invalid context data for type: ${context.type}, ignoring`
            );
          }
        }
      }

      // Enrich contexts with dynamically-loaded data if needed
      const enrichedContexts = await this.enrichContexts(combinedContexts);

      // Convert previous messages to format expected by processor
      const chatHistory = session.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
      }));

      // Process the chat message
      const result = await dataProcessor.processChat(
        session.modelId,
        message,
        chatHistory,
        enrichedContexts
      );

      logger.info(
        `[MCPServer] Chat message processed successfully for session ${session.id}`
      );

      return {
        content: result.content,
        metadata: {
          processingTime: result.processingTime,
          contextTypes: enrichedContexts.map(ctx => ctx.type),
          modelVersion: session.model.version,
          timestamp: Date.now(),
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`[MCPServer] Chat processing error: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * Enrich contexts with dynamically-loaded data
   */
  async enrichContexts(contexts: MCPContext[]): Promise<MCPContext[]> {
    if (!this.config.enableContextProviders) {
      return contexts;
    }

    try {
      const enrichedContexts = [...contexts];

      // Check for contexts that need dynamic loading
      for (let i = 0; i < enrichedContexts.length; i++) {
        const context = enrichedContexts[i];

        if (context.dynamic && context.providerId) {
          const provider = this.contextProviders.get(context.providerId);

          if (provider && provider.contextTypes.includes(context.type)) {
            // Load context data dynamically
            const dynamicContext = await contextProvider.getContext(
              context.providerId,
              context.type,
              context.parameters || {}
            );

            // Replace with the dynamically loaded context
            enrichedContexts[i] = {
              ...context,
              data: dynamicContext.data,
              dynamic: false,
              loaded: true,
              timestamp: Date.now(),
            };
          }
        }
      }

      return enrichedContexts;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(`[MCPServer] Context enrichment error: ${errorMessage}`);
      // Return original contexts if enrichment fails
      return contexts;
    }
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    let expiredCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAt < now) {
        this.sessions.delete(sessionId);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      logger.info(`[MCPServer] Cleaned up ${expiredCount} expired sessions`);
    }
  }

  /**
   * Start the MCP server
   */
  start(): Promise<void> {
    // Start session cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), 60000);

    return new Promise(resolve => {
      this.server.listen(this.config.port, () => {
        logger.info(
          `[MCPServer] MCP server running on port ${this.config.port}`
        );
        resolve();
      });
    });
  }

  /**
   * Stop the MCP server
   */
  stop(): Promise<void> {
    // Clear session cleanup timer
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    return new Promise(resolve => {
      if (this.wss) {
        this.wss.close(() => {
          this.server.close(() => {
            logger.info('[MCPServer] MCP server stopped');
            resolve();
          });
        });
      } else {
        this.server.close(() => {
          logger.info('[MCPServer] MCP server stopped');
          resolve();
        });
      }
    });
  }
}

export default MCPServer;
