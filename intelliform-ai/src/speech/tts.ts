import OpenAI from 'openai';
import { createLogger } from '../common/logger';
import { TextToSpeechRequest, TextToSpeechResponse } from '../types';

const logger = createLogger('tts');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Map of language codes to voice options
const languageVoiceMap: Record<string, string[]> = {
  en: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
  es: ['alloy', 'nova', 'shimmer'],
  fr: ['alloy', 'nova', 'shimmer'],
  de: ['alloy', 'nova', 'shimmer'],
  it: ['alloy', 'nova', 'shimmer'],
  pt: ['alloy', 'nova', 'shimmer'],
  hi: ['alloy', 'nova'],
  // Add more languages as needed
};

// Default voice to use if no voice is specified
const defaultVoice = 'nova';

/**
 * Convert text to speech using OpenAI's TTS model
 * @param request Text to speech request containing text and language
 * @returns Base64 encoded audio
 */
export async function textToSpeech(request: TextToSpeechRequest): Promise<TextToSpeechResponse> {
  try {
    logger.debug('Processing text to speech request');
    
    // Determine voice to use based on language and requested voice
    let voice = request.voice || defaultVoice;
    
    // Check if the requested voice is available for the language
    const availableVoices = languageVoiceMap[request.language] || languageVoiceMap.en;
    if (!request.voice || !availableVoices.includes(request.voice)) {
      voice = availableVoices[0] || defaultVoice;
    }
    
    // Call OpenAI TTS API
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice,
      input: request.text,
    });
    
    // Convert the response to a buffer
    const buffer = Buffer.from(await mp3.arrayBuffer());
    
    // Convert buffer to base64
    const base64Audio = buffer.toString('base64');
    
    logger.debug('Text to speech conversion successful');
    
    return {
      audio: base64Audio,
    };
  } catch (error) {
    logger.error('Error in text to speech conversion:', error);
    throw new Error(`Text to speech conversion failed: ${(error as Error).message}`);
  }
}

export default {
  textToSpeech,
};
