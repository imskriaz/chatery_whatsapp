// src/services/whatsapp/WebhookManager.js

const Utilities = require('./Utilities');

class WebhookManager {
  constructor(session) {
    this.session = session;
    this.sessionId = session.sessionId;
    this.webhooks = session.webhooks || []; // array of { url: string, events: string[] }

    // Configurable defaults
    this.maxRetries = 3;
    this.requestTimeout = 10000; // 10 seconds
    this.defaultHeaders = {
      'Content-Type': 'application/json',
      'X-Webhook-Source': 'chatery-whatsapp-api',
      'X-Session-Id': this.sessionId
    };
  }

  /**
   * Add or update a webhook subscription
   * @param {string} url - Webhook endpoint URL
   * @param {string[]} [events=['all']] - Events to subscribe to ('all' or specific: 'message', 'qr', etc.)
   * @returns {object} Updated session info
   */
  add(url, events = ['all']) {
    if (!Utilities.isValidHttpUrl(url)) {
      throw new Error('Valid HTTP/HTTPS URL is required');
    }

    // Normalize events
    const normalizedEvents = Array.isArray(events) ? events : ['all'];
    if (normalizedEvents.length === 0) {
      normalizedEvents.push('all');
    }

    const exists = this.webhooks.find(w => w.url === url);
    if (exists) {
      exists.events = normalizedEvents;
      console.log(`[${this.sessionId}] Updated webhook events for ${url}: ${normalizedEvents.join(', ')}`);
    } else {
      this.webhooks.push({ url, events: normalizedEvents });
      console.log(`[${this.sessionId}] Added new webhook: ${url} for events ${normalizedEvents.join(', ')}`);
    }

    this.session._saveConfig();
    return this.session.getInfo();
  }

  /**
   * Remove a webhook by URL
   * @param {string} url - Webhook URL to remove
   * @returns {object} Updated session info
   */
  remove(url) {
    const beforeCount = this.webhooks.length;
    this.webhooks = this.webhooks.filter(w => w.url !== url);

    if (this.webhooks.length < beforeCount) {
      console.log(`[${this.sessionId}] Removed webhook: ${url}`);
    } else {
      console.log(`[${this.sessionId}] No webhook found to remove: ${url}`);
    }

    this.session._saveConfig();
    return this.session.getInfo();
  }

  /**
   * List all active webhooks
   * @returns {Array<{ url: string, events: string[] }>}
   */
  list() {
    return [...this.webhooks];
  }

  /**
   * Send event payload to all matching webhooks
   * @param {string} event - Event name (message, qr, connection.update, etc.)
   * @param {Object} data - Event payload
   * @returns {Promise<void>}
   */
  async send(event, data) {
    if (!this.webhooks?.length) return;

    const payload = {
      event,
      sessionId: this.sessionId,
      metadata: this.session.metadata || {},
      data,
      timestamp: new Date().toISOString()
    };

    const deliveryPromises = this.webhooks.map(async (hook) => {
      const events = hook.events || ['all'];
      if (!events.includes('all') && !events.includes(event)) return null;

      let attempts = 0;
      let lastError = null;

      while (attempts < this.maxRetries) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), this.requestTimeout);

          const res = await fetch(hook.url, {
            method: 'POST',
            headers: {
              ...this.defaultHeaders,
              'X-Webhook-Event': event
            },
            body: JSON.stringify(payload),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
          }

          console.debug(`[${this.sessionId}] Webhook delivered to ${hook.url} for event ${event}`);
          return { success: true, url: hook.url };
        } catch (err) {
          attempts++;
          lastError = err.message || 'Unknown error';

          if (attempts < this.maxRetries) {
            const delay = 1000 * Math.pow(2, attempts - 1);
            console.warn(`[${this.sessionId}] Webhook retry ${attempts}/${this.maxRetries} for ${hook.url} in ${delay}ms: ${lastError}`);
            await Utilities.sleep(delay);
          }
        }
      }

      console.error(`[${this.sessionId}] Webhook delivery failed after ${this.maxRetries} attempts to ${hook.url}: ${lastError}`);
      return { success: false, url: hook.url, error: lastError };
    });

    const results = await Promise.allSettled(deliveryPromises);
    // Optional: log summary
    const successes = results.filter(r => r.value?.success).length;
    const failures = results.length - successes;
    if (failures > 0) {
      console.warn(`[${this.sessionId}] Webhook summary: ${successes} succeeded, ${failures} failed`);
    }
  }

  /**
   * Clear all webhooks
   */
  clear() {
    this.webhooks = [];
    this.session._saveConfig();
    console.log(`[${this.sessionId}] All webhooks cleared`);
  }
}

module.exports = WebhookManager;