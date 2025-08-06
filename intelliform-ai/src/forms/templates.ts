import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { createLogger } from '../common/logger';
import { FormTemplate } from '../types';
import { config } from '../config';

const logger = createLogger('form-templates');

// Define the schema for form template validation
const formTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  language: z.string(),
  version: z.string(),
  sections: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      fields: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          type: z.enum(['text', 'number', 'date', 'select', 'checkbox', 'radio', 'file']),
          required: z.boolean(),
          options: z.array(z.string()).optional(),
          validation: z
            .object({
              pattern: z.string().optional(),
              minLength: z.number().optional(),
              maxLength: z.number().optional(),
              min: z.number().optional(),
              max: z.number().optional(),
            })
            .optional(),
          dependsOn: z
            .object({
              field: z.string(),
              value: z.any(),
            })
            .optional(),
        })
      ),
    })
  ),
  metadata: z.object({
    category: z.string(),
    organization: z.string(),
    lastUpdated: z.string().or(z.date()),
    expiryDate: z.string().or(z.date()).optional(),
    tags: z.array(z.string()),
  }),
});

// Cache for form templates
const templateCache = new Map<string, FormTemplate>();

/**
 * Load all form templates from the templates directory
 * @returns A map of form templates by ID
 */
export async function loadAllTemplates(): Promise<Map<string, FormTemplate>> {
  try {
    logger.debug('Loading all form templates');
    
    const templatesDir = config.FORM_TEMPLATES_PATH;
    
    // Create templates directory if it doesn't exist
    if (!fs.existsSync(templatesDir)) {
      logger.debug(`Creating templates directory: ${templatesDir}`);
      fs.mkdirSync(templatesDir, { recursive: true });
    }
    
    // Read all files in the templates directory
    const files = fs.readdirSync(templatesDir);
    const jsonFiles = files.filter(file => file.endsWith('.json'));
    
    // Clear the cache
    templateCache.clear();
    
    // Load each template
    for (const file of jsonFiles) {
      try {
        const filePath = path.join(templatesDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const template = JSON.parse(content);
        
        // Validate the template
        const validatedTemplate = formTemplateSchema.parse(template);
        
        // Convert date strings to Date objects
        if (typeof validatedTemplate.metadata.lastUpdated === 'string') {
          validatedTemplate.metadata.lastUpdated = new Date(validatedTemplate.metadata.lastUpdated);
        }
        
        if (validatedTemplate.metadata.expiryDate && typeof validatedTemplate.metadata.expiryDate === 'string') {
          validatedTemplate.metadata.expiryDate = new Date(validatedTemplate.metadata.expiryDate);
        }
        
        // Add to cache
        templateCache.set(validatedTemplate.id, validatedTemplate as FormTemplate);
        
        logger.debug(`Loaded template: ${validatedTemplate.id}`);
      } catch (error) {
        logger.error(`Error loading template from file ${file}:`, error);
      }
    }
    
    logger.info(`Loaded ${templateCache.size} form templates`);
    
    return templateCache;
  } catch (error) {
    logger.error('Error loading form templates:', error);
    throw new Error(`Failed to load form templates: ${(error as Error).message}`);
  }
}

/**
 * Get a form template by ID
 * @param id The ID of the form template
 * @returns The form template or null if not found
 */
export async function getTemplateById(id: string): Promise<FormTemplate | null> {
  try {
    // Check if the template is in the cache
    if (templateCache.has(id)) {
      return templateCache.get(id) || null;
    }
    
    // If not in cache, try to load it from file
    const templatesDir = config.FORM_TEMPLATES_PATH;
    const filePath = path.join(templatesDir, `${id}.json`);
    
    if (!fs.existsSync(filePath)) {
      logger.debug(`Template not found: ${id}`);
      return null;
    }
    
    const content = fs.readFileSync(filePath, 'utf-8');
    const template = JSON.parse(content);
    
    // Validate the template
    const validatedTemplate = formTemplateSchema.parse(template);
    
    // Convert date strings to Date objects
    if (typeof validatedTemplate.metadata.lastUpdated === 'string') {
      validatedTemplate.metadata.lastUpdated = new Date(validatedTemplate.metadata.lastUpdated);
    }
    
    if (validatedTemplate.metadata.expiryDate && typeof validatedTemplate.metadata.expiryDate === 'string') {
      validatedTemplate.metadata.expiryDate = new Date(validatedTemplate.metadata.expiryDate);
    }
    
    // Add to cache
    templateCache.set(validatedTemplate.id, validatedTemplate as FormTemplate);
    
    logger.debug(`Loaded template: ${validatedTemplate.id}`);
    
    return validatedTemplate as FormTemplate;
  } catch (error) {
    logger.error(`Error getting template ${id}:`, error);
    return null;
  }
}

/**
 * Find templates by category
 * @param category The category to search for
 * @returns An array of matching templates
 */
export async function findTemplatesByCategory(category: string): Promise<FormTemplate[]> {
  try {
    // Ensure all templates are loaded
    if (templateCache.size === 0) {
      await loadAllTemplates();
    }
    
    // Filter templates by category
    const templates = Array.from(templateCache.values()).filter(
      template => template.metadata.category.toLowerCase() === category.toLowerCase()
    );
    
    return templates;
  } catch (error) {
    logger.error(`Error finding templates by category ${category}:`, error);
    return [];
  }
}

/**
 * Find templates by language
 * @param language The language code to search for
 * @returns An array of matching templates
 */
export async function findTemplatesByLanguage(language: string): Promise<FormTemplate[]> {
  try {
    // Ensure all templates are loaded
    if (templateCache.size === 0) {
      await loadAllTemplates();
    }
    
    // Filter templates by language
    const templates = Array.from(templateCache.values()).filter(
      template => template.language.toLowerCase() === language.toLowerCase()
    );
    
    return templates;
  } catch (error) {
    logger.error(`Error finding templates by language ${language}:`, error);
    return [];
  }
}

/**
 * Save a form template
 * @param template The form template to save
 * @returns True if successful, false otherwise
 */
export async function saveTemplate(template: FormTemplate): Promise<boolean> {
  try {
    // Validate the template
    formTemplateSchema.parse(template);
    
    const templatesDir = config.FORM_TEMPLATES_PATH;
    
    // Create templates directory if it doesn't exist
    if (!fs.existsSync(templatesDir)) {
      logger.debug(`Creating templates directory: ${templatesDir}`);
      fs.mkdirSync(templatesDir, { recursive: true });
    }
    
    const filePath = path.join(templatesDir, `${template.id}.json`);
    
    // Write the template to file
    fs.writeFileSync(filePath, JSON.stringify(template, null, 2), 'utf-8');
    
    // Update the cache
    templateCache.set(template.id, template);
    
    logger.debug(`Saved template: ${template.id}`);
    
    return true;
  } catch (error) {
    logger.error(`Error saving template ${template.id}:`, error);
    return false;
  }
}

export default {
  loadAllTemplates,
  getTemplateById,
  findTemplatesByCategory,
  findTemplatesByLanguage,
  saveTemplate,
};
