import { buildFormAssistantToolset } from "../../tools/index";
import { llm } from "../../config/llm";
import { StateType } from "../graph";
import { Annotation } from "@langchain/langgraph";
import { logger } from "../../common/logger";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { RunnableSequence } from "@langchain/core/runnables";
import { zodToJsonSchema } from "zod-to-json-schema";
import { string } from "zod";
import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import { BufferMemory } from "langchain/memory";
import { ChatMessageHistory } from "langchain/stores/message/in_memory";
import { ConversationTokenBufferMemory } from "langchain/memory";

const memory = new ConversationTokenBufferMemory({
  memoryKey: "chat_history",
  returnMessages: true,
  llm, // required!
  maxTokenLimit: 2000,
});


const tools = buildFormAssistantToolset();
const toolMap = Object.fromEntries(tools.map(t => [t.name, t]));

function getToolPromptDetails(tools: any[]) {
  const tools_descriptions = tools.map(t => {
    const inputSchema = t.schema ? zodToJsonSchema(t.schema) as { properties?: any } : {};
    return `
Tool Name: ${t.name}
Description: ${t.description || "No description"}
Expected Input (JSON):
${JSON.stringify(inputSchema.properties || {}, null, 2)}
`.trim();
  }).join("\n\n");

  return { tools: tools_descriptions };
}

const { tools: tools_descriptions } = getToolPromptDetails(tools);

const formAgentPrompt = ChatPromptTemplate.fromMessages([
  [
    "system",
    [
      "You are an intelligent, reliable, and structured AI assistant designed to help users apply for government or enterprise services by filling out forms step-by-step using available tools.",
      "",
      "You must always respond in the following structured JSON format:",
      "",
      `{{
  "tool_calls": [
    {{
      "tool_name": "<ToolName>",
      "tool_input": {{ ... }}
    }},
    ...
  ],
  "final_answer": <true|false>,
  "message": "<natural language message to user if needed>"
}}`,
      "",
      "---",
      "### 🔧 Available Tools:",
      "{tools}",
      "",
      "---",
      "### ✅ Structured Response Rules",
      "",
      "- If tools are needed:",
      "  - Fill `tool_calls` array with required tool actions",
      "  - Set `final_answer` to false",
      "  - `message` can be empty or used to indicate what you're doing",
      "",
      "- If no tools are needed and you're ready to reply to the user:",
      "  - Leave `tool_calls` as an empty array",
      "  - Set `final_answer` to true",
      "  - Provide a complete natural language message in `message`",
      "",
      "---",
      "### 💬 Natural Language Replies (use `message`)",
      "",
      "Only respond naturally (via `message`) when:",
      "- Asking a question during form filling",
      "- Waiting for user input",
      "- Confirming or providing final output",
      "- Greeting, thanking, or casual small talk",
      "- Handling interruptions",
      "",
      "---",
      "### 🧾 Form Filling Protocol",
      "",
      "1. When user expresses interest in applying:",
      "   - Use `FetchAllFormsTool` or infer from session",
      "   - Select and fetch form structure via `FetchFormStructureByIdTool`",
      "   - Set `is_form_filling_started = true`",
      "   - Begin asking questions for each field",
      "",
      "2. When asking a field:",
      "   - Ask clearly and concisely",
      "   - Mention if optional, or if input type is date/number",
      "   - Wait for input by setting `awaiting_input = true`",
      "",
      "3. After each answer:",
      "   - Update `form_fields[<field_name>] = <value>`",
      "   - Update `current_field`, `last_field`",
      "   - Move to next field (or submission if complete)",
      "",
      "4. On completion:",
      "   - Use `SubmitFormTool`",
      "   - Provide confirmation via `message`",
      "",
      "---",
      "### 🔄 Interruptions Handling",
      "",
      "- If user changes topic or interrupts:",
      "  - Set `isFormfillingInterupted = true`",
      "  - Answer the user’s question in `message`",
      "  - Then resume: “Let's continue your application. Please provide: <current_field_label>”",
      "",
      "---",
      "### 🧠 Maintain Session Context:",
      "- form_id, form_name",
      "- form_fields, current_field, last_field",
      "- form_status, is_form_filling_started",
      "- awaiting_input, isFormfillingInterupted",
      "",
      "---",
      "NEVER include trailing whitespace.",
      "NEVER use markdown or explanation outside the structured JSON.",
      "NEVER hallucinate tool names.",
      "ONLY respond using the fixed structure."
    ].join("\n")
  ],
  ["human", "{input}"]
]).partial({ tools: tools_descriptions });

function cleanContent(content: string): string {
  return typeof content === 'string' ? content.trim() : content;
}

  function parseStructuredLLMOutput(output: string): {
    tool_calls: { tool_name: string; tool_input: any }[];
    final_answer: boolean;
    message: string;
  } {
    try {
      const parsed = JSON.parse(output);
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid object");
  
      return {
        tool_calls: Array.isArray(parsed.tool_calls) ? parsed.tool_calls : [],
        final_answer: !!parsed.final_answer,
        message: typeof parsed.message === "string" ? parsed.message : ""
      };
    } catch (err) {
      return {
        tool_calls: [],
        final_answer: true,
        message: `Error parsing structured LLM output: ${err}\nRaw: ${output}`
      };
    }
  }
  


  export const formAssistantAgent = async (input: string, session: StateType) => {
    logger.info(`formAssistantAgent input: ${input}`);
    const promptChain = RunnableSequence.from([await formAgentPrompt, llm]);
  
    const cleanedInput = cleanContent(input);
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
  
    const memoryVars = await memory.loadMemoryVariables({});
    let chatHistory = memoryVars.chat_history || [];
  
    let currentInput = cleanedInput;
    const MAX_ITERATIONS = 6;
  
    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        logger.info(`\n[Iteration ${iteration + 1}] Invoking LLM with input:\n${currentInput}`);
  
        const { input: _input, chat_history: _chat, memory: _mem, ...safeSession } = session;
  
        const llmOutput = await promptChain.invoke({
          input: currentInput,
          chat_history: chatHistory,
          memory: memoryVars,
          ...safeSession,
        });
  
        const raw = typeof llmOutput === "string" ? llmOutput : llmOutput.content;
        const parsed = parseStructuredLLMOutput(String(raw));
        logger.info(`[Iteration ${iteration + 1}] Parsed LLM Output: ${JSON.stringify(parsed, null, 2)}`);
  
        const toolResults: Record<string, any> = {};
        for (const call of parsed.tool_calls) {
          const tool = toolMap[call.tool_name];
          if (!tool) {
            logger.warn(`Tool "${call.tool_name}" not found.`);
            continue;
          }
          logger.info(`Calling tool: ${call.tool_name} with input: ${JSON.stringify(call.tool_input)}`);
          const result = await tool.invoke(call.tool_input);
          logger.info(`Tool "${call.tool_name}" result: ${JSON.stringify(result)}`);
          toolResults[call.tool_name] = result;
        }
  
        if (parsed.final_answer || parsed.tool_calls.length === 0) {
          return {
            response: parsed.message?.trim() || "I'm not sure what to do next.",
            ...session,
          };
        }
  
        const firstResult = Object.values(toolResults)[0] || {};
        const updatedSession = {
          ...session,
          memory,
          form_id: firstResult.form_id || session.form_id,
          form_name: firstResult.form_name || session.form_name,
          form_fields: firstResult.form_fields || session.form_fields,
          current_field: firstResult.current_field || session.current_field,
          last_field: firstResult.last_field || session.last_field,
          awaiting_input: firstResult.awaiting_input ?? session.awaiting_input,
          form_status: firstResult.form_status || session.form_status,
          is_form_filling_started: true,
          isFormfillingInterupted: false,
        };
  
        const toolMessagesString = Object.entries(toolResults)
          .map(([tool, result]) => `Tool: ${tool}\nResult:\n${JSON.stringify(result)}`)
          .join("\n\n");
  
        if (!toolMessagesString.trim()) {
          logger.warn("No tool results found. Skipping follow-up.");
          break;
        }
  
        chatHistory.push(
          new SystemMessage({
            content: "You have access to tool result context. Respond based on these tool results:\n\n" + toolMessagesString,
          }),
          new HumanMessage({
            content: currentInput || "Continue with the previous user request.",
          })
        );

        const { chat_history: _c, memory: _m, input: _i , ...cleanSession} = updatedSession;

        const followUpOutput = await promptChain.invoke({
          input: currentInput,
          ...cleanSession,
          chat_history: chatHistory,
          memory: memoryVars,
        });
        
        const followUpRaw = typeof followUpOutput === "string" ? followUpOutput : followUpOutput.content;
        currentInput = String(followUpRaw).trim();
  
        await memory.saveContext({ input: currentInput }, { output: followUpRaw });
        session = updatedSession;
      }
  
      logger.error("Max iteration limit reached.");
      return {
        response: "I'm stuck in a loop. Please try again later.",
        ...session,
      };
  
    } catch (err) {
      logger.error(`formAssistantAgent failed: ${err}`);
      return {
        response: "An error occurred while processing your request. Please try again.",
        ...session,
      };
    }
  };
  
