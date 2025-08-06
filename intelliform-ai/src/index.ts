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
import { runGraph, StateType } from './graph/graph';
import { AIMessage } from '@langchain/core/messages';

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

  async getSessionState(sessionId: string): Promise<StateType | undefined> {
    try {
      const json = await redis.get(`session:${sessionId}`);
      return json ? JSON.parse(json) : undefined;
    } catch (error) {
      console.error("Redis get error:", error);
      return undefined;
    }
  }
  
  async saveSessionState(sessionId: string, state: StateType): Promise<void> {
    try {
      await redis.set(`session:${sessionId}`, JSON.stringify(state), 'EX', 60 * 60); // Expires in 1 hour
      console.log(`Session state saved for session ${sessionId}`);
    } catch (error) {
      console.error("Redis set error:", error);
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
        console.error('File upload error:', error);
        res.status(500).json({ success: false, error: 'Upload failed' });
      }
    });

    // REST API fallback for chat
    this.app.post('/api/chat', async (req, res) => {
      try {
        const { message, sessionId, files } = req.body;
        
        // Process with AI agent
        const response = await this.chatbotAgent.chat(sessionId, message);
        
        res.json({ 
          response, 
          sessionId,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('Chat API error:', error);
        res.status(500).json({ error: 'Chat processing failed' });
      }
    });
  }

  private setupWebSocket() {
    this.wss.on('connection', (ws: WebSocket, request) => {
      const url = new URL(request.url!, `http://${request.headers.host}`);
      const sessionId = url.searchParams.get('sessionId') || uuidv4();
      
      console.log(`Client connected: ${sessionId}`);
      
      // Store client connection
      const clientConnection: ClientConnection = {
        ws,
        sessionId,
        lastActivity: new Date()
      };
      
      this.clients.set(sessionId, clientConnection);

      // Send welcome message
      this.sendMessage(ws, {
        type: 'connection',
        content: 'Connected to AI Assistant',
        sessionId
      });

      // Handle messages
      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          await this.handleMessage(sessionId, message);
        } catch (error: any) {
          console.error('Message handling error:', error);
          this.sendMessage(ws, {
            type: 'error',
            content: 'Failed to process message',
            error: error.message
          });
        }
      });

      // Handle disconnection
      ws.on('close', () => {
        console.log(`Client disconnected: ${sessionId}`);
        this.clients.delete(sessionId);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error(`WebSocket error for ${sessionId}:`, error);
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
          console.log(`Cleaning up inactive session: ${sessionId}`);
          client.ws.close();
          this.clients.delete(sessionId);
        }
      });
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  private async handleMessage(sessionId: string, message: any) {
    const client = this.clients.get(sessionId);
    logger.info(`client`, client);
    if (!client) return;

    try {
      // Update last activity
      client.lastActivity = new Date();

      // Show typing indicator
      this.sendMessage(client.ws, {
        type: 'typing',
        isTyping: true
      });

      let processedFiles: FileData[] = [];

      // Handle file uploads in message
      if (message.files && message.files.length > 0) {
        processedFiles = await this.processMessageFiles(message.files);
      }

      // Process message with AI agent
      // const aiResponse = await test(message.content);
      const previousState = await this.getSessionState(sessionId) || {};

      logger.info(`previousState: ${JSON.stringify(previousState)}`);
      logger.info(`message.content: ${message.content}`);

      const resultState = await runGraph(message.content, {});
      logger.info(`resultState: ${JSON.stringify(resultState)}`);

       const lastBotMessage = resultState.chat_history?.[resultState.chat_history.length - 1] as AIMessage;

      // 💾 Save session to Redis
      await this.saveSessionState(sessionId, resultState); 
  
      // // 📤 Send bot response
      // const lastBotMessage = resultState.chat_history?.[resultState.chat_history.length - 1] as AIMessage;

      // const aiResponse = await runGraph(message.content);
      // logger.debug('AI response:', aiResponse);

    

      // Check if AI wants to send files back
      // const responseFiles = await this.handleAIResponseFiles(aiResponse);

      // Send AI response
      this.sendMessage(client.ws, {
        type: 'message',
        content: lastBotMessage?.content || "Done.",
        // files: responseFiles,
        sessionId,
        timestamp: new Date().toISOString()
      });

    } catch (error: any) {
      console.error('Message processing error:', error);
      
      this.sendMessage(client.ws, {
        type: 'error',
        content: 'Sorry, I encountered an error processing your message. Please try again.',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined
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
        console.error('File processing error:', error);
      }
    }

    return processedFiles;
  }

  private async handleAIResponseFiles(response: string): Promise<FileData[]> {
    // Parse AI response for file generation requests
    // This is where you'd handle cases where the AI wants to generate files
    // (e.g., filled forms, reports, documents)
    
    const files: FileData[] = [];
    
    // Example: Check if AI response contains file generation instructions
    if (response.includes('[GENERATE_FORM]')) {
      // Generate a form file
      const formContent = this.generateFormContent(response);
      const filename = `form_${uuidv4()}.pdf`;
      const filepath = path.join('uploads', filename);
      
      // Save generated file
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
    // Mock form generation - replace with actual form generation logic
    const content = `Generated form based on: ${response}`;
    return Buffer.from(content, 'utf8');
  }

  private sendMessage(ws: WebSocket, data: any) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  public start(port: number = 3001) {
    this.server.listen(port, () => {
      console.log(`Chat server running on port ${port}`);
      console.log(`WebSocket endpoint: ws://localhost:${port}/chat`);
      console.log(`HTTP API endpoint: http://localhost:${port}/api/chat`);
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

// test();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down chat server...');
  chatServer.stop();
  process.exit(0);
});

export { ChatWebSocketServer };
