import { DynamicTool } from "@langchain/core/tools";
import { govDataReadTool } from "./readFileRagTool";
import { logger } from "../common/logger";

export function buildFormAssistantToolset(): DynamicTool[] {
    return [
      new DynamicTool({
        name: "ReadGovermentDocs",
        description: "Use this tool to answer questions about indian government services, policies, and regulations and FAQs and government service application guidelines.",
        func: async (input: any) => {
          try {
            // Handle different input formats
            let query: string;
            
            if (typeof input === 'string') {
              query = input;
            } else if (input && typeof input === 'object') {
              query = input.query || input.text || JSON.stringify(input);
            } else {
              query = String(input);
            }
            
            logger.info(`ReadGovermentDocs input: ${JSON.stringify(input)}`);
            logger.info(`Extracted query: ${query}`);
            
            // Call the actual govDataReadTool with the query
            const docs = await govDataReadTool(query);
            
            if (!docs || docs.length === 0) {
              return "No relevant documents found for: " + query;
            }
            
            return docs.map((doc: any) => doc.pageContent).join("\n");
          } catch (error: any) {
            logger.error(`ReadGovermentDocs error: ${error}`);
            return `Error reading government documents: ${error.message}`;
          }
        }
      }),
      
      new DynamicTool({
        name: "FetchAllAvailableForms",
        description: "Fetches all available government forms with fees and basic details",
        func: async () => ({
          forms: [
            { formId: "PAN001", name: "PAN Card Application", description: "Apply for a new PAN", fee_required: true, fee_amount: "₹110" },
            { formId: "INS001", name: "Insurance Application", description: "Health insurance enrollment", fee_required: false, fee_amount: "₹0" },
          ]
        })
      }),
  
      new DynamicTool({
        name: "fetchFormStructureById",
        description: "Fetches the JSON structure of a form by formID. to get form ids use FetchAllAvailableForms tool",
        func: async (input: any) => {
          try {
            // Handle different input formats
            console.log(input, "input for fetchFormStructureById");
            let formId: string;
            
            if (typeof input === 'string') {
              formId = input;
            } else if (input && typeof input === 'object') {
              formId = input.formId || input.id || input.form_id;
            } else {
              formId = String(input);
            }
            
            logger.info(`fetchFormStructureById - Looking for form: ${formId}`);
            
            const form = formMetadata.find(f => f.formId === formId);
            
            if (form) {
              return form;
            } else {
              // List available form IDs for debugging
              const availableIds = formMetadata.map(f => f.formId).join(', ');
              logger.warn(`Form ${formId} not found. Available forms: ${availableIds}`);
              return { 
                error: `Form ${formId} not found. Available forms: ${availableIds}` 
              };
            }
          } catch (error: any) {
            logger.error(`fetchFormStructureById error: ${error}`);
            return { error: `Failed to fetch form structure: ${error.message}` };
          }
        }
      }),
  
  
      new DynamicTool({
        name: "SubmitFormTool",
        description: "Submits a completed form and returns a reference ID.",
        func: async (input: any) => {
          const refId = await submitFormToGovAPI(input);
          return { referenceId: refId };
        }
      }),
    ];
  }
  
  // ------------------------------
  // Form metadata
  // ------------------------------
  const formMetadata = [
    {
      formId: "PAN001",
      formName: "PAN Card Application",
      fields: [
        { name: "full_name", type: "text", required: true, label: "Full Name", instruction: "Enter your full name as per official documents." },
        { name: "father_name", type: "text", required: true, label: "Father's Name", instruction: "Enter your father's full name." },
        { name: "dob", type: "date", required: true, label: "Date of Birth", instruction: "DD/MM/YYYY." },
        { name: "gender", type: "radio", required: true, label: "Gender", options: ["Male", "Female", "Other"], instruction: "Select your gender." },
        { name: "aadhaar_number", type: "text", required: true, label: "Aadhaar Number", instruction: "12-digit Aadhaar." },
        { name: "mobile_number", type: "text", required: true, label: "Mobile Number", instruction: "10-digit mobile." },
        { name: "address", type: "text", required: true, label: "Address", instruction: "Full residential address." },
        { name: "declaration_consent", type: "checkbox", required: true, label: "Declaration Consent", instruction: "Confirm all info is true." },
      ]
    },
    {
      formId: "INS001",
      formName: "Insurance Application",
      fields: [
        { name: "policy_holder_name", type: "text", required: true, label: "Policy Holder Name", instruction: "Name of primary holder." },
        { name: "insured_person_name", type: "text", required: true, label: "Insured Person Name", instruction: "Name of insured." },
        { name: "relationship_to_holder", type: "dropdown", required: true, label: "Relationship", options: ["Self", "Spouse", "Child", "Parent", "Other"], instruction: "Select relationship." },
        { name: "dob_insured", type: "date", required: true, label: "DOB of Insured", instruction: "DD/MM/YYYY." },
        { name: "sum_insured", type: "dropdown", required: true, label: "Sum Insured", options: ["1 Lakh", "5 Lakhs", "10 Lakhs", "20 Lakhs"], instruction: "Coverage amount." },
        { name: "pre_existing_disease", type: "checkbox", required: false, label: "Pre-existing Disease", instruction: "Tick if any." },
        { name: "nominee_name", type: "text", required: true, label: "Nominee Name", instruction: "Nominee full name." },
        { name: "nominee_relationship", type: "text", required: true, label: "Nominee Relationship", instruction: "Relationship to nominee." },
        { name: "consent_agreement", type: "checkbox", required: true, label: "Consent Agreement", instruction: "Agree to terms." },
      ]
    }
  ];
  
  async function submitFormToGovAPI(data: any): Promise<string> {
    // TODO: integrate with your real submission endpoint
    return "REF" + Date.now();
  }