


export const clarificationAgent = {
    invoke: async ({ input, chat_history }: { input: string, chat_history?: any[] }) => {
      if (input.toLowerCase().includes("passport")) {
        return {
          output: "Yes, you can apply for a passport here. Shall I proceed?",
          form_id: "form_passport",
          form_name: "Passport Application",
          form_fields: [
            { name: "full_name", label: "Full Name", type: "text", required: true },
            { name: "dob", label: "Date of Birth", type: "date", required: true },
            { name: "address", label: "Address", type: "text", required: true },
          ]
        };
      }
  
      return {
        output: "We offer several forms such as Passport Application, Driving License, and PAN Card. What do you want to apply for?"
      };
    }
  };



export const formFillingAgent = {
    invoke: async ({
      input,
      form_id,
      form_fields,
      current_field,
      chat_history,
    }: {
      input: string;
      form_id?: string;
      form_fields?: any[];
      current_field?: string;
      chat_history?: any[];
    }) => {
      const nextField = form_fields?.find(f => f.name !== current_field) || form_fields?.[0];
  
      if (!nextField) {
        return {
          output: "Your form is complete. Submitting now!",
          form_status: "completed",
          awaiting_input: false,
        };
      }
  
      return {
        output: `Please enter your ${nextField.label}.`,
        current_field: nextField.name,
        form_status: "in_progress",
        awaiting_input: true,
      };
    }
  };
  
  
  export const statusTrackingAgent = {
    invoke: async ({ input, form_id, chat_history }: { input: string, form_id?: string, chat_history?: any[] }) => {
      return {
        output: `The status of your form (${form_id || "unknown"}) is: Under Review. You will be notified once approved.`
      };
    }
  };
  
  