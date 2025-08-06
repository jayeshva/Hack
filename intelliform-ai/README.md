# IntelliForm AI

IntelliForm AI is an AI-powered, multilingual assistant that helps users fill and submit government and enterprise forms through voice or text. It identifies the right form, asks only relevant questions, auto-fills details, and generates ready-to-submit documents—either as PDFs or directly on official web portals.

## Features

- **Conversational Interface**: Interact via voice or text in multiple languages
- **Form Identification**: Automatically identifies the appropriate form based on user needs
- **Smart Form Filling**: Asks only relevant questions based on context
- **Auto-filling**: Pre-fills known information to save time
- **Document Generation**: Creates ready-to-submit PDFs or submits directly to web portals
- **Multilingual Support**: Supports major regional languages for inclusive access
- **Deployment Options**:
  - Embedded in government portals, voice bots, and CSC kiosks
  - Integrated by enterprises for onboarding and workflow automation
  - Accessible via secure digital interfaces (mobile or web)

## Architecture

```
                    🎙️ User Voice
                         ⬇
                    🗣️ Whisper (STT) → Transcribed Text
                         ⬇
                    🧠 LangChain (Intent Classifier)
                         ⬇
                    📄 Form Template (from MCP or JSON Store)
                         ⬇
                    🔄 LangGraph Agent Flow (Form Assistant):
                          - Ask next field
                          - Validate input
                          - Answer queries (Context-Aware QA)
                          - Store responses
                         ⬇
                    🧩 Map to PDF fields
                         ⬇
                    🧾 PDF Generation (PyMuPDF / ReportLab)
                         ⬇
                    ✅ Final Review or Submit via API
```

## Tech Stack

- **AWS Bedrock**: For AI model hosting and inference
- **LangChain**: For orchestrating AI workflows and intent classification
- **LangGraph**: For managing conversational agent flows
- **Whisper**: For speech-to-text conversion
- **Text-to-Speech**: For voice responses
- **TypeScript**: For type-safe development
- **Express**: For API endpoints
- **PDF-lib**: For PDF generation and manipulation

## Setup

### Prerequisites

- Node.js (v18 or higher)
- AWS account with Bedrock access
- OpenAI API key (for Whisper)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/intelliform-ai.git
   cd intelliform-ai
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the root directory with the following variables:
   ```
   AWS_ACCESS_KEY_ID=your_aws_access_key
   AWS_SECRET_ACCESS_KEY=your_aws_secret_key
   AWS_REGION=your_aws_region
   OPENAI_API_KEY=your_openai_api_key
   LANGSMITH_API_KEY=your_langsmith_api_key (optional)
   ```

4. Build the project:
   ```bash
   npm run build
   ```

5. Start the server:
   ```bash
   npm start
   ```

## Usage

### API Endpoints

- `POST /api/conversation`: Start or continue a conversation
- `POST /api/speech-to-text`: Convert speech to text
- `POST /api/generate-pdf`: Generate a filled PDF form
- `GET /api/forms`: Get available form templates

### Example Request

```json
POST /api/conversation
{
  "sessionId": "user123",
  "input": "I need to fill out a passport application form",
  "language": "en"
}
```

### Example Response

```json
{
  "response": "I can help you fill out a passport application form. Let's start with your full name as it appears on your birth certificate.",
  "nextField": "fullName",
  "formId": "passport-application",
  "sessionId": "user123"
}
```

## License

MIT
