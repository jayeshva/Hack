import { DynamicTool } from "@langchain/core/tools";
import { Router } from "express";

const router = Router();




const dummy_forms = [
    {
        id: 'form1',
        name: 'Passport Application',
        description: 'A form for applying for a indian passport',
        language: 'en',
        version: '1.0',
        fields: [
            {
                id: 'firstName',
                label: 'First Name',
                custom_prompt: 'Please enter your first name as per your aadhar card',
                type: 'text',
                required: true
            },
            {
                id: 'lastName',
                label: 'Last Name',
                custom_prompt: 'Please enter your last name as per your aadhar card',
                type: 'text',
                required: true
            },
            {
                id: 'dateOfBirth',
                label: 'Date of Birth',
                custom_prompt: 'Please enter your date of birth as per your aadhar card',
                type: 'date',
                required: true
            },
            {
                id: 'address',
                label: 'Address',
                custom_prompt: 'Please enter your address as per your aadhar card',
                type: 'text',
                required: true
            }

        ],
        categories: [],
        metadata: {}
    },
    {
        id: 'form2',
        name: 'Driving License Application',
        description: 'A form for applying for a indian driving license',
        language: 'en',
        version: '1.0',
        fields: [
            {
                id: 'firstName',
                label: 'First Name',
                custom_prompt: 'Please enter your first name as per your aadhar card',
                type: 'text',
                required: true
            },
            {
                id: 'lastName',
                label: 'Last Name',
                custom_prompt: 'Please enter your last name as per your aadhar card',
                type: 'text',
                required: true
            },
            {
                id: 'dateOfBirth',
                label: 'Date of Birth',
                custom_prompt: 'Please enter your date of birth as per your aadhar card',
                type: 'date',
                required: true
            },
            {
                id: 'address',
                label: 'Address',
                custom_prompt: 'Please enter your address as per your aadhar card',
                type: 'text',
                required: true
            },
            {
                id: 'InsuranceNumber',
                label: 'Insurance Number',
                custom_prompt: 'Please enter your insurance number',
                type: 'text',
                required: true
            },
            {
                id: 'insuranceExpiryDate',
                label: 'Insurance Expiry Date',
                custom_prompt: 'Please enter your insurance expiry date (dd/mm/yyyy)',
                type: 'date',
                required: true
            }
        ],
        categories: [],
        metadata: {}
    }
]

router.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});


router.get('/get-forms', (req, res) => {

    var formList = dummy_forms.map((form) => {
        return {
            id: form.id,
            name: form.name,
            description: form.description,
        }
    });

    res.status(200).json({ forms: formList });
});


router.get('/get-form-structure/:id', (req, res) => {

    var id = req.params.id;
    var form = dummy_forms.find((form) => form.id == id);
    res.status(200).json({ form: form });
});

router.post('/submit-form', (req, res) => {
    console.log(req.body.form);
    res.status(200).json({ form: req.body.form });
});


export const fetchAllForms = new DynamicTool({
    name: "fetch_all_forms",
    description: "Returns a list of available forms including their IDs and descriptions.",
    func: async () => {
      console.log("Fetching all forms");
      const formList = dummy_forms.map(form => ({
        id: form.id,
        name: form.name,
        description: form.description,
      }));
  
      if (formList.length === 0) return "No forms available.";
  
      return formList.map(f => `ID: ${f.id}, Name: ${f.name}, Desc: ${f.description}`).join("\n");
    }
  });
  

export const fetch_form_structure = new DynamicTool({
    name: "fetch_form_structure",
    description: "Returns the structure/schema of a specific form by ID.",
    func: async (formId: string) => {
      console.log("Fetching form structure for form ID:", formId);
      const form = dummy_forms.find(form => form.id === formId);
      if (!form) return "Form not found.";
      return JSON.stringify(form);
    }
  });

export default router;