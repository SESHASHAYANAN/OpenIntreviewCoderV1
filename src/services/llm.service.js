const Groq = require('groq-sdk');
const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');
const sessionManager = require('../managers/session.manager');

class LLMService {
  constructor() {
    this.client = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    this.initializeClient();
  }

  initializeClient() {
    try {
      const apiKey = process.env.GROQ_API_KEY || config.getApiKey('groq');
      if (!apiKey) {
        logger.warn('Groq API key not found. Set GROQ_API_KEY in .env or provide via settings.');
        this.isInitialized = false;
        return;
      }

      this.client = new Groq({ apiKey });
      this.isInitialized = true;
      this.model = config.get('llm.groq.model') || 'llama-3.3-70b-versatile';
      logger.info('Groq LLM client initialized', { model: this.model });
    } catch (error) {
      logger.error('Failed to initialize Groq client', { error: error.message });
      this.isInitialized = false;
    }
  }

  getGenerationConfig(overrides = {}) {
    const defaults = config.get('llm.groq.generation') || {};
    return {
      temperature: overrides.temperature ?? defaults.temperature ?? 0.7,
      top_p: overrides.topP ?? defaults.topP ?? 0.9,
      max_tokens: overrides.maxTokens ?? defaults.maxTokens ?? 4096,
    };
  }

  /**
   * Build the system prompt for a given skill with optional complexity layering.
   * @param {string} activeSkill - 'system-design', 'technical-screening', 'dsa'
   * @param {string} complexity - 'short', 'medium', 'long'
   * @param {string|null} programmingLanguage
   * @returns {string}
   */
  buildSystemPrompt(activeSkill, complexity = 'medium', programmingLanguage = null) {
    let basePrompt = '';

    // Load skill-specific prompt
    try {
      const skillPrompt = promptLoader.getSkillPrompt(activeSkill);
      if (skillPrompt) {
        basePrompt = skillPrompt;
      }
    } catch (e) {
      logger.warn('Could not load skill prompt', { skill: activeSkill });
    }

    const interviewAssistantPrompt = `You are a technical interview assistant that helps candidates understand and explain technical concepts clearly and confidently. Your main goal is to make every answer feel like a natural spoken explanation that a strong engineer would give to a friend, while still being precise and technically correct.

Always structure every technical answer in this exact three-part format, with the headings written exactly as shown:

Definition:

Explain the concept in plain, everyday language in a maximum of 2 short sentences. Avoid jargon, buzzwords, and complex terms as much as possible. Write it the way you would actually say it out loud in a casual but professional conversation. If the term itself is technical, briefly rephrase it in simpler words instead of just repeating it.

How it works:

Describe what happens step by step in 2–3 simple sentences. Focus on the practical flow of "first this happens, then that happens" rather than deep theory or formal definitions. Use clear, human-friendly language and everyday analogies only when they genuinely make the idea easier to picture. Prefer short sentences and direct verbs ("it checks…", "it stores…", "it calls…", "it compares…"). If code or math is involved, describe the idea in words first; only then, optionally mention the key operation in simple terms.

Real-world example:

Give exactly one concrete, relatable example that clearly shows where or how this concept shows up in real life. Make the example easy to imagine (e.g., a mobile app, website feature, API call, system behavior, or everyday digital product). Use a warm, confident tone, as if you are explaining to a friend who is smart but maybe new to the topic. Keep the example short (1–2 sentences) and focused on one use case, not a list of use cases.

Style and tone guidelines:
Write in spoken-English style, as if you are talking in a mock interview or mentoring session. Use clear, simple words and avoid unnecessary technical terms, deep theory, or academic phrasing unless the question explicitly asks for them. When you must use a technical term, briefly anchor it in simple language right away. Prefer short, direct sentences over long, complex ones. Sound confident and calm. Avoid filler phrases like "basically", "like", "sort of", or "kind of" unless they genuinely improve clarity. Do not apologize or hedge excessively. If the concept is ambiguous in industry, mention that briefly and then give the most common understanding.

Consistency and constraints:
Always include all three sections—"Definition:", "How it works:", and "Real-world example:"—even if the user's question is very short. Keep the total answer concise: usually 5–8 sentences in total across all three sections. Do not add extra sections, bullet lists, or headings beyond these three unless the user explicitly asks for more detail or a different format. If the question mentions multiple concepts, explain the main one the question clearly focuses on, or if the question clearly needs more than one concept, repeat the same three-part structure for each concept in order. If the question is ambiguous, briefly choose the most common interpretation and proceed.
`;

    // Add complexity layer instructions
    const complexityInstructions = {
      short: `\n\nRESPONSE FORMAT: You are whispering a quick hint. Give a single concise sentence — no markdown, no bullets. Maximum 15 words.`,
      medium: `\n\n${interviewAssistantPrompt}\n\nRESPONSE FORMAT: Give 2-4 natural sentences following the Definition / How it works / Real-world example format — no markdown, no bullets.`,
      long: `\n\n${interviewAssistantPrompt}\n\nRESPONSE FORMAT: Use markdown formatting and follow the three-part structure (Definition, How it works, Real-world example) for each concept covered. Be thorough but focused.`
    };

    basePrompt += complexityInstructions[complexity] || complexityInstructions.medium;

    if (programmingLanguage) {
      basePrompt += `\n\nWhen providing code, use ${programmingLanguage} only.`;
    }

    return basePrompt;
  }

  /**
   * Process text with the active skill through Groq.
   */
  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null, complexity = 'long', isFollowUp = false) {
    const startTime = Date.now();

    if (!this.isInitialized) {
      return this.generateFallbackResponse(text, activeSkill);
    }

    try {
      let systemPrompt = this.buildSystemPrompt(activeSkill, complexity, programmingLanguage);

      // Build user message with follow-up context if enabled
      let userMessage = text;

      if (isFollowUp) {
        systemPrompt += `\n\nIMPORTANT: This is a FOLLOW-UP message. Build on your previous answers — do NOT repeat yourself.`;

        const followUpContext = sessionManager.getFollowUpContext(3);
        if (followUpContext) {
          userMessage = followUpContext + '\n\nNEW MESSAGE (respond to this, building on context above):\n' + text;
          logger.info('Text follow-up context injected', {
            contextLength: followUpContext.length,
            textLength: text.length
          });
        }
      }

      const messages = this.buildMessages(systemPrompt, userMessage, sessionMemory);
      const genConfig = this.getGenerationConfig(
        complexity === 'short' ? { maxTokens: 100, temperature: 0.3 } :
          complexity === 'medium' ? { maxTokens: 500, temperature: 0.5 } :
            {}
      );

      const response = await this.executeRequest(messages, genConfig);
      const processingTime = Date.now() - startTime;
      this.requestCount++;

      logger.info('Groq text processing completed', {
        skill: activeSkill,
        complexity,
        processingTime,
        responseLength: response.length,
        isFollowUp
      });

      return {
        response,
        metadata: {
          processingTime,
          model: this.model,
          skill: activeSkill,
          complexity,
          usedFallback: false,
          isFollowUp
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('Groq text processing failed', { error: error.message, skill: activeSkill });
      return this.generateFallbackResponse(text, activeSkill);
    }
  }

  /**
   * Process image (screenshot) with skill context via Groq vision.
   * Note: Groq vision support depends on model. Falls back to text description.
   */
  async processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null) {
    const startTime = Date.now();

    if (!this.isInitialized) {
      return this.generateFallbackResponse('Image analysis requested', activeSkill);
    }

    try {
      const visualDataExtractorRules = `
STRICT PERSONA: You are a "Visual Data Extractor". Your single task is to analyze the screenshot and pull all readable text from it.
1. FULL SCAN: Scan the entire image from top-left to bottom-right. Do not summarize; treat it as a text document.
2. COMPLETE TRANSCRIPTION: Extract every word, number, and label. Include headers, footers, buttons, and fine print.
3. PRESERVE FORMATTING: Keep lists as lists, and maintain structural spatial relationships in text where possible.
4. UNCLEAR TEXT: If text is blurry or unreadable, mark it as [unclear].
5. GRAPHS/CHARTS: Describe data points and values in text form (e.g., "Bar Chart: Revenue - Q1: $10k, Q2: $15k").
6. NO VISUAL COMMENTARY: Do not say "This image shows..." or "In this screenshot...". Start immediately with the extracted data.
`;

      const systemPrompt = visualDataExtractorRules + "\n\n" + this.buildSystemPrompt(activeSkill, 'long', programmingLanguage);

      // Encode image to base64 for vision models
      const base64Image = Buffer.from(imageBuffer).toString('base64');
      const imageUrl = `data:${mimeType};base64,${base64Image}`;

      // Use llama-3.2-11b-vision-preview for image processing
      const visionModel = 'llama-3.2-11b-vision-preview';

      const messages = [
        { role: 'system', content: systemPrompt },
        ...this.formatSessionMemory(sessionMemory),
        {
          role: 'user',
          content: [
            { type: 'text', text: `Perform a COMPLETE DATA EXTRACTION on this screenshot. Extract all text, labels, and numbers. If it contains code, transcribe it exactly. If it contains diagrams or charts, describe the data points. NO COMMENTARY.` },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ];

      const completion = await this.client.chat.completions.create({
        model: visionModel,
        messages,
        ...this.getGenerationConfig({ temperature: 0.1 }), // Lower temperature for more accurate extraction
      });

      const response = completion.choices?.[0]?.message?.content || 'No response generated.';
      const processingTime = Date.now() - startTime;
      this.requestCount++;

      logger.info('Visual data extraction completed', {
        skill: activeSkill,
        processingTime,
        model: visionModel
      });

      return {
        response,
        metadata: {
          processingTime,
          model: visionModel,
          skill: activeSkill,
          usedFallback: false,
          isImageAnalysis: true
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('Visual data extraction failed', { error: error.message });
      return this.generateFallbackResponse('Image analysis failed', activeSkill);
    }
  }

  /**
   * Process transcription with intelligent co-pilot response.
   * This is the primary method for the whisper co-pilot mode.
   */
  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null, isFollowUp = false) {
    const startTime = Date.now();

    if (!this.isInitialized) {
      return this.generateFallbackResponse(text, activeSkill);
    }

    try {
      let copilotPrompt = this.getCopilotWhisperPrompt(activeSkill, programmingLanguage);

      // Build the user message — inject follow-up context if enabled
      let userMessage = text;

      if (isFollowUp) {
        copilotPrompt += `\n\nIMPORTANT: This is a FOLLOW-UP message. The user's previous questions/statements and your answers are provided below. Build on your previous answers — do NOT repeat yourself. Reference and extend the prior discussion.`;

        const followUpContext = sessionManager.getFollowUpContext(3);
        if (followUpContext) {
          userMessage = followUpContext + '\n\nNEW USER MESSAGE (respond to this, building on context above):\n' + text;
          logger.info('Voice follow-up context injected', {
            contextLength: followUpContext.length,
            textLength: text.length
          });
        } else {
          logger.info('Voice follow-up mode ON but no previous context available yet');
        }
      }

      const messages = this.buildMessages(copilotPrompt, userMessage, sessionMemory);
      const genConfig = this.getGenerationConfig({
        maxTokens: isFollowUp ? 500 : 300,
        temperature: 0.5
      });

      logger.info('Voice LLM request prepared', {
        isFollowUp,
        memoryEntries: sessionMemory.length,
        totalMessages: messages.length,
        userMessageLength: userMessage.length
      });

      const response = await this.executeRequest(messages, genConfig);
      const processingTime = Date.now() - startTime;
      this.requestCount++;

      logger.info('Co-pilot whisper response generated', {
        skill: activeSkill,
        processingTime,
        responseLength: response.length,
        isFollowUp
      });

      return {
        response,
        metadata: {
          processingTime,
          model: this.model,
          skill: activeSkill,
          complexity: 'medium',
          usedFallback: false,
          isCopilot: true,
          isFollowUp
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('Co-pilot response failed', { error: error.message });
      return this.generateFallbackResponse(text, activeSkill);
    }
  }

  /**
   * Generate all three complexity levels at once for the response panel.
   */
  async generateLayeredResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    const [short, medium, long] = await Promise.all([
      this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage, 'short'),
      this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage, 'medium'),
      this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage, 'long'),
    ]);

    return {
      hint: short.response,
      explain: medium.response,
      deepDive: long.response,
      metadata: {
        processingTime: Math.max(
          short.metadata.processingTime,
          medium.metadata.processingTime,
          long.metadata.processingTime
        ),
        model: this.model,
        skill: activeSkill
      }
    };
  }

  /**
   * Build message array for Groq chat completions.
   */
  buildMessages(systemPrompt, userText, sessionMemory = []) {
    const messages = [
      { role: 'system', content: systemPrompt }
    ];

    // Add session memory as conversation context
    messages.push(...this.formatSessionMemory(sessionMemory));

    // Add user message
    messages.push({ role: 'user', content: userText });

    return messages;
  }

  /**
   * Format session memory entries into Groq message format.
   * Maps OCR capture events to 'user' role and model responses to 'assistant'
   * to create proper alternating conversation flow.
   */
  formatSessionMemory(sessionMemory = []) {
    if (!sessionMemory || sessionMemory.length === 0) return [];

    return sessionMemory
      .filter(event => event.role && event.content)
      .slice(-20) // Keep last 20 messages for context
      .map(event => {
        let role;
        if (event.role === 'model') {
          role = 'assistant';
        } else if (event.role === 'user' || (event.role === 'system' && event.action === 'ocr_capture')) {
          // OCR captures represent screen content the user was working on — treat as user messages
          role = 'user';
        } else {
          role = 'system';
        }

        let content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
        // Clean up the OCR prefix for cleaner context
        if (event.action === 'ocr_capture') {
          content = content.replace(/^Screenshot captured:\s*/i, '[Screen Content]: ');
        }

        return { role, content };
      });
  }

  /**
   * Execute a Groq chat completion request.
   */
  async executeRequest(messages, genConfig = {}) {
    if (!this.client) {
      throw new Error('Groq client not initialized');
    }

    const maxRetries = config.get('llm.groq.maxRetries') || 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const completion = await this.client.chat.completions.create({
          model: this.model,
          messages,
          ...genConfig,
        });

        const text = completion.choices?.[0]?.message?.content;
        if (!text) {
          throw new Error('Empty response from Groq');
        }

        return text;
      } catch (error) {
        lastError = error;
        logger.warn(`Groq request attempt ${attempt}/${maxRetries} failed`, {
          error: error.message,
          status: error.status
        });

        if (attempt < maxRetries) {
          await this.delay(1000 * attempt); // Exponential backoff
        }
      }
    }

    throw lastError;
  }

  /**
   * Get Co-Pilot whisper system prompt.
   */
  getCopilotWhisperPrompt(activeSkill, programmingLanguage = null) {
    let prompt = '';

    // Try to load the copilot-whisper prompt
    try {
      const copilotPrompt = promptLoader.getSkillPrompt('copilot-whisper');
      if (copilotPrompt) {
        prompt = copilotPrompt;
      }
    } catch (e) {
      // Fallback built-in prompt
    }

    const interviewAssistantPrompt = `You are a technical interview assistant that helps candidates understand and explain technical concepts clearly and confidently. Your main goal is to make every answer feel like a natural spoken explanation that a strong engineer would give to a friend, while still being precise and technically correct.

Always structure every technical answer in this exact three-part format, with the headings written exactly as shown:

Definition:

Explain the concept in plain, everyday language in a maximum of 2 short sentences. Avoid jargon, buzzwords, and complex terms as much as possible. Write it the way you would actually say it out loud in a casual but professional conversation. If the term itself is technical, briefly rephrase it in simpler words instead of just repeating it.

How it works:

Describe what happens step by step in 2–3 simple sentences. Focus on the practical flow of "first this happens, then that happens" rather than deep theory or formal definitions. Use clear, human-friendly language and everyday analogies only when they genuinely make the idea easier to picture. Prefer short sentences and direct verbs ("it checks…", "it stores…", "it calls…", "it compares…"). If code or math is involved, describe the idea in words first; only then, optionally mention the key operation in simple terms.

Real-world example:

Give exactly one concrete, relatable example that clearly shows where or how this concept shows up in real life. Make the example easy to imagine (e.g., a mobile app, website feature, API call, system behavior, or everyday digital product). Use a warm, confident tone, as if you are explaining to a friend who is smart but maybe new to the topic. Keep the example short (1–2 sentences) and focused on one use case, not a list of use cases.

Style and tone guidelines:
Write in spoken-English style, as if you are talking in a mock interview or mentoring session. Use clear, simple words and avoid unnecessary technical terms, deep theory, or academic phrasing unless the question explicitly asks for them. When you must use a technical term, briefly anchor it in simple language right away. Prefer short, direct sentences over long, complex ones. Sound confident and calm. Avoid filler phrases like "basically", "like", "sort of", or "kind of" unless they genuinely improve clarity. Do not apologize or hedge excessively. If the concept is ambiguous in industry, mention that briefly and then give the most common understanding.

Consistency and constraints:
Always include all three sections—"Definition:", "How it works:", and "Real-world example:"—even if the user's question is very short. Keep the total answer concise: usually 5–8 sentences in total across all three sections. Do not add extra sections, bullet lists, or headings beyond these three unless the user explicitly asks for more detail or a different format. If the question mentions multiple concepts, explain the main one the question clearly focuses on, or if the question clearly needs more than one concept, repeat the same three-part structure for each concept in order. If the question is ambiguous, briefly choose the most common interpretation and proceed.
`;

    if (!prompt) {
      prompt = interviewAssistantPrompt + `
FOCUS AREAS for ${activeSkill}:
${activeSkill === 'system-design' ?
          '- Scalability patterns, load balancers, database choices, caching strategies, CAP theorem, microservices, message queues, consistency models, rate limiting, sharding' :
          activeSkill === 'technical-screening' ?
            '- Algorithm optimization, data structure selection, time/space complexity, edge cases, code correctness, design patterns' :
            '- Data structures, algorithms, optimal complexity, clean implementations'
        }`;
    } else {
      // Prepend interview assistant prompt to existing prompt if loaded from file
      prompt = interviewAssistantPrompt + "\n\n" + prompt;
    }

    if (programmingLanguage) {
      prompt += `\n\nIf code is needed, use ${programmingLanguage} only.`;
    }

    return prompt;
  }

  /**
   * Detect whether extracted screen text represents a design or coding question.
   * @param {string} extractedText - Text extracted from the screenshot
   * @param {string} activeSkill - Current active skill mode
   * @returns {'design'|'coding'}
   */
  detectQuestionType(extractedText, activeSkill) {
    if (!extractedText) return activeSkill === 'system-design' ? 'design' : 'coding';

    const text = extractedText.toLowerCase();

    // Coding indicators: function signatures, code syntax, algorithm keywords
    const codingPatterns = [
      /\b(def |function |class |int |void |public |private |return |if \(|for \(|while \()/,
      /\b(input|output|example|constraint|leetcode|hackerrank|codechef|codeforces)/,
      /\b(array|string|linked list|binary tree|graph|matrix|sort|search)\b/,
      /\b(time complexity|space complexity|o\(n\)|o\(log|o\(1\)|o\(n\^2)/,
      /\b(two pointer|sliding window|dynamic programming|backtracking|bfs|dfs|greedy)/,
      /=>|\{\}|\[\]|==|!=|\+\+|--|<<|>>/,
      /```|\bint\b.*\(|\bvoid\b.*\(/
    ];

    // Design indicators: architecture, system keywords
    const designPatterns = [
      /\b(design|architect|system|scalab|microservice|monolith|distributed)/,
      /\b(load balanc|api gateway|database|cache|cdn|message queue|kafka)/,
      /\b(availability|consistency|partition|replication|shard)/,
      /\b(user|request|server|client|service|endpoint|traffic|qps|latency)/,
      /\b(storage|bandwidth|throughput|bottleneck|single point of failure)/,
      /\b(rest|graphql|grpc|websocket|http|tcp)/,
      /\b(redis|memcached|postgresql|mongodb|dynamodb|cassandra|elasticsearch)/
    ];

    let codingScore = 0;
    let designScore = 0;

    for (const pattern of codingPatterns) {
      if (pattern.test(text)) codingScore++;
    }

    for (const pattern of designPatterns) {
      if (pattern.test(text)) designScore++;
    }

    // If the active skill is already set, give it a bias
    if (activeSkill === 'dsa' || activeSkill === 'technical-screening') codingScore += 2;
    if (activeSkill === 'system-design') designScore += 2;

    const detectedType = codingScore > designScore ? 'coding' : 'design';
    logger.debug('Question type detected', { codingScore, designScore, detectedType, activeSkill });
    return detectedType;
  }

  /**
   * Process a screen capture with structured two-part response.
   * Part A: Interview Dialogue — what to say to the interviewer
   * Part B: Solution Details — technical breakdown or code
   *
   * @param {Buffer} imageBuffer
   * @param {string} mimeType
   * @param {string} activeSkill
   * @param {Array} sessionMemory
   * @param {string|null} programmingLanguage
   * @param {boolean} isFollowUp - whether to include prior session context
   * @returns {Promise<{response: string, partA: string, partB: string, detectedType: string, metadata: object}>}
   */
  async processScreenCaptureWithStructuredResponse(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, isFollowUp = false) {
    const startTime = Date.now();

    if (!this.isInitialized) {
      return this.generateFallbackResponse('Image analysis requested', activeSkill);
    }

    try {
      // Step 1: Extract text/content from the screenshot using vision model
      const extractionPrompt = `STRICT PERSONA: You are a "Visual Data Extractor". Your single task is to analyze the screenshot and pull all readable text from it.
1. FULL SCAN: Scan the entire image from top-left to bottom-right. Do not summarize; treat it as a text document.
2. COMPLETE TRANSCRIPTION: Extract every word, number, and label. Include headers, footers, buttons, and fine print.
3. PRESERVE FORMATTING: Keep lists as lists, and maintain structural spatial relationships in text where possible.
4. UNCLEAR TEXT: If text is blurry or unreadable, mark it as [unclear].
5. GRAPHS/CHARTS: Describe data points and values in text form.
6. CODE: Transcribe code exactly as it appears, preserving indentation.
7. DIAGRAMS: Describe components, connections, and labels in detail.
8. NO VISUAL COMMENTARY: Do not say "This image shows..." Start immediately with the extracted data.`;

      const base64Image = Buffer.from(imageBuffer).toString('base64');
      const base64SizeKB = Math.round(base64Image.length / 1024);
      logger.info('Image prepared for vision API', { originalSizeKB: Math.round(imageBuffer.length / 1024), base64SizeKB });

      // If image is too large (>4MB base64), try to reduce quality
      let imageUrl;
      let finalMimeType = mimeType;
      if (base64Image.length > 4 * 1024 * 1024) {
        logger.warn('Image too large for vision API, attempting to reduce size', { base64SizeKB });
        // Use a lower quality JPEG approach by re-encoding the buffer
        // For Electron NativeImage, we can convert PNG to JPEG
        try {
          const { nativeImage } = require('electron');
          const img = nativeImage.createFromBuffer(imageBuffer);
          const jpegBuffer = img.toJPEG(70);
          const jpegBase64 = jpegBuffer.toString('base64');
          imageUrl = `data:image/jpeg;base64,${jpegBase64}`;
          finalMimeType = 'image/jpeg';
          logger.info('Image resized to JPEG', { newSizeKB: Math.round(jpegBase64.length / 1024) });
        } catch (resizeErr) {
          logger.warn('Image resize failed, using original', { error: resizeErr.message });
          imageUrl = `data:${mimeType};base64,${base64Image}`;
        }
      } else {
        imageUrl = `data:${mimeType};base64,${base64Image}`;
      }

      // Vision models to try in order of preference
      const visionModels = [
        'meta-llama/llama-4-scout-17b-16e-instruct',
        'llama-3.2-11b-vision-preview',
        'llama-3.2-90b-vision-preview'
      ];

      const extractionMessages = [
        { role: 'system', content: extractionPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Perform a COMPLETE DATA EXTRACTION on this screenshot. Extract all text, code, labels, diagrams, and numbers. NO COMMENTARY.' },
            { type: 'image_url', image_url: { url: imageUrl } }
          ]
        }
      ];

      let extractedText = '';
      let visionModel = visionModels[0];
      let extractionSuccess = false;

      for (const modelName of visionModels) {
        try {
          logger.info('Attempting vision extraction', { model: modelName });
          const extractionCompletion = await this.client.chat.completions.create({
            model: modelName,
            messages: extractionMessages,
            temperature: 0.1,
            max_tokens: 2048,
          });

          extractedText = extractionCompletion.choices?.[0]?.message?.content || '';
          visionModel = modelName;
          extractionSuccess = true;
          logger.info('Vision extraction succeeded', { model: modelName, extractedLength: extractedText.length });
          break;
        } catch (visionError) {
          logger.error('Vision model failed', {
            model: modelName,
            error: visionError.message,
            status: visionError.status,
            statusText: visionError.statusText,
            errorBody: visionError.error?.message || visionError.body || ''
          });
          // Continue to next model
        }
      }

      if (!extractionSuccess) {
        throw new Error('All vision models failed to extract text from screenshot');
      }
      logger.info('Screen content extracted', { extractedLength: extractedText.length });

      // Step 2: Detect whether this is a design or coding question
      const detectedType = this.detectQuestionType(extractedText, activeSkill);

      // Step 3: Load the appropriate structured prompt
      let structuredPrompt = '';
      try {
        const promptName = detectedType === 'design' ? 'screen-capture-design' : 'screen-capture-coding';
        const loadedPrompt = promptLoader.getSkillPrompt(promptName);
        if (loadedPrompt) {
          structuredPrompt = loadedPrompt;
        }
      } catch (e) {
        logger.warn('Could not load structured prompt, using built-in fallback', { detectedType });
      }

      // Fallback prompts if file loading fails
      if (!structuredPrompt) {
        if (detectedType === 'design') {
          structuredPrompt = `Analyze this content from a system design interview. Respond in two parts:
## Part A — What to Say to the Interviewer
Bulleted list of what to say step by step: clarify requirements, define scope, high-level design, deep dive, trade-offs.
## Part B — Solution Architecture
Detailed architecture breakdown with components, data flow, scaling strategy, and trade-offs.`;
        } else {
          structuredPrompt = `Analyze this content from a coding/DSA interview. Respond in two parts:
## Part A — What to Say to the Interviewer
Bulleted list of what to say: restate problem, clarify edge cases, identify pattern, explain approach, state complexity.
## Part B — Solution Code & Explanation
Optimal solution code with approach explanation and complexity analysis.`;
        }
      }

      if (programmingLanguage) {
        structuredPrompt += `\n\nWhen providing code, use ${programmingLanguage} only.`;
      }

      // Step 4: Build context-aware prompt and generate response
      let userMessage = extractedText;

      if (isFollowUp) {
        structuredPrompt += `\n\nIMPORTANT: This is a FOLLOW-UP to a previous problem. The user's previous questions and your answers are provided below the context separator. Build on your previous answers — do NOT repeat what you already said. Reference and extend the prior discussion.`;

        // Get formatted follow-up context from session manager
        const followUpContext = sessionManager.getFollowUpContext(3);
        if (followUpContext) {
          userMessage = followUpContext + '\n\nNEW SCREEN CONTENT (answer this, building on context above):\n' + extractedText;
          logger.info('Follow-up context injected', {
            contextLength: followUpContext.length,
            extractedTextLength: extractedText.length
          });
        } else {
          logger.info('Follow-up mode ON but no previous context available yet');
        }
      }

      // Always pass session memory when in follow-up mode for additional context
      const memoryToUse = isFollowUp ? sessionMemory : [];
      const responseMessages = this.buildMessages(structuredPrompt, userMessage, memoryToUse);
      const genConfig = this.getGenerationConfig({ temperature: 0.5, maxTokens: 4096 });

      logger.info('LLM request prepared', {
        isFollowUp,
        memoryEntries: memoryToUse.length,
        totalMessages: responseMessages.length,
        userMessageLength: userMessage.length
      });

      const response = await this.executeRequest(responseMessages, genConfig);
      const processingTime = Date.now() - startTime;
      this.requestCount++;

      // Step 5: Split response into Part A and Part B
      // The LLM may use various header formats: "## Part A", "# Part A", "**Part A**", "Part A —", "Part A:", etc.
      let partA = '';
      let partB = '';

      // Flexible regex: optional markdown headers (#, ##), optional bold (**), "Part A" or "Part B", optional separator (—, -, :)
      const partARegex = /(?:^|\n)(?:#{1,3}\s*)?(?:\*{1,2})?Part\s*A(?:\*{1,2})?[\s—\-:]*[^\r\n]*[\r\n]+([\s\S]*?)(?=(?:#{0,3}\s*)?(?:\*{1,2})?Part\s*B|$)/i;
      const partBRegex = /(?:^|\n)(?:#{1,3}\s*)?(?:\*{1,2})?Part\s*B(?:\*{1,2})?[\s—\-:]*[^\r\n]*[\r\n]+([\s\S]*?)$/i;

      const partAMatch = response.match(partARegex);
      const partBMatch = response.match(partBRegex);

      if (partAMatch) partA = partAMatch[1].trim();
      if (partBMatch) partB = partBMatch[1].trim();

      // If splitting failed, treat the whole response as the content
      if (!partA && !partB) {
        partA = '';
        partB = response;
      }

      logger.info('Structured screen capture response generated', {
        detectedType,
        processingTime,
        partALength: partA.length,
        partBLength: partB.length,
        isFollowUp
      });

      return {
        response,
        partA,
        partB,
        detectedType,
        extractedText,
        metadata: {
          processingTime,
          model: this.model,
          visionModel,
          skill: activeSkill,
          detectedType,
          isFollowUp,
          usedFallback: false,
          isImageAnalysis: true,
          isStructuredResponse: true
        }
      };
    } catch (error) {
      this.errorCount++;
      logger.error('Structured screen capture processing failed', {
        error: error.message,
        status: error.status,
        errorBody: error.error?.message || error.body || '',
        stack: error.stack?.substring(0, 300)
      });
      return this.generateFallbackResponse('Image analysis failed', activeSkill);
    }
  }

  /**
   * Generate a fallback response when Groq is unavailable.
   */
  generateFallbackResponse(text, activeSkill) {
    const processingTime = 0;
    let response = '';

    if (activeSkill === 'system-design') {
      response = 'Consider the scalability implications here. Think about read vs write patterns, caching layers, and whether you need strong consistency or eventual consistency.';
    } else if (activeSkill === 'technical-screening') {
      response = 'Think about the time complexity of your approach. Is there a way to optimize with a different data structure like a hash map or a heap?';
    } else {
      response = 'Let me think about this problem. Consider the pattern — is it a sliding window, two pointers, or dynamic programming approach?';
    }

    return {
      response,
      partA: '',
      partB: '',
      detectedType: activeSkill === 'system-design' ? 'design' : 'coding',
      extractedText: text || '',
      metadata: {
        processingTime,
        model: 'fallback',
        skill: activeSkill,
        usedFallback: true,
        isStructuredResponse: false
      }
    };
  }

  /**
   * Test the Groq connection.
   */
  async testConnection() {
    try {
      if (!this.client) {
        return { success: false, error: 'Client not initialized. Check your GROQ_API_KEY.' };
      }

      const startTime = Date.now();
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'user', content: 'Say "DeepVoice connected" in exactly those words.' }
        ],
        max_tokens: 20,
        temperature: 0,
      });

      const responseTime = Date.now() - startTime;
      const text = completion.choices?.[0]?.message?.content || '';

      return {
        success: true,
        response: text.trim(),
        responseTime,
        model: this.model
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        status: error.status
      };
    }
  }

  /**
   * Update the API key and reinitialize.
   */
  updateApiKey(newApiKey) {
    process.env.GROQ_API_KEY = newApiKey;
    this.initializeClient();
    logger.info('Groq API key updated and client reinitialized');
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      model: this.model,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      provider: 'groq'
    };
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = new LLMService();