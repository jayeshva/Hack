import { formAssistantAgent } from '../graph/agents/formAssistant';
import { createInitialSession, StateType } from '../graph/graph';

// Test cases
const testCases: { input: string, session: StateType }[] = [
  {
    input: 'What forms are available?',
    session: createInitialSession(),
  },
  {
    input: 'I would like to apply for a driver\'s license.',
    session: createInitialSession(),
  },
  {
    input: 'Yes, I want to start the driver\'s license form.', // Potential trailing whitespace case
    session: {
      ...createInitialSession(),
      form_name: 'Driver\'s License',
    },
  },
  // Add more test cases as needed
];

// Run tests
(async () => {
  for (const testCase of testCases) {
    try {
      console.log(`Running test case: ${testCase.input}`);
      const result = await formAssistantAgent(testCase.input, testCase.session);
      console.log('Result:', result);
    } catch (error) {
      console.error('Error:', error);
    }
  }
})();
