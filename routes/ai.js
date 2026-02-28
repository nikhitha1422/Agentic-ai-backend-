const express = require('express');
const router = express.Router();
const Meeting = require('../models/Meeting');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { v4: uuidv4 } = require('uuid');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

router.post('/process-email', async (req, res) => {
    try {
        const { emailContent } = req.body;

        if (!process.env.GEMINI_API_KEY) {
            console.error("[AI Assistant] GEMINI_API_KEY is missing from environment variables.");
            return res.status(500).json({ error: "AI service configuration missing (API Key)." });
        }

        const prompt = `
You are an AI assistant for a meeting scheduling application.

Carefully analyze the email below.

Current Time: ${new Date().toISOString()}

Your task is to detect if a meeting schedule is discussed and extract the details.
A meeting IS REQUIRED if the email includes:
- phrases like “let’s meet”, “schedule a meeting”, “schedule a call”, "talk about", "sync up"
- discussion requests with a suggestion of time or date
- suggested date, time, or participants

If a meeting is required, respond ONLY in valid JSON:
{
  "meetingRequired": true,
  "title": "A concise and professional meeting title",
  "description": "A brief summary of the meeting agenda based on the email",
  "recommendedDateTime": "ISO 8601 format (e.g. 2025-02-15T10:00:00Z). If no year is mentioned, assume 2025.",
  "participants": ["List of emails or names mentioned"]
}

If no specific date/time is mentioned but a meeting is requested, use tomorrow at 10 AM.

If a meeting is NOT required (no request to meet or discuss), respond ONLY in valid JSON:
{
  "meetingRequired": false,
  "reason": "Explain briefly why no meeting was detected"
}

Rules:
- NO markdown, NO code blocks, NO extra text.
- ONLY return the raw JSON object.

Email Content:
"""${emailContent}"""
        `;

        console.log("[AI Assistant] Processing email content...");

        // Use gemini-flash-latest as gemini-1.5-flash returns 404 in this environment
        const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text().replace(/```json\n?|\n?```/g, '').trim();

        let aiResponse;
        try {
            aiResponse = JSON.parse(text);
        } catch (parseErr) {
            console.error("[AI Assistant] Failed to parse AI response:", text);
            return res.status(500).json({ error: "Failed to parse AI response from Intelligence service." });
        }

        console.log("AI RAW RESPONSE:", aiResponse);

        const meetingRequired =
            aiResponse.meetingRequired === true ||
            aiResponse.meetingRequired === "true";

        if (meetingRequired) {
            const { title, description, recommendedDateTime, participants } = aiResponse;
            const meetingId = uuidv4();

            // Use existing meeting creation logic structure
            const newMeeting = new Meeting({
                meetingId: meetingId,
                id: meetingId, // Keep for compatibility
                title: title || 'Email Generated Meeting',
                description: description || '',
                status: 'scheduled',
                date: new Date(recommendedDateTime) || new Date(),
                allowAI: true, // Default to true for AI-generated meetings
                aiJoined: false,
                participants: participants || [],
                tasks: [],
                summary: '',
            });

            console.log('[AI Assistant] Saving meeting:', meetingId);
            const savedMeeting = await newMeeting.save();

            return res.json({
                success: true,
                message: "Meeting generated successfully",
                meetingId: savedMeeting.meetingId,
                details: {
                    title,
                    description,
                    date: recommendedDateTime,
                    participants
                }
            });
        } else {
            console.log('[AI Assistant] No meeting required:', aiResponse.reason);
            return res.json({
                success: false,
                meetingCreated: false,
                message: aiResponse.reason || "No meeting detected in this email."
            });
        }

    } catch (err) {
        console.error("[AI Assistant] CRITICAL Error processing email:", err);
        // Ensure a valid JSON response is returned even on terminal failure
        return res.status(500).json({
            success: false,
            error: "Failed to process email: " + err.message
        });
    }
});

module.exports = router;
