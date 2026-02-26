try {
    // Check if we're in Node.js context or browser context
    let logger;
    try {
        logger = require('../core/logger').createServiceLogger('CHAT-UI');
    } catch (error) {
        logger = {
            info: (...args) => console.log('[CHAT-UI INFO]', ...args),
            debug: (...args) => console.log('[CHAT-UI DEBUG]', ...args),
            error: (...args) => console.error('[CHAT-UI ERROR]', ...args),
            warn: (...args) => console.warn('[CHAT-UI WARN]', ...args)
        };
    }

    class ChatWindowUI {
        constructor() {
            this.isRecording = false;
            this.isInteractive = true; // Start in interactive mode
            this.elements = {};

            // Audio recording state
            this.mediaStream = null;
            this.mediaRecorder = null;
            this.audioChunks = [];
            this.micPermissionGranted = null; // null = unknown, true/false
            this.recordingInterval = null;
            this.CHUNK_INTERVAL_MS = 5000; // Send audio chunk every 5 seconds for interim results

            this.init();
        }

        init() {
            try {
                this.setupElements();
                this.setupEventListeners();
                this.addMessage('Chat window initialized. Click microphone or press ⌘+R to start recording.', 'system');

                logger.info('Chat window UI initialized successfully');
            } catch (error) {
                logger.error('Failed to initialize chat window UI', { error: error.message });
                console.error('Chat window initialization failed:', error);
            }
        }

        setupElements() {
            this.elements = {
                chatMessages: document.getElementById('chatMessages'),
                recordingIndicator: document.getElementById('recordingIndicator'),
                messageInput: document.getElementById('messageInput'),
                sendButton: document.getElementById('sendButton'),
                micButton: document.getElementById('micButton'),
                chatContainer: document.getElementById('chatContainer'),
                interactionIndicator: document.getElementById('interactionIndicator'),
                interactionText: document.getElementById('interactionText'),
                listeningContainer: document.getElementById('listeningContainer'),
                listeningDuration: document.getElementById('listeningDuration')
            };

            // Validate required elements
            const requiredElements = ['chatMessages', 'micButton', 'sendButton', 'messageInput'];
            for (const elementKey of requiredElements) {
                if (!this.elements[elementKey]) {
                    throw new Error(`Required element '${elementKey}' not found`);
                }
            }

            // Initialize listening timer
            this.listeningStartTime = null;
            this.listeningTimer = null;
        }

        setupEventListeners() {
            // Interaction state handlers
            if (window.electronAPI) {
                window.electronAPI.onInteractionModeChanged((event, interactive) => {
                    this.isInteractive = interactive;
                    if (interactive) {
                        this.handleInteractionEnabled();
                    } else {
                        this.handleInteractionDisabled();
                    }
                });

                // Speech recognition handlers
                window.electronAPI.onTranscriptionReceived((event, data) => {
                    if (data && data.text) {
                        this.handleTranscription(data.text);
                    } else {
                        console.warn('Transcription event received but no text data:', data);
                    }
                });

                // Listen for interim transcription (real-time)
                if (window.electronAPI.onInterimTranscription) {
                    window.electronAPI.onInterimTranscription((event, data) => {
                        if (data && data.text) {
                            this.showInterimText(data.text);
                        }
                    });
                }

                window.electronAPI.onSpeechStatus((event, data) => {
                    if (data && data.status) {
                        this.addMessage(data.status, 'system');

                        // Update recording state based on status
                        if (data.status.includes('started') || data.status.includes('Recording')) {
                            this.handleRecordingStarted();
                        } else if (data.status.includes('stopped') || data.status.includes('ended')) {
                            this.handleRecordingStopped();
                        }
                    }
                });

                window.electronAPI.onSpeechError((event, data) => {
                    if (data && data.error) {
                        const isPermDenied = data.errorType === 'permission-denied';
                        if (isPermDenied) {
                            this.showMicPermissionDenied(data.error);
                        } else {
                            this.addMessage(`Speech Error: ${data.error}`, 'error');
                        }
                        this.handleRecordingStopped(); // Stop recording on error
                    }
                });

                // Mic permission denied from main process
                if (window.electronAPI.onMicPermissionDenied) {
                    window.electronAPI.onMicPermissionDenied((event, data) => {
                        this.micPermissionGranted = false;
                        this.showMicPermissionDenied(data.message || 'Microphone access denied.');
                        this.handleRecordingStopped();
                    });
                }

                // Skill handlers
                window.electronAPI.onSkillChanged((event, data) => {
                    if (data && data.skill) {
                        this.handleSkillActivated(data.skill);
                    }
                });

                // Session handlers
                window.electronAPI.onSessionCleared(() => {
                    this.addMessage('Session memory has been cleared', 'system');
                });

                window.electronAPI.onOcrCompleted((event, data) => {
                    if (data.text && data.text.trim()) {
                        this.addMessage(`📷 OCR Result: ${data.text}`, 'transcription');
                    }
                });

                window.electronAPI.onOcrError((event, data) => {
                    this.addMessage(`OCR Error: ${data.error}`, 'error');
                });

                window.electronAPI.onLlmResponse((event, data) => {
                    // Store AI response (text + snippets) in chat history
                    if (data && data.response) {
                        this.hideThinkingIndicator?.();
                        this.renderAssistantResponse(data.response);
                    }
                });

                window.electronAPI.onLlmError((event, data) => {
                    this.addMessage(`LLM Error: ${data.error}`, 'error');
                });

                window.electronAPI.onTranscriptionLlmResponse((event, data) => {
                    if (data && data.response) {
                        // Hide thinking indicator
                        this.hideThinkingIndicator();
                        // Add assistant response (text + snippets)
                        this.renderAssistantResponse(data.response);
                    }
                });
            }

            // UI event handlers
            this.setupUIHandlers();

            logger.debug('Chat window event listeners set up');
        }

        setupUIHandlers() {
            // Microphone button
            this.elements.micButton.addEventListener('click', async () => {
                if (!this.isInteractive) {
                    this.addMessage('Window is in non-interactive mode. Press Alt+A to enable interaction.', 'error');
                    return;
                }

                try {
                    if (this.isRecording) {
                        await this.stopAudioRecording();
                    } else {
                        await this.startAudioRecording();
                    }
                } catch (error) {
                    this.handleMicError(error);
                }
            });

            // Send button
            this.elements.sendButton.addEventListener('click', () => {
                this.sendMessage();
            });

            // Message input
            this.elements.messageInput.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.sendMessage();
                }
            });

            // Global keyboard shortcuts
            document.addEventListener('keydown', (e) => {
                if (e.altKey && e.key === 'r') {
                    e.preventDefault();
                    this.elements.micButton.click();
                }
            });
        }

        handleInteractionEnabled() {
            this.isInteractive = true;
            this.elements.chatContainer.classList.remove('non-interactive');
            this.showInteractionIndicator('Interactive', true);
            logger.debug('Interaction mode enabled in chat');
        }

        handleInteractionDisabled() {
            this.isInteractive = false;
            this.elements.chatContainer.classList.add('non-interactive');
            this.showInteractionIndicator('Non-Interactive', false);
            logger.debug('Interaction mode disabled in chat');
        }

        handleRecordingStarted() {
            this.isRecording = true;
            if (this.elements.recordingIndicator) {
                this.elements.recordingIndicator.style.display = 'block';
            }
            if (this.elements.micButton) {
                this.elements.micButton.classList.add('recording');
            }

            // Show listening animation
            this.showListeningAnimation();

            logger.debug('Recording started in chat window');
        }

        handleRecordingStopped() {
            this.isRecording = false;
            if (this.elements.recordingIndicator) {
                this.elements.recordingIndicator.style.display = 'none';
            }
            if (this.elements.micButton) {
                this.elements.micButton.classList.remove('recording');
            }

            // Hide listening animation
            this.hideListeningAnimation();

            logger.debug('Recording stopped in chat window');
        }

        handleTranscription(text) {
            if (text && text.trim()) {
                // Hide listening animation first
                this.hideListeningAnimation();

                // Show transcribed text with a slight delay for smooth transition
                setTimeout(() => {
                    this.addMessage(text, 'transcription');

                    // Show thinking indicator after transcription
                    setTimeout(() => {
                        this.showThinkingIndicator();
                    }, 300);
                }, 200);

                logger.debug('Transcription received in chat', { textLength: text.length });
            } else {
                console.warn('❌ Transcription text is empty or invalid:', text);
            }
        }

        async handleSkillActivated(skillName) {
            try {
                // Request the actual skill prompt from the main process
                const skillPrompt = await window.electronAPI.getSkillPrompt(skillName);

                if (skillPrompt) {
                    // Extract the title/first line for display
                    const lines = skillPrompt.split('\n').filter(line => line.trim());
                    const title = lines.find(line => line.startsWith('#')) || `# ${skillName.toUpperCase()} Mode`;
                    const cleanTitle = title.replace(/^#+\s*/, '').trim();

                    // Show a brief activation message with the skill title
                    const icons = {
                        'dsa': '🧠',
                        'behavioral': '💼',
                        'sales': '💰',
                        'presentation': '🎤',
                        'data-science': '📊',
                        'programming': '💻',
                        'devops': '🚀',
                        'system-design': '🏗️',
                        'negotiation': '🤝'
                    };

                    const icon = icons[skillName] || '🎯';
                    this.addMessage(`${icon} ${cleanTitle} - Ready to help!`, 'system');
                } else {
                    // Fallback if prompt not found
                    this.addMessage(`🎯 ${skillName.toUpperCase()} Mode: Ready to help!`, 'system');
                }
            } catch (error) {
                logger.error('Failed to load skill prompt', { skill: skillName, error: error.message });
                // Fallback message
                this.addMessage(`🎯 ${skillName.toUpperCase()} Mode: Ready to help!`, 'system');
            }

            logger.info('Skill activated in chat', { skill: skillName });
        }

        async sendMessage() {
            const text = this.elements.messageInput.value.trim();
            if (text) {
                this.addMessage(text, 'user');
                this.elements.messageInput.value = '';

                // Send to main process for session memory storage
                try {
                    if (window.electronAPI && window.electronAPI.sendChatMessage) {
                        await window.electronAPI.sendChatMessage(text);
                    }
                } catch (error) {
                    logger.error('Failed to send chat message to main process', { error: error.message });
                }

                logger.debug('User message sent', { textLength: text.length });
            }
        }

        addMessage(text, type = 'user') {
            if (!this.elements.chatMessages) {
                console.error('❌ Chat messages element not found!');
                return;
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = `message ${type}`;

            const timeDiv = document.createElement('div');
            timeDiv.className = 'message-time';
            timeDiv.textContent = new Date().toLocaleTimeString();

            const textDiv = document.createElement('div');
            textDiv.className = 'message-text';

            // Format assistant messages as markdown
            if (type === 'assistant') {
                textDiv.innerHTML = this.formatMarkdown(text);
            } else {
                textDiv.textContent = text;
            }

            messageDiv.appendChild(timeDiv);
            messageDiv.appendChild(textDiv);

            this.elements.chatMessages.appendChild(messageDiv);

            // Auto-scroll to bottom
            this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
        }

        // Split AI response into plain text and code snippets and append to chat
        renderAssistantResponse(response) {
            if (!response || typeof response !== 'string') return;
            const blocks = this.extractCodeBlocks(response);
            const textOnly = this.stripCodeBlocks(response, blocks);
            if (textOnly && textOnly.trim().length) {
                this.addMessage(textOnly, 'assistant');
            }
            blocks.forEach(b => this.addCodeSnippet(b.language, b.code));
        }

        extractCodeBlocks(text) {
            const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
            const blocks = [];
            let match;
            while ((match = codeBlockRegex.exec(text)) !== null) {
                blocks.push({ language: match[1] || 'text', code: (match[2] || '').trim(), fullMatch: match[0] });
            }
            return blocks;
        }

        stripCodeBlocks(text, blocks) {
            let result = text || '';
            blocks.forEach(b => { result = result.replace(b.fullMatch, ''); });
            return result.replace(/\n\s*\n\s*\n/g, '\n\n').trim();
        }

        addCodeSnippet(language, code) {
            if (!this.elements.chatMessages) return;
            const messageDiv = document.createElement('div');
            messageDiv.className = 'message assistant';
            const timeDiv = document.createElement('div');
            timeDiv.className = 'message-time';
            timeDiv.textContent = new Date().toLocaleTimeString();
            const textDiv = document.createElement('div');
            textDiv.className = 'message-text';
            const escapedLang = (language || 'text').toUpperCase();
            const escapedCode = this.escapeHtmlForSnippet(code || '');
            textDiv.innerHTML = `
            <div style="font-size:12px;color:rgba(255,255,255,0.85);margin-bottom:6px;">Snippet: ${escapedLang}</div>
            <pre><code>${escapedCode}</code></pre>
        `;
            messageDiv.appendChild(timeDiv);
            messageDiv.appendChild(textDiv);
            this.elements.chatMessages.appendChild(messageDiv);
            this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
        }

        escapeHtmlForSnippet(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        formatMarkdown(text) {
            if (!text) return '';

            try {
                // Use the markdown.js library for proper markdown parsing
                // Try to access markdown library in different contexts
                let markdownLib;

                // First try global markdown object (from script tag)
                if (typeof markdown !== 'undefined' && markdown.toHTML) {
                    markdownLib = markdown;
                }
                // Then try require (Node.js context)
                else if (typeof require !== 'undefined') {
                    try {
                        markdownLib = require('markdown');
                    } catch (requireError) {
                        logger.debug('Could not require markdown library:', requireError.message);
                    }
                }
                // Finally try window.markdown (browser context)
                else if (typeof window !== 'undefined' && window.markdown) {
                    markdownLib = window.markdown;
                }

                if (markdownLib && markdownLib.toHTML) {
                    return markdownLib.toHTML(text);
                } else {
                    logger.warn('Markdown library not available, falling back to basic formatting');
                    // Fallback to basic formatting
                    return text
                        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                        .replace(/\*(.+?)\*/g, '<em>$1</em>')
                        .replace(/`(.+?)`/g, '<code>$1</code>')
                        .replace(/\n/g, '<br>');
                }
            } catch (error) {
                logger.warn('Failed to parse markdown, falling back to plain text', { error: error.message });
                // Fallback to basic formatting
                return text.replace(/\n/g, '<br>');
            }
        }

        showThinkingIndicator() {
            if (!this.elements.chatMessages) return;

            const thinkingDiv = document.createElement('div');
            thinkingDiv.className = 'message assistant thinking';
            thinkingDiv.id = 'thinking-indicator';

            const timeDiv = document.createElement('div');
            timeDiv.className = 'message-time';
            timeDiv.textContent = new Date().toLocaleTimeString();

            const textDiv = document.createElement('div');
            textDiv.className = 'message-text thinking-dots';
            textDiv.innerHTML = '<span class="dot">•</span><span class="dot">•</span><span class="dot">•</span>';

            thinkingDiv.appendChild(timeDiv);
            thinkingDiv.appendChild(textDiv);

            this.elements.chatMessages.appendChild(thinkingDiv);
            this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
        }

        hideThinkingIndicator() {
            const thinkingIndicator = document.getElementById('thinking-indicator');
            if (thinkingIndicator) {
                thinkingIndicator.remove();
            }
        }

        showInteractionIndicator(text, interactive) {
            if (!this.elements.interactionIndicator || !this.elements.interactionText) return;

            this.elements.interactionText.textContent = text;
            this.elements.interactionIndicator.className = `interaction-indicator show ${interactive ? 'interactive' : 'non-interactive'}`;

            setTimeout(() => {
                this.elements.interactionIndicator.classList.remove('show');
            }, 2000);
        }

        showListeningAnimation() {
            if (!this.elements.listeningContainer) {
                console.warn('❌ Listening container not found');
                return;
            }

            // Show the listening animation
            this.elements.listeningContainer.classList.add('active');

            // Start the duration timer
            this.listeningStartTime = Date.now();
            this.listeningTimer = setInterval(() => {
                this.updateListeningDuration();
            }, 100);

            // Auto-scroll to show the listening animation
            if (this.elements.chatMessages) {
                this.elements.chatMessages.scrollTop = 0;
            }
        }

        hideListeningAnimation() {
            if (this.elements.listeningContainer) {
                this.elements.listeningContainer.classList.remove('active');
            }

            // Clear interim text
            this.clearInterimText();

            // Clear the duration timer
            if (this.listeningTimer) {
                clearInterval(this.listeningTimer);
                this.listeningTimer = null;
            }

            this.listeningStartTime = null;
        }

        updateListeningDuration() {
            if (!this.listeningStartTime || !this.elements.listeningDuration) return;

            const elapsed = Date.now() - this.listeningStartTime;
            const seconds = Math.floor(elapsed / 1000);
            const milliseconds = Math.floor((elapsed % 1000) / 100);

            const formattedTime = `${seconds.toString().padStart(2, '0')}:${milliseconds}`;
            this.elements.listeningDuration.textContent = formattedTime;
        }

        showInterimText(text) {
            if (!this.elements.listeningContainer) return;

            // Find or create interim text element
            let interimElement = this.elements.listeningContainer.querySelector('.interim-text');
            if (!interimElement) {
                interimElement = document.createElement('div');
                interimElement.className = 'interim-text';
                interimElement.style.cssText = `
                color: rgba(255, 255, 255, 0.8);
                font-size: 12px;
                font-style: italic;
                margin-top: 10px;
                padding: 8px;
                background: rgba(76, 175, 80, 0.2);
                border-radius: 6px;
                min-height: 20px;
                border: 1px dashed rgba(76, 175, 80, 0.4);
            `;
                this.elements.listeningContainer.appendChild(interimElement);
            }

            interimElement.textContent = text || 'Waiting for speech...';
        }

        clearInterimText() {
            if (!this.elements.listeningContainer) return;

            const interimElement = this.elements.listeningContainer.querySelector('.interim-text');
            if (interimElement) {
                interimElement.remove();
            }
        }

        // ──────────────────────────────────────────────────
        // Audio Recording (getUserMedia + MediaRecorder)
        // ──────────────────────────────────────────────────

        /**
         * Request microphone access and start recording audio.
         * Sends audio blobs to main process for Whisper transcription.
         *
         * IMPORTANT: Recording is FULLY MANUAL.
         * - No automatic timeout or time limit.
         * - No silence detection or auto-stop.
         * - Recording continues indefinitely until the user explicitly
         *   presses the Stop button (which calls stopAudioRecording).
         * - Never auto-stop, never truncate, never cut off mid-question.
         */
        async startAudioRecording() {
            // First, signal main process that we're starting
            try {
                await window.electronAPI.startSpeechRecognition();
            } catch (err) {
                logger.warn('Failed to signal main process for recording start', { error: err.message });
            }

            // Request microphone access
            try {
                logger.info('Requesting microphone access via getUserMedia');
                this.mediaStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });
                this.micPermissionGranted = true;
                logger.info('Microphone access granted');
            } catch (error) {
                this.micPermissionGranted = false;
                this.handleMicError(error);
                return;
            }

            // Set up MediaRecorder
            try {
                const mimeType = this.getSupportedMimeType();
                this.audioChunks = [];
                this.mediaRecorder = new MediaRecorder(this.mediaStream, {
                    mimeType: mimeType,
                    audioBitsPerSecond: 128000
                });

                this.mediaRecorder.ondataavailable = (event) => {
                    if (event.data && event.data.size > 0) {
                        this.audioChunks.push(event.data);
                    }
                };

                this.mediaRecorder.onstop = async () => {
                    await this.processRecordedAudio();
                };

                this.mediaRecorder.onerror = (event) => {
                    logger.error('MediaRecorder error', { error: event.error?.message });
                    this.addMessage(`Recording error: ${event.error?.message || 'Unknown error'}`, 'error');
                    this.cleanupRecording();
                };

                // FULLY MANUAL RECORDING:
                // - start() is called with NO timeslice argument, so we get one complete blob on stop.
                // - There is NO auto-stop timer, NO silence detection, NO maximum duration.
                // - Recording continues until the user explicitly clicks Stop.
                this.mediaRecorder.start();
                this.handleRecordingStarted();
                logger.info('MediaRecorder started (fully manual, no auto-stop)', { mimeType });

                // NOTE: No interim chunk sending — Whisper needs complete audio files.
                // Transcription happens only when the user manually stops recording.

            } catch (error) {
                logger.error('Failed to start MediaRecorder', { error: error.message });
                this.addMessage(`Failed to start recording: ${error.message}`, 'error');
                this.cleanupRecording();
            }
        }

        /**
         * Stop audio recording and send final audio for transcription.
         * This is ONLY called when the user explicitly presses the Stop button.
         */
        async stopAudioRecording() {
            // Clear interim sending interval
            if (this.recordingInterval) {
                clearInterval(this.recordingInterval);
                this.recordingInterval = null;
            }

            // Stop MediaRecorder (triggers onstop → processRecordedAudio)
            if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
                this.mediaRecorder.stop();
            }

            // Signal main process
            try {
                await window.electronAPI.stopSpeechRecognition();
            } catch (err) {
                logger.warn('Failed to signal main process for recording stop', { error: err.message });
            }

            this.handleRecordingStopped();
        }

        /**
         * Process the full recorded audio and send to main for transcription.
         */
        async processRecordedAudio() {
            if (this.audioChunks.length === 0) {
                logger.warn('No audio chunks to process');
                this.cleanupRecording();
                return;
            }

            try {
                const mimeType = this.getSupportedMimeType();
                // Map MIME type to the correct file extension Whisper expects
                let format = 'webm';
                if (mimeType.includes('ogg')) format = 'ogg';
                else if (mimeType.includes('mp4')) format = 'mp4';
                else if (mimeType.includes('wav')) format = 'wav';
                else format = 'webm';

                const audioBlob = new Blob(this.audioChunks, { type: mimeType });

                logger.info('Audio blob created', {
                    size: audioBlob.size,
                    type: mimeType,
                    format: format,
                    chunks: this.audioChunks.length
                });

                // Minimum size check — skip if too small (likely silence/empty)
                if (audioBlob.size < 1000) {
                    logger.warn('Audio blob too small, likely empty', { size: audioBlob.size });
                    this.addMessage('Recording was too short or empty. Please speak and try again.', 'system');
                    this.cleanupRecording();
                    return;
                }

                // Convert Blob to base64 for reliable IPC transfer
                const arrayBuffer = await audioBlob.arrayBuffer();
                const audioData = btoa(
                    new Uint8Array(arrayBuffer)
                        .reduce((data, byte) => data + String.fromCharCode(byte), '')
                );

                logger.info('Sending recorded audio for transcription', {
                    blobSize: audioBlob.size,
                    base64Length: audioData.length,
                    format: format,
                    chunks: this.audioChunks.length
                });

                // Send to main process for Whisper transcription
                const result = await window.electronAPI.processAudioBlob(audioData, format);

                if (result && result.success && result.text) {
                    logger.info('Audio transcribed successfully', { textLength: result.text.length });
                } else if (result && !result.success) {
                    logger.warn('Transcription failed', { error: result.error });
                    this.addMessage(`Transcription failed: ${result.error}`, 'error');
                }
            } catch (error) {
                logger.error('Failed to process recorded audio', { error: error.message });
                this.addMessage(`Failed to process audio: ${error.message}`, 'error');
            } finally {
                this.cleanupRecording();
            }
        }

        /**
         * Clean up media stream and recorder resources.
         */
        cleanupRecording() {
            if (this.recordingInterval) {
                clearInterval(this.recordingInterval);
                this.recordingInterval = null;
            }

            if (this.mediaStream) {
                this.mediaStream.getTracks().forEach(track => track.stop());
                this.mediaStream = null;
            }

            this.mediaRecorder = null;
            this.audioChunks = [];
        }

        /**
         * Get a MIME type supported by MediaRecorder.
         */
        getSupportedMimeType() {
            const types = [
                'audio/webm;codecs=opus',
                'audio/webm',
                'audio/ogg;codecs=opus',
                'audio/mp4',
                'audio/wav'
            ];
            for (const type of types) {
                if (MediaRecorder.isTypeSupported(type)) {
                    return type;
                }
            }
            return 'audio/webm'; // fallback
        }

        // ──────────────────────────────────────────────────
        // Mic Permission Error Handling
        // ──────────────────────────────────────────────────

        /**
         * Handle microphone errors (permission denied, device not found, etc.)
         */
        handleMicError(error) {
            logger.error('Microphone error', { error: error.message, name: error.name });

            this.cleanupRecording();
            this.handleRecordingStopped();

            if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') {
                this.micPermissionGranted = false;
                this.showMicPermissionDenied(
                    'Microphone access was denied. Please allow microphone access in your system settings and restart the app.'
                );
                // Notify main process
                if (window.electronAPI && window.electronAPI.reportMicPermissionDenied) {
                    window.electronAPI.reportMicPermissionDenied({
                        message: error.message,
                        name: error.name
                    });
                }
            } else if (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError') {
                this.addMessage('No microphone found. Please connect a microphone and try again.', 'error');
            } else if (error.name === 'NotReadableError' || error.name === 'TrackStartError') {
                this.addMessage('Microphone is in use by another application. Please close other apps using the mic and try again.', 'error');
            } else {
                this.addMessage(`Microphone error: ${error.message}`, 'error');
            }
        }

        /**
         * Show a prominent permission denied message with guidance.
         */
        showMicPermissionDenied(message) {
            // Remove any existing permission banner
            const existingBanner = document.getElementById('mic-permission-banner');
            if (existingBanner) existingBanner.remove();

            // Create a dismissible banner
            const banner = document.createElement('div');
            banner.id = 'mic-permission-banner';
            banner.style.cssText = `
            background: linear-gradient(135deg, rgba(255, 60, 60, 0.15), rgba(255, 120, 60, 0.1));
            border: 1px solid rgba(255, 60, 60, 0.4);
            border-radius: 10px;
            padding: 14px 16px;
            margin: 8px 12px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            animation: fadeIn 0.3s ease;
        `;
            banner.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 18px;">🎙️</span>
                <span style="font-size: 13px; font-weight: 600; color: #ff6b6b;">Microphone Access Denied</span>
                <button id="mic-banner-dismiss" style="
                    margin-left: auto; background: none; border: none; color: rgba(255,255,255,0.5);
                    cursor: pointer; font-size: 16px; padding: 0 4px;
                ">&times;</button>
            </div>
            <div style="font-size: 12px; color: rgba(255, 255, 255, 0.7); line-height: 1.5;">
                ${message || 'Microphone access was denied.'}
            </div>
            <div style="font-size: 11px; color: rgba(255, 255, 255, 0.5); line-height: 1.4;">
                <strong>How to fix:</strong><br>
                • <strong>Windows:</strong> Settings → Privacy → Microphone → Allow apps to access your microphone<br>
                • <strong>macOS:</strong> System Settings → Privacy & Security → Microphone → Enable for this app<br>
                • Then restart the application.
            </div>
            <button id="mic-retry-btn" style="
                background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255,255,255,0.15);
                border-radius: 6px; padding: 6px 14px; color: rgba(255,255,255,0.8);
                cursor: pointer; font-size: 12px; align-self: flex-start; margin-top: 4px;
            ">🔄 Retry Microphone Access</button>
        `;

            // Insert at the top of chat messages
            if (this.elements.chatMessages) {
                this.elements.chatMessages.insertBefore(banner, this.elements.chatMessages.firstChild);
            }

            // Dismiss handler
            const dismissBtn = banner.querySelector('#mic-banner-dismiss');
            if (dismissBtn) {
                dismissBtn.addEventListener('click', () => banner.remove());
            }

            // Retry handler
            const retryBtn = banner.querySelector('#mic-retry-btn');
            if (retryBtn) {
                retryBtn.addEventListener('click', async () => {
                    banner.remove();
                    try {
                        await this.startAudioRecording();
                    } catch (err) {
                        this.handleMicError(err);
                    }
                });
            }

            // Disable mic button visual cue
            if (this.elements.micButton) {
                this.elements.micButton.classList.add('mic-denied');
            }
        }
    }

    // Initialize when DOM is loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            new ChatWindowUI();
        });
    } else {
        new ChatWindowUI();
    }

} catch (error) {
    console.error('💥 CHAT-WINDOW.JS: Script execution failed!', error);
    console.error('💥 CHAT-WINDOW.JS: Error stack:', error.stack);
}