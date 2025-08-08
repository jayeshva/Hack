import { buildFormAssistantToolset } from "../../tools/index";
import { llm } from "../../config/llm";
import { StateType } from "../graph";
import { logger } from "../../common/logger";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { HumanMessage, SystemMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { ConversationTokenBufferMemory } from "langchain/memory";
import { AgentExecutor } from "langchain/agents";
import { RunnableSequence } from "@langchain/core/runnables";
import { formatToOpenAIFunctionMessages } from "langchain/agents/format_scratchpad";
import { OpenAIFunctionsAgentOutputParser } from "langchain/agents/openai/output_parser";

// Get the tools
const tools = buildFormAssistantToolset();

// System prompt for the reactive agent
const SYSTEM_PROMPT = `You are an intelligent, reliable AI assistant designed to help users apply for government or enterprise services by filling out forms step-by-step.

## Core Capabilities:
- Remember and use information from the entire conversation history
- Maintain context about users, including their names and details they've shared
- Help with form applications while keeping track of user information

## Your Capabilities:
You have access to tools that allow you to:
- Fetch available forms
- Get form structure and fields
- Update form field values
- Submit completed forms
- Manage the form filling session

## Form Filling Protocol:

1. **Starting an Application:**
   - When a user expresses interest in applying for a service, use the available tools to fetch forms
   - Select the appropriate form and fetch its structure
   - Begin asking questions for each required field
   - Use any information the user has already provided in the conversation

2. **Collecting Information:**
   - Ask for one field at a time, clearly and concisely
   - Remember and use information already provided by the user
   - Mention if a field is optional or has specific requirements (date format, number range, etc.)
   - After receiving an answer, update the form field using the appropriate tool
   - Move to the next field

3. **Handling Interruptions:**
   - If the user changes topic or asks an unrelated question, answer it
   - Remember the context of both the interruption and the ongoing application
   - Then politely remind them about the ongoing application
   - Resume from where you left off

4. **Completing Applications:**
   - Once all required fields are collected, use the submit tool
   - Provide confirmation to the user

## Important Guidelines:
- Be conversational and friendly
- ALWAYS remember what users tell you about themselves (names, preferences, etc.)
- Keep track of which field you're currently asking about
- Validate inputs when necessary
- Handle errors gracefully
- Always maintain context about the ongoing form filling process and conversation history`;

// Helper function to format messages for Bedrock compatibility
function formatMessagesForBedrock(messages: BaseMessage[]): BaseMessage[] {
  return messages.map(msg => {
    // Ensure content is always a string
    if (typeof msg.content !== 'string') {
      let textContent: string;
      
      if (Array.isArray(msg.content)) {
        // If content is an array, extract text based on the type of each item
        textContent = msg.content
          .map(item => {
            if (typeof item === 'string') {
              return item;
            } else if (item && typeof item === 'object') {
              // Check for different content types
              if ('text' in item && typeof item.text === 'string') {
                return item.text;
              } else if ('type' in item && item.type === 'text' && 'text' in item) {
                return item.text;
              } else if ('type' in item && item.type === 'image_url') {
                return '[Image]'; // Placeholder for image content
              } else {
                // For any other object type, stringify it
                return JSON.stringify(item);
              }
            }
            return '';
          })
          .filter(text => text) // Remove empty strings
          .join(' ');
      } else if (msg.content && typeof msg.content === 'object') {
        // If content is an object, stringify it
        textContent = JSON.stringify(msg.content);
      } else {
        textContent = String(msg.content);
      }
      
      // Create new message of the same type with string content
      if (msg._getType() === 'human') {
        return new HumanMessage(textContent);
      } else if (msg._getType() === 'ai') {
        return new AIMessage(textContent);
      } else if (msg._getType() === 'system') {
        return new SystemMessage(textContent);
      } else {
        // Fallback: create a new message with the same fields but string content
        return {
          ...msg,
          content: textContent,
        } as BaseMessage;
      }
    }
    return msg;
  });
}

// Custom agent implementation that's compatible with Bedrock
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
    
    // Also check if session has chat_history and merge if needed
    if (session.chat_history && Array.isArray(session.chat_history)) {
      // Use session chat history if it's more complete
      if (session.chat_history.length > chatHistory.length) {
        chatHistory = session.chat_history;
      }
    }
    
    // Format chat history for Bedrock compatibility
    chatHistory = formatMessagesForBedrock(chatHistory);
    
    // Log chat history for debugging
    logger.info(`Chat history length: ${chatHistory.length}`);
    if (chatHistory.length > 0) {
      logger.info(`Recent chat context: ${chatHistory.slice(-4).map((m: { _getType: () => any; content: string; }) => `${m._getType()}: ${m.content?.substring(0, 50)}...`).join(' | ')}`);
    }

    // Create a custom agent that works with Bedrock
    const prompt = ChatPromptTemplate.fromMessages([
      ["system", SYSTEM_PROMPT],
      new MessagesPlaceholder("chat_history"),
      ["human", "{input}"],
    ]);

    // Instead of using createToolCallingAgent, we'll create a custom chain
    // that's compatible with Bedrock
    const MAX_ITERATIONS = 5;
    let currentInput = input.trim();
    let iterations = 0;
    let finalResponse = "";

    // Create a tool execution loop
    while (iterations < MAX_ITERATIONS) {
      iterations++;
      
      // Format the prompt with current context - INCLUDE CHAT HISTORY
      const formattedPrompt = await prompt.formatMessages({
        chat_history: chatHistory, // This is crucial - passing the actual chat history
        input: currentInput,
      });

      // Add tool descriptions to the system message with proper input schemas
      const toolDescriptions = tools.map(tool => {
        // Get the input schema if available
        const inputSchema = tool.schema ? 
          `\n  Input schema: ${JSON.stringify(tool.schema._def || tool.schema, null, 2)}` : 
          '\n  Input: {}';
        return `- ${tool.name}: ${tool.description}${inputSchema}`;
      }).join('\n');

      const enhancedSystemMessage = `${SYSTEM_PROMPT}

## CONVERSATION CONTEXT:
You are in an ongoing conversation. Remember what the user has told you previously.
The user may refer to information from earlier in the conversation.

Available tools:
${toolDescriptions}

IMPORTANT TOOL USAGE RULES:
1. Always provide the correct INPUT format for each tool
2. If a tool expects a query or text input, provide it as {"query": "your text"}
3. If a tool expects an ID, provide it as {"id": "the_id"} or {"formId": "the_id"}
4. Never call a tool with empty {} unless it explicitly accepts no input
5. Check the input schema for each tool before calling it

RESPONSE FORMAT:
- When you need to use a tool AND provide an answer, use this format:
  TOOL: [tool_name]
  INPUT: [tool_input_as_json]
  RESPONSE: [your_complete_answer_to_user]

- When you only need to use a tool (for intermediate steps), use:
  TOOL: [tool_name]
  INPUT: [tool_input_as_json]

- When you have a final answer without needing tools, use:
  RESPONSE: [your_message_to_user]

IMPORTANT: 
- Remember the conversation context and what the user has told you
- If you call a tool to get information, include your complete answer in the RESPONSE section immediately after
- Don't wait for another iteration unless absolutely necessary`;

      // Update system message
      formattedPrompt[0] = new SystemMessage(enhancedSystemMessage);

      // Ensure all messages are properly formatted
      const bedrockCompatibleMessages = formatMessagesForBedrock(formattedPrompt);

      // Call the LLM
      let llmResponse;
      try {
        llmResponse = await llm.invoke(bedrockCompatibleMessages);
      } catch (llmError) {
        logger.error(`LLM invocation error: ${llmError}`);
        // Fallback: try with simplified messages but still include history
        const simplifiedMessages = [
          new SystemMessage(enhancedSystemMessage),
          ...chatHistory.slice(-6), // Include recent history
          new HumanMessage(currentInput)
        ];
        llmResponse = await llm.invoke(simplifiedMessages);
      }

      const responseText = typeof llmResponse.content === 'string' 
        ? llmResponse.content 
        : JSON.stringify(llmResponse.content);

      logger.info(`Iteration ${iterations} LLM response: ${responseText}`);

      // Parse the response to check for tool calls
      const hasToolCall = responseText.includes('TOOL:') && responseText.includes('INPUT:');
      const hasResponse = responseText.includes('RESPONSE:');
      
      // If we have both a tool call and a response, extract both
      if (hasToolCall && hasResponse) {
        // Extract tool call - improved regex to handle multiline JSON
        const toolMatch = responseText.match(/TOOL:\s*([^\n]+)/);
        const inputMatch = responseText.match(/INPUT:\s*([\s\S]*?)(?=\n\n|RESPONSE:|$)/);
        const responseMatch = responseText.match(/RESPONSE:\s*([\s\S]+)/);

        if (toolMatch && inputMatch) {
          const toolName = toolMatch[1].trim();
          let toolInput;
          
          try {
            // Clean up the input string and parse as JSON
            const inputStr = inputMatch[1].trim();
            toolInput = JSON.parse(inputStr);
          } catch {
            // If not valid JSON, check if it's a simple string that should be wrapped
            const inputStr = inputMatch[1].trim();
            if (inputStr && inputStr !== '{}') {
              // Assume it's meant to be a query parameter
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
              // Validate and prepare tool input
              let preparedInput = toolInput;
              
              // Special handling for tools that expect specific input formats
              if (toolName === 'ReadGovermentDocs' || toolName === 'readGovermentDocs') {
                // If the tool expects a query but got empty object, provide a default
                if (!toolInput || Object.keys(toolInput).length === 0) {
                  preparedInput = { query: "government services and forms" };
                } else if (typeof toolInput === 'string') {
                  preparedInput = { query: toolInput };
                }
              }
              
              // For form-related tools, ensure proper ID format
              if (toolName.toLowerCase().includes('form') && toolInput) {
                if (toolInput.id && !toolInput.formId) {
                  preparedInput = { ...toolInput, formId: toolInput.id };
                }
              }
              
              const toolResult = await tool.invoke(preparedInput);
              logger.info(`Tool result: ${JSON.stringify(toolResult)}`);
              
              // Update session with tool results
              if (toolResult && typeof toolResult === 'object' && !toolResult.error) {
                session = {
                  ...session,
                  form_id: toolResult.form_id || session.form_id,
                  form_name: toolResult.form_name || session.form_name,
                  form_fields: toolResult.form_fields || session.form_fields,
                  current_field: toolResult.current_field || session.current_field,
                  last_field: toolResult.last_field || session.last_field,
                  awaiting_input: toolResult.awaiting_input ?? session.awaiting_input,
                  form_status: toolResult.form_status || session.form_status,
                  is_form_filling_started: toolResult.is_form_filling_started ?? session.is_form_filling_started,
                };
              }
              
              // If we have a RESPONSE section after the tool call, use it as the final answer
              if (responseMatch) {
                finalResponse = responseMatch[1].trim();
                break; // Exit the loop - we have our answer
              } else {
                // Prepare next iteration with tool result
                if (toolResult && toolResult.error) {
                  currentInput = `Tool ${toolName} returned an error: ${toolResult.error}. Please provide an alternative approach or inform the user.`;
                } else {
                  currentInput = `Tool ${toolName} returned: ${JSON.stringify(toolResult)}. Based on this result, please provide a final RESPONSE to answer the user's original question: "${input.trim()}"`;
                }
              }
              
            } catch (toolError) {
              logger.error(`Tool execution error: ${toolError}`);
              currentInput = `Tool ${toolName} failed with error: ${toolError}. Please provide a RESPONSE to answer the user's question directly without using this tool.`;
            }
          } else {
            logger.warn(`Tool ${toolName} not found`);
            currentInput = `Tool ${toolName} is not available. Please provide a RESPONSE to answer the user's question directly.`;
          }
        }
      } else if (hasToolCall && !hasResponse) {
        // Extract tool call - improved regex to handle multiline JSON
        const toolMatch = responseText.match(/TOOL:\s*([^\n]+)/);
        const inputMatch = responseText.match(/INPUT:\s*([\s\S]*?)(?=\n\n|RESPONSE:|$)/);

        if (toolMatch && inputMatch) {
          const toolName = toolMatch[1].trim();
          let toolInput;
          
          try {
            // Clean up the input string and parse as JSON
            const inputStr = inputMatch[1].trim();
            toolInput = JSON.parse(inputStr);
          } catch {
            // If not valid JSON, check if it's a simple string that should be wrapped
            const inputStr = inputMatch[1].trim();
            if (inputStr && inputStr !== '{}') {
              // Assume it's meant to be a query parameter
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
              // Validate and prepare tool input
              let preparedInput = toolInput;
              
              // Special handling for tools that expect specific input formats
              if (toolName === 'ReadGovermentDocs' || toolName === 'readGovermentDocs') {
                // If the tool expects a query but got empty object, provide a default
                if (!toolInput || Object.keys(toolInput).length === 0) {
                  preparedInput = { query: "government services and forms" };
                } else if (typeof toolInput === 'string') {
                  preparedInput = { query: toolInput };
                }
              }
              
              // For form-related tools, ensure proper ID format
              if (toolName.toLowerCase().includes('form') && toolInput) {
                if (toolInput.id && !toolInput.formId) {
                  preparedInput = { ...toolInput, formId: toolInput.id };
                }
              }
              
              const toolResult = await tool.invoke(preparedInput);
              logger.info(`Tool result: ${JSON.stringify(toolResult)}`);
              
              // Update session with tool results
              if (toolResult && typeof toolResult === 'object' && !toolResult.error) {
                session = {
                  ...session,
                  form_id: toolResult.form_id || session.form_id,
                  form_name: toolResult.form_name || session.form_name,
                  form_fields: toolResult.form_fields || session.form_fields,
                  current_field: toolResult.current_field || session.current_field,
                  last_field: toolResult.last_field || session.last_field,
                  awaiting_input: toolResult.awaiting_input ?? session.awaiting_input,
                  form_status: toolResult.form_status || session.form_status,
                  is_form_filling_started: toolResult.is_form_filling_started ?? session.is_form_filling_started,
                };
              }
              
              // Prepare next iteration with tool result
              if (toolResult && toolResult.error) {
                currentInput = `Tool ${toolName} returned an error: ${toolResult.error}. Please provide an alternative approach or inform the user.`;
              } else {
                currentInput = `Tool ${toolName} returned: ${JSON.stringify(toolResult)}. Please continue with the user's request.`;
              }
              
            } catch (toolError) {
              logger.error(`Tool execution error: ${toolError}`);
              currentInput = `Tool ${toolName} failed with error: ${toolError}. Please handle this gracefully and provide an alternative response to the user.`;
            }
          } else {
            logger.warn(`Tool ${toolName} not found`);
            currentInput = `Tool ${toolName} is not available. Please continue without it.`;
          }
        }
      } else if (responseText.includes('RESPONSE:')) {
        // Extract final response
        const responseMatch = responseText.match(/RESPONSE:\s*([\s\S]+)/);
        if (responseMatch) {
          finalResponse = responseMatch[1].trim();
          break;
        }
      } else {
        // Treat the entire response as final
        finalResponse = responseText;
        break;
      }
    }

    // If no final response after iterations, use a default
    if (!finalResponse) {
      finalResponse = "I'm ready to help you with your application. What would you like to apply for?";
    }

    // Save the interaction to memory
    await memory.saveContext(
      { input: input.trim() },
      { output: finalResponse }
    );
    
    // Update chat history with the new messages
    const updatedChatHistory = [
      ...chatHistory,
      new HumanMessage(input.trim()),
      new AIMessage(finalResponse)
    ];

    return {
      response: finalResponse,
      ...session,
      memory,
      chat_history: updatedChatHistory, // Return the updated chat history
    };

  } catch (error) {
    logger.error(`formAssistantAgent failed: ${error}`);
    
    const errorResponse = "I encountered an error while processing your request. Please try again.";
    
    // Try to save error context to memory if possible
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