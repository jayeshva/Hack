import { ChatPromptTemplate } from '@langchain/core/prompts';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { BedrockChat } from '@langchain/community/chat_models/bedrock';
import { z } from 'zod';
import { StructuredOutputParser } from 'langchain/output_parsers';
import { createLogger } from '../common/logger';
import { awsConfig } from '../config';

const logger = createLogger('intent-classifier');

// Initialize Bedrock client
const model = new BedrockChat({
  model: 'anthropic.claude-3-sonnet-20240229-v1:0',
  region: awsConfig.region,
  credentials: {
    accessKeyId: awsConfig.accessKeyId,
    secretAccessKey: awsConfig.secretAccessKey,
  },
});

// Define the schema for intent classification output
const intentSchema = z.object({
  intent: z.enum([
    'form_request', // User wants to fill a specific form
    'form_field', // User is providing information for a form field
    'question', // User is asking a question about the form or process
    'correction', // User wants to correct previously provided information
    'restart', // User wants to start over
    'help', // User needs help
    'cancel', // User wants to cancel the process
    'other', // Other intents
  ]),
  confidence: z.number().min(0).max(1),
  formType: z.string().optional(), // The type of form the user is requesting
  fieldName: z.string().optional(), // The field the user is providing information for
  value: z.string().optional(), // The value provided by the user
  question: z.string().optional(), // The question asked by the user
});

// Create a parser based on the schema
const parser = StructuredOutputParser.fromZodSchema(intentSchema);

// Create a prompt template for intent classification
const promptTemplate = ChatPromptTemplate.fromMessages([
  ['system', `You are an AI assistant that helps classify user intents for a form-filling application.
  
The user might be:
1. Requesting to fill a specific form
2. Providing information for a form field
3. Asking a question about the form or process
4. Correcting previously provided information
5. Requesting to start over
6. Asking for help
7. Canceling the process
8. Something else

Analyze the user's message and classify their intent. Return a JSON object with the following structure:
{
  "intent": "form_request" | "form_field" | "question" | "correction" | "restart" | "help" | "cancel" | "other",
  "confidence": <number between 0 and 1>,
  "formType": <string, optional - the type of form requested>,
  "fieldName": <string, optional - the field name the user is providing information for>,
  "value": <string, optional - the value provided by the user>,
  "question": <string, optional - the question asked by the user>
}

Be precise and concise in your classification.`],
  ['human', '{input}'],
]);

/**
 * Classify the intent of a user message
 * @param message The user's message
 * @returns Classified intent with confidence score and additional information
 */
export async function classifyIntent(message: string) {
  try {
    logger.debug('Classifying intent for message');
    
    // Create the chain
    const chain = promptTemplate.pipe(model).pipe(new StringOutputParser());
    
    // Run the chain
    const result = await chain.invoke({
      input: message,
    });
    
    // Parse the result
    const parsedResult = await parser.parse(result);
    
    logger.debug('Intent classification successful', { intent: parsedResult.intent });
    
    return parsedResult;
  } catch (error) {
    logger.error('Error in intent classification:', error);
    throw new Error(`Intent classification failed: ${(error as Error).message}`);
  }
}

/**
 * Identify the form type from a user message
 * @param message The user's message
 * @returns The identified form type or null if not found
 */
export async function identifyFormType(message: string): Promise<string | null> {
  try {
    const intent = await classifyIntent(message);
    
    if (intent.intent === 'form_request' && intent.formType) {
      return intent.formType;
    }
    
    return null;
  } catch (error) {
    logger.error('Error in form type identification:', error);
    return null;
  }
}

export default {
  classifyIntent,
  identifyFormType,
};
