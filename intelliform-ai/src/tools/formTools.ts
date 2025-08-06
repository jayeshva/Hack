// mcpTools.ts
import axios from "axios";

const BASE_URL = "http://localhost:3000"; 

// Tool: Fetch all available forms
export async function getAvailableForms(): Promise<{ id: string; name: string; description: string; }[]> {
  const res = await axios.get(`${BASE_URL}/get-forms`);
  return res.data.forms;
}

// Tool: Fetch structure/schema of a specific form by ID
export async function getFormSchemaById(formId: string): Promise<any> {
  const res = await axios.get(`${BASE_URL}/get-form-structure/${formId}`);
  return res.data.form;
}

// Tool: Check if a form name exists using getAvailableForms
export async function checkIfFormExistsByName(query: string): Promise<{ exists: boolean; id?: string; name?: string; description?: string }> {
  const forms = await getAvailableForms();
  const matched = forms.find(f => f.name.toLowerCase().includes(query.toLowerCase()));
  if (matched) {
    return { exists: true, id: matched.id, name: matched.name, description: matched.description };
  }
  return { exists: false };
}
