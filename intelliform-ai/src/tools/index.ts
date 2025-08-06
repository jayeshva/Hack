import { DynamicTool } from "@langchain/core/tools";
import { govDataReadTool } from "./readFileRagTool";

export function buildFormAssistantToolset(): DynamicTool[] {
    return [
      new DynamicTool({
        name: "ReadGovermentDocs",
        description: "Use this tool to answer questions about indian government services, policies, and regulations and FAQs and gevertment service application guidelines.",
        func: async (input: string) => {
          const docs = await govDataReadTool(input);
          if (docs.length === 0) {
            return "No relevant documents found.";
          }
          return docs.map((doc: any) => doc.pageContent).join("\n");
        }
      }),
      
      new DynamicTool({
        name: "FetchAllAvailableForms",
        description: "Use this tool to fetch all available forms for government services and applications. This tool will return a list of forms with their names, descriptions, and IDs.",
        func: async () => {
          return {
            forms: [
              { id: "form1", name: "Form 1", description: "Description of Form 1" },
              { id: "form2", name: "Form 2", description: "Description of Form 2" },
              { id: "form3", name: "Form 3", description: "Description of Form 3" },
            ]
          };
        }
      }),
      
      new DynamicTool({
        name: "fetchFormStructureById",
        description: "Use this tool to fetch the structure/schema of a specific form by ID. This tool will return the structure of the form as a JSON object.",
        func: async (input: string) => {
          return {
            form: {
              id: "form1",
              name: "Form 1",
              description: "Description of Form 1",
              fields: [
                { name: "name", type: "text", required: true, label: "Full Name" },
                { name: "email", type: "email", required: true, label: "Email Address" }
              ]
            }
          };
        }
      }),
    
    ];
  }