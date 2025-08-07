import { END, StateGraph, Annotation, START } from "@langchain/langgraph";
import { BedrockChat } from "@langchain/community/chat_models/bedrock";
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
import { formAssistantAgent } from "./agents/formAssistant";

// ------------------------------
// Session State Definition
// ------------------------------
const StateAnnotation = Annotation.Root({
  memory: Annotation<ConversationTokenBufferMemory>({
    reducer: (current, update) => update ?? current,
    default: () => new ConversationTokenBufferMemory({ memoryKey: 'chat_history', llm,maxTokenLimit: 2000 }),
  }),
  input: Annotation<string>,
  chat_history: Annotation<BaseMessage[]>({
    reducer: (current, update) => update ?? current,
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
  })
});

type StateType = typeof StateAnnotation.State;

// ------------------------------
// LLM Initialization
// ------------------------------


// ------------------------------
// Router Node
// ------------------------------
async function routerNode(state: StateType): Promise<{ current_node: string; last_node: string | null }> {
  const routerPrompt = new SystemMessage({
    content: `
You are a router agent responsible for deciding which specialized agent to route the user request to.

You have access to the following agents and their capabilities:

1. form_assistant_agent – Helps answer general, vague, or open-ended queries. It can fetch available form list, form schema, and use retrieval tools for FAQs and general information.

2. form_assistant_agent – Guides users step-by-step to fill a selected form using current context. It can collect inputs, edit/delete fields, and validate responses.

3. status_tracking_agent – Answers user queries about the progress or status of submitted applications.

---

🔁 Routing Rules:

- Route to \`form_assistant_agent\` if:
  - The user asks a general question about eligibility, form availability, fees, etc.
  - The user gives short affirmations like “yes” or “okay” **without sufficient context**.
  - The user asks "how to", "what do I need", "where can I", etc., which implies clarification is needed.
  - The user message is vague or context-less, and does not include form name or intent to proceed.

- Route to \`form_assistant_agent\` if:
  - The user explicitly wants to start or proceed with filling a form.
  - The user affirms **after previously being asked to confirm starting the form**.
  - The message contains intent to provide details like name, dob, email, address, etc.
  - The message includes phrases like “start application”, “continue filling”, “submit”, or “fill the form”.

- Route to \`status_tracking_agent\` if:
  - The user asks about the status or result of a form or application.
  - The user mentions tracking number, reference ID, or phrases like “submitted”, “processing”, “approval”, etc.
  - The message includes phrases like “check my status”, “any update”, or “when will I get it”.

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
- last_field: ${state.last_field || 'none'}

---

📥 User Message: "${state.input}"

Now, based on this input and context, reply with ONLY ONE of the following route names:
→ form_assistant_agent
→ status_tracking_agent

Do NOT explain. Just return the route name.
    `.trim(),
  });

  try {
    const response = await llm.invoke([
      routerPrompt,
      ...state.chat_history,
      new HumanMessage({ content: state.input }),
    ]);

    logger.info(`Router response: ${response.content}`);
    const content =
      typeof response.content === "string"
        ? response.content.trim().toLowerCase()
        : "";

    const validRoutes = ["form_assistant_agent", "status_tracking_agent"];
    const selectedRoute = validRoutes.includes(content) ? content : "form_assistant_agent";

    return {
      current_node: selectedRoute,
      last_node: state.current_node,
    };
  } catch (error) {
    console.error("Router error:", error);
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
    // if (!state.form_id && !state.form_fields && state.is_form_filling_started) {
    //   return {
    //     chat_history: [
    //       ...state.chat_history,
    //       new HumanMessage({ content: state.input }),
    //       new AIMessage({ content: "Please first select a form to fill out. You can ask me 'What forms are available?' to see your options." })
    //     ],
    //     last_node: state.current_node,
    //     current_node: "form_assistant_agent",
    //   };
    // }

    const result = await formAssistantAgent(state.input, state);
    const { chat_history: _omit, ...rest } = result;

    return {
      chat_history: [
        ...state.chat_history,
        new HumanMessage({ content: state.input }),
        new AIMessage({ content: result?.response }),
      ],
      ...rest,
      last_node: state.current_node,
      current_node: "form_assistant_agent",
    };

  } catch (error) {
    console.error("Form assistant error:", error);
    return {
      chat_history: [
        ...state.chat_history,
        new HumanMessage({ content: state.input }),
        new AIMessage({ content: "I encountered an error while processing your form. Please try again." })
      ],
      last_node: state.current_node,
      current_node: "form_assistant_agent",
    };
  }
}


async function statusTrackingNode(state: StateType): Promise<Partial<StateType>> {
  try {
    const result = await statusTrackingAgent.invoke({
      input: state.input,
      form_id: state.form_id,
      chat_history: state.chat_history
    });

    return {
      chat_history: [
        ...state.chat_history,
        new HumanMessage({ content: state.input }),
        new AIMessage({ content: result.output })
      ],
      last_node: state.current_node,
      current_node: "status_tracking_agent",
    };
  } catch (error) {
    console.error("Status tracking agent error:", error);
    return {
      chat_history: [
        ...state.chat_history,
        new HumanMessage({ content: state.input }),
        new AIMessage({ content: "I'm having trouble checking the form status. Please try again later." })
      ],
      last_node: state.current_node,
      current_node: "status_tracking_agent",
    };
  }
}


// ------------------------------
// Build LangGraph
// ------------------------------
const builder = new StateGraph(StateAnnotation)
  .addNode("router", routerNode)
  .addNode("form_assistant_agent", formAssistantNode)
  .addNode("status_tracking_agent", statusTrackingNode)
  .addEdge(START, "router")
  .addConditionalEdges("router", routeToAgent, {
    form_assistant_agent: "form_assistant_agent",
    status_tracking_agent: "status_tracking_agent",
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
    const result = await appGraph.invoke({
      input,
      ...session,
    });
    logger.info(`Graph execution result: ${JSON.stringify(result)}`);
    return result as StateType;
  } catch (error) {
    console.error("Graph execution error:", error);
    // Return a safe fallback state
    return {
      input,
      chat_history: [
        ...(session.chat_history || []),
        new HumanMessage({ content: input }),
        new AIMessage({ content: "I apologize, but I encountered an error. Please try your request again." })
      ],
      current_node: "clarification_agent",
      last_node: session.current_node || null,
      awaiting_input: false,
      is_form_filling_started: session.is_form_filling_started || false,
      form_status: session.form_status || "not_started",
      form_id: session.form_id,
      form_name: session.form_name,
      form_fields: session.form_fields,
      current_field: session.current_field,
      last_field: session.last_field,
    } as StateType;
  }
}

// ------------------------------
// Session State Initialization Helper
// ------------------------------
export function createInitialSession(): StateType {
  return {
    input: "",
    chat_history: [],
    current_node: null,
    last_node: null,
    awaiting_input: false,
    is_form_filling_started: false,
    form_status: "not_started",
    form_id: undefined,
    form_name: undefined,
    form_fields: undefined,
    current_field: undefined,
    last_field: undefined,
    isFormfillingInterupted: false,
    memory: new ConversationTokenBufferMemory({ memoryKey: 'chat_history', llm })
  };
}

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
