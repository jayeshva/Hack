import OpenAI from 'openai';
import { createLogger } from '../common/logger';
import { SpeechToTextRequest, SpeechToTextResponse } from '../types';

const logger = createLogger('whisper');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Convert speech to text using OpenAI's Whisper model
 * @param request Speech to text request containing audio data
 * @returns Transcribed text and confidence score
 */
export async function speechToText(request: SpeechToTextRequest): Promise<SpeechToTextResponse> {
  try {
    logger.debug('Processing speech to text request');
    
    // Convert base64 to buffer
    const buffer = Buffer.from(request.audio, 'base64');
    
    // Create a blob from the buffer
    const blob = new Blob([buffer]);
    
    // Create a file from the blob
    const file = new File([blob], 'audio.wav', { type: 'audio/wav' });
    
    // Call Whisper API
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: request.language,
      response_format: 'json',
    });
    
    logger.debug('Speech to text conversion successful');
    
    return {
      text: transcription.text,
      confidence: 0.95, // Whisper doesn't provide confidence scores, so we use a default value
    };
  } catch (error) {
    logger.error('Error in speech to text conversion:', error);
    throw new Error(`Speech to text conversion failed: ${(error as Error).message}`);
  }
}

/**
 * Detect language from audio using Whisper
 * @param audio Base64 encoded audio
 * @returns Detected language code
 */
export async function detectLanguage(audio: string): Promise<string> {
  try {
    logger.debug('Detecting language from audio');
    
    // Convert base64 to buffer
    const buffer = Buffer.from(audio, 'base64');
    
    // Create a blob from the buffer
    const blob = new Blob([buffer]);
    
    // Create a file from the blob
    const file = new File([blob], 'audio.wav', { type: 'audio/wav' });
    
    // Call Whisper API with language detection
    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      response_format: 'verbose_json',
    });
    
    // Extract language from response
    const language = (transcription as any).language;
    
    logger.debug(`Language detected: ${language}`);
    
    return language;
  } catch (error) {
    logger.error('Error in language detection:', error);
    throw new Error(`Language detection failed: ${(error as Error).message}`);
  }
}

export default {
  speechToText,
  detectLanguage,
};
