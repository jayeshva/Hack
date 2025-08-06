// enhanced-chatbot-agent.ts
import { BedrockRuntime } from '@aws-sdk/client-bedrock-runtime';
import fs from 'fs';
import path from 'path';

// Define types for Bedrock responses
interface BedrockMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: BedrockToolCall[];
  tool_call_id?: string;
}

interface BedrockToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface BedrockResponse {
  content: string;
  tool_calls?: BedrockToolCall[];
}

interface BedrockInvokeParams {
  model: string;
  messages: BedrockMessage[];
  tools?: BedrockFunctionDefinition[];
  tool_choice?: 'auto' | 'none';
}

interface BedrockFunctionDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

interface FileData {
  id: string;
  name: string;
  type: string;
  size: number;
  path: string;
  url: string;
}

interface ChatOptions {
  files?: FileData[];
  generateFiles?: boolean;
}

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: BedrockToolCall[];
  tool_call_id?: string;
}

interface ChatSession {
  sessionId: string;
  messages: Message[];
  activeForm?: {
    type: string;
    schema: any;
    data: Record<string, any>;
    currentField?: string;
  };
  lastSearch?: {
    query: string;
    resultCount: number;
    timestamp: Date;
    sources?: string[];
  };
  uploadedFiles?: FileData[];
  createdAt: Date;
  lastActivity: Date;
}

interface TranscriptionResult {
  text: string;
  confidence: number;
  language: string;
}

interface FunctionCallResult {
  call_id: string;
  output: any;
}

export class ChatbotAgent {
  private bedrock: BedrockRuntime;
  private sessions = new Map<string, ChatSession>();
  private vectorStore: any; // Your vector store implementation
  private mcpClient: any; // Your MCP client
  private logger = console; // Simple logger implementation

  constructor() {
    this.bedrock = new BedrockRuntime({
      region: process.env.AWS_REGION || 'us-east-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      }
    });
    
    this.initializeVectorStore();
    this.initializeMCPClient();
  }

  private initializeVectorStore(): void {
    // Initialize your vector store here
    this.logger.info('Vector store initialized');
    this.vectorStore = {}; // Placeholder implementation
  }

  private initializeMCPClient(): void {
    // Initialize your MCP client here
    this.logger.info('MCP client initialized');
    this.mcpClient = {}; // Placeholder implementation
  }

  private getSession(sessionId: string): ChatSession {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        messages: [],
        createdAt: new Date(),
        lastActivity: new Date()
      });
    }
    
    const session = this.sessions.get(sessionId)!;
    session.lastActivity = new Date();
    return session;
  }

  async chat(sessionId: string, message: string, options?: ChatOptions): Promise<string> {
    const session = this.getSession(sessionId);
    
    // Handle file uploads
    if (options?.files && options.files.length > 0) {
      await this.processUploadedFiles(session, options.files);
    }
    
    // Add user message to history
    const userMessage: Message = {
      role: 'user',
      content: this.buildMessageWithFiles(message, options?.files || [])
    };
    session.messages.push(userMessage);
    
    // Single LLM call with enhanced file-aware system prompt
    // Using any type here as a workaround for the missing invoke method
    const response = await (this.bedrock as any).invoke({
      model: 'anthropic.claude-3-sonnet-20240229-v1:0',
      messages: [
        { role: 'system', content: this.buildEnhancedSystemPrompt(session) },
        ...session.messages
      ],
      tools: this.getFunctionDefinitions(),
      tool_choice: 'auto'
    }) as BedrockResponse;
    
    // Handle function calls
    if (response.tool_calls && response.tool_calls.length > 0) {
      const results = await this.executeFunctions(response.tool_calls, session);
      
      // Add assistant message with tool calls
      session.messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.tool_calls
      });
      
      // Add tool results
      for (const result of results) {
        session.messages.push({
          role: 'tool',
          content: JSON.stringify(result.output),
          tool_call_id: result.call_id
        });
      }
      
      // Get final response
      // Using any type here as a workaround for the missing invoke method
      const finalResponse = await (this.bedrock as any).invoke({
        model: 'anthropic.claude-3-sonnet-20240229-v1:0',
        messages: [
          { role: 'system', content: this.buildEnhancedSystemPrompt(session) },
          ...session.messages
        ]
      }) as BedrockResponse;
      
      session.messages.push({ role: 'assistant', content: finalResponse.content });
      
      // Check if we need to generate files
      // const generatedFiles = await this.handleFileGeneration(finalResponse.content, session);
      
      // return this.formatResponseWithFiles(finalResponse.content, generatedFiles);
    }
    
    // No function calls - direct response
    session.messages.push({ role: 'assistant', content: response.content });
    
    // Check for file generation in direct response
    // const generatedFiles = await this.handleFileGeneration(response.content, session);
    
    // return this.formatResponseWithFiles(response.content, generatedFiles);
    
    return response.content;
  }

  private buildMessageWithFiles(message: string, files: FileData[]): string {
    if (files.length === 0) return message;
    
    let content = message + '\n\n[FILES UPLOADED]\n';
    
    for (const file of files) {
      content += `- ${file.name} (${file.type}, ${this.formatFileSize(file.size)})\n`;
      
      // Add file content for text files
      if (this.isTextFile(file)) {
        try {
          const fileContent = fs.readFileSync(file.path, 'utf8');
          content += `Content preview:\n${fileContent.substring(0, 1000)}${fileContent.length > 1000 ? '...' : ''}\n\n`;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          content += `Error reading file content: ${errorMessage}\n\n`;
          this.logger.error(`Error reading file ${file.path}:`, error);
        }
      }
      
      // Add metadata for images
      if (file.type.startsWith('image/')) {
        content += `Image file - can be processed for OCR or analysis\n\n`;
      }
      
      // Add metadata for audio
      if (file.type.startsWith('audio/')) {
        content += `Audio file - can be transcribed or analyzed\n\n`;
      }
    }
    
    return content;
  }

  private buildEnhancedSystemPrompt(session: ChatSession): string {
    return `You are a helpful AI assistant with advanced capabilities:

CORE CAPABILITIES:
1. **Answer Questions**: Search knowledge base for accurate, sourced information
2. **Fill Forms**: Guide users through form completion step-by-step
3. **Process Files**: Handle uploaded documents, images, and audio files
4. **Generate Files**: Create forms, reports, documents as needed
5. **System Actions**: Execute various operations via MCP connections

FILE PROCESSING CAPABILITIES:
- Extract text from images (OCR)
- Transcribe audio files
- Parse documents (PDF, Word, CSV, JSON)
- Analyze image content
- Generate new files (forms, reports, certificates)

CURRENT SESSION STATE:
${this.buildSessionContext(session)}

UPLOADED FILES:
${this.buildFileContext(session)}

CONVERSATION GUIDELINES:
- Always acknowledge uploaded files and explain what you can do with them
- Use search_knowledge proactively for factual questions
- Guide form filling naturally with validation
- Offer to generate files when appropriate (forms, reports, summaries)
- Handle mixed conversations seamlessly
- Provide clear next steps and options

FUNCTION CALLING STRATEGY:
- search_knowledge: For any factual questions or information needs
- process_file: When users upload files that need analysis
- transcribe_audio: For voice messages or audio files
- generate_file: When creating documents, forms, or reports
- Form functions: For application processes
- MCP functions: For system integrations

Be proactive, helpful, and always explain what you're doing with files.`;
  }

  private buildSessionContext(session: ChatSession): string {
    let context = `Session ID: ${session.sessionId}\n`;
    context += `Created: ${session.createdAt.toISOString()}\n`;
    context += `Last Activity: ${session.lastActivity.toISOString()}\n`;
    
    if (session.activeForm) {
      context += `\nActive Form: ${session.activeForm.type}\n`;
      context += `Current Field: ${session.activeForm.currentField || 'None'}\n`;
      context += `Completion: ${Object.keys(session.activeForm.data).length} fields filled\n`;
    }
    
    if (session.lastSearch) {
      context += `\nLast Search: "${session.lastSearch.query}"\n`;
      context += `Results: ${session.lastSearch.resultCount} found\n`;
      context += `Time: ${session.lastSearch.timestamp.toISOString()}\n`;
    }
    
    return context;
  }

  private buildFileContext(session: ChatSession): string {
    if (!session.uploadedFiles || session.uploadedFiles.length === 0) {
      return 'No files currently uploaded';
    }
    
    let context = 'Recently uploaded files:\n';
    for (const file of session.uploadedFiles) {
      context += `- ${file.name} (${file.type}) - ${this.formatFileSize(file.size)}\n`;
    }
    
    return context;
  }

  private async processUploadedFiles(session: ChatSession, files: FileData[]): Promise<void> {
    // Store files in session
    session.uploadedFiles = [...(session.uploadedFiles || []), ...files];
    
    // Process files based on type
    for (const file of files) {
      try {
        if (file.type.startsWith('audio/')) {
          // Queue for transcription
          await this.queueAudioTranscription(file);
        } else if (file.type.startsWith('image/')) {
          // Queue for OCR/analysis
          await this.queueImageAnalysis(file);
        } else if (this.isTextFile(file)) {
          // Process text content immediately
          await this.processTextFile(file);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        this.logger.error(`Error processing file ${file.name}:`, errorMessage);
      }
    }
  }

  private async queueAudioTranscription(file: FileData): Promise<void> {
    // Implementation for queueing audio transcription
    this.logger.info(`Queued audio transcription for ${file.name}`);
  }

  private async queueImageAnalysis(file: FileData): Promise<void> {
    // Implementation for queueing image analysis
    this.logger.info(`Queued image analysis for ${file.name}`);
  }

  private async processTextFile(file: FileData): Promise<void> {
    // Implementation for processing text files
    this.logger.info(`Processing text file ${file.name}`);
  }

  private getFunctionDefinitions(): BedrockFunctionDefinition[] {
    return [
      // Enhanced knowledge search
      {
        name: 'search_knowledge',
        description: 'Search knowledge base for information to answer questions',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query with relevant keywords' },
            context: { type: 'string', description: 'Additional context from conversation' },
            filters: { type: 'object', description: 'Search filters (category, date, etc.)' }
          },
          required: ['query']
        }
      },
      
      // File processing functions
      {
        name: 'process_file',
        description: 'Process uploaded files for content extraction or analysis',
        parameters: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'ID of the file to process' },
            operation: { 
              type: 'string', 
              enum: ['extract_text', 'analyze_content', 'convert_format'],
              description: 'Type of processing to perform'
            }
          },
          required: ['file_id', 'operation']
        }
      },
      
      {
        name: 'transcribe_audio',
        description: 'Transcribe audio files to text',
        parameters: {
          type: 'object',
          properties: {
            file_id: { type: 'string', description: 'ID of audio file to transcribe' },
            language: { type: 'string', description: 'Language code (auto-detect if not specified)' }
          },
          required: ['file_id']
        }
      },
      
      {
        name: 'generate_file',
        description: 'Generate new files like forms, reports, or documents',
        parameters: {
          type: 'object',
          properties: {
            file_type: { 
              type: 'string', 
              enum: ['pdf_form', 'word_document', 'csv_report', 'json_data'],
              description: 'Type of file to generate'
            },
            content: { type: 'object', description: 'Content and data for the file' },
            template: { type: 'string', description: 'Template to use (optional)' }
          },
          required: ['file_type', 'content']
        }
      },
      
      // Form functions (existing)
      {
        name: 'check_form_exists',
        description: 'Check if a form type exists',
        parameters: {
          type: 'object',
          properties: {
            formType: { type: 'string', description: 'Type of form to check' }
          },
          required: ['formType']
        }
      },
      
      {
        name: 'get_form_schema',
        description: 'Get form structure and fields',
        parameters: {
          type: 'object',
          properties: {
            formType: { type: 'string', description: 'Type of form' }
          },
          required: ['formType']
        }
      },
      
      {
        name: 'validate_field',
        description: 'Validate form field input',
        parameters: {
          type: 'object',
          properties: {
            fieldName: { type: 'string', description: 'Name of the field' },
            value: { type: 'string', description: 'User input value' },
            formType: { type: 'string', description: 'Type of form' }
          },
          required: ['fieldName', 'value', 'formType']
        }
      },
      
      {
        name: 'submit_form',
        description: 'Submit completed form',
        parameters: {
          type: 'object',
          properties: {
            formType: { type: 'string', description: 'Type of form' },
            formData: { type: 'object', description: 'Complete form data' }
          },
          required: ['formType', 'formData']
        }
      },
      
      // MCP function
      {
        name: 'mcp_call',
        description: 'Execute system actions via MCP',
        parameters: {
          type: 'object',
          properties: {
            method: { type: 'string', description: 'MCP method name' },
            params: { type: 'object', description: 'Method parameters' }
          },
          required: ['method']
        }
      }
    ];
  }

  private async executeFunctions(toolCalls: BedrockToolCall[], session: ChatSession): Promise<FunctionCallResult[]> {
    const results: FunctionCallResult[] = [];
    
    for (const call of toolCalls) {
      try {
        let result;
        const args = JSON.parse(call.function.arguments);
        
        switch (call.function.name) {
          case 'search_knowledge':
            result = await this.searchKnowledge(args);
            break;
            
          case 'process_file':
            result = await this.processFile(args, session);
            break;
            
          case 'transcribe_audio':
            result = await this.transcribeAudio(args, session);
            break;
            
          case 'generate_file':
            result = await this.generateFile(args, session);
            break;
            
          // Form functions
          case 'check_form_exists':
            result = await this.checkFormExists(args);
            break;
            
          case 'get_form_schema':
            result = await this.getFormSchema(args, session);
            break;
            
          case 'validate_field':
            result = await this.validateField(args, session);
            break;
            
          case 'submit_form':
            result = await this.submitForm(args, session);
            break;
            
          case 'mcp_call':
            result = await this.mcpCall(args);
            break;
            
          default:
            result = { error: `Unknown function: ${call.function.name}` };
        }
        
        results.push({
          call_id: call.id,
          output: result
        });
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.push({
          call_id: call.id,
          output: { error: errorMessage }
        });
      }
    }
    
    return results;
  }

  // Function implementations
  private async searchKnowledge(args: { query: string; context?: string; filters?: Record<string, any> }): Promise<any> {
    // Implementation for searching knowledge base
    this.logger.info(`Searching knowledge base for: ${args.query}`);
    return {
      results: [
        { title: "Sample result 1", content: "Sample content 1", relevance: 0.95 },
        { title: "Sample result 2", content: "Sample content 2", relevance: 0.85 }
      ],
      count: 2,
      query: args.query
    };
  }

  private async checkFormExists(args: { formType: string }): Promise<any> {
    // Implementation for checking if form exists
    this.logger.info(`Checking if form exists: ${args.formType}`);
    return { exists: true, formType: args.formType };
  }

  private async getFormSchema(args: { formType: string }, session: ChatSession): Promise<any> {
    // Implementation for getting form schema
    this.logger.info(`Getting schema for form: ${args.formType}`);
    return {
      formType: args.formType,
      fields: [
        { name: "name", type: "text", required: true, label: "Full Name" },
        { name: "email", type: "email", required: true, label: "Email Address" }
      ]
    };
  }

  private async validateField(args: { fieldName: string; value: string; formType: string }, session: ChatSession): Promise<any> {
    // Implementation for validating form field
    this.logger.info(`Validating field ${args.fieldName} with value: ${args.value}`);
    return { valid: true, fieldName: args.fieldName };
  }

  private async submitForm(args: { formType: string; formData: Record<string, any> }, session: ChatSession): Promise<any> {
    // Implementation for submitting form
    this.logger.info(`Submitting form ${args.formType} with data:`, args.formData);
    return { success: true, formType: args.formType, id: `form_${Date.now()}` };
  }

  private async mcpCall(args: { method: string; params?: Record<string, any> }): Promise<any> {
    // Implementation for MCP call
    this.logger.info(`MCP call to method: ${args.method}`);
    return { success: true, method: args.method, result: "Operation completed" };
  }

  // File processing implementations
  private async processFile(args: { file_id: string, operation: string }, session: ChatSession): Promise<any> {
    const file = session.uploadedFiles?.find(f => f.id === args.file_id);
    if (!file) {
      return { error: 'File not found' };
    }
    
    try {
      switch (args.operation) {
        case 'extract_text':
          if (file.type === 'application/pdf') {
            return await this.extractPDFText(file);
          } else if (file.type.startsWith('image/')) {
            return await this.performOCR(file);
          } else if (this.isTextFile(file)) {
            const content = fs.readFileSync(file.path, 'utf8');
            return { success: true, text: content };
          }
          break;
          
        case 'analyze_content':
          return await this.analyzeFileContent(file);
          
        case 'convert_format':
          return await this.convertFileFormat(file);
      }
      
      return { error: 'Operation not supported for this file type' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { error: `File processing failed: ${errorMessage}` };
    }
  }

  private async performOCR(file: FileData): Promise<any> {
    // Implementation for OCR
    this.logger.info(`Performing OCR on image: ${file.name}`);
    return { success: true, text: "Sample OCR text content" };
  }

  private async extractPDFText(file: FileData): Promise<any> {
    // Implementation for extracting text from PDF
    this.logger.info(`Extracting text from PDF: ${file.name}`);
    return { success: true, text: "Sample PDF text content" };
  }

  private async analyzeFileContent(file: FileData): Promise<any> {
    // Implementation for analyzing file content
    this.logger.info(`Analyzing content of file: ${file.name}`);
    return { success: true, analysis: "Sample file analysis" };
  }

  private async convertFileFormat(file: FileData): Promise<any> {
    // Implementation for converting file format
    this.logger.info(`Converting format of file: ${file.name}`);
    return { success: true, convertedFile: { name: `converted_${file.name}` } };
  }

  private async transcribeAudio(args: { file_id: string, language?: string }, session: ChatSession): Promise<any> {
    const file = session.uploadedFiles?.find(f => f.id === args.file_id);
    if (!file || !file.type.startsWith('audio/')) {
      return { error: 'Audio file not found' };
    }
    
    try {
      // Use AWS Transcribe or similar service
      const transcription = await this.performAudioTranscription(file, args.language);
      return {
        success: true,
        transcription: transcription.text,
        confidence: transcription.confidence,
        language: transcription.language
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { error: `Transcription failed: ${errorMessage}` };
    }
  }

  private async performAudioTranscription(file: FileData, language?: string): Promise<TranscriptionResult> {
    // Implementation for audio transcription
    this.logger.info(`Transcribing audio file: ${file.name}`);
    return { text: 'Transcribed text would go here', confidence: 0.95, language: language || 'en' };
  }

  private async generateFile(args: { file_type: string, content: any, template?: string }, session: ChatSession): Promise<any> {
    try {
      const fileName = `generated_${Date.now()}.${this.getFileExtension(args.file_type)}`;
      const filePath = path.join('uploads', fileName);
      
      let fileBuffer: Buffer = Buffer.from(JSON.stringify(args.content, null, 2), 'utf8');;
      
      switch (args.file_type) {
        case 'pdf_form':
          fileBuffer = await this.generatePDF(args.content, args.template);
          break;
          
        case 'word_document':
          fileBuffer = await this.generateWordDoc(args.content, args.template);
          break;
          
        case 'csv_report':
          // fileBuffer = Buffer.from(this.generateCSV(args.content), 'utf8');
          break;
          
        case 'json_data':
          fileBuffer = Buffer.from(JSON.stringify(args.content, null, 2), 'utf8');
          break;
          
        default:
          return { error: 'Unsupported file type' };
      }
      
      // await fs.promises.writeFile(filePath, fileBuffer);
      
      const fileData: FileData = {
        id: `generated_${Date.now()}`,
        name: fileName,
        type: this.getMimeType(args.file_type),
        size: fileBuffer.length,
        path: filePath,
        url: `/uploads/${fileName}`
      };
      
      // Add to session files
      session.uploadedFiles = session.uploadedFiles || [];
      session.uploadedFiles.push(fileData);
      
      return {
        success: true,
        file: fileData,
        message: `Generated ${args.file_type} successfully`
      };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { error: `File generation failed: ${errorMessage}` };
    }
  }

  private async generateFormFile(form: ChatSession['activeForm']): Promise<FileData | null> {
    if (!form) return null;
    
    try {
      const fileName = `form_${form.type}_${Date.now()}.pdf`;
      const filePath = path.join('uploads', fileName);
      
      // Generate PDF with form data
      const fileBuffer = await this.generatePDF(form.data, form.type);
      await fs.promises.writeFile(filePath, fileBuffer);
      
      return {
        id: `form_${Date.now()}`,
        name: fileName,
        type: 'application/pdf',
        size: fileBuffer.length,
        path: filePath,
        url: `/uploads/${fileName}`
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error generating form file: ${errorMessage}`);
      return null;
    }
  }

  private async generateReportFile(session: ChatSession): Promise<FileData | null> {
    try {
      const fileName = `report_${Date.now()}.pdf`;
      const filePath = path.join('uploads', fileName);
      
      // Generate report based on session data
      const reportData = {
        sessionId: session.sessionId,
        timestamp: new Date().toISOString(),
        summary: "Session report"
      };
      
      const fileBuffer = await this.generatePDF(reportData, 'report');
      await fs.promises.writeFile(filePath, fileBuffer);
      
      return {
        id: `report_${Date.now()}`,
        name: fileName,
        type: 'application/pdf',
        size: fileBuffer.length,
        path: filePath,
        url: `/uploads/${fileName}`
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Error generating report file: ${errorMessage}`);
      return null;
    }
  }

  // Helper methods
  private isTextFile(file: FileData): boolean {
    const textTypes = ['text/plain', 'text/csv', 'application/json', 'text/html'];
    return textTypes.includes(file.type) || file.name.endsWith('.txt') || file.name.endsWith('.md');
  }

  private formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  private getFileExtension(fileType: string): string {
    const extensions: Record<string, string> = {
      'pdf_form': 'pdf',
      'word_document': 'docx',
      'csv_report': 'csv',
      'json_data': 'json'
    };
    return extensions[fileType] || 'txt';
  }

  private getMimeType(fileType: string): string {
    const mimeTypes: Record<string, string> = {
      'pdf_form': 'application/pdf',
      'word_document': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'csv_report': 'text/csv',
      'json_data': 'application/json'
    };
    return mimeTypes[fileType] || 'text/plain';
  }

  private async generatePDF(content: any, template?: string): Promise<Buffer> {
    // Implementation for PDF generation
    this.logger.info(`Generating PDF with template: ${template || 'default'}`);
    return Buffer.from('PDF content would go here');
  }

  private async generateWordDoc(content: any, template?: string): Promise<Buffer> {
    // Implementation for Word doc generation
    this.logger.info(`Generating Word document with template: ${template || 'default'}`);
    return Buffer.from('Word document content would go here');
  }
}

