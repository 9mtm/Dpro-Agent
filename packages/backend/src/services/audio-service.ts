import { dataPath } from '../config/data-root.js';
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { q } from '../repositories/sql-steps.js';
import { spawnPython, getPythonPath, PYTHON_SCRIPTS_DIR } from './python-env.js';
import { getEnvProviderApiKey } from '../credentials/authority.js';

type AudioProvider = 'openai' | 'local' | 'qwen';

/**
 * Audio Service
 * Supports both OpenAI API and Local models (Whisper + Coqui TTS)
 */
export class AudioService {
  private openai: OpenAI | null = null;
  private audioDir: string;
  private provider: AudioProvider;

  constructor() {
    // Check which provider to use
    const apiKey = getEnvProviderApiKey('openai') || undefined; // S1.1: via the credential authority
    this.provider = apiKey ? 'openai' : 'local';

    if (this.provider === 'openai') {
      this.openai = new OpenAI({ apiKey });
      console.log('[Audio] Using OpenAI API (Whisper + TTS)');
    } else {
      console.log('[Audio] Using Local Models (faster-whisper + Coqui TTS)');
      console.log('[Audio] ⚠️  Make sure Python dependencies are installed:');
      console.log('[Audio]    pip install faster-whisper TTS');
    }

    // Create audio storage directory
    this.audioDir = dataPath('audio');
    if (!fs.existsSync(this.audioDir)) {
      fs.mkdirSync(this.audioDir, { recursive: true });
    }
  }

  /**
   * Transcribe audio using Whisper (OpenAI API or Local)
   */
  async transcribe(
    audioBuffer: Buffer,
    filename: string
  ): Promise<{
    text: string;
    language?: string;
    duration?: number;
  }> {
    // Save buffer to temp file
    const tempPath = path.join(this.audioDir, `temp-${Date.now()}-${filename}`);
    fs.writeFileSync(tempPath, audioBuffer);

    try {
      if (this.provider === 'openai') {
        return await this.transcribeWithOpenAI(tempPath);
      } else {
        return await this.transcribeWithLocal(tempPath);
      }
    } finally {
      // Clean up temp file
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }

  /**
   * Transcribe using OpenAI API
   */
  private async transcribeWithOpenAI(audioPath: string): Promise<{
    text: string;
    language?: string;
    duration?: number;
  }> {
    try {
      const transcription = await this.openai!.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: 'whisper-1',
        response_format: 'verbose_json',
        language: undefined // Auto-detect language
      });

      return {
        text: transcription.text,
        language: transcription.language,
        duration: transcription.duration
      };
    } catch (error: any) {
      console.error('OpenAI Whisper error:', error);
      throw new Error(`Transcription failed: ${error.message}`);
    }
  }

  /**
   * Transcribe using Local Whisper (faster-whisper)
   */
  private async transcribeWithLocal(audioPath: string): Promise<{
    text: string;
    language?: string;
    duration?: number;
  }> {
    return new Promise((resolve, reject) => {
      // Call Python script
      const python = spawnPython(
        path.join(PYTHON_SCRIPTS_DIR, 'tools', 'stt', 'stt.py'),
        [audioPath]
      );

      let output = '';
      let errorOutput = '';

      python.stdout!.on('data', (data) => {
        output += data.toString();
      });

      python.stderr!.on('data', (data) => {
        errorOutput += data.toString();
      });

      python.on('error', (err: any) => {
        if (err.code === 'ENOENT') {
          reject(new Error(`Python not found. Run: npm run setup:python`));
        } else {
          reject(err);
        }
      });

      python.on('close', (code) => {
        if (code !== 0) {
          console.error('[Local Whisper] Error:', errorOutput);
          reject(new Error(`Local Whisper failed: ${errorOutput}`));
          return;
        }

        try {
          const result = JSON.parse(output);
          resolve({
            text: result.text,
            language: result.language,
            duration: result.duration
          });
        } catch (err) {
          reject(new Error(`Failed to parse Whisper output: ${output}`));
        }
      });
    });
  }

  /**
   * Generate speech from text (OpenAI TTS or Local Coqui or Qwen3-TTS)
   */
  async textToSpeech(options: {
    text: string;
    voice?: string;
    language?: string;
    sessionId?: string;
    messageId?: string;
    provider?: AudioProvider;
    emotion?: string;
    referenceAudio?: string;
  }): Promise<{
    audioId: string;
    duration?: number;
  }> {
    const { text, voice = 'alloy', sessionId, messageId, provider, emotion, referenceAudio } = options;

    // Use specified provider or fallback to instance provider
    const activeProvider = provider || this.provider;

    // Generate unique audio ID
    const audioId = randomUUID();
    const audioPath = path.join(this.audioDir, `${audioId}.mp3`);

    if (activeProvider === 'openai') {
      await this.ttsWithOpenAI(text, voice, audioPath);
    } else if (activeProvider === 'qwen') {
      await this.ttsWithQwen(text, voice, options.language || 'auto', audioPath, emotion, referenceAudio);
    } else {
      await this.ttsWithLocal(text, voice, options.language || 'auto', audioPath);
    }

    // Index in storage manifest (best-effort, never blocks)
    void import('./storage-manager.js').then(({ getStorageManager }) => {
      void getStorageManager().indexExistingFile({
        zone: 'cache',
        category: 'audio',
        filepath: audioPath,
        filename: `${audioId}.mp3`,
        mimeType: 'audio/mpeg',
        description: `TTS: "${text.slice(0, 80)}${text.length > 80 ? '...' : ''}"`,
        tags: ['tts', 'audio', voice],
        ttl: '7d',
        createdBy: 'system',
      });
    }).catch(() => { /* storage index is optional */ });

    // Store in database if session/message IDs provided
    if (sessionId && messageId) {
      await recordVoiceMessage({
        sessionId,
        messageId,
        audioUrl: `/api/audio/download/${audioId}`,
        language: options.language || 'auto',
        transcript: text,
      });
    }

    return { audioId };
  }

  /**
   * TTS using OpenAI API
   */
  private async ttsWithOpenAI(text: string, voice: string, outputPath: string): Promise<void> {
    try {
      // Validate voice
      const validVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'];
      const selectedVoice = validVoices.includes(voice) ? voice : 'alloy';

      // Call OpenAI TTS API
      const mp3 = await this.openai!.audio.speech.create({
        model: 'tts-1',
        voice: selectedVoice as any,
        input: text,
        response_format: 'mp3',
        speed: 1.0
      });

      // Save audio file
      const buffer = Buffer.from(await mp3.arrayBuffer());
      fs.writeFileSync(outputPath, buffer);
    } catch (error: any) {
      console.error('OpenAI TTS error:', error);
      throw new Error(`TTS failed: ${error.message}`);
    }
  }

  /**
   * TTS using Local Coqui TTS
   */
  private async ttsWithLocal(text: string, voice: string, language: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // Write args to a temp JSON file to avoid Windows encoding issues with Unicode CLI args
      const argsFile = outputPath + '.args.json';
      fs.writeFileSync(argsFile, JSON.stringify({ text, voice, outputPath, language }), 'utf8');

      const ttsScriptPath = path.join(PYTHON_SCRIPTS_DIR, 'tools', 'tts', 'tts.py');
      console.log('[TTS] Using Python:', getPythonPath());
      console.log('[TTS] Script path:', ttsScriptPath);
      console.log('[TTS] Args file:', argsFile);

      const python = spawnPython(ttsScriptPath, ['--args-file', argsFile]);

      let errorOutput = '';
      let stdOutput = '';

      python.stdout!.on('data', (data) => {
        stdOutput += data.toString();
      });

      python.stderr!.on('data', (data) => {
        errorOutput += data.toString();
      });

      python.on('error', (err: any) => {
        try { fs.unlinkSync(argsFile); } catch {}
        if (err.code === 'ENOENT') {
          reject(new Error('Python not found. Run: npm run setup:python'));
        } else {
          reject(err);
        }
      });

      python.on('close', (code) => {
        console.log('[TTS] Python stdout:', stdOutput);
        console.log('[TTS] Python stderr:', errorOutput);
        console.log('[TTS] Exit code:', code);
        try { fs.unlinkSync(argsFile); } catch {}
        if (code !== 0) {
          console.error('[Local TTS] Error:', errorOutput);
          reject(new Error(`Local TTS failed (code ${code}): ${errorOutput || stdOutput}`));
          return;
        }
        if (!fs.existsSync(outputPath)) {
          reject(new Error('TTS output file not created'));
          return;
        }
        console.log('[TTS] Success! Output file created:', outputPath);
        resolve();
      });
    });
  }

  /**
   * TTS using Qwen3-TTS (Free, Open-Source, Voice Cloning)
   */
  private async ttsWithQwen(
    text: string,
    voice: string,
    language: string,
    outputPath: string,
    emotion?: string,
    referenceAudio?: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // Write args to JSON file to avoid encoding issues
      const argsFile = outputPath + '.args.json';
      fs.writeFileSync(argsFile, JSON.stringify({
        text,
        voice,
        outputPath,
        language,
        emotion,
        referenceAudio
      }), 'utf8');

      const qwenScriptPath = path.join(PYTHON_SCRIPTS_DIR, 'tools', 'tts', 'qwen-tts.py');
      console.log('[Qwen3-TTS] Using Python:', getPythonPath());
      console.log('[Qwen3-TTS] Script path:', qwenScriptPath);
      console.log('[Qwen3-TTS] Args:', { voice, language, emotion: emotion || 'none', hasReference: !!referenceAudio });

      const python = spawnPython(qwenScriptPath, ['--args-file', argsFile]);

      let errorOutput = '';
      let stdOutput = '';

      python.stdout!.on('data', (data) => {
        stdOutput += data.toString();
      });

      python.stderr!.on('data', (data) => {
        errorOutput += data.toString();
      });

      python.on('error', (err: any) => {
        try { fs.unlinkSync(argsFile); } catch {}
        if (err.code === 'ENOENT') {
          reject(new Error('Python not found. Run: npm run setup:python'));
        } else {
          reject(err);
        }
      });

      python.on('close', (code) => {
        console.log('[Qwen3-TTS] Python stdout:', stdOutput);
        console.log('[Qwen3-TTS] Python stderr:', errorOutput);
        console.log('[Qwen3-TTS] Exit code:', code);
        try { fs.unlinkSync(argsFile); } catch {}

        if (code !== 0) {
          console.error('[Qwen3-TTS] Error:', errorOutput);
          reject(new Error(`Qwen3-TTS failed (code ${code}): ${errorOutput || stdOutput}`));
          return;
        }

        if (!fs.existsSync(outputPath)) {
          reject(new Error('Qwen3-TTS output file not created'));
          return;
        }

        console.log('[Qwen3-TTS] Success! Output file created:', outputPath);
        resolve();
      });
    });
  }

  /**
   * Clean up old audio files (run periodically)
   */
  async cleanupOldFiles(maxAgeHours: number = 24): Promise<number> {
    try {
      const now = Date.now();
      const maxAge = maxAgeHours * 60 * 60 * 1000;
      let deletedCount = 0;

      const files = fs.readdirSync(this.audioDir);

      for (const file of files) {
        const filePath = path.join(this.audioDir, file);
        const stats = fs.statSync(filePath);
        const age = now - stats.mtimeMs;

        if (age > maxAge) {
          fs.unlinkSync(filePath);
          deletedCount++;
        }
      }

      console.log(`Cleaned up ${deletedCount} old audio files`);
      return deletedCount;
    } catch (error) {
      console.error('Audio cleanup error:', error);
      return 0;
    }
  }
}

// Singleton instance
let audioServiceInstance: AudioService | null = null;

/**
 * Record a generated voice message (B2.2d-14: on the process driver).
 * Best effort: a database error is logged and never fails the speech, whose
 * audio file is already saved.
 */
export async function recordVoiceMessage(m: {
  sessionId: string;
  messageId: string;
  audioUrl: string;
  language: string;
  transcript: string;
}): Promise<boolean> {
  try {
    await q.run(`
      INSERT INTO voice_messages (
        session_id,
        message_id,
        audio_url,
        language,
        transcript,
        duration_seconds
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      m.sessionId,
      m.messageId,
      m.audioUrl,
      m.language,
      m.transcript,
      null); // Duration calculated later if needed
    return true;
  } catch (dbError) {
    console.error('Failed to store voice message in DB:', dbError);
    // Continue anyway - audio file is still saved
    return false;
  }
}

export function getAudioService(): AudioService {
  if (!audioServiceInstance) {
    audioServiceInstance = new AudioService();
  }
  return audioServiceInstance;
}
