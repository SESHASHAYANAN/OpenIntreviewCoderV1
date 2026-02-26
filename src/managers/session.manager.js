const logger = require('../core/logger').createServiceLogger('SESSION');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');

class SessionManager {
  constructor() {
    this.sessionMemory = [];
    this.compressionEnabled = true;
    this.maxSize = config.get('session.maxMemorySize');
    this.compressionThreshold = config.get('session.compressionThreshold');
    this.maxDurationMinutes = config.get('session.maxDurationMinutes') || 240;
    this.activeSkill = config.get('interview.defaultMode') || 'system-design';
    this.sessionStartTime = null;
    this.sessionActive = false;
    this.topicTags = new Map(); // topic -> [{content, timestamp, relevance}]
    this.sessionTimer = null;

    this.initializeWithSkillPrompts();
  }

  // ──────────────────────────────────────────────────
  // Session Lifecycle
  // ──────────────────────────────────────────────────

  startSession(mode = null) {
    if (mode) this.activeSkill = mode;
    this.sessionStartTime = Date.now();
    this.sessionActive = true;
    this.sessionMemory = [];
    this.topicTags.clear();

    // Auto-end after maxDurationMinutes
    this.sessionTimer = setTimeout(() => {
      this.endSession();
    }, this.maxDurationMinutes * 60 * 1000);

    this.addConversationEvent({
      role: 'system',
      content: `Interview session started. Mode: ${this.activeSkill}. Duration: ${this.maxDurationMinutes} minutes.`,
      action: 'session_start'
    });

    logger.info('Session started', { mode: this.activeSkill, durationMinutes: this.maxDurationMinutes });
    return this.getSessionTimer();
  }

  endSession() {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }

    const summary = this.generateSessionSummary();
    this.sessionActive = false;

    logger.info('Session ended', {
      duration: this.getElapsedMinutes(),
      eventCount: this.sessionMemory.length,
      topicCount: this.topicTags.size
    });

    return summary;
  }

  getSessionTimer() {
    if (!this.sessionStartTime) {
      return { elapsed: 0, remaining: this.maxDurationMinutes * 60, isActive: false };
    }

    const elapsedMs = Date.now() - this.sessionStartTime;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    const totalSeconds = this.maxDurationMinutes * 60;
    const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);

    return {
      elapsed: elapsedSeconds,
      remaining: remainingSeconds,
      elapsedFormatted: this.formatTime(elapsedSeconds),
      remainingFormatted: this.formatTime(remainingSeconds),
      isActive: this.sessionActive,
      percentComplete: Math.min(100, Math.round((elapsedSeconds / totalSeconds) * 100))
    };
  }

  getElapsedMinutes() {
    if (!this.sessionStartTime) return 0;
    return Math.round((Date.now() - this.sessionStartTime) / 60000);
  }

  formatTime(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) {
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  // ──────────────────────────────────────────────────
  // Skill Prompts
  // ──────────────────────────────────────────────────

  initializeWithSkillPrompts() {
    try {
      const skills = config.get('interview.availableModes') || ['system-design', 'technical-screening', 'dsa'];

      for (const skill of skills) {
        try {
          const prompt = promptLoader.getSkillPrompt(skill);
          if (prompt) {
            this.sessionMemory.push({
              id: this.generateEventId(),
              timestamp: Date.now(),
              role: 'system',
              content: `Skill prompt loaded: ${skill}`,
              action: 'skill_init',
              category: 'system',
              metadata: { skill, promptLength: prompt.length }
            });
          }
        } catch (e) {
          logger.debug('Skill prompt not found', { skill });
        }
      }
    } catch (error) {
      logger.warn('Failed to initialize skill prompts', { error: error.message });
    }
  }

  setActiveSkill(skill) {
    const previousSkill = this.activeSkill;
    this.activeSkill = skill;

    this.addConversationEvent({
      role: 'system',
      content: `Interview mode switched from ${previousSkill} to ${skill}`,
      action: 'skill_change',
      metadata: { from: previousSkill, to: skill }
    });

    logger.info('Active skill changed', { from: previousSkill, to: skill });
  }

  // ──────────────────────────────────────────────────
  // Event Management
  // ──────────────────────────────────────────────────

  addConversationEvent({ role, content, action = null, metadata = {} }) {
    const event = {
      id: this.generateEventId(),
      timestamp: Date.now(),
      role,
      content,
      action: action || this.inferActionFromRole(role),
      category: this.categorizeAction(action || role),
      metadata: {
        ...metadata,
        skill: this.activeSkill,
        sessionElapsed: this.getElapsedMinutes()
      }
    };

    this.sessionMemory.push(event);
    this.extractAndTagTopics(content, event.timestamp);
    this.evictExpiredEvents();
    this.performMaintenanceIfNeeded();

    return event;
  }

  addUserInput(text, source = 'speech') {
    return this.addConversationEvent({
      role: 'user',
      content: text,
      action: source === 'speech' ? 'voice_input' : 'chat_input',
      metadata: { source, textLength: text.length }
    });
  }

  addModelResponse(text, metadata = {}) {
    return this.addConversationEvent({
      role: 'model',
      content: text,
      action: 'model_response',
      metadata: { responseLength: text.length, ...metadata }
    });
  }

  addOCREvent(extractedText, metadata = {}) {
    // Store more context (up to 4000 chars) for follow-up questions
    const safeText = extractedText.length > 4000 ? extractedText.substring(0, 4000) + '...' : extractedText;
    return this.addConversationEvent({
      role: 'system',
      content: `Screenshot captured: ${safeText}`,
      action: 'ocr_capture',
      metadata: { fullTextLength: extractedText.length, ...metadata }
    });
  }

  addEvent(action, details = {}) {
    return this.addConversationEvent({
      role: 'system',
      content: details.content || action,
      action,
      metadata: details
    });
  }

  // ──────────────────────────────────────────────────
  // 240-Minute Memory & Topic Tagging
  // ──────────────────────────────────────────────────

  /**
   * Evict events older than 240 minutes to maintain the working memory window.
   */
  evictExpiredEvents() {
    const cutoffTime = Date.now() - (this.maxDurationMinutes * 60 * 1000);
    const beforeCount = this.sessionMemory.length;

    this.sessionMemory = this.sessionMemory.filter(event => {
      // Keep system/init events and all events within the time window
      if (event.category === 'system' && event.action === 'skill_init') return true;
      return event.timestamp >= cutoffTime;
    });

    const evicted = beforeCount - this.sessionMemory.length;
    if (evicted > 0) {
      logger.debug('Evicted expired events', { evicted, remaining: this.sessionMemory.length });
    }

    // Also evict old topic tags
    for (const [topic, entries] of this.topicTags.entries()) {
      const filtered = entries.filter(e => e.timestamp >= cutoffTime);
      if (filtered.length === 0) {
        this.topicTags.delete(topic);
      } else {
        this.topicTags.set(topic, filtered);
      }
    }
  }

  /**
   * Extract and tag key technical topics from content for semantic recall.
   */
  extractAndTagTopics(content, timestamp) {
    if (!content || typeof content !== 'string') return;

    const topicPatterns = [
      // Database & Storage
      /\b(SQL|NoSQL|PostgreSQL|MySQL|MongoDB|DynamoDB|Cassandra|Redis|Memcached)\b/gi,
      /\b(database|DB|schema|index|query|JOIN|partition|shard)\b/gi,
      /\b(ACID|BASE|transaction|consistency|durability)\b/gi,
      // Architecture
      /\b(microservice|monolith|API gateway|service mesh|load balancer)\b/gi,
      /\b(REST|GraphQL|gRPC|WebSocket|HTTP|HTTPS)\b/gi,
      /\b(cache|caching|CDN|proxy|reverse proxy)\b/gi,
      // Scalability
      /\b(horizontal scaling|vertical scaling|auto-scaling|replication|read replica)\b/gi,
      /\b(throughput|latency|QPS|TPS|SLA|availability)\b/gi,
      /\b(CAP theorem|eventual consistency|strong consistency)\b/gi,
      // Algorithms & DS
      /\b(hash map|hash table|binary search|two pointer|sliding window)\b/gi,
      /\b(dynamic programming|DP|greedy|BFS|DFS|topological sort)\b/gi,
      /\b(tree|graph|heap|stack|queue|trie|linked list)\b/gi,
      /\b(O\([\w\s\*log]+\)|time complexity|space complexity)\b/gi,
      // Infrastructure
      /\b(Kubernetes|Docker|container|pod|deployment|Kafka|RabbitMQ)\b/gi,
      /\b(message queue|pub-sub|event-driven|CQRS|saga)\b/gi,
      // Specific numbers/values
      /\b(\d+(?:\.\d+)?\s*(?:MB|GB|TB|ms|seconds|QPS|TPS|ops\/sec))\b/gi,
    ];

    for (const pattern of topicPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        for (const match of matches) {
          const topic = match.toLowerCase().trim();
          if (!this.topicTags.has(topic)) {
            this.topicTags.set(topic, []);
          }
          this.topicTags.get(topic).push({
            content: content.substring(0, 200),
            timestamp,
            relevance: 1.0
          });
        }
      }
    }
  }

  /**
   * Recall information about a specific topic from the session memory.
   * Used when the user asks "What did we say about X?"
   */
  recallTopic(query) {
    const queryLower = query.toLowerCase();
    const results = [];

    // Search topic tags
    for (const [topic, entries] of this.topicTags.entries()) {
      if (queryLower.includes(topic) || topic.includes(queryLower)) {
        results.push(...entries.map(e => ({
          topic,
          content: e.content,
          timestamp: e.timestamp,
          ago: this.formatTimeAgo(e.timestamp)
        })));
      }
    }

    // Also search raw memory for context
    const relevantEvents = this.sessionMemory.filter(event => {
      if (!event.content || typeof event.content !== 'string') return false;
      return event.content.toLowerCase().includes(queryLower);
    });

    for (const event of relevantEvents) {
      results.push({
        topic: 'direct_match',
        content: event.content,
        timestamp: event.timestamp,
        ago: this.formatTimeAgo(event.timestamp),
        role: event.role
      });
    }

    // Sort by timestamp, most recent first
    results.sort((a, b) => b.timestamp - a.timestamp);

    return results.slice(0, 10); // Top 10 results
  }

  formatTimeAgo(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes === 1) return '1 minute ago';
    return `${minutes} minutes ago`;
  }

  // ──────────────────────────────────────────────────
  // History & Context
  // ──────────────────────────────────────────────────

  getConversationHistory(maxEntries = 20) {
    return this.sessionMemory
      .filter(e => e.role === 'user' || e.role === 'model')
      .slice(-maxEntries)
      .map(e => ({
        role: e.role,
        content: e.content,
        timestamp: e.timestamp
      }));
  }

  getFullConversationHistory() {
    return this.sessionMemory
      .filter(e => e.action !== 'skill_init')
      .map(e => ({
        role: e.role,
        content: e.content,
        timestamp: e.timestamp,
        action: e.action
      }));
  }

  getSkillContext(skillName = null, programmingLanguage = null) {
    const skill = skillName || this.activeSkill;
    let context = '';

    try {
      const prompt = promptLoader.getSkillPrompt(skill);
      if (prompt) context = prompt;
    } catch (e) {
      logger.debug('Skill context not found', { skill });
    }

    if (programmingLanguage) {
      context += `\n\nProgramming language: ${programmingLanguage}`;
    }

    return context;
  }


  /**
   * Get a formatted follow-up context string for the LLM.
   * Returns previous question/input + model answer pairs as a clear narrative.
   * Supports both OCR captures (screen content) and voice/chat user inputs.
   */
  getFollowUpContext(maxPairs = 3) {
    // Collect user inputs (OCR captures + voice/chat) and model responses in chronological order
    const relevantEvents = this.sessionMemory.filter(e =>
      (e.role === 'system' && e.action === 'ocr_capture') ||
      e.role === 'user' ||
      e.role === 'model'
    );

    if (relevantEvents.length === 0) return '';

    // Build Q&A pairs — match user messages/OCR events with subsequent model responses
    const pairs = [];
    let currentQuestion = null;
    let questionSource = null;

    for (const event of relevantEvents) {
      if (event.action === 'ocr_capture') {
        // Screen capture — extract the actual text (remove "Screenshot captured: " prefix)
        currentQuestion = event.content.replace(/^Screenshot captured:\s*/i, '');
        questionSource = 'screen';
      } else if (event.role === 'user') {
        // Voice or chat input
        currentQuestion = event.content;
        questionSource = 'voice/chat';
      } else if (event.role === 'model' && currentQuestion) {
        pairs.push({
          question: currentQuestion,
          answer: event.content,
          source: questionSource
        });
        currentQuestion = null;
        questionSource = null;
      }
    }

    if (pairs.length === 0) return '';

    // Take the last N pairs
    const recentPairs = pairs.slice(-maxPairs);

    let context = '=== PREVIOUS CONVERSATION CONTEXT ===\n';
    recentPairs.forEach((pair, i) => {
      context += `\n--- Turn ${i + 1} ---\n`;
      const label = pair.source === 'screen' ? 'SCREEN CONTENT' : 'USER MESSAGE';
      context += `${label}:\n${pair.question.substring(0, 1500)}\n\n`;
      context += `YOUR PREVIOUS ANSWER:\n${pair.answer.substring(0, 2000)}\n`;
    });
    context += '\n=== END PREVIOUS CONTEXT ===\n';

    return context;
  }

  inferActionFromRole(role) {
    switch (role) {
      case 'user': return 'user_message';
      case 'model': return 'model_response';
      case 'system': return 'system_event';
      default: return 'unknown';
    }
  }

  categorizeAction(action) {
    if (!action) return 'general';
    const categories = {
      voice_input: 'interaction', chat_input: 'interaction',
      model_response: 'ai', copilot_whisper: 'ai',
      ocr_capture: 'capture', screenshot: 'capture',
      skill_init: 'system', skill_change: 'system',
      session_start: 'system', session_end: 'system'
    };
    return categories[action] || 'general';
  }

  generateEventId() {
    return `evt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  }

  // ──────────────────────────────────────────────────
  // Maintenance
  // ──────────────────────────────────────────────────

  performMaintenanceIfNeeded() {
    if (this.sessionMemory.length > this.compressionThreshold) {
      this.performMaintenance();
    }
  }

  performMaintenance() {
    this.evictExpiredEvents();
    this.consolidateSimilarEvents();

    if (this.sessionMemory.length > this.maxSize) {
      // Keep the most recent events
      const excess = this.sessionMemory.length - this.maxSize;
      this.sessionMemory = this.sessionMemory.slice(excess);
      logger.debug('Memory truncated', { removed: excess, remaining: this.sessionMemory.length });
    }
  }

  consolidateSimilarEvents() {
    // Group consecutive system events with the same action
    const consolidated = [];
    let i = 0;

    while (i < this.sessionMemory.length) {
      const current = this.sessionMemory[i];

      if (current.category === 'system' && i + 1 < this.sessionMemory.length) {
        const next = this.sessionMemory[i + 1];
        if (next.category === 'system' && next.action === current.action) {
          // Merge
          consolidated.push({
            ...current,
            content: `${current.content} (×${2})`,
            metadata: { ...current.metadata, consolidated: true }
          });
          i += 2;
          continue;
        }
      }

      consolidated.push(current);
      i++;
    }

    this.sessionMemory = consolidated;
  }

  // ──────────────────────────────────────────────────
  // Output Methods
  // ──────────────────────────────────────────────────

  getOptimizedHistory(limit = 15) {
    this.evictExpiredEvents();

    const recent = this.sessionMemory
      .filter(e =>
        e.role === 'user' ||
        e.role === 'model' ||
        (e.role === 'system' && e.action === 'ocr_capture')
      )
      .slice(-limit);

    const important = this.sessionMemory
      .filter(e =>
        e.category === 'interaction' ||
        e.category === 'ai' ||
        (e.category === 'system' && e.action === 'ocr_capture')
      )
      .slice(-5);

    return {
      recent,
      important,
      topics: Array.from(this.topicTags.keys()),
      timer: this.getSessionTimer(),
      eventCount: this.sessionMemory.length
    };
  }

  getRecentEvents(count = 10) {
    return this.sessionMemory.slice(-count);
  }

  generateSessionSummary() {
    const timer = this.getSessionTimer();
    const topics = Array.from(this.topicTags.keys());
    const userMessages = this.sessionMemory.filter(e => e.role === 'user').length;
    const aiResponses = this.sessionMemory.filter(e => e.role === 'model').length;

    return {
      duration: timer.elapsedFormatted || '00:00',
      durationMinutes: this.getElapsedMinutes(),
      mode: this.activeSkill,
      totalEvents: this.sessionMemory.length,
      userMessages,
      aiResponses,
      topicsCovered: topics,
      topicCount: topics.length,
      transcript: this.sessionMemory
        .filter(e => e.role === 'user' || e.role === 'model')
        .map(e => ({
          role: e.role,
          content: e.content,
          timestamp: e.timestamp
        }))
    };
  }

  clear() {
    this.sessionMemory = [];
    this.topicTags.clear();
    this.sessionStartTime = null;
    this.sessionActive = false;
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
    logger.info('Session memory cleared');
    this.initializeWithSkillPrompts();
  }

  getMemoryUsage() {
    return {
      eventCount: this.sessionMemory.length,
      topicCount: this.topicTags.size,
      maxSize: this.maxSize,
      maxDurationMinutes: this.maxDurationMinutes,
      sessionActive: this.sessionActive,
      timer: this.getSessionTimer()
    };
  }
}

module.exports = new SessionManager();