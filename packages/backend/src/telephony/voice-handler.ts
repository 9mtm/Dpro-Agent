import { safeConsole } from '../services/safe-error-log.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { one, run, sql } from '../repositories/sql-steps.js';
import { nowText, secondsSinceText } from '../db/pg/dialect.js';
import { randomBytes } from 'crypto';
import { beginChannelTurn, CHANNEL_TURN_HEADER } from '../tools/channel-policy.js';

/**
 * Voice Webhook Handler
 * Handles Twilio/Google Voice webhooks for inbound/outbound calls
 * Generates TwiML responses and manages AI conversation flow
 *
 * B2.2c: queries run on the process driver (sql-steps); the call timestamps
 * are TEXT on both drivers (nowText). Status changes are single statements.
 */

/**
 * Handle incoming call (Twilio voice webhook)
 */
export async function handleIncomingCall(request: FastifyRequest, reply: FastifyReply) {
  const { From, To, CallSid } = request.body as any;

  try {
    const db = sql();

    // 1. Find call point by phone number
    const callPoint = await db.read(one<any>(`
      SELECT cp.*, pn.phone_number, pn.provider
      FROM call_points cp
      JOIN phone_numbers pn ON pn.id = cp.phone_number_id
      WHERE pn.phone_number = ? AND cp.enabled = 1
    `, To));

    if (!callPoint) {
      // No call point configured - return error TwiML
      return reply.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="Polly.Joanna">This number is not configured. Goodbye.</Say>
          <Hangup/>
        </Response>
      `);
    }

    // 2. Check business hours
    if (callPoint.business_hours && !isWithinBusinessHours(callPoint.business_hours)) {
      const afterHoursMsg = callPoint.after_hours_message || 'We are currently closed. Please call back during business hours.';
      return reply.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="${getTwilioVoice(callPoint.voice_id)}">${escapeXml(afterHoursMsg)}</Say>
          <Hangup/>
        </Response>
      `);
    }

    // 3. Create call session
    const sessionId = randomBytes(16).toString('hex');
    await db.read(run(`
      INSERT INTO call_sessions (
        id, call_point_id, direction, from_number, to_number,
        call_sid, provider, status, started_at, agent_id
      ) VALUES (?, ?, 'inbound', ?, ?, ?, ?, 'in-progress', ${nowText(db.dialect)}, ?)
    `, sessionId, callPoint.id, From, To, CallSid, callPoint.provider, callPoint.agent_id));

    // 4. Check if IVR menu is configured
    if (callPoint.ivr_menu) {
      const ivrMenu = JSON.parse(callPoint.ivr_menu);
      return handleIvrMenu(reply, sessionId, ivrMenu, callPoint);
    }

    // 5. Return TwiML with greeting + Gather for speech input
    const greeting = callPoint.greeting_message || 'Hello, how can I help you?';
    const lang = callPoint.language_preference === 'ar' ? 'ar-SA' : 'en-US';
    const voice = getTwilioVoice(callPoint.voice_id);

    const twiml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="${voice}">${escapeXml(greeting)}</Say>
        <Gather
          input="speech"
          action="/api/telephony/process-speech?sessionId=${sessionId}"
          method="POST"
          speechTimeout="auto"
          language="${lang}">
        </Gather>
        <Say voice="${voice}">I did not hear anything. Goodbye.</Say>
        <Hangup/>
      </Response>
    `;

    return reply.type('text/xml').send(twiml);
  } catch (error: any) {
    request.log.error('Incoming call error:', error);
    return reply.type('text/xml').send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="Polly.Joanna">An error occurred. Please try again later.</Say>
        <Hangup/>
      </Response>
    `);
  }
}

/**
 * Handle outbound call TwiML
 */
export async function handleOutboundTwiml(request: FastifyRequest, reply: FastifyReply) {
  const { callPointId } = request.query as any;

  try {
    const db = sql();

    const callPoint = await db.read(one<any>(`
      SELECT * FROM call_points WHERE id = ?
    `, callPointId));

    if (!callPoint) {
      return reply.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="Polly.Joanna">Configuration error.</Say>
          <Hangup/>
        </Response>
      `);
    }

    const greeting = callPoint.greeting_message || 'Hello, this is an automated call.';
    const lang = callPoint.language_preference === 'ar' ? 'ar-SA' : 'en-US';
    const voice = getTwilioVoice(callPoint.voice_id);

    // For outbound calls, we need to get the session ID from call_sid
    const { CallSid } = request.body as any;
    const session = await db.read(one<any>(`
      SELECT id FROM call_sessions WHERE call_sid = ?
    `, CallSid));

    if (!session) {
      return reply.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="${voice}">Session error.</Say>
          <Hangup/>
        </Response>
      `);
    }

    const twiml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="${voice}">${escapeXml(greeting)}</Say>
        <Gather
          input="speech"
          action="/api/telephony/process-speech?sessionId=${session.id}"
          method="POST"
          speechTimeout="auto"
          language="${lang}">
        </Gather>
        <Say voice="${voice}">Thank you. Goodbye.</Say>
        <Hangup/>
      </Response>
    `;

    return reply.type('text/xml').send(twiml);
  } catch (error: any) {
    request.log.error('Outbound TwiML error:', error);
    return reply.type('text/xml').send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="Polly.Joanna">An error occurred.</Say>
        <Hangup/>
      </Response>
    `);
  }
}

/**
 * Process speech input from caller and generate AI response
 */
export async function processSpeech(request: FastifyRequest, reply: FastifyReply) {
  const { SpeechResult, CallSid } = request.body as any;
  const { sessionId } = request.query as any;

  try {
    const db = sql();

    // Get session and call point details
    const session = await db.read(one<any>(`
      SELECT
        cs.*,
        cp.agent_id, cp.voice_id, cp.language_preference, cp.max_call_duration,
        cp.workflow_id
      FROM call_sessions cs
      JOIN call_points cp ON cp.id = cs.call_point_id
      WHERE cs.id = ?
    `, sessionId));

    if (!session) {
      return reply.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="Polly.Joanna">Session not found.</Say>
          <Hangup/>
        </Response>
      `);
    }

    // Store caller message
    const callerMsgId = randomBytes(16).toString('hex');
    await db.read(run(`
      INSERT INTO call_messages (id, call_session_id, role, content, timestamp)
      VALUES (?, ?, 'caller', ?, ${nowText(db.dialect)})
    `, callerMsgId, sessionId, SpeechResult || '[silence]'));

    // If no speech detected, end call
    if (!SpeechResult || SpeechResult.trim() === '') {
      return reply.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="${getTwilioVoice(session.voice_id)}">I did not hear anything. Goodbye.</Say>
          <Hangup/>
        </Response>
      `);
    }

    // Get AI response from agent
    const agentResponse = await getAgentResponse(
      session.agent_id,
      SpeechResult,
      sessionId,
      request.log
    );

    // Store agent message
    const agentMsgId = randomBytes(16).toString('hex');
    await db.read(run(`
      INSERT INTO call_messages (id, call_session_id, role, content, timestamp)
      VALUES (?, ?, 'agent', ?, ${nowText(db.dialect)})
    `, agentMsgId, sessionId, agentResponse));

    // Check max call duration
    const duration = await db.read(one<any>(`
      SELECT ${secondsSinceText(db.dialect, 'started_at')} as duration
      FROM call_sessions WHERE id = ?
    `, sessionId));

    if (duration && duration.duration > session.max_call_duration) {
      return reply.type('text/xml').send(`
        <?xml version="1.0" encoding="UTF-8"?>
        <Response>
          <Say voice="${getTwilioVoice(session.voice_id)}">Thank you for calling. Our time limit has been reached. Goodbye.</Say>
          <Hangup/>
        </Response>
      `);
    }

    // Return TwiML with AI response + continue gathering
    const voice = getTwilioVoice(session.voice_id);
    const lang = session.language_preference === 'ar' ? 'ar-SA' : 'en-US';

    const twiml = `
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="${voice}">${escapeXml(agentResponse)}</Say>
        <Gather
          input="speech"
          action="/api/telephony/process-speech?sessionId=${sessionId}"
          method="POST"
          speechTimeout="auto"
          language="${lang}">
        </Gather>
        <Say voice="${voice}">Thank you for calling. Goodbye.</Say>
        <Hangup/>
      </Response>
    `;

    return reply.type('text/xml').send(twiml);
  } catch (error: any) {
    request.log.error('Process speech error:', error);
    return reply.type('text/xml').send(`
      <?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Say voice="Polly.Joanna">An error occurred processing your request.</Say>
        <Hangup/>
      </Response>
    `);
  }
}

/**
 * Handle call status updates from Twilio
 */
export async function handleStatusWebhook(request: FastifyRequest, reply: FastifyReply) {
  const { CallSid, CallStatus, CallDuration } = request.body as any;

  try {
    const db = sql();

    // Update call session status
    if (CallStatus === 'completed' || CallStatus === 'failed' || CallStatus === 'busy' || CallStatus === 'no-answer') {
      await db.read(run(`
        UPDATE call_sessions
        SET status = ?,
            ended_at = ${nowText(db.dialect)},
            duration_seconds = ?
        WHERE call_sid = ?
      `, CallStatus, CallDuration || 0, CallSid));

      // If call completed, trigger post-call processing
      if (CallStatus === 'completed') {
        const session = await db.read(one<any>('SELECT * FROM call_sessions WHERE call_sid = ?', CallSid));
        if (session) {
          // Queue for transcription and AI summary (async)
          queuePostCallProcessing(session.id).catch(err => {
            request.log.error('Post-call processing error:', err);
          });
        }
      }
    } else {
      // Update status for in-progress states
      await db.read(run(`
        UPDATE call_sessions
        SET status = ?,
            answered_at = CASE WHEN ? = 'in-progress' AND answered_at IS NULL THEN ${nowText(db.dialect)} ELSE answered_at END
        WHERE call_sid = ?
      `, CallStatus, CallStatus, CallSid));
    }

    return reply.send({ success: true });
  } catch (error: any) {
    request.log.error('Status webhook error:', error);
    return reply.status(500).send({ error: error.message });
  }
}

/**
 * Handle recording ready webhook from Twilio
 */
export async function handleRecordingWebhook(request: FastifyRequest, reply: FastifyReply) {
  const { CallSid, RecordingUrl, RecordingSid, RecordingDuration } = request.body as any;

  try {
    const db = sql();

    // Update call session with recording URL
    await db.read(run(`
      UPDATE call_sessions
      SET recording_url = ?
      WHERE call_sid = ?
    `, RecordingUrl, CallSid));

    // Queue recording download to local storage (async)
    queueRecordingDownload(CallSid, RecordingUrl).catch(err => {
      request.log.error('Recording download error:', err);
    });

    return reply.send({ success: true });
  } catch (error: any) {
    request.log.error('Recording webhook error:', error);
    return reply.status(500).send({ error: error.message });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if current time is within business hours
 */
function isWithinBusinessHours(businessHoursJson: string): boolean {
  try {
    const hours = JSON.parse(businessHoursJson);
    const now = new Date();
    const dayOfWeek = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()];
    const dayHours = hours[dayOfWeek];

    if (!dayHours || !dayHours.start || !dayHours.end) {
      return true; // If not configured, always open
    }

    const currentTime = now.getHours() * 60 + now.getMinutes();
    const [startHour, startMin] = dayHours.start.split(':').map(Number);
    const [endHour, endMin] = dayHours.end.split(':').map(Number);
    const startTime = startHour * 60 + startMin;
    const endTime = endHour * 60 + endMin;

    return currentTime >= startTime && currentTime <= endTime;
  } catch {
    return true; // If parse error, assume open
  }
}

/**
 * Map OpenAI voice ID to Twilio Polly voice
 */
function getTwilioVoice(voiceId: string): string {
  const voiceMap: Record<string, string> = {
    alloy: 'Polly.Joanna',
    echo: 'Polly.Matthew',
    fable: 'Polly.Kimberly',
    onyx: 'Polly.Russell',
    nova: 'Polly.Salli',
    shimmer: 'Polly.Amy',
  };

  return voiceMap[voiceId] || 'Polly.Joanna';
}

/**
 * Escape XML special characters
 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Get AI agent response for user message
 */
/** Address for calls to this backend: loopback unless bound to one specific address. */
function selfHost(): string {
  const host = process.env.HOST || '127.0.0.1';
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') ? `[${host}]` : host;
}

async function getAgentResponse(
  agentId: string | null,
  userMessage: string,
  sessionId: string,
  logger: any
): Promise<string> {
  // SECURITY (S0-Q.9): /api/chat requires authentication. A phone caller is an
  // outside sender, so the turn runs as a server-created channel turn
  // ("telephony"): restricted tool set (opt-in via CHANNEL_AGENT_TOOLS_TELEPHONY),
  // bound to a random per-turn token that only this process knows.
  const turn = beginChannelTurn({ channel: 'telephony', conversationId: sessionId });
  try {
    // Call existing chat API with agent context
    const response = await fetch(`http://${selfHost()}:${process.env.PORT || '41522'}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CHANNEL_TURN_HEADER]: turn.token },
      body: JSON.stringify({
        agentId: agentId || undefined,
        messages: [{ role: 'user', content: userMessage }],
        sessionId, // Link to call session
        stream: false,
        systemPromptAppend: 'You are speaking to a caller over the phone. Keep responses brief, clear, and conversational. Avoid technical jargon.'
      }),
    });

    if (!response.ok) {
      throw new Error(`Chat API error: ${response.status}`);
    }

    const data = await response.json();
    return data.message?.content || 'I apologize, I could not process that. Can you please repeat?';
  } catch (error: any) {
    logger.error('Agent response error:', error);
    return 'I apologize, I am experiencing technical difficulties. Please try again later.';
  } finally {
    turn.end();
  }
}

/**
 * Handle IVR menu
 */
function handleIvrMenu(
  reply: FastifyReply,
  sessionId: string,
  ivrMenu: any,
  callPoint: any
): FastifyReply {
  const voice = getTwilioVoice(callPoint.voice_id);
  const lang = callPoint.language_preference === 'ar' ? 'ar-SA' : 'en-US';

  // Build Gather with digit input for IVR
  const menuMessage = ivrMenu.message || 'Please select an option.';
  const timeout = ivrMenu.timeout || 5;

  const twiml = `
    <?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Gather
        input="dtmf"
        action="/api/telephony/process-ivr?sessionId=${sessionId}"
        method="POST"
        timeout="${timeout}"
        numDigits="1">
        <Say voice="${voice}">${escapeXml(menuMessage)}</Say>
      </Gather>
      <Say voice="${voice}">I did not receive a selection. Goodbye.</Say>
      <Hangup/>
    </Response>
  `;

  return reply.type('text/xml').send(twiml);
}

/**
 * Queue post-call processing (transcription + AI summary)
 */
async function queuePostCallProcessing(sessionId: string): Promise<void> {
  // TODO: Implement async processing queue
  // This should:
  // 1. Get call_messages for session
  // 2. If transcription_provider = 'whisper' or 'both', transcribe recording with Whisper
  // 3. Generate AI summary using agent
  // 4. Store summary in call_sessions.conversation_summary
  console.log(`[Telephony] Queued post-call processing for session ${sessionId}`);
}

/**
 * Queue recording download to local storage
 */
async function queueRecordingDownload(callSid: string, recordingUrl: string): Promise<void> {
  // TODO: Implement recording download
  // This should:
  // 1. Download recording from Twilio URL
  // 2. Save to .data/storage/cdn/recordings/
  // 3. Create storage_files entry
  // 4. Update call_sessions.recording_file_id
  safeConsole.log(`[Telephony] Queued recording download for call ${callSid}: ${recordingUrl}`);
}
