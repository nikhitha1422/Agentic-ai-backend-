const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();
const Meeting = require('../models/Meeting');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Multer Storage Configuration
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, '../uploads/meetings');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        const meetingId = req.params.meetingId;
        cb(null, `${meetingId}.webm`);
    }
});

const upload = multer({ storage: storage });

// Initialize Gemini services with safety checks
let fileManager = null;
let model = null;
if (process.env.GEMINI_API_KEY) {
    try {
        const { GoogleAIFileManager } = require("@google/generative-ai/server");
        fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);
        const { GoogleGenerativeAI } = require("@google/generative-ai");
        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        // Use flash model for compatibility
        model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
    } catch (initErr) {
        console.error("Failed to initialize Gemini services:", initErr);
    }
} else {
    console.warn("GEMINI_API_KEY not set; Gemini functionality disabled.");
}

// ------------------------------------------
// 1. Create a new meeting
// POST /api/meetings
// ------------------------------------------
router.post('/', async (req, res) => {
    try {
        console.log('Incoming meeting creation request:', JSON.stringify(req.body, null, 2));
        const { title, allowAI, description, date } = req.body;

        const meetingIdStr = uuidv4();

        // Robust date parsing
        let finalDate = new Date();
        if (date) {
            const parsedDate = new Date(date);
            if (!isNaN(parsedDate.getTime())) {
                finalDate = parsedDate;
            } else {
                console.warn(`Invalid date format received: "${date}". Falling back to current date.`);
                // Optional: return 400 if you want to be strict
                // return res.status(400).json({ error: 'Invalid date format' });
            }
        }

        const newMeeting = new Meeting({
            meetingId: meetingIdStr,
            id: meetingIdStr, // Keep for compatibility
            title: title || 'Untitled Meeting',
            description: description || '',
            status: 'scheduled',
            date: finalDate,
            allowAI: allowAI === true,
            aiJoined: false,
            participants: [],
            tasks: [],
            summary: '',
        });

        console.log('Attempting to save meeting:', meetingIdStr);
        const savedMeeting = await newMeeting.save();
        console.log('Meeting saved successfully:', savedMeeting.meetingId);
        res.status(201).json(savedMeeting);
    } catch (err) {
        console.error('Error in POST /api/meetings:', err);
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 2. User joins the meeting
// POST /api/meetings/join
// ------------------------------------------
router.post('/join', async (req, res) => {
    try {
        const { meetingId } = req.body;
        const meeting = await Meeting.findOne({ meetingId });

        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        meeting.status = 'live';
        await meeting.save();

        res.json({ message: 'Joined meeting successfully', meeting });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 2.1 Explicitly End Meeting
// POST /api/meetings/:meetingId/end
// ------------------------------------------
router.post('/:meetingId/end', async (req, res) => {
    try {
        const { meetingId } = req.params;
        const meeting = await Meeting.findOne({ meetingId });

        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        meeting.status = 'completed';
        meeting.endedAt = new Date();
        await meeting.save();

        res.json({ success: true, status: 'completed' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 3. Grant AI Permission (Explicit Consent)
// POST /api/meetings/ai-permission
// ------------------------------------------
router.post('/ai-permission', async (req, res) => {
    try {
        const { meetingId, allowAI } = req.body;
        const meeting = await Meeting.findOne({ meetingId });

        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        if (allowAI === true) {
            meeting.allowAI = true;
            meeting.aiJoined = true;
            await meeting.save();
            res.json({ message: 'AI Agent has joined the meeting', aiJoined: true });
        } else {
            meeting.allowAI = false;
            meeting.aiJoined = false;
            await meeting.save();
            res.json({ message: 'AI Agent has left the meeting', aiJoined: false });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 4. Get all meetings (or search)
// GET /api/meetings
// ------------------------------------------
router.get('/', async (req, res) => {
    try {
        const { query } = req.query;
        let filter = {};
        if (query) {
            filter = {
                $or: [
                    { title: { $regex: query, $options: 'i' } },
                    { description: { $regex: query, $options: 'i' } }
                ]
            };
        }
        const meetings = await Meeting.find(filter).sort({ date: -1 });
        res.json(meetings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 4.1 Get all tasks from all meetings
// GET /api/meetings/tasks/all
// ------------------------------------------
router.get('/tasks/all', async (req, res) => {
    try {
        const meetings = await Meeting.find({}, 'tasks title meetingId');
        let allTasks = [];
        meetings.forEach(meeting => {
            if (meeting.tasks && meeting.tasks.length > 0) {
                const tasksWithMeetingInfo = meeting.tasks.map(t => ({
                    ...t.toObject(),
                    meetingTitle: meeting.title,
                    meetingId: meeting.meetingId
                }));
                allTasks = allTasks.concat(tasksWithMeetingInfo);
            }
        });
        res.json(allTasks);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 5. Get single meeting details
// GET /api/meetings/:id
// ------------------------------------------
router.get('/:meetingId', async (req, res) => {
    try {
        const meeting = await Meeting.findOne({ meetingId: req.params.meetingId });
        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }
        res.json(meeting);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 5.1 Upload Meeting Audio
// POST /api/meetings/:meetingId/audio
// ------------------------------------------
router.post('/:meetingId/audio', upload.single('audio'), async (req, res) => {
    try {
        const meetingId = req.params.meetingId;
        console.log(`Audio upload request for meeting: ${meetingId}`);
        if (req.file) {
            console.log(`Received file: ${req.file.originalname}, Size: ${req.file.size} bytes, Mimetype: ${req.file.mimetype}`);
        } else {
            console.warn(`No file received in upload request for meeting: ${meetingId}`);
        }

        // Update meeting document with audio path and set status to ended
        const updatedMeeting = await Meeting.findOneAndUpdate(
            { meetingId: meetingId },
            {
                audioPath: `uploads/meetings/${req.file.filename}`, // Removed leading slash for Windows path.join compatibility
                status: 'completed'
            },
            { new: true }
        );

        if (!updatedMeeting) {
            console.error(`Meeting not found during audio upload: ${meetingId}`);
            return res.status(404).json({ error: 'Meeting not found' });
        }

        // Return immediately to the client
        res.json({ message: 'Audio uploaded successfully. Summary generation started.', audioPath: updatedMeeting.audioPath, size: req.file.size });

        // Trigger AI summary generation in the background
        generateAISummary(meetingId).catch(err => {
            console.error("Background Summary Generation Error:", err);
        });

    } catch (err) {
        console.error("Audio Upload Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 5.2 Upload Meeting Attachments
// POST /api/meetings/:meetingId/attachments
// ------------------------------------------
router.post('/:meetingId/attachments', upload.array('files'), async (req, res) => {
    try {
        const meetingId = req.params.meetingId;
        const meeting = await Meeting.findOne({ meetingId });

        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }

        const newAttachments = req.files.map(file => ({
            name: file.originalname,
            path: `uploads/meetings/${file.filename}`,
            size: file.size,
            type: file.mimetype,
            uploadedAt: new Date()
        }));

        meeting.attachments = [...(meeting.attachments || []), ...newAttachments];
        await meeting.save();

        res.json({
            success: true,
            message: 'Files uploaded successfully',
            attachments: meeting.attachments
        });
    } catch (err) {
        console.error("Attachment Upload Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// Helper function to generate AI summary
async function generateAISummary(meetingId) {
    let meeting;
    try {
        console.log(`[AI] Summary job started for: ${meetingId}`);
        meeting = await Meeting.findOne({ meetingId });

        if (!meeting) {
            console.error(`[AI] Meeting ${meetingId} not found in DB`);
            return;
        }

        if (!meeting.audioPath) {
            console.warn(`[AI] No audioPath for meeting ${meetingId}. Cannot summarize.`);
            meeting.summary = "Error: No audio recording found.";
            meeting.status = "failed";
            await meeting.save();
            return;
        }

        // Robust path joining
        const cleanAudioPath = meeting.audioPath.startsWith('/') ? meeting.audioPath.substring(1) : meeting.audioPath;
        const audioPath = path.join(__dirname, '..', cleanAudioPath);

        if (!fs.existsSync(audioPath)) {
            console.error(`[AI] Audio file NOT found on disk: ${audioPath}`);
            meeting.summary = "Error: Audio file not found on server.";
            meeting.status = "failed";
            await meeting.save();
            return;
        }

        console.log(`[AI] Audio found: ${audioPath}`);
        // Audio file verified present

        // Detect mime type based on extension
        const ext = path.extname(audioPath).toLowerCase();
        const mimeType = ext === '.ogg' ? 'audio/ogg' : 'audio/webm';

        console.log(`[AI] Uploading to Gemini...`);

        let promptParts = [];
        const meetingDate = meeting.date ? new Date(meeting.date).toDateString() : "Not specified";
        const meetingTime = meeting.date ? new Date(meeting.date).toLocaleTimeString() : "Not specified";

        const textPrompt = `
You are an AI meeting assistant. Your goal is to provide a modern, clear, and professional summary of the meeting.
Use simple English, clean formatting, and bold headings. Keep it easy to read and focus on clarity.

Meeting Title: ${meeting.title}
Meeting Description: ${meeting.description || "No description provided"}
Date: ${meetingDate}
Time: ${meetingTime}

Please structure your response exactly with these sections (using Markdown):

## 1️⃣ Meeting Overview
(Include strictly: Title, Date, Participants (if mentioned in audio), and Purpose of the meeting)

## 2️⃣ Key Discussion Points
(Provide a concise summary of the main topics discussed. Use bullet points and short paragraphs.)

## 3️⃣ Decisions Taken
(List the final conclusions and decisions made during the meeting.)

## 4️⃣ Action Items
(List the tasks clearly. Format each line exactly as: - Task Description • Assigned To: Name • Deadline: Date/Time)
(If no assignee or deadline is mentioned, write "Unassigned" or "None" respectively)

## 5️⃣ Deadlines / Timeline
(Highlight important dates and milestones mentioned)

## 6️⃣ Conclusion
(A brief wrapping up of the meeting outcomes)

Ensure the tone is professional but friendly. Avoid clutter and unnecessary text.
Use proper spacing between sections.
`;
        promptParts.push(textPrompt);

        if (!fileManager || !model) {
            console.error('[AI] Gemini services not initialized. Skipping summary generation.');
            meeting.summary = 'Error: Gemini API not configured.';
            meeting.status = 'failed';
            await meeting.save();
            return;
        }
        const uploadResponse = await fileManager.uploadFile(audioPath, {

            mimeType: mimeType,
            displayName: `Meeting ${meeting.title}`,
        });

        console.log(`[AI] Uploaded to Gemini: ${uploadResponse.file.uri}`);

        promptParts.push({
            fileData: {
                mimeType: uploadResponse.file.mimeType,
                fileUri: uploadResponse.file.uri
            }
        });

        // Generate content with Gemini
        const result = await model.generateContent(promptParts);
        const response = await result.response;
        const summaryText = response.text();

        // --- EXTRACT TASKS ---
        const Notification = require('../models/Notification');
        const tasks = [];
        // Regex to find the Action Items section
        // Matches "## 4️⃣ Action Items" (allow variations in spacing or emojis) up to the next "##" or end of string
        const actionItemsMatch = summaryText.match(/##\s*4️⃣\s*Action Items\n([\s\S]*?)(?:\n##|$)/);

        if (actionItemsMatch && actionItemsMatch[1]) {
            const lines = actionItemsMatch[1].trim().split('\n');
            lines.forEach(line => {
                // Expected format: - Task Description • Assigned To: Name • Deadline: Date/Time
                const itemMatch = line.match(/-\s*(.*?)\s*•\s*Assigned To:\s*(.*?)\s*•\s*Deadline:\s*(.*)/i);

                if (itemMatch) {
                    const taskDesc = itemMatch[1].trim();
                    const assignedTo = itemMatch[2].trim();
                    const deadline = itemMatch[3].trim();

                    if (taskDesc) {
                        tasks.push({
                            id: uuidv4(),
                            task: taskDesc,
                            assignedTo: assignedTo !== 'Unassigned' ? assignedTo : 'Unassigned',
                            dueDate: deadline !== 'None' ? deadline : null,
                            status: 'pending'
                        });
                    }
                } else {
                    // Fallback for lines that might be simple bullets
                    const simpleClean = line.replace(/^\s*-\s*/, '').trim();
                    if (simpleClean && !simpleClean.startsWith('(')) { // Ignore instructions in parentheses
                        tasks.push({
                            id: uuidv4(),
                            task: simpleClean,
                            assignedTo: 'Unassigned',
                            status: 'pending'
                        });
                    }
                }
            });
        }

        meeting.summary = summaryText;
        meeting.tasks = tasks;
        meeting.status = 'summarized';
        await meeting.save();
        console.log(`[AI] Summary generated and tasks extracted for: ${meetingId}`);

        // --- CREATE NOTIFICATION ---
        try {
            await Notification.create({
                type: 'summary',
                title: 'Intelligence Extraction Complete',
                message: `Session "${meeting.title}" has been summarized. ${tasks.length} objectives identified.`,
                link: `/dashboard/meetings/${meetingId}/summary`,
                metadata: { meetingId }
            });
        } catch (notifErr) {
            console.error("[AI] Failed to create notification:", notifErr);
        }

        // --- DELETE TEMP FILE ---
        await fileManager.deleteFile(uploadResponse.file.name);
        console.log(`[AI] Deleted temporary Gemini file: ${uploadResponse.file.name}`);

    } catch (err) {
        console.error(`[AI] Error generating summary for ${meetingId}:`, err);
        if (meeting) {
            const Notification = require('../models/Notification');
            // Check for quota exceeded (429)
            if (err.status === 429 || (err.message && err.message.includes('429'))) {
                console.error("[AI] Gemini Quota Exceeded (429). Marking as failed.");
                meeting.summary = "Error: AI Quota Exceeded. Please try again later.";
            } else {
                meeting.summary = `Error generating summary: ${err.message}`;
            }
            meeting.status = 'failed';
            await meeting.save();

            // Notify about failure
            try {
                await Notification.create({
                    type: 'system',
                    title: 'Synthesis Protocol Failed',
                    message: `Summary generation for "${meeting.title}" encountered a terminal error.`,
                    link: `/dashboard/meetings/${meetingId}/summary`,
                    metadata: { meetingId }
                });
            } catch (ignore) { }
        }
    }
}

// ------------------------------------------
// 6. Get Summary Status and Content
// GET /api/meetings/:meetingId/summary
// ------------------------------------------
router.get('/:meetingId/summary', async (req, res) => {
    try {
        const meetingId = req.params.meetingId;
        const meeting = await Meeting.findOne({ meetingId });

        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        // If summary exists, return it with 'ready' status
        if (meeting.summary && meeting.summary.trim() !== "" && !meeting.summary.startsWith("Error generating summary")) {
            return res.json({
                status: 'ready',
                summary: meeting.summary,
                meetingTitle: meeting.title
            });
        }

        // If status is 'failed', return 'failed'
        if (meeting.status === 'failed') {
            return res.json({
                status: 'failed',
                error: meeting.summary || "Summary generation failed"
            });
        }

        // Processing: Meeting ended, audio uploaded, but no summary yet
        if (meeting.status === 'completed' || meeting.audioPath) {
            // Check if we need to trigger generation (fallback)
            // ONLY trigger if status is NOT failed and summary is empty
            if (meeting.status !== 'failed' && (!meeting.summary || meeting.summary === '')) {
                console.log(`[AI] Triggering missing summary generation for: ${meetingId}`);
                generateAISummary(meetingId).catch(err => console.error(err));
            }
            return res.json({ status: 'processing' });
        }

        // Live: Meeting is currently in progress
        if (meeting.status === 'live') {
            return res.json({ status: 'not_started', message: 'Meeting is live. Waiting for it to end.' });
        }

        // Scheduled: Meeting hasn't started yet
        res.json({ status: 'not_started', message: 'Meeting has not started yet.' });

    } catch (err) {
        console.error("GET Summary Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 6.1 Get Latest Meeting Summary (Global Chat Support)
// GET /api/meetings/latest/summary
// ------------------------------------------
router.get('/latest/summary', async (req, res) => {
    try {
        // Find the most recent meeting that has a summary
        const meeting = await Meeting.findOne({
            summary: { $exists: true, $ne: "" },
            status: 'summarized'
        }).sort({ date: -1 });

        if (!meeting) {
            return res.status(404).json({ error: 'No meeting summaries found' });
        }

        res.json({
            status: 'ready',
            summary: meeting.summary,
            meetingTitle: meeting.title,
            meetingId: meeting.meetingId,
            date: meeting.date
        });
    } catch (err) {
        console.error("GET Latest Summary Error:", err);
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 7. Generate Summary (Manual Trigger - Real AI using Gemini)
// POST /api/meetings/:meetingId/summary
// ------------------------------------------
router.post('/:meetingId/summary', async (req, res) => {
    try {
        const meetingId = req.params.meetingId;
        const meeting = await Meeting.findOne({ meetingId });
        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        if (!meeting.audioPath) {
            return res.status(400).json({ error: "No audio available to summarize. Please upload meeting audio first." });
        }

        // Check if already summarized or processing
        if (meeting.status === 'summarized') {
            return res.json({ message: 'Summary already exists', summary: meeting.summary });
        }

        // Trigger or wait for summary? For manual request, we'll run it synchronously or return "processing"
        await generateAISummary(meetingId);
        const updatedMeeting = await Meeting.findOne({ meetingId });

        res.json({ message: 'Summary generated successfully', summary: updatedMeeting.summary });
    } catch (err) {
        console.error("AI Generation Error:", err);
        res.status(500).json({ error: "Failed to generate summary: " + err.message });
    }
});

// ------------------------------------------
// 7. Create Task (Simulates Task Manager Agent)
// POST /api/meetings/:id/tasks
// ------------------------------------------
router.post('/:meetingId/tasks', async (req, res) => {
    try {
        const { task, assignedTo, dueDate } = req.body;
        const meeting = await Meeting.findOne({ meetingId: req.params.meetingId });

        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        const newTask = {
            id: uuidv4(),
            task,
            assignedTo,
            dueDate,
            status: 'pending'
        };

        meeting.tasks.push(newTask);
        await meeting.save();

        res.status(201).json({ message: 'Task assigned successfully', task: newTask });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 7.1 Update Task Status (Manual)
// DELETE /api/meetings/tasks/:taskId/status (Using PATCH)
// ------------------------------------------
router.patch('/tasks/:taskId/status', async (req, res) => {
    try {
        const { taskId } = req.params;
        const { meetingId, status } = req.body;

        const meeting = await Meeting.findOne({ meetingId });
        if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

        const task = meeting.tasks.find(t => t.id === taskId);
        if (!task) return res.status(404).json({ error: 'Task not found' });

        task.status = status;
        await meeting.save();

        // Notify client via Socket.IO
        if (req.io) {
            req.io.emit('task-status-updated', { taskId, meetingId, status, task });
        }

        res.json({ message: 'Task status updated', task });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ------------------------------------------
// 8. Neutralize Task (Autonomous Action Agent)
// POST /api/meetings/tasks/:taskId/neutralize
// ------------------------------------------
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const ActivityLog = require('../models/ActivityLog');

const neutralizeLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 50, // limit each user to 50 requests per windowMs
    message: { error: 'Neutralization quota exceeded for this cycle.' },
    keyGenerator: (req) => req.user.userId
});

router.post('/tasks/:taskId/neutralize', auth, neutralizeLimiter, async (req, res) => {
    const { taskId } = req.params;
    const { meetingId } = req.body;
    const user = req.user;

    console.log(`[Agent] Neutralization request for Task: ${taskId} by User: ${user.fullName}`);

    const meeting = await Meeting.findOne({ meetingId });
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const taskIndex = meeting.tasks.findIndex(t => t.id === taskId);
    if (taskIndex === -1) return res.status(404).json({ error: 'Task not found' });

    const task = meeting.tasks[taskIndex];
    if (task.status === 'done') return res.status(400).json({ error: 'Objective already neutralized.' });

    const prevState = task.status;

    try {
        // 1. Update status to neutralizing
        task.status = 'neutralizing';
        await meeting.save();

        // Notify client via Socket.IO
        if (req.io) {
            req.io.emit('task-status-updated', { taskId, meetingId, status: 'neutralizing' });
        }

        // 2. Prepare Gemini Prompt
        const agentPrompt = `
        You are the "Neutral Intelligence Agent". Your mission is to autonomously resolve an action item from a meeting.
        
        CONTEXT:
        Meeting Title: ${meeting.title}
        Task: ${task.task}
        Assigned To: ${task.assignedTo}
        
        INSTRUCTIONS:
        1. Solve the task or provide a high-quality draft/workflow to complete it.
        2. Provide a "Confidence Score" (0-100) based on how complete your solution is.
        3. Suggest "Next Steps" if any work remains.
        
        FORMAT YOUR RESPONSE AS JSON:
        {
          "summary": "Clear executive summary of what you did",
          "resolution": "The actual draft/code/solution",
          "confidence": 85,
          "nextSteps": ["Step 1", "Step 2"]
        }
        `;

        // 3. AICall with Timeout & Retry
        let aiResponse;
        let retryCount = 0;
        const maxRetries = 1;

        const callAI = async () => {
            const result = await model.generateContent(agentPrompt);
            const response = await result.response;
            return JSON.parse(response.text().replace(/```json\n?|\n?```/g, ''));
        };

        while (retryCount <= maxRetries) {
            try {
                // Simulate 30s timeout
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('AI Pipeline Timeout')), 30000)
                );
                aiResponse = await Promise.race([callAI(), timeoutPromise]);
                break;
            } catch (err) {
                if (retryCount === maxRetries) throw err;
                retryCount++;
                console.warn(`[Agent] Retry attempt ${retryCount} for task ${taskId}`);
            }
        }

        // 4. Update Task with success
        task.status = 'done';
        task.agentOutput = aiResponse.resolution;
        task.confidenceScore = aiResponse.confidence;
        task.nextSteps = aiResponse.nextSteps;
        await meeting.save();

        // Notify client via Socket.IO
        if (req.io) {
            req.io.emit('task-status-updated', { taskId, meetingId, status: 'done', task });
        }

        // 5. Audit Log
        await ActivityLog.create({
            type: 'neutralization',
            action: 'task_complete',
            userId: user.userId,
            userName: user.fullName,
            taskId,
            meetingId,
            previousState: prevState,
            newState: 'done',
            agentOutput: aiResponse.summary,
            status: 'success'
        });

        res.json({ success: true, task });

    } catch (err) {
        console.error(`[Agent] Neutralization failure: ${err.message}`);

        // ROLLBACK
        task.status = 'failed';
        task.failureReason = err.message;
        await meeting.save();

        // Notify client via Socket.IO
        if (req.io) {
            req.io.emit('task-status-updated', { taskId, meetingId, status: 'failed', error: err.message });
        }

        await ActivityLog.create({
            type: 'neutralization',
            action: 'task_failed',
            userId: user.userId,
            userName: user.fullName,
            taskId,
            meetingId,
            previousState: prevState,
            newState: 'failed',
            status: 'failure',
            error: err.message
        });

        res.status(500).json({ error: 'Intelligence synthesis encountered a terminal error. Reverting to manual status.' });
    }
});

// ------------------------------------------
// 9. Chat with Meeting Agent
// POST /api/meetings/:meetingId/chat
// ------------------------------------------
router.post('/:meetingId/chat', async (req, res) => {
    try {
        const { meetingId } = req.params;
        const { message, history } = req.body; // history is array of { role: 'user' | 'model', parts: [{ text: ... }] }

        if (!message) {
            return res.status(400).json({ error: "Message is required" });
        }

        const meeting = await Meeting.findOne({ meetingId });
        if (!meeting) {
            return res.status(404).json({ error: 'Meeting not found' });
        }

        if (!meeting.summary || meeting.summary.trim() === "") {
            return res.status(400).json({
                error: 'Meeting summary is not ready yet. Please wait for the summary to be generated.'
            });
        }

        // Limit summary length to avoid context window issues (approx 50k chars is safe for Flash)
        const safeSummary = meeting.summary.length > 50000
            ? meeting.summary.substring(0, 50000) + "...[Truncated]"
            : meeting.summary;

        // Construct System Prompt
        const systemInstruction = `
        You are a helpful and intelligent AI Meeting Assistant defined by the meeting summary below.
        
        CONTEXT (MEETING SUMMARY):
        ${safeSummary}

        INSTRUCTIONS:
        1. Answer the user's questions clearly based ONLY on the meeting summary provided above.
        2. If the answer is not in the summary, politely say you don't have that information from this meeting.
        3. Be professional, concise, and friendly.
        4. You are chatting with a participant of the meeting.
        
        Keep your answers direct. Use bullet points for lists if needed.
        `;

        // Start Chat Session
        // Note: GoogleGenerativeAI manages history if we use startChat, but we need to pass initial history
        // correctly formatted.
        // History format for Gemini: [ { role: "user" | "model", parts: [ { text: "..." } ] } ]

        const chatValues = history && Array.isArray(history) ? history.map(h => ({
            role: h.role,
            parts: [{ text: h.text }]
        })) : [];

        const chat = model.startChat({
            history: [
                {
                    role: "user",
                    parts: [{ text: systemInstruction }] // Seed context as first user message or system instruction depending on model support. 
                    // For simple usage, putting context in first user message acts as system prompt.
                },
                {
                    role: "model",
                    parts: [{ text: "Understood. I am ready to answer questions about the meeting summary." }]
                },
                ...chatValues
            ],
            generationConfig: {
                maxOutputTokens: 1000,
            },
        });

        const result = await chat.sendMessage(message);
        const response = await result.response;
        const text = response.text();

        res.json({ reply: text });

    } catch (err) {
        console.error("[Chat] Error:", err);
        res.status(500).json({ error: "Failed to process chat message: " + err.message });
    }
});

module.exports = router;
