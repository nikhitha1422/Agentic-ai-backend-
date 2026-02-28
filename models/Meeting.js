const mongoose = require('mongoose');

const MeetingSchema = new mongoose.Schema({
    meetingId: {
        type: String,
        required: true,
        unique: true
    },
    id: {
        type: String,
        required: true,
        unique: true
    },
    title: {
        type: String,
        required: true
    },
    date: {
        type: Date,
        default: Date.now
    },
    status: {
        type: String,
        enum: ['scheduled', 'live', 'ended', 'failed', 'summarized', 'completed'],
        default: 'scheduled'
    },
    attachments: [{
        name: String,
        path: String,
        size: Number,
        type: String,
        uploadedAt: { type: Date, default: Date.now }
    }],
    allowAI: {
        type: Boolean,
        default: false
    },
    aiJoined: {
        type: Boolean,
        default: false
    },
    participants: [String],
    tasks: [{
        id: String,
        task: String,
        assignedTo: String,
        dueDate: String,
        status: {
            type: String,
            enum: ['pending', 'neutralizing', 'done', 'failed'],
            default: 'pending'
        },
        agentOutput: {
            type: String,
            default: ''
        },
        failureReason: {
            type: String,
            default: ''
        },
        confidenceScore: {
            type: Number,
            default: 0
        },
        nextSteps: [String]
    }],
    summary: {
        type: String,
        default: ''
    },
    description: {
        type: String,
        default: ''
    },
    audioPath: {
        type: String,
        default: ''
    }
}, { timestamps: true });

module.exports = mongoose.model('Meeting', MeetingSchema);
