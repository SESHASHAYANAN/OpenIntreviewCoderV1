const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods for the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Screenshot and OCR
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),

  // Speech recognition
  startSpeechRecognition: () => ipcRenderer.invoke('start-speech-recognition'),
  stopSpeechRecognition: () => ipcRenderer.invoke('stop-speech-recognition'),
  getSpeechAvailability: () => ipcRenderer.invoke('get-speech-availability'),
  getDesktopAudioSource: () => ipcRenderer.invoke('get-desktop-audio-source'),

  // Audio blob processing (Whisper STT)
  processAudioBlob: (audioData, format) => ipcRenderer.invoke('process-audio-blob', { audioData, format }),

  // Microphone permission
  checkMicPermission: () => ipcRenderer.invoke('check-mic-permission'),
  reportMicPermissionDenied: (data) => ipcRenderer.invoke('report-mic-permission-denied', data),

  // Interview session
  startInterviewSession: (mode) => ipcRenderer.invoke('start-interview-session', mode),
  endInterviewSession: () => ipcRenderer.invoke('end-interview-session'),
  getSessionTimer: () => ipcRenderer.invoke('get-session-timer'),
  setInterviewMode: (mode) => ipcRenderer.invoke('set-interview-mode', mode),
  getInterviewMode: () => ipcRenderer.invoke('get-interview-mode'),
  setResponseComplexity: (level) => ipcRenderer.invoke('set-response-complexity', level),

  // Window management
  showAllWindows: () => ipcRenderer.invoke('show-all-windows'),
  hideAllWindows: () => ipcRenderer.invoke('hide-all-windows'),
  enableWindowInteraction: () => ipcRenderer.invoke('enable-window-interaction'),
  disableWindowInteraction: () => ipcRenderer.invoke('disable-window-interaction'),
  switchToChat: () => ipcRenderer.invoke('switch-to-chat'),
  switchToSkills: () => ipcRenderer.invoke('switch-to-skills'),
  resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', { width, height }),
  moveWindow: (deltaX, deltaY) => ipcRenderer.invoke('move-window', { deltaX, deltaY }),
  getWindowStats: () => ipcRenderer.invoke('get-window-stats'),

  // Session memory
  getSessionHistory: () => ipcRenderer.invoke('get-session-history'),
  clearSessionMemory: () => ipcRenderer.invoke('clear-session-memory'),
  recallTopic: (query) => ipcRenderer.invoke('recall-topic', query),
  sendChatMessage: (text) => ipcRenderer.invoke('send-chat-message', text),
  getSkillPrompt: (skillName) => ipcRenderer.invoke('get-skill-prompt', skillName),

  // Groq LLM configuration
  setGroqApiKey: (apiKey) => ipcRenderer.invoke('set-groq-api-key', apiKey),
  getGroqStatus: () => ipcRenderer.invoke('get-groq-status'),
  testGroqConnection: () => ipcRenderer.invoke('test-groq-connection'),

  // Settings
  showSettings: () => ipcRenderer.invoke('show-settings'),
  hideSettings: () => ipcRenderer.invoke('hide-settings'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  updateAppIcon: (iconKey) => ipcRenderer.invoke('update-app-icon', iconKey),
  updateActiveSkill: (skill) => ipcRenderer.invoke('update-active-skill', skill),
  restartAppForStealth: () => ipcRenderer.invoke('restart-app-for-stealth'),

  // Follow-Up & Auto-Capture
  toggleFollowUp: () => ipcRenderer.invoke('toggle-follow-up'),
  getFollowUpState: () => ipcRenderer.invoke('get-follow-up-state'),
  toggleAutoCapture: () => ipcRenderer.invoke('toggle-auto-capture'),
  setAutoCaptureInterval: (ms) => ipcRenderer.invoke('set-auto-capture-interval', ms),
  getAutoCaptureState: () => ipcRenderer.invoke('get-auto-capture-state'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  quit: () => {
    try {
      ipcRenderer.send('quit-app');
    } catch (error) {
      console.error('Error in quit:', error);
    }
  },

  // LLM window specific methods
  expandLlmWindow: (contentMetrics) => ipcRenderer.invoke('expand-llm-window', contentMetrics),
  resizeLlmWindowForContent: (contentMetrics) => ipcRenderer.invoke('resize-llm-window-for-content', contentMetrics),

  // Clipboard helper
  copyToClipboard: (text) => {
    try {
      return ipcRenderer.invoke('copy-to-clipboard', String(text ?? ''));
    } catch (e) {
      console.error('copyToClipboard failed:', e);
      return false;
    }
  },

  // Display management
  listDisplays: () => ipcRenderer.invoke('list-displays'),
  captureArea: (options) => ipcRenderer.invoke('capture-area', options),

  // Event listeners — Voice & Transcription
  onTranscriptionReceived: (callback) => ipcRenderer.on('transcription-received', callback),
  onInterimTranscription: (callback) => ipcRenderer.on('interim-transcription', callback),
  onSpeechStatus: (callback) => ipcRenderer.on('speech-status', callback),
  onSpeechError: (callback) => ipcRenderer.on('speech-error', callback),
  onSpeechAvailability: (callback) => ipcRenderer.on('speech-availability', callback),
  onMicPermissionDenied: (callback) => ipcRenderer.on('mic-permission-denied', callback),

  // Event listeners — Session
  onSessionEvent: (callback) => ipcRenderer.on('session-event', callback),
  onSessionCleared: (callback) => ipcRenderer.on('session-cleared', callback),
  onSessionTimerUpdate: (callback) => ipcRenderer.on('session-timer-update', callback),
  onInterviewSessionStarted: (callback) => ipcRenderer.on('interview-session-started', callback),
  onInterviewSessionEnded: (callback) => ipcRenderer.on('interview-session-ended', callback),
  onInterviewModeChanged: (callback) => ipcRenderer.on('interview-mode-changed', callback),

  // Event listeners — AI Responses
  onOcrCompleted: (callback) => ipcRenderer.on('ocr-completed', callback),
  onOcrError: (callback) => ipcRenderer.on('ocr-error', callback),
  onLlmResponse: (callback) => ipcRenderer.on('llm-response', callback),
  onLlmError: (callback) => ipcRenderer.on('llm-error', callback),
  onTranscriptionLlmResponse: (callback) => ipcRenderer.on('transcription-llm-response', callback),
  onWhisperSuggestion: (callback) => ipcRenderer.on('whisper-suggestion', callback),
  onDisplayLlmResponse: (callback) => ipcRenderer.on('display-llm-response', callback),
  onShowLoading: (callback) => ipcRenderer.on('show-loading', callback),

  // Event listeners — UI State
  onSkillChanged: (callback) => ipcRenderer.on('skill-changed', callback),
  onComplexityChanged: (callback) => ipcRenderer.on('complexity-changed', callback),
  onInteractionModeChanged: (callback) => ipcRenderer.on('interaction-mode-changed', callback),
  onRecordingStarted: (callback) => ipcRenderer.on('recording-started', callback),
  onRecordingStopped: (callback) => ipcRenderer.on('recording-stopped', callback),
  onCodingLanguageChanged: (callback) => ipcRenderer.on('coding-language-changed', callback),

  // Event listeners — Follow-Up & Auto-Capture
  onFollowUpChanged: (callback) => ipcRenderer.on('follow-up-changed', callback),
  onAutoCaptureChanged: (callback) => ipcRenderer.on('auto-capture-changed', callback),

  // Generic receive method
  receive: (channel, callback) => ipcRenderer.on(channel, callback),
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
})

contextBridge.exposeInMainWorld('api', {
  send: (channel, data) => {
    let validChannels = [
      'close-settings',
      'quit-app',
      'save-settings',
      'toggle-recording',
      'toggle-interaction-mode',
      'update-skill',
      'window-loaded'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },
  receive: (channel, func) => {
    let validChannels = [
      'load-settings',
      'recording-state-changed',
      'interaction-mode-changed',
      'skill-changed',
      'update-skill',
      'recording-started',
      'recording-stopped'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => func(...args));
    }
  }
});