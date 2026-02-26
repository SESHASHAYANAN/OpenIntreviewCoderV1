// CRITICAL: Ensure electron.exe runs as Electron, not as plain Node.js
// The ELECTRON_RUN_AS_NODE env var can be inherited from the parent process
// and causes require('electron') to return the npm package path instead of the built-in module
require("dotenv").config();

const { app, BrowserWindow, globalShortcut, session, ipcMain } = require("electron");
const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");

// Services
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.activeSkill = config.get('interview.defaultMode') || "system-design";
    this.codingLanguage = "cpp";
    this.speechAvailable = false;
    this.interviewMode = config.get('interview.defaultMode') || "system-design";
    this.sessionActive = false;
    this.responseComplexity = "medium"; // 'short' | 'medium' | 'long'

    // Screen capture & follow-up state
    this.followUpMode = false;
    this.autoCaptureEnabled = false;
    this.autoCaptureInterval = null;
    this.autoCaptureIntervalMs = 30000; // 30 seconds default

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "DeepVoice" },
      chat: { title: "Transcript" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    console.log("[DEBUG] Constructor: before setupStealth");
    this.setupStealth();
    console.log("[DEBUG] Constructor: done");
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // app.setName() may fail if called before app is ready on some platforms
    try {
      app.setName("Terminal");
    } catch (e) {
      // Will be set again in onAppReady
    }
    process.title = "Terminal";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  // Permissions and Network config are defined below

  /**
   * Initialize IPC handlers and service event handlers.
   * Called after app.whenReady() resolves, NOT in the constructor.
   */
  setupEventHandlers() {
    try {
      console.log("[DEBUG] setupEventHandlers: setupIPCHandlers");
      this.setupIPCHandlers();
      console.log("[DEBUG] setupEventHandlers: setupServiceEventHandlers");
      this.setupServiceEventHandlers();
      console.log("[DEBUG] setupEventHandlers: done");
    } catch (e) {
      console.error("[DEBUG] setupEventHandlers CRASHED:", e.message, e.stack);
    }
  }

  async onAppReady() {
    app.setName("Terminal");
    process.title = "Terminal";

    logger.info("DeepVoice starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment") ? "development" : "production",
      platform: process.platform,
    });

    try {
      console.log("[DEBUG] Step 1: setupPermissions");
      this.setupPermissions();
      console.log("[DEBUG] Step 2: setupNetworkConfiguration");
      this.setupNetworkConfiguration();

      await new Promise((resolve) => setTimeout(resolve, 200));

      console.log("[DEBUG] Step 3: initializeWindows");
      await windowManager.initializeWindows();
      console.log("[DEBUG] Step 4: setupGlobalShortcuts");
      this.setupGlobalShortcuts();

      console.log("[DEBUG] Step 5: updateAppIcon");
      this.updateAppIcon("terminal");

      this.isReady = true;

      logger.info("DeepVoice initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        interviewMode: this.interviewMode,
      });

      sessionManager.addEvent("Application started");
      console.log("[DEBUG] Initialization complete");
    } catch (error) {
      console.error("DeepVoice initialization CRASHED:", error.message, error.stack);
      logger.error("DeepVoice initialization failed", { error: error.message });
      app.quit();
    }
  }

  setupNetworkConfiguration() {
    const ses = session.defaultSession;

    // Allow HTTPS requests to Groq API
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.includes('api.groq.com')) {
        details.requestHeaders['User-Agent'] = 'DeepVoice/2.0';
      }
      callback({ requestHeaders: details.requestHeaders });
    });

    logger.debug('Network configuration applied for Groq API');
  }

  setupPermissions() {
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const allowedPermissions = ["microphone", "camera", "display-capture", "media"];
        const granted = allowedPermissions.includes(permission);
        logger.debug("Permission request", { permission, granted });

        if (!granted) {
          logger.warn("Permission denied by handler", { permission });
          // Notify all renderer windows about the denial
          BrowserWindow.getAllWindows().forEach((window) => {
            window.webContents.send("mic-permission-denied", {
              permission,
              reason: "not-allowed",
              message: `Permission '${permission}' was denied. Please allow access in your system settings.`
            });
          });
        }

        callback(granted);
      }
    );

    // Also handle permission check (synchronous check from Chromium)
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, requestingOrigin) => {
        const allowedPermissions = ["microphone", "camera", "display-capture", "media"];
        return allowedPermissions.includes(permission);
      }
    );
  }

  setupGlobalShortcuts() {
    const shortcuts = {
      "CommandOrControl+Shift+S": () => this.triggerScreenshotOCR(),
      "CommandOrControl+Shift+V": () => windowManager.toggleVisibility(),
      "CommandOrControl+Shift+I": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+C": () => windowManager.switchToWindow("chat"),
      "CommandOrControl+Shift+\\": () => this.clearSessionMemory(),
      "CommandOrControl+,": () => windowManager.showSettings(),
      "Alt+A": () => windowManager.toggleInteraction(),
      "Alt+R": () => this.toggleSpeechRecognition(),
      "CommandOrControl+Shift+T": () => windowManager.forceAlwaysOnTopForAllWindows(),
      "CommandOrControl+Up": () => this.handleUpArrow(),
      "CommandOrControl+Down": () => this.handleDownArrow(),
      "CommandOrControl+Left": () => this.handleLeftArrow(),
      "CommandOrControl+Right": () => this.handleRightArrow(),
    };

    Object.entries(shortcuts).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      logger.debug("Global shortcut registered", { accelerator, success });
    });
  }

  // ──────────────────────────────────────────────────
  // Speech & Audio Event Handlers
  // ──────────────────────────────────────────────────

  setupServiceEventHandlers() {
    speechService.on("recording-started", () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-started");
      });
    });

    speechService.on("recording-stopped", () => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("recording-stopped");
      });
    });

    speechService.on("transcription", (text) => {
      // Add transcription to session memory
      sessionManager.addUserInput(text, 'speech');

      // Check for trigger phrase
      if (speechService.containsTriggerPhrase(text)) {
        logger.info('Trigger phrase detected: "Deep, help"');
        this.handleTriggerPhrase(text);
        return;
      }

      // Broadcast transcription to all windows
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("transcription-received", { text });
      });

      // Process with LLM for co-pilot response
      setTimeout(async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processTranscriptionWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process transcription with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      }, 300);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable();
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
    });

    speechService.on("error", (error) => {
      this.speechAvailable = speechService.isAvailable();
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error, available: this.speechAvailable });
      });
    });
  }

  // ──────────────────────────────────────────────────
  // IPC Handlers
  // ──────────────────────────────────────────────────

  setupIPCHandlers() {
    // Screenshot & Capture
    ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());
    ipcMain.handle("list-displays", () => captureService.listDisplays());
    ipcMain.handle("capture-area", (event, options) => captureService.captureAndProcess(options));

    // Clipboard
    ipcMain.handle("copy-to-clipboard", (event, text) => {
      try {
        const { clipboard } = require("electron");
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (e) {
        logger.error("Failed to write to clipboard", { error: e.message });
        return false;
      }
    });

    // Desktop Audio Source for remote participant voice
    ipcMain.handle("get-desktop-audio-source", async () => {
      try {
        const { desktopCapturer } = require("electron");
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        // Return the first screen source (usually Entire Screen) which provides system audio loopback
        const screenSource = sources.find(s => s.id.startsWith('screen'));
        return { success: true, sourceId: screenSource ? screenSource.id : sources[0]?.id };
      } catch (error) {
        logger.error("Failed to get desktop audio source", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Speech Recognition
    ipcMain.handle("get-speech-availability", () => speechService.isAvailable());
    ipcMain.handle("start-speech-recognition", () => {
      speechService.startRecording();
      return speechService.getStatus();
    });
    ipcMain.handle("stop-speech-recognition", () => {
      speechService.stopRecording();
      return speechService.getStatus();
    });
    ipcMain.on("start-speech-recognition", () => speechService.startRecording());
    ipcMain.on("stop-speech-recognition", () => speechService.stopRecording());

    // Microphone permission check
    ipcMain.handle("check-mic-permission", async () => {
      try {
        // Correctly check microphone permission using app.getMediaAccessStatus or similar
        // For cross-platform support, we use app.getMediaAccessStatus on macOS/Windows
        let status = "unknown";
        if (process.platform === "darwin" || process.platform === "win32") {
          status = app.getMediaAccessStatus("microphone");
        }
        return { available: true, permission: status };
      } catch (error) {
        return { available: false, permission: "denied", error: error.message };
      }
    });

    // Handle mic permission error from renderer
    ipcMain.handle("report-mic-permission-denied", (event, data) => {
      logger.warn("Microphone access denied in renderer", data);
      speechService.stopRecording();

      const errorMessage = data.message || "Microphone access denied. Please allow microphone access in your system settings.";

      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", {
          error: errorMessage,
          errorType: "permission-denied",
          available: false
        });
        // Also send specific mic-permission-denied event
        window.webContents.send("mic-permission-denied", {
          message: errorMessage
        });
      });
      return { success: true };
    });

    // Audio blob processing (Whisper STT)
    ipcMain.handle("process-audio-blob", async (event, { audioData, format }) => {
      try {
        // audioData is base64-encoded from the renderer
        const audioBuffer = Buffer.from(audioData, 'base64');
        if (audioBuffer.length < 100) {
          return { success: false, error: 'Audio data too small — recording may have failed' };
        }
        logger.debug('Received audio blob for transcription', { bufferSize: audioBuffer.length, format });
        const text = await speechService.transcribeAudio(audioBuffer, format || 'webm');
        return { success: true, text };
      } catch (error) {
        logger.error("Audio blob processing failed", { error: error.message });
        return { success: false, error: error.message };
      }
    });

    // Interview Session
    ipcMain.handle("start-interview-session", (event, mode) => {
      try {
        return this.startInterviewSession(mode);
      } catch (err) {
        logger.error("Failed to start session:", err);
        return { success: false, error: err.message };
      }
    });
    ipcMain.handle("end-interview-session", () => {
      try {
        return this.endInterviewSession();
      } catch (err) {
        logger.error("Failed to end session:", err);
        return { success: false, error: err.message };
      }
    });
    ipcMain.handle("get-session-timer", () => {
      return sessionManager.getSessionTimer();
    });
    ipcMain.handle("set-interview-mode", (event, mode) => {
      this.interviewMode = mode;
      this.activeSkill = mode;
      sessionManager.setActiveSkill(mode);
      windowManager.broadcastToAllWindows("interview-mode-changed", { mode });
      return { success: true, mode };
    });
    ipcMain.handle("get-interview-mode", () => {
      return { mode: this.interviewMode, skill: this.activeSkill };
    });
    ipcMain.handle("set-response-complexity", (event, level) => {
      this.responseComplexity = level;
      windowManager.broadcastToAllWindows("complexity-changed", { level });
      return { success: true, level };
    });

    // Session Memory
    ipcMain.handle("get-session-history", () => sessionManager.getOptimizedHistory());
    ipcMain.handle("clear-session-memory", () => {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      return { success: true };
    });
    ipcMain.handle("recall-topic", (event, query) => {
      return sessionManager.recallTopic(query);
    });

    // Chat
    ipcMain.on("chat-window-ready", () => {
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "DeepVoice ready. Say 'Deep, help' anytime for assistance.",
        });
      }, 1000);
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      sessionManager.addUserInput(text, 'chat');

      setTimeout(async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processTranscriptionWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      }, 300);

      return { success: true };
    });

    // Window Management
    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });
    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });
    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });
    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });
    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });
    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });
    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        try {
          mainWindow.setContentSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        } catch (e) {
          mainWindow.setSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        }
      }
      return { success: true };
    });
    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        mainWindow.setPosition(currentX + deltaX, currentY + deltaY);
      }
      return { success: true };
    });

    // Always on top
    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    // Groq LLM
    ipcMain.handle("set-groq-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      speechService.updateApiKey(apiKey);
      return llmService.getStats();
    });
    ipcMain.handle("get-groq-status", () => llmService.getStats());
    ipcMain.handle("test-groq-connection", async () => llmService.testConnection());

    // Skill Prompt
    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        return promptLoader.getSkillPrompt(skillName);
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    // Settings
    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", this.getSettings());
        }, 100);
      }
      return { success: true };
    });
    ipcMain.handle("hide-settings", () => {
      windowManager.hideSettings();
      return { success: true };
    });
    ipcMain.handle("get-settings", () => this.getSettings());
    ipcMain.handle("save-settings", (event, settings) => this.saveSettings(settings));
    ipcMain.handle("update-app-icon", (event, iconKey) => this.updateAppIcon(iconKey));
    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      this.interviewMode = skill;
      sessionManager.setActiveSkill(skill);
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      return { success: true };
    });

    // Follow-Up Mode
    ipcMain.handle("toggle-follow-up", () => {
      this.followUpMode = !this.followUpMode;
      if (!this.followUpMode) {
        sessionManager.clear();
        logger.info('Follow-up mode OFF — session memory cleared');
      } else {
        logger.info('Follow-up mode ON — retaining context');
      }
      windowManager.broadcastToAllWindows("follow-up-changed", { followUpMode: this.followUpMode });
      return { success: true, followUpMode: this.followUpMode };
    });
    ipcMain.handle("get-follow-up-state", () => {
      return { followUpMode: this.followUpMode };
    });

    // Auto-Capture
    ipcMain.handle("toggle-auto-capture", () => {
      if (this.autoCaptureEnabled) {
        this.stopAutoCapture();
      } else {
        this.startAutoCapture();
      }
      return { success: true, enabled: this.autoCaptureEnabled, intervalMs: this.autoCaptureIntervalMs };
    });
    ipcMain.handle("set-auto-capture-interval", (event, ms) => {
      this.autoCaptureIntervalMs = Math.max(5000, Math.min(120000, ms)); // 5s-120s
      if (this.autoCaptureEnabled) {
        this.stopAutoCapture();
        this.startAutoCapture();
      }
      return { success: true, intervalMs: this.autoCaptureIntervalMs };
    });
    ipcMain.handle("get-auto-capture-state", () => {
      return { enabled: this.autoCaptureEnabled, intervalMs: this.autoCaptureIntervalMs };
    });

    // Window binding
    ipcMain.handle("set-window-binding", (event, enabled) => windowManager.setWindowBinding(enabled));
    ipcMain.handle("toggle-window-binding", () => windowManager.toggleWindowBinding());
    ipcMain.handle("get-window-binding-status", () => windowManager.getWindowBindingStatus());
    ipcMain.handle("get-window-stats", () => windowManager.getWindowStats());
    ipcMain.handle("set-window-gap", (event, gap) => windowManager.setWindowGap(gap));
    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    // App lifecycle
    ipcMain.handle("restart-app-for-stealth", () => {
      app.relaunch();
      app.exit();
    });
    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      windowManager.windows.forEach((win) => {
        if (win.webContents === webContents) {
          win.hide();
        }
      });
      return { success: true };
    });

    // LLM window
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });
    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Disabled — windows are fixed size now
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested");
      try {
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) settingsWindow.hide();
    });
    ipcMain.on("save-settings", (event, settings) => this.saveSettings(settings));
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = skill;
      this.interviewMode = skill;
      windowManager.broadcastToAllWindows("skill-changed", { skill });
    });
    ipcMain.on("quit-app", () => {
      try {
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        process.exit(1);
      }
    });
  }

  // ──────────────────────────────────────────────────
  // Interview Session Lifecycle
  // ──────────────────────────────────────────────────

  startInterviewSession(mode = null) {
    const sessionMode = mode || this.interviewMode;
    this.interviewMode = sessionMode;
    this.activeSkill = sessionMode;
    this.sessionActive = true;

    const timer = sessionManager.startSession(sessionMode);

    windowManager.broadcastToAllWindows("interview-session-started", {
      mode: sessionMode,
      timer
    });

    // Start session timer broadcasts (every second)
    this.timerInterval = setInterval(() => {
      const currentTimer = sessionManager.getSessionTimer();
      windowManager.broadcastToAllWindows("session-timer-update", currentTimer);

      if (currentTimer.remaining <= 0) {
        this.endInterviewSession();
      }
    }, 1000);

    logger.info('Interview session started', { mode: sessionMode, timer });
    return { success: true, mode: sessionMode, timer };
  }

  endInterviewSession() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }

    this.sessionActive = false;
    const summary = sessionManager.endSession();

    windowManager.broadcastToAllWindows("interview-session-ended", { summary });

    logger.info('Interview session ended', {
      duration: summary.durationMinutes,
      topicCount: summary.topicCount
    });

    return { success: true, summary };
  }

  // ──────────────────────────────────────────────────
  // Trigger Phrase Handler
  // ──────────────────────────────────────────────────

  async handleTriggerPhrase(text) {
    try {
      // Remove the trigger phrase from the text
      const triggerPhrase = config.get('interview.triggerPhrase') || 'deep help';
      const cleanText = text.toLowerCase().replace(triggerPhrase, '').trim();

      const sessionHistory = sessionManager.getOptimizedHistory();

      // Generate an immediate co-pilot response
      const llmResult = await llmService.processTranscriptionWithIntelligentResponse(
        cleanText || 'The candidate needs help with the current topic being discussed.',
        this.activeSkill,
        sessionHistory.recent,
        this.codingLanguage
      );

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        isTriggerResponse: true
      });

      // Broadcast as whisper suggestion
      windowManager.broadcastToAllWindows("whisper-suggestion", {
        response: llmResult.response,
        metadata: llmResult.metadata,
        skill: this.activeSkill,
        trigger: 'phrase'
      });

      // Also show in LLM response window
      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        isTriggerResponse: true
      });

      logger.info('Trigger phrase response generated', {
        responseLength: llmResult.response.length,
        processingTime: llmResult.metadata.processingTime
      });
    } catch (error) {
      logger.error('Trigger phrase handling failed', { error: error.message });
    }
  }

  // ──────────────────────────────────────────────────
  // Speech & Audio
  // ──────────────────────────────────────────────────

  toggleSpeechRecognition() {
    if (!speechService.isAvailable()) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-status", { status: 'Whisper unavailable', available: false });
      } catch (e) { }
      return;
    }

    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      speechService.stopRecording();
      windowManager.hideChatWindow();
      logger.info("Speech recognition stopped via global shortcut");
    } else {
      speechService.startRecording();
      windowManager.showChatWindow();
      logger.info("Speech recognition started via global shortcut");
    }
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  // ──────────────────────────────────────────────────
  // Auto-Capture
  // ──────────────────────────────────────────────────

  startAutoCapture() {
    if (this.autoCaptureInterval) {
      clearInterval(this.autoCaptureInterval);
    }
    this.autoCaptureEnabled = true;
    this.autoCaptureInterval = setInterval(() => {
      if (this.isReady) {
        logger.info('Auto-capture triggered');
        this.triggerScreenshotOCR();
      }
    }, this.autoCaptureIntervalMs);
    logger.info('Auto-capture started', { intervalMs: this.autoCaptureIntervalMs });
    windowManager.broadcastToAllWindows("auto-capture-changed", { enabled: true, intervalMs: this.autoCaptureIntervalMs });
  }

  stopAutoCapture() {
    if (this.autoCaptureInterval) {
      clearInterval(this.autoCaptureInterval);
      this.autoCaptureInterval = null;
    }
    this.autoCaptureEnabled = false;
    logger.info('Auto-capture stopped');
    windowManager.broadcastToAllWindows("auto-capture-changed", { enabled: false, intervalMs: this.autoCaptureIntervalMs });
  }

  // ──────────────────────────────────────────────────
  // Arrow Key Navigation
  // ──────────────────────────────────────────────────

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;
    if (isInteractive) {
      this.navigateSkill(-1);
    } else {
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;
    if (isInteractive) {
      this.navigateSkill(1);
    } else {
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    if (!windowManager.getWindowStats().isInteractive) {
      windowManager.moveBoundWindows(-20, 0);
    }
  }

  handleRightArrow() {
    if (!windowManager.getWindowStats().isInteractive) {
      windowManager.moveBoundWindows(20, 0);
    }
  }

  navigateSkill(direction) {
    const availableModes = config.get('interview.availableModes') || ["system-design", "technical-screening", "dsa"];
    const currentIndex = availableModes.indexOf(this.activeSkill);
    if (currentIndex === -1) return;

    let newIndex = currentIndex + direction;
    if (newIndex >= availableModes.length) newIndex = 0;
    else if (newIndex < 0) newIndex = availableModes.length - 1;

    const newSkill = availableModes[newIndex];
    this.activeSkill = newSkill;
    this.interviewMode = newSkill;
    sessionManager.setActiveSkill(newSkill);

    logger.info("Mode navigated", { from: availableModes[currentIndex], to: newSkill });
    windowManager.broadcastToAllWindows("skill-changed", { skill: newSkill });
  }

  // ──────────────────────────────────────────────────
  // Screenshot & OCR
  // ──────────────────────────────────────────────────

  async triggerScreenshotOCR() {
    if (!this.isReady) return;

    try {
      windowManager.showLLMLoading();

      const capture = await captureService.captureAndProcess();

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        windowManager.hideLLMResponse();
        windowManager.broadcastToAllWindows("ocr-error", { error: "Failed to capture screenshot" });
        return;
      }

      // If follow-up is OFF, clear conversation memory (but keep session alive)
      if (!this.followUpMode) {
        sessionManager.sessionMemory = [];
      }

      const sessionHistory = sessionManager.getOptimizedHistory();
      const needsProgrammingLanguage = ['dsa', 'technical-screening'].includes(this.activeSkill);

      logger.info('[Follow-up context debug]', {
        followUpMode: this.followUpMode,
        sessionMemoryCount: sessionManager.sessionMemory.length,
        recentHistoryCount: sessionHistory.recent?.length || 0,
        importantHistoryCount: sessionHistory.important?.length || 0,
        topics: sessionHistory.topics
      });

      // Use the new structured two-part response method
      const llmResult = await llmService.processScreenCaptureWithStructuredResponse(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        this.followUpMode
      );

      const resultResponse = llmResult.response || '';
      const resultMetadata = llmResult.metadata || {};
      const resultPartA = llmResult.partA || '';
      const resultPartB = llmResult.partB || '';
      const resultDetectedType = llmResult.detectedType || 'coding';
      const isStructured = resultMetadata.isStructuredResponse || false;
      const extractedText = llmResult.extractedText || '';

      // Save the OCR event (user context) FIRST
      if (extractedText) {
        sessionManager.addOCREvent(extractedText, {
          skill: this.activeSkill,
          detectedType: resultDetectedType
        });
      }

      // Save the model response
      sessionManager.addModelResponse(resultResponse, {
        skill: this.activeSkill,
        processingTime: resultMetadata.processingTime,
        usedFallback: resultMetadata.usedFallback,
        isImageAnalysis: true,
        detectedType: resultDetectedType,
        isStructuredResponse: isStructured
      });

      windowManager.showLLMResponse(resultResponse, {
        skill: this.activeSkill,
        processingTime: resultMetadata.processingTime,
        usedFallback: resultMetadata.usedFallback,
        isImageAnalysis: true,
        detectedType: resultDetectedType,
        partA: resultPartA,
        partB: resultPartB,
        isStructuredResponse: isStructured,
        isFollowUp: this.followUpMode,
        extractedText: extractedText
      });

      windowManager.broadcastToAllWindows("llm-response", {
        content: resultResponse,
        skill: this.activeSkill,
        metadata: resultMetadata,
        partA: resultPartA,
        partB: resultPartB,
        detectedType: resultDetectedType,
        isStructuredResponse: isStructured,
        isFollowUp: this.followUpMode
      });
    } catch (error) {
      logger.error("Screenshot OCR process failed", { error: error.message });
      windowManager.hideLLMResponse();
      windowManager.broadcastToAllWindows("ocr-error", { error: error.message });
    }
  }

  // ──────────────────────────────────────────────────
  // LLM Processing
  // ──────────────────────────────────────────────────

  async processWithLLM(text, sessionHistory) {
    try {
      sessionManager.addUserInput(text, 'llm_input');

      const needsProgrammingLanguage = ['dsa', 'technical-screening'].includes(this.activeSkill);

      const llmResult = await llmService.processTextWithSkill(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        this.responseComplexity,
        this.followUpMode
      );

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastLLMSuccess(llmResult);
    } catch (error) {
      logger.error("LLM processing failed", { error: error.message });
      windowManager.hideLLMResponse();
      this.broadcastLLMError(error.message);
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    try {
      if (!text || typeof text !== 'string' || text.trim().length < 2) return;
      const cleanText = text.trim();

      logger.info("Processing transcription with co-pilot", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        followUpMode: this.followUpMode,
        sessionMemoryCount: sessionManager.sessionMemory.length,
        recentHistoryCount: sessionHistory.recent?.length || 0
      });

      const needsProgrammingLanguage = ['dsa', 'technical-screening'].includes(this.activeSkill);

      const llmResult = await llmService.processTranscriptionWithIntelligentResponse(
        cleanText,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        this.followUpMode
      );

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      // Show in LLM response window (the "window box")
      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        isTranscriptionResponse: true,
        trigger: 'transcription'
      });

      // Also broadcast as whisper suggestion for those who listen for it (e.g., index.html)
      windowManager.broadcastToAllWindows("whisper-suggestion", {
        response: llmResult.response,
        metadata: llmResult.metadata,
        skill: this.activeSkill,
        trigger: 'transcription'
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

    } catch (error) {
      logger.error("Transcription LLM processing failed", { error: error.message });

      try {
        const fallbackResult = llmService.generateFallbackResponse(text, this.activeSkill);
        sessionManager.addModelResponse(fallbackResult.response, {
          usedFallback: true,
          isTranscriptionResponse: true
        });
        this.broadcastTranscriptionLLMResponse(fallbackResult);
      } catch (fallbackError) {
        logger.error("Fallback response also failed", { fallbackError: fallbackError.message });
      }
    }
  }

  // ──────────────────────────────────────────────────
  // Broadcast Helpers
  // ──────────────────────────────────────────────────

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    windowManager.broadcastToAllWindows("llm-response", {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill,
    });
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    windowManager.broadcastToAllWindows("transcription-llm-response", {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    });
  }

  // ──────────────────────────────────────────────────
  // App Lifecycle
  // ──────────────────────────────────────────────────

  onWindowAllClosed() {
    if (process.platform !== "darwin" && this.isReady) {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady) {
      this.onAppReady();
    } else {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }
      windowManager.windows.forEach((window) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();

    if (this.timerInterval) {
      clearInterval(this.timerInterval);
    }

    if (this.sessionActive) {
      this.endInterviewSession();
    }

    windowManager.destroyAllWindows();
    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("DeepVoice shutting down", { sessionEvents: sessionStats.eventCount });
  }

  // ──────────────────────────────────────────────────
  // Settings
  // ──────────────────────────────────────────────────

  getSettings() {
    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || "system-design",
      interviewMode: this.interviewMode || "system-design",
      responseComplexity: this.responseComplexity || "medium",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      groqConfigured: !!process.env.GROQ_API_KEY,
      speechAvailable: this.speechAvailable,
      sessionDuration: config.get('session.maxDurationMinutes') || 240,
      sessionActive: this.sessionActive,
      timer: sessionManager.getSessionTimer()
    };
  }

  saveSettings(settings) {
    try {
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        this.interviewMode = settings.activeSkill;
        sessionManager.setActiveSkill(settings.activeSkill);
        windowManager.broadcastToAllWindows("skill-changed", {
          skill: settings.activeSkill,
        });
      }
      if (settings.responseComplexity) {
        this.responseComplexity = settings.responseComplexity;
      }
      if (settings.sessionDuration) {
        config.set('session.maxDurationMinutes', settings.sessionDuration);
      }
      if (settings.appIcon || settings.selectedIcon) {
        this.appIcon = settings.selectedIcon || settings.appIcon;
        this.updateAppIcon(this.appIcon);
      }

      logger.info("Settings saved", settings);
      return { success: true };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  updateAppIcon(iconKey) {
    try {
      const path = require("path");
      const fs = require("fs");

      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];
      if (!iconPath) return { success: false, error: "Invalid icon key" };

      const fullIconPath = path.resolve(iconPath);
      if (!fs.existsSync(fullIconPath)) return { success: false, error: "Icon file not found" };

      if (process.platform === "darwin") {
        app.dock.setIcon(fullIconPath);
      } else {
        windowManager.windows.forEach((window) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      this.updateAppName(appName, iconKey);
      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      process.title = appName;
      if (process.platform === "darwin") {
        app.setName(appName);
      }
      app.setAppUserModelId(`${appName.trim()}-${iconKey}`);

      windowManager.windows.forEach((window) => {
        if (window && !window.isDestroyed()) {
          window.setTitle(appName.trim());
        }
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

// Create the controller instance (constructor no longer calls app.whenReady)
const controller = new ApplicationController();

// Register app lifecycle events at module scope where `app` is guaranteed available
app.whenReady()
  .then(async () => {
    console.log("[DEBUG] app.whenReady resolved — initializing");
    controller.setupEventHandlers();
    await controller.onAppReady();
  })
  .catch((e) => {
    console.error("[DEBUG] app.whenReady FATAL error:", e.message, e.stack);
    process.exit(1);
  });

app.on("window-all-closed", () => controller.onWindowAllClosed());
app.on("activate", () => controller.onActivate());
app.on("will-quit", () => controller.onWillQuit());

