// websocket-server.ts
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from './common/logger';
import dotenv from 'dotenv';
import Redis from 'ioredis';

dotenv.config();

import { ChatbotAgent } from './chatbot';
import { runGraph, StateType, createInitialSession, isValidSessionState } from './graph/graph';
import { AIMessage, HumanMessage, BaseMessage } from '@langchain/core/messages';
import { buildGovVectorStore } from './graph/vectorStore';

const logger = createLogger('server');

const redis = new Redis(process.env.REDIS_URL || "redis://localhost:6379");

interface ClientConnection {
  ws: WebSocket;
  sessionId: string;
  userId?: string;
  lastActivity: Date;
}

interface FileData {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
  url: string;
}

// Serializable session state (without memory object)
interface SerializableSessionState {
  input: string;
  chat_history: BaseMessage[];
  current_node: string | null;
  last_node: string | null;
  awaiting_input: boolean;
  is_form_filling_started: boolean;
  form_id?: string;
  form_name?: string;
  form_fields?: any[];
  form_status?: "not_started" | "in_progress" | "completed";
  current_field?: string;
  last_field?: string;
  isFormfillingInterupted: boolean;
}

class ChatWebSocketServer {
  private app: express.Application;
  private server: any;
  private wss: WebSocketServer;
  private clients: Map<string, ClientConnection> = new Map();
  private chatbotAgent: ChatbotAgent;
  private upload: multer.Multer;

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });
    this.chatbotAgent = new ChatbotAgent();

    // Configure file upload
    this.upload = multer({
      dest: 'uploads/',
      limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
      },
      fileFilter: (_req: express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
        // Allow common file types
        const allowedTypes = [
          'image/jpeg', 'image/png', 'image/gif', 'image/webp',
          'audio/wav', 'audio/mp3', 'audio/m4a',
          'application/pdf', 'text/plain', 'text/csv',
          'application/json', 'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        ];

        if (allowedTypes.includes(file.mimetype)) {
          cb(null, true);
        } else {
          cb(null, false);
        }
      }
    });

    this.setupExpress();
    this.setupWebSocket();
  }

  // Fixed session state retrieval
  async getSessionState(sessionId: string): Promise<SerializableSessionState | undefined> {
    try {
      const json = await redis.get(`session:${sessionId}`);
      if (!json) return undefined;
      
      const parsed = JSON.parse(json);
      
      // Reconstruct message objects from serialized data
      if (parsed.chat_history && Array.isArray(parsed.chat_history)) {
        parsed.chat_history = parsed.chat_history.map((msg: any) => {
          if (msg._getType) {
            // Already a proper message object
            return msg;
          }
          // Reconstruct message based on type
          if (msg.type === 'human' || msg.constructor?.name === 'HumanMessage') {
            return new HumanMessage({ content: msg.content || msg.text || '' });
          } else if (msg.type === 'ai' || msg.constructor?.name === 'AIMessage') {
            return new AIMessage({ content: msg.content || msg.text || '' });
          }
          // Fallback
          return new HumanMessage({ content: msg.content || msg.text || '' });
        });
      }
      
      return parsed;
    } catch (error) {
      logger.error("Redis get error:", error);
      return undefined;
    }
  }

  // Fixed session state saving
  async saveSessionState(sessionId: string, state: StateType): Promise<void> {
    try {
      // Create serializable version by removing memory and converting messages
      const serializableState: SerializableSessionState = {
        input: state.input,
        chat_history: state.chat_history.map(msg => ({
          type: msg._getType(),
          content: msg.content,
          // Store additional properties if needed
          ...(msg.additional_kwargs && { additional_kwargs: msg.additional_kwargs })
        })) as any,
        current_node: state.current_node,
        last_node: state.last_node,
        awaiting_input: state.awaiting_input,
        is_form_filling_started: state.is_form_filling_started,
        form_id: state.form_id,
        form_name: state.form_name,
        form_fields: state.form_fields,
        form_status: state.form_status,
        current_field: state.current_field,
        last_field: state.last_field,
        isFormfillingInterupted: state.isFormfillingInterupted
      };

      await redis.set(
        `session:${sessionId}`, 
        JSON.stringify(serializableState), 
        'EX', 
        60 * 60 * 24 // Expires in 24 hours (increased from 1 hour)
      );
      
      logger.info(`Session state saved for session ${sessionId}`);
    } catch (error) {
      logger.error("Redis set error:", error);
    }
  }

  private setupExpress() {
    // CORS configuration
    this.app.use(cors({
      origin: process.env.FRONTEND_URL || 'http://localhost:3000',
      credentials: true
    }));

    this.app.use(express.json({ limit: '50mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '50mb' }));

    // Serve uploaded files
    this.app.use('/uploads', express.static('uploads'));

    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        connections: this.clients.size,
        timestamp: new Date().toISOString()
      });
    });

    // Session debug endpoint
    this.app.get('/debug/session/:sessionId', async (req, res) => {
      try {
        const sessionState = await this.getSessionState(req.params.sessionId);
        res.json({ sessionId: req.params.sessionId, state: sessionState });
      } catch (error) {
        res.status(500).json({ error: 'Failed to get session state' });
      }
    });

    // File upload endpoint
    this.app.post('/upload', this.upload.array('files', 10), (req, res) => {
      try {
        const files = req.files as Express.Multer.File[];
        const fileData: FileData[] = files.map(file => ({
          id: uuidv4(),
          name: file.originalname,
          type: file.mimetype,
          size: file.size,
          path: file.path,
          url: `/uploads/${file.filename}`
        }));

        res.json({ success: true, files: fileData });
      } catch (error) {
        logger.error('File upload error:', error);
        res.status(500).json({ success: false, error: 'Upload failed' });
      }
    });

    // REST API fallback for chat
    this.app.post('/api/chat', async (req, res) => {
      try {
        const { message, sessionId, files } = req.body;
        
        // Get or create session
        let sessionState = await this.getSessionState(sessionId);
        if (!sessionState) {
          sessionState = createInitialSession();
        }

        const response = await this.chatbotAgent.chat(sessionId, message);

        res.json({
          response,
          sessionId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error('Chat API error:', error);
        res.status(500).json({ error: 'Chat processing failed' });
      }
    });
  }

  private setupWebSocket() {
    this.wss.on('connection', (ws: WebSocket, request) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const sessionId = url.searchParams.get('sessionId') || uuidv4();

      logger.info(`Client connected: ${sessionId}`);

      // Store client connection
      const clientConnection: ClientConnection = {
        ws,
        sessionId,
        lastActivity: new Date()
      };

      this.clients.set(sessionId, clientConnection);

      // Send welcome message with session info
      this.sendMessage(ws, {
        type: 'connection',
        content: 'Connected to AI Assistant',
        sessionId,
        timestamp: new Date().toISOString()
      });

      // Handle messages
      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          await this.handleMessage(sessionId, message);
        } catch (error: any) {
          logger.error('Message handling error:', error);
          this.sendMessage(ws, {
            type: 'error',
            content: 'Failed to process message',
            error: error.message,
            sessionId
          });
        }
      });

      // Handle disconnection
      ws.on('close', () => {
        logger.info(`Client disconnected: ${sessionId}`);
        this.clients.delete(sessionId);
      });

      // Handle errors
      ws.on('error', (error) => {
        logger.error(`WebSocket error for ${sessionId}:`, error);
        this.clients.delete(sessionId);
      });

      // Update last activity
      clientConnection.lastActivity = new Date();
    });

    // Cleanup inactive connections
    setInterval(() => {
      const now = new Date();
      const timeout = 30 * 60 * 1000; // 30 minutes

      this.clients.forEach((client, sessionId) => {
        if (now.getTime() - client.lastActivity.getTime() > timeout) {
          logger.info(`Cleaning up inactive session: ${sessionId}`);
          client.ws.close();
          this.clients.delete(sessionId);
        }
      });
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  private async handleMessage(sessionId: string, message: any) {
    const client = this.clients.get(sessionId);
    if (!client) return;

    try {
      client.lastActivity = new Date();

      // Send typing indicator
      this.sendMessage(client.ws, {
        type: 'typing',
        isTyping: true,
        sessionId
      });

      let processedFiles: FileData[] = [];
      if (message.files?.length > 0) {
        processedFiles = await this.processMessageFiles(message.files);
      }

      // Get existing session or create new one
      let previousState = await this.getSessionState(sessionId);
      if (!previousState) {
        logger.info(`Creating new session for ${sessionId}`);
        previousState = createInitialSession();
      } else {
        logger.info(`Retrieved existing session for ${sessionId} with ${previousState.chat_history?.length || 0} messages`);
      }

      // Set current input
      previousState.input = message.content;

      logger.info(`Processing message for session ${sessionId}: "${message.content}"`);
      logger.info(`Previous chat history length: ${previousState.chat_history?.length || 0}`);

      // Run the graph with the previous state
      const resultState = await runGraph(message.content, previousState);

      logger.info(`New chat history length: ${resultState.chat_history?.length || 0}`);

      // Get the last bot message
      const lastBotMessage = resultState.chat_history?.[resultState.chat_history.length - 1] as AIMessage;
      const botResponse = lastBotMessage?.content || "I'm here to help you with forms and applications.";

      // Save updated session state
      await this.saveSessionState(sessionId, resultState);

      // Stop typing indicator and send response
      this.sendMessage(client.ws, {
        type: 'typing',
        isTyping: false,
        sessionId
      });

      this.sendMessage(client.ws, {
        type: 'message',
        content: botResponse,
        sessionId,
        timestamp: new Date().toISOString(),
        // Include session debug info in development
        ...(process.env.NODE_ENV === 'development' && {
          debug: {
            historyLength: resultState.chat_history?.length,
            currentNode: resultState.current_node,
            formStatus: resultState.form_status,
            isFormFilling: resultState.is_form_filling_started
          }
        })
      });

    } catch (error: any) {
      logger.error('Message processing error:', error);

      this.sendMessage(client.ws, {
        type: 'typing',
        isTyping: false,
        sessionId
      });

      this.sendMessage(client.ws, {
        type: 'error',
        content: 'Sorry, I encountered an error processing your message. Please try again.',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        sessionId
      });
    }
  }

  private async processMessageFiles(files: any[]): Promise<FileData[]> {
    const processedFiles: FileData[] = [];

    for (const file of files) {
      try {
        if (file.data) {
          // Handle base64 data
          const buffer = Buffer.from(file.data.split(',')[1], 'base64');
          const filename = `${uuidv4()}_${file.name}`;
          const filepath = path.join('uploads', filename);

          await fs.promises.writeFile(filepath, buffer);

          processedFiles.push({
            id: file.id || uuidv4(),
            name: file.name,
            type: file.type,
            size: file.size,
            path: filepath,
            url: `/uploads/${filename}`
          });
        }
      } catch (error) {
        logger.error('File processing error:', error);
      }
    }

    return processedFiles;
  }

  private async handleAIResponseFiles(response: string): Promise<FileData[]> {
    const files: FileData[] = [];

    if (response.includes('[GENERATE_FORM]')) {
      const formContent = this.generateFormContent(response);
      const filename = `form_${uuidv4()}.pdf`;
      const filepath = path.join('uploads', filename);

      await fs.promises.writeFile(filepath, formContent);

      files.push({
        id: uuidv4(),
        name: 'Generated Form.pdf',
        type: 'application/pdf',
        size: formContent.length,
        path: filepath,
        url: `/uploads/${filename}`
      });
    }

    return files;
  }

  private generateFormContent(response: string): Buffer {
    const content = `Generated form based on: ${response}`;
    return Buffer.from(content, 'utf8');
  }

  private sendMessage(ws: WebSocket, data: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  public async start(port: number = 3001) {
    await buildGovVectorStore();
    this.server.listen(port, () => {
      logger.info(`Chat server running on port ${port}`);
      logger.info(`WebSocket endpoint: ws://localhost:${port}/chat`);
      logger.info(`HTTP API endpoint: http://localhost:${port}/api/chat`);
      logger.info(`Session debug endpoint: http://localhost:${port}/debug/session/:sessionId`);
    });
  }

  public stop() {
    this.wss.close();
    this.server.close();
  }
}

// Start server
const chatServer = new ChatWebSocketServer();
chatServer.start(3001);

// Graceful shutdown
process.on('SIGINT', () => {
  logger.info('Shutting down chat server...');
  chatServer.stop();
  process.exit(0);
});

export { ChatWebSocketServer };