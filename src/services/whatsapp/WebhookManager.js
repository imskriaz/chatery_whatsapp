// src/services/whatsapp/WebhookManager.js

class WebhookManager {
  constructor(session) {
    this.session = session;
    this.sessionId = session.sessionId;
    this.webhooks = session.webhooks; // reference to array in parent session
  }

  /**
   * Add or update a webhook URL with specific events
   * @param {string} url - Webhook endpoint URL
   * @param {string[]} [events=['all']] - Events to subscribe ('all' or specific: 'message', 'qr', etc.)
   * @returns {Object} Updated session info
   */
  add(url, events = ['all']) {
    if (!url || typeof url !== 'string' || !url.startsWith('http')) {
      throw new Error('Valid webhook URL is required');
    }

    const exists = this.webhooks.find(w => w.url === url);
    if (exists) {
      exists.events = events;
      console.log(`[${this.sessionId}] Updated webhook events for ${url}: ${events.join(', ')}`);
    } else {
      this.webhooks.push({ url, events });
      console.log(`[${this.sessionId}] Added new webhook: ${url} for events ${events.join(', ')}`);
    }

    this.session._saveConfig();
    return this.session.getInfo();
  }

  /**
   * Remove a webhook by URL
   * @param {string} url - Webhook URL to remove
   * @returns {Object} Updated session info
   */
  remove(url) {
    const before = this.webhooks.length;
    this.webhooks = this.webhooks.filter(w => w.url !== url);

    if (this.webhooks.length < before) {
      console.log(`[${this.sessionId}] Removed webhook: ${url}`);
    } else {
      console.log(`[${this.sessionId}] No webhook found to remove: ${url}`);
    }

    this.session._saveConfig();
    return this.session.getInfo();
  }

  /**
   * Send event payload to all matching webhooks
   * @param {string} event - Event name (message, qr, connection.update, etc.)
   * @param {Object} data - Event payload data
   */
  async send(event, data) {
    if (!this.webhooks?.length) return;

    const payload = {
      event,
      sessionId: this.sessionId,
      metadata: this.session.metadata,
      data,
      timestamp: new Date().toISOString()
    };

    await Promise.allSettled(
      this.webhooks.map(async (hook) => {
        const events = hook.events || ['all'];
        if (!events.includes('all') && !events.includes(event)) return;

        try {
          const res = await fetch(hook.url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Webhook-Source': 'chatery-whatsapp-api',
              'X-Session-Id': this.sessionId,
              'X-Webhook-Event': event
            },
            body: JSON.stringify(payload)
          });

          if (!res.ok) {
            console.warn(`[${this.sessionId}] Webhook delivery failed [${hook.url}]: ${res.status} ${res.statusText}`);
          } else {
            console.debug(`[${this.sessionId}] Webhook sent successfully to ${hook.url} for event ${event}`);
          }
        } catch (err) {
          console.warn(`[${this.sessionId}] Webhook request error [${hook.url}]: ${err.message}`);
        }
      })
    );
  }

  /**
   * Get list of active webhooks (for debugging or admin UI)
   * @returns {Array} Current webhook configurations
   */
  list() {
    return [...this.webhooks];
  }
}

module.exports = WebhookManager;