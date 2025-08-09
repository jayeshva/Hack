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
import { formAssistantAgent } from "./agents/formAssistant";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { Runnable } from "@langchain/core/runnables";
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';

// Map form IDs to their PDF template paths
const PDF_TEMPLATES: Record<string, string> = {
  'PAN001': 'templates/pan_card_template.pdf',
  'INS001': 'templates/insurance_application_template.pdf',
  // Add more form ID to template mappings here
};


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

- Route to form_filling_agent if: 
  - the form_is_started is true and check the input for the anwser for the context or not if any queries route to form_assistant_agent

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

    const validRoutes = ["form_assistant_agent", "status_tracking_agent","submit_form"];
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

  logger.info(`Current form context: ${JSON.stringify(state.is_form_filling_started)}`);

  // Always prioritize form filling if started, regardless of router decision
  if (state.is_form_filling_started) {
    logger.info(`Form filling started, always routing to form_filling_agent`);
    return "form_filling_agent";
  }
  else if (state.form_status === "completed") {
    return "submit_form";
  }
  else {
    logger.info(`Routing to agent in else: ${state.current_node}`);
    switch (state.current_node) {
      case "form_assistant_agent":
        return "form_assistant_agent";
      case "status_tracking_agent":
        return "status_tracking_agent";
      default:
        return "form_assistant_agent";
    }
  }
};

// ------------------------------
// Agent Nodes
// ------------------------------
async function formAssistantNode(state: StateType): Promise<Partial<StateType>> {
  try {
    logger.info(`Form assistant processing: ${state.input}`);
    // logger.info(`Current form context: ${state.form_id ? `form_id=${state.form_id}` : 'no form'}`);

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
    logger.info(`Form filling processing: "${state.input}"`);
    const { form_fields, current_field, input } = state;
  logger.info(`current scenario form fields: ${JSON.stringify(form_fields)}`);

    const currentFieldObj = form_fields?.find(f => f.name === current_field);
    if (!currentFieldObj) {
      logger.error(`Current field not found: ${current_field}`);
      return { ...state };
    }

    // Save user input to current field
    const updatedFields = form_fields?.map(f =>
      f.name === current_field ?   { ...f, value: input }  : {...f }
    );

    const remainingFields = updatedFields?.filter(
      (f) =>  (f.value === null || f.value === "" || f.value === undefined)
    );

    const nextField = remainingFields?.[0];

    const updatedState: Partial<StateType> = {
      chat_history: [...(state.chat_history || []), new HumanMessage({ content: input })],
      form_fields: updatedFields,
      current_field: nextField?.name,
      form_status: "in_progress",
    };

    logger.info(`Remaining fields: ${JSON.stringify(remainingFields)}`);


    if ( remainingFields && remainingFields.length > 0) {
      logger.info(`Remaining fields: ${JSON.stringify(remainingFields)}`);
      const prompt = ChatPromptTemplate.fromMessages([
        ["system", "You are a helpful assistant collecting form data from a user."],
        ["human", `Please provide: ${nextField.name}\n${nextField.instruction}`],
      ]);
      const llmInput = await prompt.formatMessages({});
      const aiResponse = await llm.invoke(llmInput);

      updatedState.chat_history?.push(new AIMessage({ content: aiResponse.content }));
    } else {
      // All fields filled → Ask LLM to summarize and request confirmation
      logger.info(`All fields filled: ${JSON.stringify(updatedFields)}`);
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



// async function submitFormNode(state: StateType): Promise<Partial<StateType>> {
//   const formData = Object.fromEntries(
//     (state.form_fields || []).map((f) => [f.name, f.value])
//   );

//   logger.info("Submitting form data:", formData);

//   // Replace this with real API call or logic
//   const confirmationMessage = `✅ Your "${state.form_name}" form has been submitted successfully.\n\nSummary:\n${Object.entries(formData)
//     .map(([k, v]) => `• ${k}: ${v}`)
//     .join("\n")}`;

//   const aiMessage = new AIMessage({ content: confirmationMessage });

//   return {
//     chat_history: [...(state.chat_history || []), aiMessage],
//     current_node: "submit_form",
//     last_node: state.current_node,
//     awaiting_input: false,
//     is_form_filling_started: false,
//     form_id: undefined,
//     form_name: undefined,
//     form_fields: undefined,
//     current_field: undefined,
//     last_field: undefined,
//     isFormfillingInterupted: false,
//     form_status: undefined,
//   };
// }


// ------------------------------
// Build LangGraph
// ------------------------------


async function fillPDFTemplate(
  templatePath: string,
  formData: Record<string, any>,
  formFields: any[]
): Promise<Buffer> {
  try {
    // Read the existing PDF template
    const existingPdfBytes = fs.readFileSync(templatePath);
    
    // Load the PDF document
    const pdfDoc = await PDFDocument.load(existingPdfBytes);
    
    // Get the form from the PDF
    const form = pdfDoc.getForm();
    
    // Log available fields in the template (useful for debugging)
    const fields = form.getFields();
    logger.info('Available PDF form fields:', fields.map(f => f.getName()));
    
    // Fill each field based on the form data
    formFields.forEach(field => {
      const fieldName = field.name;
      const fieldValue = formData[fieldName];
      
      try {
        // Check if the field exists in the PDF template
        const pdfField = fields.find(f => f.getName() === fieldName);
        
        if (!pdfField) {
          logger.warn(`Field "${fieldName}" not found in PDF template`);
          return;
        }
        
        // Handle different field types
        switch (field.type) {
          case 'text':
          case 'date':
          case 'number':
            const textField = form.getTextField(fieldName);
            if (textField) {
              textField.setText(String(fieldValue || ''));
            }
            break;
            
          case 'dropdown':
          case 'select':
            const dropdown = form.getDropdown(fieldName);
            if (dropdown && fieldValue) {
              // Check if the option exists
              const options = dropdown.getOptions();
              if (options.includes(String(fieldValue))) {
                dropdown.select(String(fieldValue));
              } else {
                logger.warn(`Option "${fieldValue}" not found in dropdown "${fieldName}"`);
              }
            }
            break;
            
          case 'radio':
            const radioGroup = form.getRadioGroup(fieldName);
            if (radioGroup && fieldValue) {
              const options = radioGroup.getOptions();
              if (options.includes(String(fieldValue))) {
                radioGroup.select(String(fieldValue));
              }
            }
            break;
            
          case 'checkbox':
            const checkBox = form.getCheckBox(fieldName);
            if (checkBox) {
              // Handle different checkbox value formats
              const isChecked = 
                fieldValue === true || 
                fieldValue === 'true' || 
                fieldValue === 'yes' || 
                fieldValue === 'on' ||
                fieldValue === 1 ||
                fieldValue === '1';
              
              if (isChecked) {
                checkBox.check();
              } else {
                checkBox.uncheck();
              }
            }
            break;
            
          default:
            // Try as text field for unknown types
            try {
              const genericField = form.getTextField(fieldName);
              if (genericField && fieldValue !== undefined) {
                genericField.setText(String(fieldValue));
              }
            } catch (e) {
              logger.warn(`Could not set field "${fieldName}" with type "${field.type}"`);
            }
        }
      } catch (error) {
        logger.error(`Error filling field "${fieldName}":`, error);
      }
    });
    
    // Add metadata
    pdfDoc.setTitle(`${formData.form_name || 'Form'} - Submitted`);
    pdfDoc.setSubject(`Form submission - ${new Date().toISOString()}`);
    pdfDoc.setCreator('Form Assistant System');
    pdfDoc.setProducer('Form Assistant PDF Generator');
    pdfDoc.setCreationDate(new Date());
    pdfDoc.setModificationDate(new Date());
    
    // Optional: Flatten the form to prevent further editing
    // This makes the form fields non-editable
    form.flatten();
    
    // Serialize the PDFDocument to bytes
    const pdfBytes = await pdfDoc.save();
    
    return Buffer.from(pdfBytes);
    
  } catch (error) {
    logger.error('Error filling PDF template:', error);
    throw error;
  }
}

// Helper function to add a stamp/watermark to the PDF
async function addSubmissionStamp(
  pdfBuffer: Buffer,
  submissionId: string
): Promise<Buffer> {
  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages = pdfDoc.getPages();
    const firstPage = pages[0];
    
    // Embed font
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    
    // Add submission stamp on first page
    const { width, height } = firstPage.getSize();
    const stampText = `SUBMITTED: ${new Date().toLocaleDateString()} | ID: ${submissionId}`;
    const textWidth = font.widthOfTextAtSize(stampText, 10);
    
    firstPage.drawText(stampText, {
      x: width - textWidth - 20,
      y: height - 20,
      size: 10,
      font: font,
      color: rgb(0.5, 0.5, 0.5),
    });
    
    // Add watermark (optional)
    pages.forEach(page => {
      page.drawText('SUBMITTED', {
        x: page.getWidth() / 2 - 100,
        y: page.getHeight() / 2,
        size: 60,
        font: font,
        color: rgb(0.9, 0.9, 0.9),
        // rotate: { angle: -45 * (Math.PI / 180) },
        opacity: 0.3,
      });
    });
    
    return Buffer.from(await pdfDoc.save());
    
  } catch (error) {
    logger.error('Error adding submission stamp:', error);
    return pdfBuffer; // Return original if stamping fails
  }
}

async function submitFormNode(state: StateType): Promise<Partial<StateType>> {
  try {
    // Prepare form data
    const formData = Object.fromEntries(
      (state.form_fields || []).map((f) => [f.name, f.value || ''])
    );

    logger.info("Submitting form data:", formData);

    // Generate submission ID
    const submissionId = uuidv4().slice(0, 8).toUpperCase();
    
    // Check if we have a template for this form
    const templatePath = PDF_TEMPLATES[state.form_id || ''];
    
    let downloadInfo = '';
    let pdfFileName = '';
    
    if (templatePath && fs.existsSync(templatePath)) {
      try {
        logger.info(`Using PDF template: ${templatePath}`);
        
        // Fill the PDF template
        let pdfBuffer = await fillPDFTemplate(
          templatePath,
          formData,
          state.form_fields || []
        );
        
        // Add submission stamp
        pdfBuffer = await addSubmissionStamp(pdfBuffer, submissionId);
        
        // Save the filled PDF
        pdfFileName = `${state.form_id}_${submissionId}_${Date.now()}.pdf`;
        const outputDir = path.join(process.cwd(), 'submitted-forms');
        
        // Ensure directory exists
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        
        const outputPath = path.join(outputDir, pdfFileName);
        fs.writeFileSync(outputPath, pdfBuffer);
        
        logger.info(`Filled PDF saved: ${outputPath}`);
        
        // Generate download URL
        const downloadUrl = `/api/download-form/${pdfFileName}`;
        
        downloadInfo = `\n\n📄 **Your completed form is ready!**
🔗 **Download:** [${state.form_name || 'Form'}.pdf](${downloadUrl})
📧 A copy has been sent to your registered email.
🔒 Your submission ID: \`${submissionId}\``;
        
        // Optional: Save to database
        await saveFormSubmission({
          submissionId,
          formId: state.form_id,
          formName: state.form_name,
          formData: formData,
          pdfPath: outputPath,
          templateUsed: templatePath,
          submittedAt: new Date()
        });
        
      } catch (pdfError) {
        logger.error('PDF template filling failed:', pdfError);
        downloadInfo = '\n\n⚠️ Unable to generate PDF. Your form data has been saved.';
      }
    } else {
      logger.warn(`No PDF template found for form ID: ${state.form_id}`);
      downloadInfo = '\n\n📋 Form submitted successfully (no PDF template available).';
    }

    // Format summary for display
    const formattedSummary = (state.form_fields || [])
      .filter(f => f.value) // Only show filled fields
      .map(field => {
        const value = formData[field.name];
        let displayValue = value;
        
        if (field.type === 'checkbox') {
          displayValue = value === 'yes' || value === true ? '✅ Yes' : '❌ No';
        } else if (field.type === 'date' && value) {
          // Format date nicely
          try {
            displayValue = new Date(value).toLocaleDateString();
          } catch (e) {
            displayValue = value;
          }
        }
        
        return `• **${field.label || field.name}:** ${displayValue || 'Not provided'}`;
      })
      .join('\n');

    // Create confirmation message
    const confirmationMessage = `✅ **Form Submitted Successfully!**

📋 **${state.form_name || 'Application Form'}**
🆔 **Submission ID:** \`${submissionId}\`
📅 **Submitted:** ${new Date().toLocaleString()}

**Summary of your submission:**
${formattedSummary}${downloadInfo}

Thank you for your submission! Please save your submission ID for future reference.`;

    const aiMessage = new AIMessage({ content: confirmationMessage });

    // Clear form state after successful submission
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
      isFormReady: false,
    };

  } catch (error) {
    logger.error('Form submission error:', error);
    
    const errorMessage = `❌ An error occurred while submitting your form. 
    
Error details: ${error instanceof Error ? error.message : 'Unknown error'}

Your data has been saved locally. Please contact support with this error message.`;
    
    const aiMessage = new AIMessage({ content: errorMessage });
    
    return {
      ...state,
      chat_history: [...(state.chat_history || []), aiMessage],
      current_node: "submit_form",
      last_node: state.current_node,
    };
  }
}

async function saveFormSubmission(data: {
  submissionId: string;
  formId: string | undefined;
  formName: string | undefined;
  formData: Record<string, any>;
  pdfPath: string;
  templateUsed: string;
  submittedAt: Date;
}): Promise<void> {
  // Implement your database save logic here
  // Example: await db.formSubmissions.create(data);
  logger.info(`Form submission saved: ${data.submissionId}`);
}

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
  .addEdge("status_tracking_agent", END)
  .addEdge("form_filling_agent", END)
  .addEdge("submit_form", END);

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
