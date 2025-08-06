import { AgentExecutor, createStructuredChatAgent } from "langchain/agents";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { buildFormAssistantToolset } from "../../tools/index";
import { llm } from "../../config/llm";
import { StateType } from "../graph";
import { logger } from "../../common/logger";



const formAgentPrompt = ChatPromptTemplate.fromMessages([
    [
        "system",
        ` You are an intelligent, multilingual AI assistant that helps users apply for government or enterprise services by:
  
  - Understanding the user's intent
  - Suggesting and explaining available application forms
  - Retrieving eligibility criteria, rules, and policy documentation
  - Guiding the user through form filling with step-by-step, context-aware input prompts
  - Submitting the completed form
  - Gracefully handling interruptions or clarifications mid-process
  
  ---
  
   Available Tools:
  {tool_names}
  
  ---
  1. FetchAllFormsTool
  2. FetchFormStructureByIdTool
  3. SubmitFormTool
  4. RAGTool
  
  ---
  Tool Descriptions:
  {tools}
  
  ---
   Always follow this flow:
  
  1. **Clarification Phase**:
     - If user asks about available forms → Use FetchAllFormsTool.
     - If user mentions a form → Use FetchFormStructureByIdTool.
     - Ask user: "Would you like to start filling the [form name] form?"
  
  2. **Form Filling Phase**:
     - Wait for user confirmation ("yes", "start", etc.).
     - Fetch form structure if not yet fetched.
     - Ask for fields one-by-one in user-friendly format.
       - Rephrase field labels.
       - Mention if optional.
       - Guide user if field expects date, number, or dropdown.
     - After each input:
       - Update session state → form_fields, current_field, last_field
       - Set awaiting_input = true and wait for reply
  
  3. **Interrupt Handling**:
     - If user interrupts with unrelated query →
       - Set is_interrupt = true
       - Handle the question
       - After answering, return: "Let's continue your application. Please provide: [current_field_label]"
       - Set is_interrupt = false
  
  4. **Submission**:
     - Once all required fields are collected → Call SubmitFormTool
     - Show confirmation or reference ID
  
  5. **Session Memory**:
     - Maintain these in session:
       - form_id, form_name, form_fields, current_field, last_field
       - awaiting_input, is_interrupt, form_status, chat_history
  
   Be polite, helpful, and avoid hallucinating. Confirm before starting. Ask clearly when awaiting input.
   **Don't add trailing whitespaces in your responses**. If the user interrupts, return: "Let's continue your application. Please provide: [current_field_label]".`
    ],
    ["human", "{input}"],
    ["ai", `{agent_scratchpad}`],
]);




let executor: any; // Declare a variable in the module scope

async function initializeAgent() {

    const tools = buildFormAssistantToolset();
    const agent = await createStructuredChatAgent({
        llm,
        tools,
        prompt: formAgentPrompt
    });

    executor = AgentExecutor.fromAgentAndTools({
        agent,
        tools,
        verbose: true,
    });
} 

initializeAgent();

// Helper function to clean content and remove trailing whitespace
function cleanContent(content: string): string {
    if (typeof content !== 'string') {
        return content;
    }
    // Remove all trailing whitespace
    return content.trim();
}

// Enhanced message validation
function validateAndCleanMessages(messages: any[]): any[] {
    return messages.map(message => {
        if (message && typeof message.content === 'string') {
            return {
                ...message,
                content: cleanContent(message.content).trim()
            };
        }
        return message;
    });
}

export const formAssistantAgent = async (input: string, session: StateType) => {
    logger.info(`formAssistantAgent input: ${input}`);

    // Wait for executor to be initialized
    while (!executor) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    try {
        // Clean and validate chat history before passing to agent
        const cleanedChatHistory = session.chat_history ?
            validateAndCleanMessages(session.chat_history) : [];

        // Clean the input as well
        const cleanedInput = cleanContent(input);

        const result = await executor.invoke({
            input: cleanedInput,
            chat_history: cleanedChatHistory,
            form_id: session.form_id,
            form_name: session.form_name,
            form_fields: session.form_fields,
            current_field: session.current_field,
            last_field: session.last_field,
            awaiting_input: session.awaiting_input,
            form_status: session.form_status,
            is_form_filling_started: session.is_form_filling_started,
            isFormfillingInterupted: session.isFormfillingInterupted,
            // agent_scratchpad: []
        });

        logger.info(`formAssistantAgent result: ${JSON.stringify(result)}`);

        // Extract and clean the output
        let output = typeof result === "string" ? result : result?.output;
        let cleanedOutput = output;

        // Clean the output to remove any trailing whitespace
        if (typeof cleanedOutput === 'string') {
            cleanedOutput = cleanedOutput.trim();
        }

        // Retry if trailing whitespace error occurs
        let retries = 0;
        const maxRetries = 3;
        while (retries < maxRetries) {
            try {
                const retryResult = await executor.invoke({
                    input: cleanedInput,
                    chat_history: cleanedChatHistory,
                    form_id: session.form_id,
                    form_name: session.form_name,
                    form_fields: session.form_fields,
                    current_field: session.current_field,
                    last_field: session.last_field,
                    awaiting_input: session.awaiting_input,
                    form_status: session.form_status,
                    is_form_filling_started: session.is_form_filling_started,
                    isFormfillingInterupted: session.isFormfillingInterupted,
                });

                let retryOutput = typeof retryResult === "string" ? retryResult : retryResult?.output;
                if (typeof retryOutput === 'string') {
                    retryOutput = retryOutput.trim();
                }

                if (!retryOutput.endsWith(' ')) {
                    return {
                        response: retryOutput,
                        current_field: retryResult?.current_field || session.current_field,
                        last_field: retryResult?.last_field || session.last_field,
                        form_status: retryResult?.form_status || session.form_status,
                        awaiting_input: retryResult?.awaiting_input ?? session.awaiting_input,
                        is_form_filling_started: true,
                        isFormfillingInterupted: retryResult?.isFormfillingInterupted ?? false,
                        form_id: retryResult?.form_id || session.form_id,
                        form_name: retryResult?.form_name || session.form_name,
                        form_fields: retryResult?.form_fields || session.form_fields,
                    };
                }
            } catch (error) {
                logger.error(`Retry ${retries + 1} failed: ${error}`);
                retries++;
            }
        }
    } catch (error) {
        logger.error(`Error in formAssistantAgent: ${error}`);

        // If max retries exceeded, return fallback response
        const fallbackResponse = {
            response: "I apologize, but I encountered a formatting issue. Could you please rephrase your request?",
            current_field: session.current_field,
            last_field: session.last_field,
            form_status: session.form_status,
            awaiting_input: session.awaiting_input,
            is_form_filling_started: session.is_form_filling_started,
            isFormfillingInterupted: false,
            form_id: session.form_id,
            form_name: session.form_name,
            form_fields: session.form_fields,
        };
        return fallbackResponse;
    }

}
