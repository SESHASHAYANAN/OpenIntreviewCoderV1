const EventEmitter = require('events');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../core/logger').createServiceLogger('SPEECH');
const config = require('../core/config');

/**
 * WhisperSpeechService — Uses Groq's Whisper API for speech-to-text.
 * Audio is recorded in the renderer (Web Audio API) and sent as blobs via IPC.
 */
class WhisperSpeechService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.isRecordingState = false;
    this.initialized = false;
    this.whisperModel = config.get('llm.groq.whisperModel') || 'whisper-large-v3';
    this.language = config.get('speech.whisper.language') || 'en';
    this.tempDir = os.tmpdir();
    this.chunkCounter = 0;

    this.initialize();
  }

  initialize() {
    try {
      const apiKey = process.env.GROQ_API_KEY || config.getApiKey('groq');
      if (!apiKey) {
        logger.warn('Groq API key not found — Whisper STT unavailable. Please set GROQ_API_KEY in your .env file or settings.');
        this.emit('status', 'Whisper unavailable: No API key');
        return;
      }

      this.client = new Groq({ apiKey });
      this.initialized = true;
      logger.info('Whisper Speech Service initialized', { model: this.whisperModel });
      this.emit('status', 'Whisper ready');
    } catch (error) {
      logger.error('Failed to initialize Whisper service', { error: error.message });
      this.emit('status', `Whisper init failed: ${error.message}`);
    }
  }

  isAvailable() {
    return this.initialized && this.client !== null;
  }

  getStatus() {
    return {
      isInitialized: this.initialized,
      isRecording: this.isRecordingState,
      model: this.whisperModel,
      language: this.language,
      provider: 'groq-whisper'
    };
  }

  /**
   * Signal that recording has started (actual recording happens in renderer).
   * Recording is FULLY MANUAL — no auto-stop, no timeout, no silence detection.
   * Recording continues until the user explicitly stops it.
   */
  startRecording() {
    if (!this.isAvailable()) {
      logger.warn('Cannot start recording — Whisper not available');
      this.emit('error', 'Whisper service not available. Check your GROQ_API_KEY.');
      this.emit('permission-error', {
        type: 'service-unavailable',
        message: 'Whisper service not available. Check your GROQ_API_KEY.'
      });
      return false;
    }

    this.isRecordingState = true;
    this.emit('recording-started');
    logger.info('Recording started (audio capture in renderer)');
    return true;
  }

  /**
   * Signal that recording has stopped.
   */
  stopRecording() {
    this.isRecordingState = false;
    this.emit('recording-stopped');
    logger.info('Recording stopped');
  }

  /**
   * Handle microphone permission denied from renderer.
   */
  handleMicPermissionDenied(details = {}) {
    this.isRecordingState = false;
    logger.error('Microphone permission denied', details);
    this.emit('error', details.message || 'Microphone access denied');
    this.emit('permission-error', {
      type: 'mic-denied',
      message: details.message || 'Microphone access denied. Please allow microphone access in your system settings.',
      details
    });
  }

  /**
   * Process an audio blob received from the renderer process.
   * The blob is a Buffer containing WebM/WAV audio data.
   * 
   * @param {Buffer} audioBuffer - Raw audio data
   * @param {string} format - Audio format ('webm', 'wav', 'mp3')
   * @returns {Promise<string>} Transcribed text
   */
  async transcribeAudio(audioBuffer, format = 'webm') {
    if (!this.isAvailable()) {
      throw new Error('Whisper service not available');
    }

    // Validate audio buffer
    if (!audioBuffer || audioBuffer.length < 100) {
      throw new Error('Audio buffer is empty or too small');
    }

    // Validate it looks like a real audio file (check for webm/ogg magic bytes)
    const header = audioBuffer.slice(0, 4);
    const headerHex = header.toString('hex');
    logger.debug('Audio buffer header', { headerHex, size: audioBuffer.length, format });

    const startTime = Date.now();
    // Use correct extension — Groq Whisper infers codec from file extension
    const ext = ['webm', 'ogg', 'mp3', 'mp4', 'wav', 'flac', 'm4a'].includes(format) ? format : 'webm';
    const tempFileName = `deepvoice_audio_${Date.now()}_${this.chunkCounter++}.${ext}`;
    const tempFilePath = path.join(this.tempDir, tempFileName);

    try {
      // Write audio buffer to a temp file (Groq SDK expects file streams)
      fs.writeFileSync(tempFilePath, audioBuffer);

      // Verify file was written correctly
      const fileStats = fs.statSync(tempFilePath);
      logger.debug('Temp audio file written', { path: tempFilePath, size: fileStats.size });

      if (fileStats.size < 100) {
        throw new Error('Written audio file is too small — recording likely failed');
      }

      // Send to Groq Whisper API
      const transcription = await this.client.audio.transcriptions.create({
        file: fs.createReadStream(tempFilePath),
        model: this.whisperModel,
        language: this.language,
        response_format: 'text',
      });

      const text = typeof transcription === 'string' ? transcription.trim() : (transcription.text || '').trim();
      const processingTime = Date.now() - startTime;

      logger.info('Audio transcribed', {
        textLength: text.length,
        processingTime,
        format
      });

      if (text && text.length > 0) {
        this.emit('transcription', text);
      }

      return text;
    } catch (error) {
      logger.error('Whisper transcription failed', {
        error: error.message,
        status: error.status,
        format
      });
      this.emit('error', `Transcription failed: ${error.message}`);
      throw error;
    } finally {
      // Clean up temp file
      try {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
      } catch (cleanupError) {
        logger.warn('Failed to clean up temp audio file', { path: tempFilePath });
      }
    }
  }

  /**
   * Process an audio chunk during continuous recording.
   * Emits interim transcription events.
   */
  async processAudioChunk(audioBuffer, format = 'webm') {
    try {
      const text = await this.transcribeAudio(audioBuffer, format);
      if (text) {
        this.emit('interim-transcription', text);
      }
      return text;
    } catch (error) {
      logger.warn('Audio chunk processing failed', { error: error.message });
      return '';
    }
  }

  /**
   * Check if a transcription contains the trigger phrase.
   */
  containsTriggerPhrase(text) {
    const triggerPhrase = config.get('interview.triggerPhrase') || 'deep help';
    const normalized = text.toLowerCase().trim();
    return normalized.includes(triggerPhrase);
  }

  /**
   * Reinitialize with a new API key.
   */
  updateApiKey(newApiKey) {
    process.env.GROQ_API_KEY = newApiKey;
    this.initialize();
  }
}

module.exports = new WhisperSpeechService();