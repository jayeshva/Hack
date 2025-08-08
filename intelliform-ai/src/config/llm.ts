import { BedrockChat } from "@langchain/community/chat_models/bedrock";
import { CallbackHandler } from "langfuse-langchain";



// Initialize Langfuse callback handler
const langfuseHandler = new CallbackHandler({
  publicKey: "pk-lf-61036817-ccbe-4989-a7aa-22f35dd3b9d7",
  secretKey: "sk-lf-53e62775-c833-4471-a4c1-5c3d60b35bf5",
  baseUrl: "https://cloud.langfuse.com",
});

// // Claude via Bedrock
export const llm = new BedrockChat({
  model: 'us.anthropic.claude-3-7-sonnet-20250219-v1:0', 
  region: process.env.AWS_REGION || 'us-east-2',
  temperature: 0.1,
  streaming: true,
})
 
