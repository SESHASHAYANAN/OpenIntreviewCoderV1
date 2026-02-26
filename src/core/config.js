const path = require('path');
const os = require('os');

class ConfigManager {
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.appDataDir = path.join(os.homedir(), '.DeepVoice');
    this.loadConfiguration();
  }

  loadConfiguration() {
    this.config = {
      app: {
        name: 'DeepVoice',
        version: '2.0.0',
        processTitle: 'DeepVoice',
        dataDir: this.appDataDir,
        isDevelopment: this.env === 'development',
        isProduction: this.env === 'production'
      },

      window: {
        defaultWidth: 400,
        defaultHeight: 600,
        minWidth: 300,
        minHeight: 400,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          enableRemoteModule: false,
          preload: path.join(__dirname, '../../preload.js')
        }
      },

      ocr: {
        language: 'eng',
        tempDir: os.tmpdir(),
        cleanupDelay: 5000
      },

      llm: {
        groq: {
          model: 'llama-3.3-70b-versatile',
          whisperModel: 'whisper-large-v3',
          maxRetries: 3,
          timeout: 30000,
          fallbackEnabled: true,
          generation: {
            temperature: 0.7,
            topP: 0.9,
            maxTokens: 4096
          }
        }
      },

      speech: {
        whisper: {
          language: 'en',
          audioFormat: 'webm'
          // Recording is fully manual: no auto-stop, no silence detection,
          // no timeout. Recording continues until the user explicitly stops it.
        }
      },

      session: {
        maxMemorySize: 1000,
        compressionThreshold: 500,
        clearOnRestart: false,
        maxDurationMinutes: 240
      },

      interview: {
        triggerPhrase: 'deep help',
        defaultMode: 'system-design',
        availableModes: ['system-design', 'technical-screening', 'dsa'],
        whisperEnabled: true
      },

      stealth: {
        hideFromDock: true,
        noAttachConsole: true,
        disguiseProcess: true
      }
    };
  }

  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => obj[key] = obj[key] || {}, this.config);
    target[lastKey] = value;
  }

  getApiKey(service) {
    const envKey = `${service.toUpperCase()}_API_KEY`;
    return process.env[envKey];
  }

  isFeatureEnabled(feature) {
    return this.get(`features.${feature}`) !== false;
  }
}

module.exports = new ConfigManager();