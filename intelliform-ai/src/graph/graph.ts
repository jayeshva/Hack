import { END, StateGraph, Annotation, START } from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  BaseMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { ConversationTokenBufferMemory } from 'langchain/memory';

import { statusTrackingAgent } from "./agents";
import logger from "../common/logger";
import { llm } from "../config/llm";
import { formAssistantAgent, formAssistantAgentSimple } from "./agents/formAssistant";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { Runnable } from "@langchain/core/runnables";

// ------------------------------
// Session State Definition
// ------------------------------
const StateAnnotation = Annotation.Root({
  memory: Annotation<ConversationTokenBufferMemory>({
    reducer: (current, update) => update ?? current,
    default: () => new ConversationTokenBufferMemory({ 
      memoryKey: 'chat_history', 
      llm,
      maxTokenLimit: 2000,
      returnMessages: true 
    }),
  }),
  input: Annotation<string>,
  chat_history: Annotation<BaseMessage[]>({
    reducer: (current, update) => {
      // Always append new messages to preserve history
      if (!current) return update || [];
      if (!update) return current;
      
      // If update contains new messages, append them
      const currentIds = new Set(current.map((msg, idx) => `${msg._getType()}-${idx}`));
      const newMessages = update.filter((msg, idx) => !currentIds.has(`${msg._getType()}-${idx}`));
      
      return [...current, ...newMessages];
    },
    default: () => [],
  }),
  current_node: Annotation<string | null>({
    reducer: (current, update) => update ?? current,
    default: () => null,
  }),
  last_node: Annotation<string | null>({
    reducer: (current, update) => update ?? current,
    default: () => null,
  }),
  awaiting_input: Annotation<boolean>({
    reducer: (current, update) => update ?? current,
    default: () => false,
  }),
  is_form_filling_started: Annotation<boolean>({
    reducer: (current, update) => update ?? current,
    default: () => false,
  }),
  form_id: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
  form_name: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
  form_fields: Annotation<any[] | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
  form_status: Annotation<"not_started" | "in_progress" | "completed" | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => "not_started",
  }),
  current_field: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
  last_field: Annotation<string | undefined>({
    reducer: (current, update) => update ?? current,
    default: () => undefined,
  }),
  isFormfillingInterupted: Annotation<boolean>({
    reducer: (current, update) => update ?? current,
    default: () => false
  }),
  isFormReady: Annotation<boolean>({
    reducer: (current, update) => update ?? current,
    default: () => false
  })
});

type StateType = typeof StateAnnotation.State;

// ------------------------------
// Router Node
// ------------------------------
async function routerNode(state: StateType): Promise<{ current_node: string; last_node: string | null }> {
  const routerPrompt = new SystemMessage({
    content: `
You are a router agent responsible for deciding which specialized agent to route the user request to.

You have access to the following agents and their capabilities:

1. form_assistant_agent – Helps with general questions, fetches forms, guides form filling, and handles user interactions during the application process.

2. status_tracking_agent – Answers user queries about the progress or status of submitted applications.

---

🔁 Routing Rules:

- Route to \`form_assistant_agent\` if:
  - The user asks general questions about eligibility, form availability, fees, etc.
  - The user wants to start, continue, or complete filling a form
  - The user gives responses during form filling (names, dates, addresses, etc.)
  - The user asks "how to", "what do I need", "where can I", etc.
  - The user gives short responses like "yes", "okay", "continue" during form interactions
  - The user asks about available forms or services
  - Default choice for most interactions

- Route to \`status_tracking_agent\` if:
  - The user explicitly asks about the status or result of a submitted form/application
  - The user mentions tracking numbers, reference IDs, or application statuses
  - The message includes phrases like "check my status", "any update", "when will I get it"
  - The user asks about processing times or approval status

---

📌 Current Context:
- input: ${state.input}
- current_node: ${state.current_node}
- last_node: ${state.last_node}
- awaiting_input: ${state.awaiting_input}
- is_form_filling_started: ${state.is_form_filling_started}
- form_id: ${state.form_id || 'none'}
- form_name: ${state.form_name || 'none'}
- form_status: ${state.form_status || 'not_started'}
- current_field: ${state.current_field || 'none'}
- chat_history_length: ${state.chat_history?.length || 0}

---

📥 User Message: "${state.input}"

Based on this input and context, reply with ONLY ONE of the following route names:
→ form_assistant_agent
→ status_tracking_agent

Do NOT explain. Just return the route name.
    `.trim(),
  });

  try {
    const response = await llm.invoke([
      routerPrompt,
      new HumanMessage({ content: state.input }),
    ]);

    logger.info(`Router response: ${response.content}`);
    const content =
      typeof response.content === "string"
        ? response.content.trim().toLowerCase()
        : "";

    const validRoutes = ["form_assistant_agent", "status_tracking_agent"];
    const selectedRoute = validRoutes.includes(content) ? content : "form_assistant_agent";

    logger.info(`Routing to: ${selectedRoute}`);

    return {
      current_node: selectedRoute,
      last_node: state.current_node,
    };
  } catch (error) {
    logger.error("Router error:", error);
    return {
      current_node: "form_assistant_agent",
      last_node: state.current_node,
    };
  }
}

// ------------------------------
// Conditional Edge Function
// ------------------------------
const routeToAgent = (state: StateType): string => {
  logger.info(`Routing to agent: ${state.current_node}`);

  if(state.is_form_filling_started === true) {
    return "form_filling_agent";
  }
  else if(state.isFormReady){
    return "submit_form";
  }
  switch (state.current_node) {
    case "form_assistant_agent":
      return "form_assistant_agent";
    case "status_tracking_agent":
      return "status_tracking_agent";
    default:
      return "form_assistant_agent";
  }
};

// ------------------------------
// Agent Nodes
// ------------------------------
async function formAssistantNode(state: StateType): Promise<Partial<StateType>> {
  try {
    logger.info(`Form assistant processing: "${state.input}"`);
    logger.info(`Current form context: ${state.form_id ? `form_id=${state.form_id}` : 'no form'}`);

    const result = await formAssistantAgent(state.input, state);
    
    if (!result || !result.response) {
      throw new Error("Invalid response from form assistant agent");
    }

    // Create the new messages
    const humanMessage = new HumanMessage({ content: state.input });
    const aiMessage = new AIMessage({ content: result.response });

    // Build the updated chat history
    const updatedChatHistory = [
      ...(state.chat_history || []),
      humanMessage,
      aiMessage
    ];

    logger.info(`Form assistant response: "${result.response}"`);
    logger.info(`Updated chat history length: ${updatedChatHistory.length}`);

    return {
      chat_history: updatedChatHistory,
      last_node: state.current_node,
      current_node: "form_assistant_agent",
      // Include all updated state from the agent
      memory: result.memory || state.memory,
      form_id: result.form_id ?? state.form_id,
      form_name: result.form_name ?? state.form_name,
      form_fields: result.form_fields ?? state.form_fields,
      form_status: result.form_status ?? state.form_status,
      current_field: result.current_field ?? state.current_field,
      last_field: result.last_field ?? state.last_field,
      awaiting_input: result.awaiting_input ?? state.awaiting_input,
      is_form_filling_started: result.is_form_filling_started ?? state.is_form_filling_started,
      isFormfillingInterupted: result.isFormfillingInterupted ?? state.isFormfillingInterupted,
    };

  } catch (error) {
    logger.error("Form assistant error:", error);
    
    const errorMessage = "I encountered an error while processing your form request. Please try again.";
    const humanMessage = new HumanMessage({ content: state.input });
    const aiMessage = new AIMessage({ content: errorMessage });

    return {
      chat_history: [
        ...(state.chat_history || []),
        humanMessage,
        aiMessage
      ],
      last_node: state.current_node,
      current_node: "form_assistant_agent",
    };
  }
}

async function statusTrackingNode(state: StateType): Promise<Partial<StateType>> {
  try {
    logger.info(`Status tracking processing: "${state.input}"`);

    const result = await statusTrackingAgent.invoke({
      input: state.input,
      form_id: state.form_id,
      chat_history: state.chat_history
    });

    const humanMessage = new HumanMessage({ content: state.input });
    const aiMessage = new AIMessage({ content: result.output });

    logger.info(`Status tracking response: "${result.output}"`);

    return {
      chat_history: [
        ...(state.chat_history || []),
        humanMessage,
        aiMessage
      ],
      last_node: state.current_node,
      current_node: "status_tracking_agent",
    };
  } catch (error) {
    logger.error("Status tracking agent error:", error);
    
    const errorMessage = "I'm having trouble checking the form status. Please try again later or provide more details.";
    const humanMessage = new HumanMessage({ content: state.input });
    const aiMessage = new AIMessage({ content: errorMessage });

    return {
      chat_history: [
        ...(state.chat_history || []),
        humanMessage,
        aiMessage
      ],
      last_node: state.current_node,
      current_node: "status_tracking_agent",
    };
  }
}

async function formFillingNode(state: StateType): Promise<Partial<StateType>> {
  try {
    const { form_fields, current_field, input } = state;

    const currentFieldObj = form_fields?.find(f => f.name === current_field);
    if (!currentFieldObj) {
      return { ...state };
    }

    // Save user input to current field
    const updatedFields = form_fields?.map(f =>
      f.name === current_field ? { ...f, value: input } : f
    );

    const remainingFields = updatedFields?.filter(
      (f) => f.required && (f.value === null || f.value === "")
    );

    const nextField = remainingFields?.[0];

    const updatedState: Partial<StateType> = {
      chat_history: [...(state.chat_history || []), new HumanMessage({ content: input })],
      form_fields: updatedFields,
      current_field: nextField?.name,
      form_status: "in_progress",
    };

    if ( remainingFields && remainingFields.length > 0) {
      const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You are a helpful assistant collecting form data from a user."],
        ["human", `Please provide: ${nextField.label}\n${nextField.instruction}`],
      ]);
      const llmInput = await prompt.formatMessages({});
      const aiResponse = await llm.invoke(llmInput);

      updatedState.chat_history?.push(new AIMessage({ content: aiResponse.content }));
    } else {
      // All fields filled → Ask LLM to summarize and request confirmation
      const formSummary = updatedFields
        ?.map(f => `- ${f.label}: ${f.value}`)
        .join("\n");

      const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You are an assistant confirming collected form data with the user."],
        ["human", `Here is the filled form:\n${formSummary}\n\nPlease summarize this politely and ask the user: 'Do you want to submit this form?'`],
      ]);
      const messages = await prompt.formatMessages({});
      const llmResponse = await llm.invoke(messages);

      updatedState.chat_history?.push(new AIMessage({ content: llmResponse.content }));
      updatedState.is_form_filling_started = false;
      updatedState.form_status = "completed";
      updatedState.isFormReady = true;
    }

    return updatedState;

  } catch (error: any) {
    logger.error(`Form filling error: ${error.message}`);
    return {
      ...state,
      form_status: "in_progress",
    };
  }
}



async function submitFormNode(state: StateType): Promise<Partial<StateType>> {
  const formData = Object.fromEntries(
    (state.form_fields || []).map((f) => [f.name, f.value])
  );

  logger.info("Submitting form data:", formData);

  // Replace this with real API call or logic
  const confirmationMessage = `✅ Your "${state.form_name}" form has been submitted successfully.\n\nSummary:\n${Object.entries(formData)
    .map(([k, v]) => `• ${k}: ${v}`)
    .join("\n")}`;

  const aiMessage = new AIMessage({ content: confirmationMessage });

  return {
    chat_history: [...(state.chat_history || []), aiMessage],
    current_node: "submit_form",
    last_node: state.current_node,
    awaiting_input: false,
    is_form_filling_started: false,
    form_id: undefined,
    form_name: undefined,
    form_fields: undefined,
    current_field: undefined,
    last_field: undefined,
    isFormfillingInterupted: false,
    form_status: undefined,
  };
}


// ------------------------------
// Build LangGraph
// ------------------------------
const builder = new StateGraph(StateAnnotation)
  .addNode("router", routerNode)
  .addNode("form_assistant_agent", formAssistantNode)
  .addNode("status_tracking_agent", statusTrackingNode)
  .addNode("form_filling_agent", formFillingNode)
  .addNode("submit_form", submitFormNode)
  .addEdge(START, "router")
  .addConditionalEdges("router", routeToAgent, {
    form_assistant_agent: "form_assistant_agent",
    status_tracking_agent: "status_tracking_agent",
    form_filling_agent: "form_filling_agent",
    submit_form: "submit_form",
  })
  .addEdge("form_assistant_agent", END)
  .addEdge("status_tracking_agent", END);

// Compile the graph
export const appGraph = builder.compile();

// ------------------------------
// Execution Helper
// ------------------------------
export async function runGraph(input: string, session: Partial<StateType> = {}): Promise<StateType> {
  try {
    logger.info(`Running graph with input: "${input}"`);
    logger.info(`Session chat history length: ${session.chat_history?.length || 0}`);

    // Ensure memory exists
    if (!session.memory) {
      session.memory = new ConversationTokenBufferMemory({ 
        memoryKey: 'chat_history', 
        llm,
        maxTokenLimit: 2000,
        returnMessages: true 
      });
    }

    const result = await appGraph.invoke({
      input,
      ...session,
    });

    logger.info(`Graph execution completed`);
    logger.info(`Result chat history length: ${result.chat_history?.length || 0}`);

    return result as StateType;
  } catch (error) {
    logger.error(`Graph execution error: ${error}`);
    
    // Return a safe fallback state with preserved history
    const fallbackResponse = "I apologize, but I encountered an error. Please try your request again.";
    
    return {
      input,
      chat_history: [
        ...(session.chat_history || []),
        new HumanMessage({ content: input }),
        new AIMessage({ content: fallbackResponse })
      ],
      current_node: "form_assistant_agent",
      last_node: session.current_node || null,
      awaiting_input: false,
      is_form_filling_started: session.is_form_filling_started || false,
      form_status: session.form_status || "not_started",
      form_id: session.form_id,
      form_name: session.form_name,
      form_fields: session.form_fields,
      current_field: session.current_field,
      last_field: session.last_field,
      isFormfillingInterupted: session.isFormfillingInterupted || false,
      memory: session.memory || new ConversationTokenBufferMemory({ 
        memoryKey: 'chat_history', 
        llm,
        maxTokenLimit: 2000000,
        returnMessages: true 
      })
    } as StateType;
  }
}

// ------------------------------
// Session State Initialization Helper
// ------------------------------
export function createInitialSession(): StateType {
  const memory = new ConversationTokenBufferMemory({ 
    memoryKey: 'chat_history', 
    llm,
    maxTokenLimit: 2000000,
    returnMessages: true 
  });

  return {
    input: "",
    chat_history: [],
    current_node: null,
    last_node: null,
    awaiting_input: false,
    is_form_filling_started: false,
    form_status: undefined,
    form_id: undefined ,
    form_name: undefined,
    form_fields: undefined,
    current_field: undefined,
    last_field: undefined,
    isFormfillingInterupted: false,
    memory,
    isFormReady: false
  };
}

const PAN_FORM_FIELDS = [
  { name: "full_name", type: "text", required: true, label: "Full Name", instruction: "Enter your full name as per official documents." },
  { name: "father_name", type: "text", required: true, label: "Father's Name", instruction: "Enter your father's full name." },
  { name: "dob", type: "date", required: true, label: "Date of Birth", instruction: "DD/MM/YYYY." },
  { name: "gender", type: "radio", required: true, label: "Gender", options: ["Male", "Female", "Other"], instruction: "Select your gender." },
  { name: "aadhaar_number", type: "text", required: true, label: "Aadhaar Number", instruction: "12-digit Aadhaar." },
  { name: "mobile_number", type: "text", required: true, label: "Mobile Number", instruction: "10-digit mobile." },
  { name: "address", type: "text", required: true, label: "Address", instruction: "Full residential address." },
  { name: "declaration_consent", type: "checkbox", required: true, label: "Declaration Consent", instruction: "Confirm all info is true." },
];


// ------------------------------
// Type Guards and Validation
// ------------------------------
export function isValidSessionState(state: any): state is StateType {
  return (
    state &&
    typeof state.input === 'string' &&
    Array.isArray(state.chat_history) &&
    typeof state.awaiting_input === 'boolean' &&
    typeof state.is_form_filling_started === 'boolean' &&
    (state.form_status === undefined ||
      ["not_started", "in_progress", "completed"].includes(state.form_status))
  );
}

// Export types for external use
export type { StateType };
export { StateAnnotation };