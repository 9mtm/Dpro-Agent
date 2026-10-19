import { safeConsole } from '../../../src/services/safe-error-log.js';
/**
 * Post-Call Processor
 * Handles post-call automation: recording download, transcription, analytics, workflow triggers
 */

import { getDatabase } from '../../../src/db/index.js';
import { analyzeSentiment } from './sentiment-analyzer.js';
import audioService from '../../../src/services/audio-service.js';
import storageAPI from '../../../src/services/storage-manager.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PostCallProcessor {
  constructor() {
    this.db = getDatabase();
  }

  /**
   * Process completed call (main entry point)
   * @param {string} callSessionId - Call session ID
   * @returns {Promise<Object>} Processing result
   */
  async processCompletedCall(callSessionId) {
    try {
      console.log(`[PostCallProcessor] Processing completed call: ${callSessionId}`);

      // Get call session
      const session = await this.db.get(
        `SELECT * FROM call_sessions WHERE id = ?`,
        [callSessionId]
      );

      if (!session) {
        throw new Error(`Call session not found: ${callSessionId}`);
      }

      const results = {
        sessionId: callSessionId,
        recordingDownloaded: false,
        transcribed: false,
        analyticsCreated: false,
        workflowsTriggered: [],
        errors: []
      };

      // Step 1: Download recording from Twilio (if URL exists)
      if (session.recording_url && !session.recording_file_id) {
        try {
          const recordingFile = await this.downloadRecording(session.recording_url, callSessionId);

          await this.db.run(
            `UPDATE call_sessions SET recording_file_id = ? WHERE id = ?`,
            [recordingFile.id, callSessionId]
          );

          session.recording_file_id = recordingFile.id;
          results.recordingDownloaded = true;
        } catch (error) {
          safeConsole.error('[PostCallProcessor] Error downloading recording:', error);
          results.errors.push({ step: 'download', error: error.message });
        }
      }

      // Step 2: Transcribe recording via Whisper
      if (session.recording_file_id && !session.transcript_file_id) {
        try {
          const transcriptFile = await this.transcribeRecording(session.recording_file_id, callSessionId);

          await this.db.run(
            `UPDATE call_sessions SET transcript_file_id = ? WHERE id = ?`,
            [transcriptFile.id, callSessionId]
          );

          session.transcript_file_id = transcriptFile.id;
          results.transcribed = true;
        } catch (error) {
          console.error('[PostCallProcessor] Error transcribing recording:', error);
          results.errors.push({ step: 'transcribe', error: error.message });
        }
      }

      // Step 3: Create analytics if not exists
      const existingAnalytics = await this.db.get(
        `SELECT * FROM call_analytics WHERE call_session_id = ?`,
        [callSessionId]
      );

      if (!existingAnalytics) {
        try {
          const analytics = await this.createCallAnalytics(session);
          results.analyticsCreated = true;
          results.analytics = analytics;
        } catch (error) {
          console.error('[PostCallProcessor] Error creating analytics:', error);
          results.errors.push({ step: 'analytics', error: error.message });
        }
      }

      // Step 4: Trigger workflows based on analytics
      const analytics = existingAnalytics || results.analytics;
      if (analytics) {
        try {
          const workflows = await this.triggerWorkflows(session, analytics);
          results.workflowsTriggered = workflows;
        } catch (error) {
          console.error('[PostCallProcessor] Error triggering workflows:', error);
          results.errors.push({ step: 'workflows', error: error.message });
        }
      }

      console.log(`[PostCallProcessor] Processing complete:`, results);
      return results;
    } catch (error) {
      console.error('[PostCallProcessor] Error processing call:', error);
      throw error;
    }
  }

  /**
   * Download recording from Twilio URL
   * @param {string} recordingUrl - Twilio recording URL
   * @param {string} callSessionId - Call session ID
   * @returns {Promise<Object>} Storage file object
   */
  async downloadRecording(recordingUrl, callSessionId) {
    try {
      console.log(`[PostCallProcessor] Downloading recording: ${recordingUrl}`);

      // Create temp file path
      const tempDir = path.join(process.cwd(), '.data', 'temp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const tempFilePath = path.join(tempDir, `recording_${callSessionId}_${Date.now()}.mp3`);

      // Download file
      await this.downloadFile(recordingUrl, tempFilePath);

      // Upload to storage
      const fileStats = fs.statSync(tempFilePath);
      const storageFile = await storageAPI.storeFile({
        filepath: tempFilePath,
        originalname: `call_recording_${callSessionId}.mp3`,
        mimetype: 'audio/mpeg',
        size: fileStats.size,
        zone: 'cache',
        category: 'audio',
        userId: 'system',
        metadata: {
          callSessionId,
          source: 'twilio'
        }
      });

      // Clean up temp file
      fs.unlinkSync(tempFilePath);

      console.log(`[PostCallProcessor] Recording downloaded and stored: ${storageFile.id}`);
      return storageFile;
    } catch (error) {
      safeConsole.error('[PostCallProcessor] Error downloading recording:', error);
      throw error;
    }
  }

  /**
   * Download file from URL
   * @param {string} url - File URL
   * @param {string} outputPath - Output file path
   * @returns {Promise<void>}
   */
  downloadFile(url, outputPath) {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(outputPath);

      https.get(url, (response) => {
        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      }).on('error', (error) => {
        fs.unlink(outputPath, () => {}); // Delete partial file
        reject(error);
      });
    });
  }

  /**
   * Transcribe recording via Whisper
   * @param {string} recordingFileId - Storage file ID
   * @param {string} callSessionId - Call session ID
   * @returns {Promise<Object>} Transcript storage file
   */
  async transcribeRecording(recordingFileId, callSessionId) {
    try {
      console.log(`[PostCallProcessor] Transcribing recording: ${recordingFileId}`);

      // Get recording file
      const recordingFile = await this.db.get(
        `SELECT * FROM storage_files WHERE id = ?`,
        [recordingFileId]
      );

      if (!recordingFile) {
        throw new Error(`Recording file not found: ${recordingFileId}`);
      }

      // Transcribe via Whisper
      const transcription = await audioService.transcribe({
        audioPath: recordingFile.filepath
      });

      if (!transcription || !transcription.text) {
        throw new Error('Transcription failed: no text returned');
      }

      // Save transcript as text file
      const transcriptText = this.formatTranscript(transcription);
      const tempDir = path.join(process.cwd(), '.data', 'temp');
      const tempFilePath = path.join(tempDir, `transcript_${callSessionId}_${Date.now()}.txt`);

      fs.writeFileSync(tempFilePath, transcriptText);

      // Upload to storage
      const fileStats = fs.statSync(tempFilePath);
      const transcriptFile = await storageAPI.storeFile({
        filepath: tempFilePath,
        originalname: `call_transcript_${callSessionId}.txt`,
        mimetype: 'text/plain',
        size: fileStats.size,
        zone: 'cache',
        category: 'audio',
        userId: 'system',
        metadata: {
          callSessionId,
          language: transcription.language || 'unknown',
          duration: transcription.duration || 0
        }
      });

      // Clean up temp file
      fs.unlinkSync(tempFilePath);

      console.log(`[PostCallProcessor] Transcription complete: ${transcriptFile.id}`);
      return transcriptFile;
    } catch (error) {
      console.error('[PostCallProcessor] Error transcribing recording:', error);
      throw error;
    }
  }

  /**
   * Format transcription result as readable text
   * @param {Object} transcription - Whisper transcription result
   * @returns {string} Formatted transcript
   */
  formatTranscript(transcription) {
    let text = `Call Transcription\n`;
    text += `Language: ${transcription.language || 'Unknown'}\n`;
    text += `Duration: ${transcription.duration || 'Unknown'}s\n`;
    text += `\n--- Transcript ---\n\n`;
    text += transcription.text;
    return text;
  }

  /**
   * Create call analytics from session
   * @param {Object} session - Call session object
   * @returns {Promise<Object>} Analytics object
   */
  async createCallAnalytics(session) {
    try {
      console.log(`[PostCallProcessor] Creating analytics for session: ${session.id}`);

      // Get call messages
      const messages = await this.db.all(
        `SELECT * FROM call_messages WHERE session_id = ? ORDER BY created_at ASC`,
        [session.id]
      );

      // Analyze sentiment
      const userMessages = messages
        .filter(msg => msg.role === 'user')
        .map(msg => msg.content);

      const sentiment = analyzeSentiment(userMessages);

      // Calculate metrics
      const totalMessages = messages.length;
      const userMessageCount = messages.filter(msg => msg.role === 'user').length;
      const assistantMessageCount = messages.filter(msg => msg.role === 'assistant').length;

      // Calculate average response time (ms between user message and next assistant message)
      const responseTimes = [];
      for (let i = 0; i < messages.length - 1; i++) {
        if (messages[i].role === 'user' && messages[i + 1].role === 'assistant') {
          const userTime = new Date(messages[i].created_at).getTime();
          const assistantTime = new Date(messages[i + 1].created_at).getTime();
          responseTimes.push(assistantTime - userTime);
        }
      }

      const avgResponseTime = responseTimes.length > 0
        ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length)
        : null;

      // Calculate total duration
      const startTime = new Date(session.started_at).getTime();
      const endTime = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
      const totalDuration = Math.round((endTime - startTime) / 1000); // seconds

      // Create analytics record
      const analyticsId = `analytics_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      await this.db.run(
        `INSERT INTO call_analytics (
          id, call_session_id, call_point_id, agent_id,
          total_messages, avg_response_time_ms, total_duration_seconds,
          sentiment_score, sentiment_label, detected_emotions,
          language_detected, model_used, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          analyticsId,
          session.id,
          session.call_point_id,
          session.agent_id || null,
          totalMessages,
          avgResponseTime,
          totalDuration,
          sentiment.score,
          sentiment.label,
          JSON.stringify(sentiment.detectedEmotions),
          'en', // TODO: detect from transcription
          session.model_used || 'unknown'
        ]
      );

      // Update session with analytics_id
      await this.db.run(
        `UPDATE call_sessions SET analytics_id = ? WHERE id = ?`,
        [analyticsId, session.id]
      );

      const analytics = {
        id: analyticsId,
        call_session_id: session.id,
        sentiment_score: sentiment.score,
        sentiment_label: sentiment.label,
        detected_emotions: sentiment.detectedEmotions,
        total_messages: totalMessages,
        avg_response_time_ms: avgResponseTime,
        total_duration_seconds: totalDuration
      };

      console.log(`[PostCallProcessor] Analytics created:`, analytics);
      return analytics;
    } catch (error) {
      console.error('[PostCallProcessor] Error creating analytics:', error);
      throw error;
    }
  }

  /**
   * Trigger workflows based on call analytics
   * @param {Object} session - Call session
   * @param {Object} analytics - Call analytics
   * @returns {Promise<Array>} Triggered workflows
   */
  async triggerWorkflows(session, analytics) {
    try {
      const workflows = [];

      // Workflow 1: Low CSAT → Notify supervisor
      if (analytics.csat_score && analytics.csat_score <= 2) {
        workflows.push({
          type: 'low_csat_alert',
          reason: `CSAT score ${analytics.csat_score}/5`,
          action: 'notify_supervisor',
          data: {
            callSessionId: session.id,
            csatScore: analytics.csat_score,
            sentiment: analytics.sentiment_label
          }
        });

        console.log(`[PostCallProcessor] Workflow: Low CSAT alert (${analytics.csat_score}/5)`);
      }

      // Workflow 2: Unresolved issue → Create follow-up task
      if (analytics.issue_resolved === false || analytics.issue_resolved === 0) {
        workflows.push({
          type: 'unresolved_issue',
          reason: 'Issue not resolved during call',
          action: 'create_followup_task',
          data: {
            callSessionId: session.id,
            fromNumber: session.from_number,
            sentiment: analytics.sentiment_label
          }
        });

        console.log(`[PostCallProcessor] Workflow: Create follow-up task (unresolved)`);
      }

      // Workflow 3: Negative sentiment → Flag for review
      if (analytics.sentiment_score < -0.5) {
        workflows.push({
          type: 'negative_sentiment',
          reason: `Sentiment score ${analytics.sentiment_score.toFixed(2)}`,
          action: 'flag_for_review',
          data: {
            callSessionId: session.id,
            sentimentScore: analytics.sentiment_score,
            detectedEmotions: analytics.detected_emotions
          }
        });

        console.log(`[PostCallProcessor] Workflow: Flag for review (negative sentiment)`);
      }

      // Workflow 4: High frustration → Escalate
      if (analytics.detected_emotions) {
        const emotions = typeof analytics.detected_emotions === 'string'
          ? JSON.parse(analytics.detected_emotions)
          : analytics.detected_emotions;

        if (emotions.includes('frustrated') || emotions.includes('angry')) {
          workflows.push({
            type: 'high_frustration',
            reason: 'Frustration detected in conversation',
            action: 'escalate_to_human',
            data: {
              callSessionId: session.id,
              emotions
            }
          });

          console.log(`[PostCallProcessor] Workflow: Escalation recommended (frustration)`);
        }
      }

      return workflows;
    } catch (error) {
      console.error('[PostCallProcessor] Error triggering workflows:', error);
      return [];
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get PostCallProcessor instance
 * @returns {PostCallProcessor}
 */
export function getPostCallProcessor() {
  if (!instance) {
    instance = new PostCallProcessor();
  }
  return instance;
}

export default PostCallProcessor;
