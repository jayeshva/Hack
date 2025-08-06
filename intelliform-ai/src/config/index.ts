import { z } from 'zod';
import { logger } from '../common/logger';
export * from "./llm"

import dotenv from 'dotenv';
import { llm } from './llm';

dotenv.config();

// Define the schema for environment variables
const envSchema = z.object({
  // AWS Configuration
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  AWS_REGION: z.string().min(1),
  
  // OpenAI Configuration
  OPENAI_API_KEY: z.string().min(1),
  
  // LangSmith Configuration (optional)
  LANGSMITH_API_KEY: z.string().optional(),
  LANGSMITH_PROJECT: z.string().optional(),
  
  // Server Configuration
  PORT: z.string().transform(Number).optional().default('3000'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  
  // Security
  JWT_SECRET: z.string().min(1),
  JWT_EXPIRY: z.string().default('24h'),
  
  // Database (if needed)
  DB_URI: z.string().optional(),
  
  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  
  // Form Templates Storage
  FORM_TEMPLATES_PATH: z.string().default('./data/templates'),
});

// Parse and validate environment variables
const parseEnv = () => {
  try {
    return envSchema.parse(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const missingVars = error.errors
        .filter(err => err.code === 'invalid_type' && err.received === 'undefined')
        .map(err => err.path.join('.'));
      
      if (missingVars.length > 0) {
        logger.error(`Missing required environment variables: ${missingVars.join(', ')}`);
      }
      
      logger.error('Environment validation failed:', error.errors);
    } else {
      logger.error('Unknown error during environment validation:', error);
    }
    
    process.exit(1);
  }
};

// Export the validated config
export const config = parseEnv();

// Export specific config sections
export const awsConfig = {
  accessKeyId: config.AWS_ACCESS_KEY_ID,
  secretAccessKey: config.AWS_SECRET_ACCESS_KEY,
  region: config.AWS_REGION,
};

export const serverConfig = {
  port: config.PORT,
  nodeEnv: config.NODE_ENV,
  isProduction: config.NODE_ENV === 'production',
  isDevelopment: config.NODE_ENV === 'development',
  isTest: config.NODE_ENV === 'test',
};

export const securityConfig = {
  jwtSecret: config.JWT_SECRET,
  jwtExpiry: config.JWT_EXPIRY,
};

export default config;
