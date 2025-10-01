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

// Glide API credentials
const GLIDE_API_TOKEN = process.env.GLIDE_API_TOKEN;
const GLIDE_APP_ID = process.env.GLIDE_APP_ID;
const GLIDE_TABLE_NAME = process.env.GLIDE_TABLE_NAME;

// Validate environment variables on startup
if (!OPENAI_API_KEY || !SHEET_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
  console.error('❌ Missing required environment variables!');
  console.error('Required: OPENAI_API_KEY, GOOGLE_SHEET_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY');
  process.exit(1);
}

if (!GLIDE_API_TOKEN || !GLIDE_APP_ID || !GLIDE_TABLE_NAME) {
  console.warn('⚠️ Glide API credentials missing. Summary will not auto-update in Glide table.');
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

// Function to update Glide table with AI summary
async function updateGlideTable(rowID, summary) {
  if (!GLIDE_API_TOKEN || !GLIDE_APP_ID || !GLIDE_TABLE_NAME) {
    console.log('⚠️ Skipping Glide update - credentials not configured');
    return false;
  }

  try {
    console.log(`📤 Updating Glide table for Row ID: ${rowID}`);
    
    const response = await fetch('https://api.glideapp.io/api/function/mutateTables', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GLIDE_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        appID: GLIDE_APP_ID,
        mutations: [
          {
            kind: 'set-columns-in-row',
            tableName: GLIDE_TABLE_NAME,
            columnValues: {
              'Gn4HH': summary  // AI Project summary column
            },
            rowID: rowID
          }
        ]
      })
    });

    const result = await response.json();
    
    if (response.ok) {
      console.log('✅ Glide table updated successfully');
      return true;
    } else {
      console.error('❌ Glide API error:', result);
      return false;
    }
  } catch (error) {
    console.error('❌ Error updating Glide table:', error.message);
    return false;
  }
}

// Function to build structured input data
function buildProjectData(params) {
  const data = {
    rowId: params.rowID || params['Row ID'] || params.rowId || 'Not provided',
    projectName: params.projectName || params['Project name'] || params['5DWpY'] || 'Not provided',
    partNumber: params.partNumber || params['Part number'] || params['Name'] || 'Not provided',
    partName: params.partName || params['Part name'] || params['Mzfxa'] || 'Not provided',
    checkins: params.checkins || params.Checkins || 'No check-ins recorded',
    updates: params.updates || params.Updates || 'No updates provided',
    processes: params.processes || params.Processes || 'No processes listed',
    bo: params.bo || params.BO || params['2YvCK'] || 'No bill of operations provided',
    rm: params.rm || params.RM || params['Mgpag'] || 'No raw materials listed',
    dispatchDate: params.dispatchDate || params['Dispatch date'] || params['QNggY'] || 'Not specified',
    vendorPOC: params.vendorPOC || params['Vendor POC'] || params['PHOD2'] || 'Not specified'
  };
  
  return data;
}

// Core logic function
async function generateSummaryLogic(params, startTime) {
  const projectId = params.rowID || 
                    params['Row ID'] ||
                    params.projectId || 
                    params.projectid || 
                    params.ProjectID || 
                    params.RowID ||
                    params.rowId;
  
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
  
  const projectData = buildProjectData(params);
  const previousSummaries = await getPreviousSummaries(projectId, 3);
  
  let previousContext = 'No previous analysis available for this project.';
  if (previousSummaries.length > 0) {
    previousContext = `Previous Assessments (Last ${previousSummaries.length}):\n\n` + 
      previousSummaries.map((s, i) => {
        const daysAgo = previousSummaries.length - i;
        return `Assessment -${daysAgo} (${s.timestamp}):\n${s.summary}\n`;
      }).join('\n');
  }
  
  const prompt = `You are a project management analyst evaluating a manufacturing assembly project for Wootz.Work which deals in B2B exports high quality and high precision equipment across industries. Analyze the provided data and generate a concise, easy-to-read status report focused on schedule and scope.

**INPUT DATA:**

**Project Identifier:** ${projectData.rowId}
**Project Name:** ${projectData.projectName}
**Part Number:** ${projectData.partNumber}
**Part Name:** ${projectData.partName}

**Target Dispatch Date:** ${projectData.dispatchDate}
**Vendor POC:** ${projectData.vendorPOC}

**Project Updates (chronological process updates with timestamps and contributors):**
${projectData.updates}

**Quality Check-ins (inspection findings, issues identified, and timestamps):**
${projectData.checkins}

**Processes List (required manufacturing processes with parameters and drawing numbers):**
${projectData.processes}

**Raw Materials List (list of raw materials with dimensions):**
${projectData.rm}

**Boughtouts List (list of boughtouts to be purchased and fitted in assembly):**
${projectData.bo}

**PREVIOUS ANALYSIS CONTEXT:**
${previousContext}

**YOUR TASK:**
Provide a brief, actionable assessment covering:
1. Are we on schedule to meet the dispatch date?
2. Is the scope (processes, materials, quality) on track?
3. What are the key risks and opportunities?

**OUTPUT FORMAT:**
Keep your response concise and structured as follows:

**Project Status Summary**

**Scope Completion:** [On Track / Needs Attention / Critical Gaps]

[2-3 sentences summarizing the overall situation and biggest concern]

**✅ Strengths (What's Going Well)**
* [Bullet point 1 - be specific with data]
* [Bullet point 2]
* [Bullet point 3 - only if relevant]

**⚠️ Weaknesses (Internal Issues Causing Delays)**
* [Bullet point 1 - be specific about the gap]
* [Bullet point 2]
* [Bullet point 3 - only if relevant]
For example, if there are any blindspots that we are missing or repeating any mistakes again and again

**🎯 Opportunities (Ways to Accelerate)**
* [Bullet point 1 - or state "None identified" if no data supports this]
* [Bullet point 2 - only if relevant]

**🚨 Threats (External Risks to Timeline)**
* [Bullet point 1 - focus on timeline risks]
* [Bullet point 2 - only if relevant]

**🔥 Critical Actions Needed**
1. **[Action 1]** - [One line explaining why] (Owner: [Name if known])
2. **[Action 2]** - [One line explaining why]
3. **[Action 3]** - Only if critical

**IMPORTANT GUIDELINES:**
* **Be concise**: Maximum 2-3 bullet points per section
* **Be specific**: Use actual dates, names, and numbers from the data
* **Skip sections** if there's no relevant data (write "None identified from available data")
* **Prioritize timeline impact**: Focus on what affects the dispatch date most
* **No fluff**: Every sentence should add value
* **Highlight patterns**: If multiple check-ins show the same issue (e.g., paint defects), group them
* **Call out blockers**: Clearly identify what's stopping progress (payments, approvals, quality issues)

**DATA FOCUS:**
* Recent updates matter most for schedule assessment
* Quality check-in frequency and severity indicate scope risks
* Payment/approval mentions are red flags
* Process completion vs. time remaining is key

Only use information present in the provided data. If you cannot make a confident assessment due to limited data, state that clearly.`;

  console.log('🤖 Calling OpenAI API with new prompt structure...');
  
  const completion = await Promise.race([
    openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.5,
      max_tokens: 1000
    }),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('OpenAI API timeout')), 30000)
    )
  ]);
  
  const summary = completion.choices[0].message.content;
  console.log('✅ Summary generated successfully');
  
  const scheduleMatch = summary.match(/\*\*Schedule:\*\*\s*\[(.*?)\]/);
  const scopeMatch = summary.match(/\*\*Scope Completion:\*\*\s*\[(.*?)\]/);
  
  const keyChanges = [
    scheduleMatch ? `Schedule: ${scheduleMatch[1]}` : '',
    scopeMatch ? `Scope: ${scopeMatch[1]}` : '',
    `Analysis generated at ${new Date().toLocaleString()}`
  ].filter(Boolean).join(' | ');
  
  // Save to Google Sheets
  const saveSuccess = await saveSummary(
    projectId, 
    summary, 
    keyChanges, 
    previousContext,
    params
  );
  
  // Update Glide table with the summary
  const glideUpdateSuccess = await updateGlideTable(projectId, summary);
  
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
        savedToGlide: glideUpdateSuccess,
        executionTimeMs: executionTime,
        timestamp: new Date().toISOString()
      }
    }
  };
}

// GET endpoint
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

// POST endpoint
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
    const glideConfigured = !!(GLIDE_API_TOKEN && GLIDE_APP_ID && GLIDE_TABLE_NAME);
    
    res.json({ 
      status: 'ok',
      service: 'Wootz Summary API',
      timestamp: new Date().toISOString(),
      connections: {
        googleSheets: sheetConnected ? '✅ Connected' : '❌ Failed',
        openAI: openaiConnected ? '✅ Configured' : '❌ Not configured',
        glideAPI: glideConfigured ? '✅ Configured' : '⚠️ Not configured (optional)'
      },
      version: '3.1.0'
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
    version: '3.1.0',
    features: ['OpenAI Analysis', 'Google Sheets Storage', 'Glide Table Auto-Update'],
    endpoints: {
      generateSummary: {
        path: '/generate-summary',
        methods: ['GET', 'POST'],
        description: 'Generate project analysis and auto-update Glide table'
      },
      health: {
        path: '/health',
        method: 'GET',
        description: 'Check API health and connections'
      }
    },
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
║   🚀 Wootz Summary API v3.1.0         ║
║   📡 Server running on port ${PORT}       ║
║   🌐 Environment: ${process.env.NODE_ENV || 'production'}      ║
║   📋 Auto-updates Glide table         ║
╚═══════════════════════════════════════╝
  `);
  console.log(`✅ Ready to accept requests!`);
});
