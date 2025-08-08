import { buildFormAssistantToolset } from "../../tools/index";
import { llm } from "../../config/llm";
import { StateType } from "../graph";
import { logger } from "../../common/logger";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { ConversationTokenBufferMemory } from "langchain/memory";

// Get the tools
const tools = buildFormAssistantToolset();

// Enhanced system prompt with strict accuracy requirements
const SYSTEM_PROMPT = `You are an intelligent, reliable AI assistant designed to help users apply for government or enterprise services by filling out forms step-by-step.

## CRITICAL ACCURACY REQUIREMENTS:
1. **NEVER modify, add, or remove form fields** - Always use EXACTLY the fields returned by the fetch_form_structure tool
2. **Always provide consistent information** - Once you've fetched form structure, use that exact structure in all responses
3. **Store and reference tool results** - Keep track of fetched data and reuse it instead of inventing new information
4. **Be precise with field names and types** - Use the exact field names, types, and requirements from the tool response

## Core Capabilities:
- Remember and use information from the entire conversation history
- Maintain context about users, including their names and details they've shared
- Help with form applications while keeping track of user information
- Provide ACCURATE and CONSISTENT form information based on tool results

## Your Capabilities:
You have access to tools that allow you to:
- Fetch available forms
- Get form structure and fields by using the fetch_form_structure tool providing the form ID
- Update form field values
- Submit completed forms
- Manage the form filling session

## Form Structure Protocol:
When describing form structures:
1. ONLY use the fields returned by the fetchFormStructureById tool
2. Present fields in the EXACT format returned by the tool:
   - Field name (exactly as returned)
   - Field type (text, date, radio, checkbox, etc.)
   - Required status (true/false)
   - Label (as provided)
   - Instructions (as provided)
   - Options (for radio/select fields, if provided)
3. Do NOT add fields that weren't in the tool response
4. Do NOT modify field names or types
5. Do NOT change requirements or instructions

## Form Filling Protocol:

1. **Starting an Application:**
   - When a user expresses interest in applying for a service, use the available tools to fetch forms
   - Select the appropriate form and fetch its structure using the exact form ID
   - Store the fetched structure and use it consistently throughout the conversation
   - Begin asking questions for each required field IN THE ORDER PROVIDED BY THE TOOL

2. **Collecting Information:**
   - Ask for one field at a time, using the exact field name and label from the tool response
   - Remember and use information already provided by the user
   - Mention the exact requirements from the tool response (format, constraints, etc.)
   - After receiving an answer, update the form field using the appropriate tool
   - Move to the next field in the exact order from the tool response

3. **Handling Form Structure Queries:**
   - When asked about form structure, ALWAYS refer to the previously fetched data
   - If you haven't fetched the structure yet, fetch it first using the tool
   - Present the structure EXACTLY as returned by the tool, without modifications
   - Use a clear, organized format but maintain field accuracy

4. **Completing Applications:**
   - Verify all required fields from the tool response are collected
   - Use the submit tool only when all required fields have values
   - Provide confirmation to the user with accurate form details

## Important Guidelines:
- Be conversational and friendly while maintaining accuracy
- ALWAYS remember what users tell you about themselves
- Keep track of tool responses and use them as the single source of truth
- Never hallucinate or invent form fields or requirements
- Handle errors gracefully
- Always maintain context about the ongoing form filling process`;

// Helper function to format messages for Bedrock compatibility
function formatMessagesForBedrock(messages: BaseMessage[]): BaseMessage[] {
  return messages.map(msg => {
    if (typeof msg.content !== 'string') {
      let textContent: string;

      if (Array.isArray(msg.content)) {
        textContent = msg.content
          .map(item => {
            if (typeof item === 'string') {
              return item;
            } else if (item && typeof item === 'object') {
              if ('text' in item && typeof item.text === 'string') {
                return item.text;
              } else if ('type' in item && item.type === 'text' && 'text' in item) {
                return item.text;
              } else if ('type' in item && item.type === 'image_url') {
                return '[Image]';
              } else {
                return JSON.stringify(item);
              }
            }
            return '';
          })
          .filter(text => text)
          .join(' ');
      } else if (msg.content && typeof msg.content === 'object') {
        textContent = JSON.stringify(msg.content);
      } else {
        textContent = String(msg.content);
      }

      if (msg._getType() === 'human') {
        return new HumanMessage(textContent);
      } else if (msg._getType() === 'ai') {
        return new AIMessage(textContent);
      } else if (msg._getType() === 'system') {
        return new SystemMessage(textContent);
      } else {
        return {
          ...msg,
          content: textContent,
        } as BaseMessage;
      }
    }
    return msg;
  });
}

// Store tool results for consistency
const toolResultsCache = new Map<string, any>();

export const formAssistantAgent = async (input: string, session: StateType) => {
  logger.info(`formAssistantAgent input: ${input}`);

  try {
    // Initialize or retrieve memory
    let memory = session.memory;
    if (!memory || typeof memory.loadMemoryVariables !== "function") {
      memory = new ConversationTokenBufferMemory({
        memoryKey: "chat_history",
        returnMessages: true,
        llm,
        maxTokenLimit: 2000,
      });
      session.memory = memory;
    }

    // Load existing chat history from memory
    const memoryVars = await memory.loadMemoryVariables({});
    let chatHistory = memoryVars.chat_history || [];

    if (session.chat_history && Array.isArray(session.chat_history)) {
      if (session.chat_history.length > chatHistory.length) {
        chatHistory = session.chat_history;
      }
    }

    // Format chat history for Bedrock compatibility
    chatHistory = formatMessagesForBedrock(chatHistory);

    logger.info(`Chat history length: ${chatHistory.length}`);

    // Create prompt template
    const prompt = ChatPromptTemplate.fromMessages([
      ["system", SYSTEM_PROMPT],
      new MessagesPlaceholder("chat_history"),
      ["human", "{input}"],
    ]);

    const MAX_ITERATIONS = 5;
    let currentInput = input.trim();
    let iterations = 0;
    let finalResponse = "";

    // Tool execution loop
    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Format the prompt with current context
      const formattedPrompt = await prompt.formatMessages({
        chat_history: chatHistory,
        input: currentInput,
      });

      // Add tool descriptions
      const toolDescriptions = tools.map(tool => {
        const inputSchema = tool.schema ?
          `\n  Input schema: ${JSON.stringify(tool.schema._def || tool.schema, null, 2)}` :
          '\n  Input: {}';
        return `- ${tool.name}: ${tool.description}${inputSchema}`;
      }).join('\n');

      // Get cached form structure if available
      const cachedFormStructure = session.form_id ? 
        toolResultsCache.get(`form_structure_${session.form_id}`) : null;
      
      const contextInfo = cachedFormStructure ? 
        `\n## CACHED FORM STRUCTURE FOR ${session.form_id}:\n${JSON.stringify(cachedFormStructure, null, 2)}\nUSE THIS EXACT STRUCTURE - DO NOT MODIFY OR ADD FIELDS\n` : '';

      const enhancedSystemMessage = `${SYSTEM_PROMPT}

## CONVERSATION CONTEXT:
You are in an ongoing conversation. Remember what the user has told you previously.
${contextInfo}

Available tools:
${toolDescriptions}

## CRITICAL TOOL USAGE RULES:
1. Always provide the correct INPUT format for each tool
2. For form structure queries, ALWAYS use the exact data returned by fetchFormStructureById
3. NEVER invent or modify form fields - use only what the tool returns
4. Cache and reuse tool results for consistency
5. When describing forms, list ONLY the fields returned by the tool, in the exact format

## RESPONSE FORMAT RULES:
- When you need to use a tool AND provide an answer:
  TOOL: [tool_name]
  INPUT: [tool_input_as_json]
  RESPONSE: [your_answer_using_EXACT_tool_results]

- When you only need to use a tool:
  TOOL: [tool_name]
  INPUT: [tool_input_as_json]

- When you have a final answer without needing tools:
  RESPONSE: [your_message_using_cached_data_if_available]

## ACCURACY REQUIREMENTS:
- If describing a form structure, use EXACTLY the fields from the tool response
- Present fields in a clear format but with EXACT names, types, and requirements
- Do not add interpretive text that changes field meanings
- Maintain consistency across all responses about the same form`;

      // Update system message
      formattedPrompt[0] = new SystemMessage(enhancedSystemMessage);

      const bedrockCompatibleMessages = formatMessagesForBedrock(formattedPrompt);

      // Call the LLM
      let llmResponse;
      try {
        llmResponse = await llm.invoke(bedrockCompatibleMessages);
      } catch (llmError) {
        logger.error(`LLM invocation error: ${llmError}`);
        const simplifiedMessages = [
          new SystemMessage(enhancedSystemMessage),
          ...chatHistory.slice(-6),
          new HumanMessage(currentInput)
        ];
        llmResponse = await llm.invoke(simplifiedMessages);
      }

      const responseText = typeof llmResponse.content === 'string'
        ? llmResponse.content
        : JSON.stringify(llmResponse.content);

      logger.info(`Iteration ${iterations} LLM response: ${responseText}`);

      // Parse the response for tool calls
      const hasToolCall = responseText.includes('TOOL:') && responseText.includes('INPUT:');
      const hasResponse = responseText.includes('RESPONSE:');

      if (hasToolCall) {
        const toolMatch = responseText.match(/TOOL:\s*([^\n]+)/);
        const inputMatch = responseText.match(/INPUT:\s*([\s\S]*?)(?=\n\n|RESPONSE:|$)/);
        const responseMatch = responseText.match(/RESPONSE:\s*([\s\S]+)/);

        if (toolMatch && inputMatch) {
          const toolName = toolMatch[1].trim();
          let toolInput;

          try {
            const inputStr = inputMatch[1].trim();
            toolInput = JSON.parse(inputStr);
          } catch {
            const inputStr = inputMatch[1].trim();
            if (inputStr && inputStr !== '{}') {
              toolInput = { query: inputStr };
            } else {
              toolInput = {};
            }
          }

          // Find and execute the tool
          const tool = tools.find(t => t.name === toolName);
          if (tool) {
            logger.info(`Executing tool: ${toolName} with input: ${JSON.stringify(toolInput)}`);

            try {
              let preparedInput = toolInput;

              // Prepare input for specific tools
              if (toolName === 'ReadGovermentDocs' || toolName === 'readGovermentDocs') {
                if (!toolInput || Object.keys(toolInput).length === 0) {
                  preparedInput = { query: "government services and forms" };
                } else if (typeof toolInput === 'string') {
                  preparedInput = { query: toolInput };
                }
              }

              if (toolName.toLowerCase().includes('form') && toolInput) {
                if (toolInput.id && !toolInput.formId) {
                  preparedInput = { ...toolInput, formId: toolInput.id };
                } else if (toolInput.formId) {
                  preparedInput = { input: toolInput.formId };
                }
              }

              const toolResult = await tool.invoke(preparedInput);
              logger.info(`Tool result: ${JSON.stringify(toolResult)}`);

              // Cache form structure results for consistency
              if (toolName === 'fetchFormStructureById' || toolName === 'fetch_form_structure') {
                const formId = toolResult.formId || preparedInput.formId || preparedInput.input;
                if (formId && toolResult.fields) {
                  toolResultsCache.set(`form_structure_${formId}`, toolResult);
                  logger.info(`Cached form structure for ${formId}`);
                }
              }

              // Update session with tool results
              if (toolResult && typeof toolResult === 'object' && !toolResult.error) {
                session = {
                  ...session,
                  form_id: toolResult.formId || toolResult.form_id || session.form_id,
                  form_name: toolResult.formName || toolResult.form_name || session.form_name,
                  form_fields: toolResult.fields || toolResult.form_fields || session.form_fields,
                  current_field: toolResult.current_field || session.current_field,
                  last_field: toolResult.last_field || session.last_field,
                  awaiting_input: toolResult.awaiting_input ?? session.awaiting_input,
                  form_status: toolResult.form_status || session.form_status,
                  is_form_filling_started: toolResult.is_form_filling_started ?? session.is_form_filling_started,
                };
              }

              if (responseMatch) {
                // If we have a RESPONSE section, ensure it uses the tool results accurately
                let responseText = responseMatch[1].trim();
                
                // If this was a form structure query, format the response properly
                if ((toolName === 'fetchFormStructureById' || toolName === 'fetch_form_structure') && toolResult.fields) {
                  const fields = toolResult.fields;
                  const formattedFields = fields.map((field: any) => {
                    let fieldDesc = `- **${field.label || field.name}** (${field.type}${field.required ? ', required' : ', optional'})`;
                    if (field.instruction) {
                      fieldDesc += `: ${field.instruction}`;
                    }
                    if (field.options) {
                      fieldDesc += ` Options: ${field.options.join(', ')}`;
                    }
                    return fieldDesc;
                  }).join('\n');

                  finalResponse = `Here's the structure of the ${toolResult.formName || 'form'} (Form ID: ${toolResult.formId}):\n\n${formattedFields}\n\nWould you like to proceed with filling out this form?`;
                } else {
                  finalResponse = responseText;
                }
                break;
              } else {
                // Prepare next iteration with tool result
                if (toolResult && toolResult.error) {
                  currentInput = `Tool ${toolName} returned an error: ${toolResult.error}. Please provide an alternative approach or inform the user.`;
                } else {
                  // For form structure queries, enforce using the exact result
                  if ((toolName === 'fetchFormStructureById' || toolName === 'fetch_form_structure') && toolResult.fields) {
                    currentInput = `Tool ${toolName} returned the form structure. Create a RESPONSE that lists EXACTLY these fields: ${JSON.stringify(toolResult)}. Do not add any fields not in this result.`;
                  } else {
                    currentInput = `Tool ${toolName} returned: ${JSON.stringify(toolResult)}. Based on this EXACT result, provide a final RESPONSE to answer the user's original question: "${input.trim()}"`;
                  }
                }
              }

            } catch (toolError) {
              logger.error(`Tool execution error: ${toolError}`);
              currentInput = `Tool ${toolName} failed with error: ${toolError}. Please provide a RESPONSE to answer the user's question directly.`;
            }
          } else {
            logger.warn(`Tool ${toolName} not found`);
            currentInput = `Tool ${toolName} is not available. Please provide a RESPONSE to answer the user's question directly.`;
          }
        }
      } else if (responseText.includes('RESPONSE:')) {
        const responseMatch = responseText.match(/RESPONSE:\s*([\s\S]+)/);
        if (responseMatch) {
          finalResponse = responseMatch[1].trim();
          break;
        }
      } else {
        finalResponse = responseText;
        break;
      }
    }

    if (!finalResponse) {
      finalResponse = "I'm ready to help you with your application. What would you like to apply for?";
    }

    // Save the interaction to memory
    await memory.saveContext(
      { input: input.trim() },
      { output: finalResponse }
    );

    const updatedChatHistory = [
      ...chatHistory,
      new HumanMessage(input.trim()),
      new AIMessage(finalResponse)
    ];

    return {
      response: finalResponse,
      ...session,
      memory,
      chat_history: updatedChatHistory,
    };

  } catch (error) {
    logger.error(`formAssistantAgent failed: ${error}`);

    const errorResponse = "I encountered an error while processing your request. Please try again.";

    try {
      if (session.memory) {
        await session.memory.saveContext(
          { input: input.trim() },
          { output: errorResponse }
        );
      }
    } catch (memoryError) {
      logger.error(`Failed to save error context to memory: ${memoryError}`);
    }

    return {
      response: errorResponse,
      ...session,
    };
  }
};
// Alternative: Simple tool-calling implementation without agent framework
export const formAssistantAgentSimple = async (input: string, session: StateType) => {
  logger.info(`formAssistantAgentSimple input: ${input}`);

  try {
    // Initialize memory
    let memory = session.memory;
    if (!memory) {
      memory = new ConversationTokenBufferMemory({
        memoryKey: "chat_history",
        returnMessages: true,
        llm,
        maxTokenLimit: 2000,
      });
      session.memory = memory;
    }

    const memoryVars = await memory.loadMemoryVariables({});
    const chatHistory = formatMessagesForBedrock(memoryVars.chat_history || []);

    // Create a function-calling prompt
    const toolSchemas = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema || {}
    }));

    const systemMessageWithTools = `${SYSTEM_PROMPT}

You have access to the following functions:
${JSON.stringify(toolSchemas, null, 2)}

To use a function, respond with a JSON object in this format:
{
  "function_call": {
    "name": "function_name",
    "arguments": {}
  }
}

For normal responses, respond with:
{
  "message": "your response to the user"
}`;

    // Create messages for LLM
    const messages = [
      new SystemMessage(systemMessageWithTools),
      ...chatHistory.slice(-6), // Keep last 6 messages for context
      new HumanMessage(input)
    ];

    // Invoke LLM
    const llmResponse = await llm.invoke(messages);
    const responseContent = typeof llmResponse.content === 'string'
      ? llmResponse.content
      : JSON.stringify(llmResponse.content);

    // Try to parse as JSON
    let parsedResponse;
    try {
      parsedResponse = JSON.parse(responseContent);
    } catch {
      // If not JSON, treat as plain message
      parsedResponse = { message: responseContent };
    }

    // Handle function calls
    if (parsedResponse.function_call) {
      const { name, arguments: args } = parsedResponse.function_call;
      const tool = tools.find(t => t.name === name);

      if (tool) {
        const toolResult = await tool.invoke(args);

        // Update session with tool results
        if (toolResult && typeof toolResult === 'object') {
          Object.assign(session, {
            form_id: toolResult.form_id || session.form_id,
            form_name: toolResult.form_name || session.form_name,
            form_fields: toolResult.form_fields || session.form_fields,
            current_field: toolResult.current_field || session.current_field,
            last_field: toolResult.last_field || session.last_field,
            awaiting_input: toolResult.awaiting_input ?? session.awaiting_input,
            form_status: toolResult.form_status || session.form_status,
            is_form_filling_started: true,
          });
        }

        // Get follow-up response
        const followUpMessages = [
          ...messages,
          new SystemMessage(`Function ${name} returned: ${JSON.stringify(toolResult)}`),
          new HumanMessage("Please provide an appropriate response to the user based on this result.")
        ];

        const followUpResponse = await llm.invoke(followUpMessages);
        const finalMessage = typeof followUpResponse.content === 'string'
          ? followUpResponse.content
          : "I've processed your request. How can I help you further?";

        await memory.saveContext(
          { input: input.trim() },
          { output: finalMessage }
        );

        return {
          response: finalMessage,
          ...session,
          memory,
        };
      }
    }

    // Regular message response
    const finalMessage = parsedResponse.message || responseContent;

    await memory.saveContext(
      { input: input.trim() },
      { output: finalMessage }
    );

    return {
      response: finalMessage,
      ...session,
      memory,
    };

  } catch (error) {
    logger.error(`formAssistantAgentSimple failed: ${error}`);
    return {
      response: "I encountered an error. Please try again.",
      ...session,
    };
  }
};