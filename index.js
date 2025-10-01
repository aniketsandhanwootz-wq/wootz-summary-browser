const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const OpenAI = require('openai');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Environment Variables with validation
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

// Validate environment variables on startup
if (!OPENAI_API_KEY || !SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error('❌ Missing required environment variables!');
  console.error('Required: OPENAI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY');
  process.exit(1);
}

// Initialize OpenAI
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Initialize Google Sheets Auth
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: GOOGLE_PRIVATE_KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Cache for sheet document
let sheetDoc = null;

// Initialize sheet connection (with retry)
async function getSheetDoc() {
  if (!sheetDoc) {
    sheetDoc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);
    await sheetDoc.loadInfo();
    console.log(`📊 Connected to sheet: ${sheetDoc.title}`);
  }
  return sheetDoc;
}

// Function to get previous summaries with error handling
async function getPreviousSummaries(projectId, limit = 5) {
  try {
    const doc = await getSheetDoc();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    if (rows.length === 0) {
      console.log('📝 No previous summaries found (empty sheet)');
      return [];
    }
    
    // Filter by projectId and get last 'limit' entries
    const projectRows = rows
      .filter(row => {
        const rowProjectId = row.get('ProjectID');
        return rowProjectId && rowProjectId.toString().trim() === projectId.toString().trim();
      })
      .slice(-limit)
      .map(row => ({
        timestamp: row.get('Timestamp') || 'Unknown time',
        summary: row.get('Summary') || 'No summary',
        keyChanges: row.get('Key_Changes') || 'No changes recorded'
      }));
    
    console.log(`📋 Found ${projectRows.length} previous summaries for project ${projectId}`);
    return projectRows;
  } catch (error) {
    console.error('❌ Error fetching previous summaries:', error.message);
    return [];
  }
}

// Function to save summary with retry logic
async function saveSummary(projectId, summary, keyChanges, previousContext, allData) {
  try {
    const doc = await getSheetDoc();
    const sheet = doc.sheetsByIndex[0];
    
    // Store all input data as JSON for future reference
    const dataSnapshot = JSON.stringify(allData);
    
    await sheet.addRow({
      Timestamp: new Date().toISOString(),
      ProjectID: projectId,
      Summary: summary,
      Key_Changes: keyChanges,
      Previous_Context: previousContext,
      Data_Snapshot: dataSnapshot
    });
    
    console.log(`✅ Summary saved for project ${projectId}`);
    return true;
  } catch (error) {
    console.error('❌ Error saving summary:', error.message);
    try {
      console.log('🔄 Retrying save operation...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      sheetDoc = null;
      const doc = await getSheetDoc();
      const sheet = doc.sheetsByIndex[0];
      const dataSnapshot = JSON.stringify(allData);
      
      await sheet.addRow({
        Timestamp: new Date().toISOString(),
        ProjectID: projectId,
        Summary: summary,
        Key_Changes: keyChanges,
        Previous_Context: previousContext,
        Data_Snapshot: dataSnapshot
      });
      
      console.log('✅ Summary saved on retry');
      return true;
    } catch (retryError) {
      console.error('❌ Retry failed:', retryError.message);
      return false;
    }
  }
}

// Dynamic function to build project status from any parameters
function buildProjectStatus(params) {
  const excludeParams = ['projectid', 'projectId', 'ProjectID', 'rowid', 'rowId', 'RowID', 'row_id', 'Row ID'];
  const statusLines = [];
  
  for (const [key, value] of Object.entries(params)) {
    if (!excludeParams.includes(key) && !excludeParams.includes(key.toLowerCase()) && value) {
      const readableKey = key
        .replace(/([A-Z])/g, ' $1')
        .replace(/_/g, ' ')
        .trim()
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');
      
      statusLines.push(`- ${readableKey}: ${value}`);
    }
  }
  
  return statusLines.length > 0 
    ? statusLines.join('\n')
    : '- No specific details provided';
}

// Core logic function (shared between GET and POST)
async function generateSummaryLogic(data, startTime) {
  // Get projectId from various possible field names
  const projectId = data.projectId || 
                    data.projectid || 
                    data.ProjectID || 
                    data.rowID || 
                    data.RowID ||
                    data.rowId ||
                    data.row_id ||
                    data['Row ID'];
  
  if (!projectId) {
    console.log('❌ Missing projectId/rowId');
    return {
      status: 400,
      response: { 
        success: false,
        error: 'ProjectID or RowID is required',
        hint: 'Include projectId or rowID in request'
      }
    };
  }
  
  // Build dynamic project status
  const projectStatus = buildProjectStatus(data);
  
  // Get previous summaries
  const previousSummaries = await getPreviousSummaries(projectId, 5);
  
  // Build previous context
  let previousContext = 'No previous history available.';
  if (previousSummaries.length > 0) {
    previousContext = previousSummaries.map((s, i) => {
      const daysAgo = previousSummaries.length - i;
      return `📅 Day -${daysAgo} (${s.timestamp}):\n${s.summary}`;
    }).join('\n\n');
  }
  
  // Create dynamic prompt
  const prompt = `You are analyzing a manufacturing project for Wootz company. Generate a concise summary in Hindi-English mix (Hinglish) that managers can quickly understand.

📊 PROJECT: ${projectId}

📜 PREVIOUS CONTEXT (Last ${previousSummaries.length} ${previousSummaries.length === 1 ? 'day' : 'days'}):
${previousContext}

📋 CURRENT PROJECT STATUS:
${projectStatus}

🎯 Generate a clear summary with:
1. **Aaj ka Progress**: What happened today compared to previous days
2. **Current Status**: Overall project health aur state
3. **⚠️ Issues/Blockers**: Any problems jo immediate attention chahte hain
4. **⏭️ Next Steps**: Kya karna hai aage

Style Guidelines:
- Keep it concise (max 250 words)
- Use bullet points for clarity
- Mix Hindi-English naturally (Hinglish)
- Highlight critical issues with emojis (🔴 for urgent, ⚠️ for important)
- Be specific about numbers, dates, percentages when available
- If there's no previous history, focus more on current status and next steps

Generate the summary now:`;

  console.log('🤖 Calling OpenAI API...');
  
  // Call OpenAI with timeout
  const completion = await Promise.race([
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 600
    }),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('OpenAI API timeout')), 30000)
    )
  ]);
  
  const summary = completion.choices[0].message.content;
  console.log('✅ Summary generated successfully');
  
  // Extract key changes
  const keyChangesKeywords = [
    'Progress', 'Changed', 'New', 'Updated', 'Completed', 
    'Started', 'Received', 'Approved', 'Issue', 'Blocker',
    'प्रगति', 'बदलाव', 'नया', 'पूरा'
  ];
  
  const keyChanges = summary
    .split('\n')
    .filter(line => 
      keyChangesKeywords.some(keyword => 
        line.toLowerCase().includes(keyword.toLowerCase())
      )
    )
    .map(line => line.replace(/^[•\-*]\s*/, '').trim())
    .filter(line => line.length > 10)
    .slice(0, 3)
    .join(' | ') || 'No major changes detected';
  
  // Save to Google Sheets
  const saveSuccess = await saveSummary(
    projectId, 
    summary, 
    keyChanges, 
    previousContext,
    data
  );
  
  const executionTime = Date.now() - startTime;
  console.log(`⏱️ Total execution time: ${executionTime}ms`);
  
  return {
    status: 200,
    response: {
      success: true,
      projectId: projectId,
      summary: summary,
      keyChanges: keyChanges,
      metadata: {
        previousSummariesCount: previousSummaries.length,
        savedToSheet: saveSuccess,
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString()
      }
    }
  };
}

// GET endpoint (for browser/Open Link)
app.get('/generate-summary', async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('🚀 GET request received');
    console.log('📥 Query params:', JSON.stringify(req.query, null, 2));
    
    const result = await generateSummaryLogic(req.query, startTime);
    return res.status(result.status).json(result.response);
    
  } catch (error) {
    console.error('❌ Error in GET /generate-summary:', error);
    const executionTime = Date.now() - startTime;
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to generate summary',
      details: error.message,
      metadata: {
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// POST endpoint (for Glide webhook)
app.post('/generate-summary', async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('🚀 POST request received (webhook)');
    console.log('📥 Request body:', JSON.stringify(req.body, null, 2));
    
    const result = await generateSummaryLogic(req.body, startTime);
    return res.status(result.status).json(result.response);
    
  } catch (error) {
    console.error('❌ Error in POST /generate-summary:', error);
    const executionTime = Date.now() - startTime;
    
    res.status(500).json({ 
      success: false,
      error: 'Failed to generate summary',
      details: error.message,
      metadata: {
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString()
      }
    });
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    const doc = await getSheetDoc();
    const sheetConnected = !!doc;
    const openaiConnected = !!OPENAI_API_KEY && OPENAI_API_KEY.startsWith('sk-');
    
    res.json({ 
      status: 'ok',
      service: 'Wootz Summary API',
      timestamp: new Date().toISOString(),
      connections: {
        googleSheets: sheetConnected ? '✅ Connected' : '❌ Failed',
        openAI: openaiConnected ? '✅ Configured' : '❌ Not configured'
      },
      version: '2.2.0'
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 Wootz Summary API is running',
    version: '2.2.0',
    endpoints: {
      generateSummary: {
        path: '/generate-summary',
        methods: ['GET', 'POST'],
        requiredParams: ['projectId or rowID'],
        optionalParams: 'Any additional parameters (flexible)',
        getExample: 'GET /generate-summary?rowID=123&status=Testing',
        postExample: 'POST /generate-summary with JSON body: {"rowID": "123", "status": "Testing"}',
        glideWebhook: 'Use POST method, add fields to request body'
      },
      health: {
        path: '/health',
        method: 'GET',
        description: 'Check API health and connections'
      }
    },
    documentation: 'Supports both GET (URL params) and POST (request body). Perfect for Glide webhooks.',
    timestamp: new Date().toISOString()
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: ['/', '/health', '/generate-summary (GET/POST)'],
    hint: 'Check the root endpoint (/) for API documentation'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('💥 Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║   🚀 Wootz Summary API v2.2.0         ║
║   📡 Server running on port ${PORT}       ║
║   🌐 Environment: ${process.env.NODE_ENV || 'production'}      ║
║   🔄 Supports GET & POST requests     ║
╚═══════════════════════════════════════╝
  `);
  console.log(`✅ Ready to accept requests!`);
});
