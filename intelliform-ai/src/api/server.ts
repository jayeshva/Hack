import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createLogger } from '../common/logger';
import { config } from '../config';
import routes from './routes';

const logger = createLogger('server');

/**
 * Error with status code for API errors
 */
export class ApiError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = 'ApiError';
  }
}

/**
 * Create and configure the Express application
 */
export function createApp() {
  const app = express();

  // Apply middleware
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '50mb' })); // Increased limit for audio data
  app.use(express.urlencoded({ extended: true }));

  // Request logging middleware
  app.use((req: Request, _res: Response, next: NextFunction) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
  });

  // API routes
  app.use('/api', routes);

  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // 404 handler
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // Error handling middleware
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Error handling request:', err);

    if (err instanceof ApiError) {
      return res.status(err.statusCode).json({
        error: err.message,
      });
    }

    return res.status(500).json({
      error: 'Internal Server Error',
    });
  });

  return app;
}

/**
 * Start the server on the specified port
 * @param port The port to listen on
 * @returns The HTTP server instance
 */
export async function startServer(port: number) {
  try {
    const app = createApp();
    
    // Start the server
    const server = app.listen(port, () => {
      logger.info(`Server started on port ${port}`);
      logger.info(`Environment: ${config.NODE_ENV}`);
    });

    // Handle server errors
    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(`Port ${port} is already in use`);
      } else {
        logger.error('Server error:', error);
      }
      process.exit(1);
    });

    return server;
  } catch (error) {
    logger.error('Failed to start server:', error);
    throw error;
  }
}

export default { createApp, startServer };
