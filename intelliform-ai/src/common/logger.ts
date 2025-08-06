import pino from 'pino';

// Configure logger
const logLevel = process.env.LOG_LEVEL || 'info' || 'debug';

export const logger = pino({
  level: logLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
  base: undefined,
});

// Create namespaced loggers for different modules
export const createLogger = (namespace: string) => {
  return logger.child({ namespace });
};

export default logger;
