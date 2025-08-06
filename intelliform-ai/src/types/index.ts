import { BaseMessage } from "@langchain/core/messages";


export interface FormField  {
  name: string;
  type: string;
  label?: string;
  required?: boolean;
  value?: string;
};

export interface GraphState  {
  // 🧠 Conversation tracking
  chat_history: BaseMessage[];

  // 🔁 Agent routing
  current_node: string | null;
  last_node: string | null;

  // ⏳ Input flags
  awaiting_input: boolean;
  is_form_filling_started: boolean;

  form_id?: string;               
  form_name?: string;            
  form_fields?: FormField[];      
  form_status?: "not_started" | "in_progress" | "completed";

  // ✍️ Field tracking
  current_field?: string;
  last_field?: string;
};

export interface FileData {
  fileName: string;
  fileContent: string;
}

export interface ChatSession {
  sessionId: string;
  messages: BaseMessage[];
  graphState: GraphState;
  uploadedFiles?: FileData[];
  createdAt: Date;
  lastActivity: Date;
}