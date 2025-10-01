const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const OpenAI = require('openai');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Environment Variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

// Initialize OpenAI
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Initialize Google Sheets
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: GOOGLE_PRIVATE_KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Function to get previous summaries
async function getPreviousSummaries(projectId, limit = 5) {
  try {
    const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    // Filter by projectId and get last 'limit' entries
    const projectRows = rows
      .filter(row => row.get('ProjectID') === projectId)
      .slice(-limit)
      .map(row => ({
        timestamp: row.get('Timestamp'),
        summary: row.get('Summary'),
        keyChanges: row.get('Key_Changes')
      }));
    
    return projectRows;
  } catch (error) {
    console.error('Error fetching previous summaries:', error);
    return [];
  }
}

// Function to save summary
async function saveSummary(projectId, summary, keyChanges, previousContext) {
  try {
    const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    
    await sheet.addRow({
      Timestamp: new Date().toISOString(),
      ProjectID: projectId,
      Summary: summary,
      Key_Changes: keyChanges,
      Previous_Context: previousContext
    });
    
    return true;
  } catch (error) {
    console.error('Error saving summary:', error);
    return false;
  }
}

// Main endpoint
app.get('/generate-summary', async (req, res) => {
  try {
    const { projectId, drawings, materials, process, conversations } = req.query;
    
    if (!projectId) {
      return res.status(400).json({ error: 'ProjectID is required' });
    }
    
    // Get previous summaries
    const previousSummaries = await getPreviousSummaries(projectId, 5);
    
    // Build context
    let previousContext = '';
    if (previousSummaries.length > 0) {
      previousContext = previousSummaries.map((s, i) => 
        `Day -${previousSummaries.length - i}: ${s.summary}`
      ).join('\n\n');
    }
    
    // Create prompt for OpenAI
    const prompt = `You are analyzing a manufacturing project. Generate a concise summary in Hindi-English mix (Hinglish) that managers can quickly understand.

Previous Context (Last ${previousSummaries.length} days):
${previousContext || 'No previous history'}

Current Project Status:
- Engineering Drawings: ${drawings || 'Not provided'}
- Materials Status: ${materials || 'Not provided'}
- Process: ${process || 'Not provided'}
- Recent Conversations: ${conversations || 'Not provided'}

Generate a summary with:
1. **Aaj ka Progress**: What happened today vs yesterday
2. **Current Status**: Overall project state
3. **Issues/Blockers**: Any problems (in red flag style)
4. **Next Steps**: What needs to be done

Keep it concise (max 200 words), use bullet points, mix Hindi-English naturally.`;

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 500
    });
    
    const summary = completion.choices[0].message.content;
    
    // Extract key changes (simple approach)
    const keyChanges = summary.split('\n').filter(line => 
      line.includes('Progress') || line.includes('Changed') || line.includes('New')
    ).join(' | ');
    
    // Save to Google Sheets
    await saveSummary(projectId, summary, keyChanges, previousContext);
    
    // Return response
    res.json({
      success: true,
      projectId: projectId,
      summary: summary,
      previousDays: previousSummaries.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ 
      error: 'Failed to generate summary',
      details: error.message 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Test endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: 'Wootz Summary API is running',
    endpoints: {
      generateSummary: '/generate-summary?projectId=xxx&drawings=xxx&materials=xxx&process=xxx&conversations=xxx',
      health: '/health'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
