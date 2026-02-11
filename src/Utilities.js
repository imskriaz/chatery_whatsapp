const path = require('path');
const fs = require('fs');

class Utilities {
  /**
   * Normalize phone number to international format (without @s.whatsapp.net)
   * Handles Indonesian 0 → 62 conversion, removes non-digits
   * @param {string} input
   * @returns {{ valid: boolean, normalized: string|null, error?: string }}
   */
  static normalizePhoneNumber(input) {
    if (!input || typeof input !== 'string') {
      return { valid: false, normalized: null, error: 'Phone must be a non-empty string' };
    }

    let cleaned = input.replace(/\D/g, '');

    if (cleaned.length === 0) {
      return { valid: false, normalized: null, error: 'No valid digits found' };
    }

    if (cleaned.startsWith('0')) {
      cleaned = '62' + cleaned.substring(1);
    } else if (cleaned.startsWith('8') && cleaned.length >= 10) {
      cleaned = '62' + cleaned;
    }

    if (cleaned.length < 9 || cleaned.length > 15) {
      return { valid: false, normalized: null, error: 'Phone number must have 9–15 digits after normalization' };
    }

    return { valid: true, normalized: cleaned, error: null };
  }

  /**
   * Convert phone / ID to full WhatsApp JID
   * @param {string} input
   * @param {boolean} [preferGroup=false]
   * @returns {string|null}
   */
  static toJid(input, preferGroup = false) {
    if (!input) return null;

    if (input.includes('@')) return input;

    const norm = Utilities.normalizePhoneNumber(input);
    if (!norm.valid) return null;

    return norm.normalized + (preferGroup ? '@g.us' : '@s.whatsapp.net');
  }

  /**
   * Check if string is a group JID
   * @param {string} jid
   * @returns {boolean}
   */
  static isGroupJid(jid) {
    return typeof jid === 'string' && jid.endsWith('@g.us');
  }

  /**
   * Validate full WhatsApp JID
   * @param {string} jid
   * @returns {{ valid: boolean, error?: string }}
   */
  static validateJid(jid) {
    if (!jid || typeof jid !== 'string') {
      return { valid: false, error: 'JID must be a non-empty string' };
    }

    if (!jid.includes('@')) {
      return { valid: false, error: 'JID must contain @ symbol' };
    }

    const [numberPart, domain] = jid.split('@');
    if (!['s.whatsapp.net', 'g.us', 'c.us'].includes(domain)) {
      return { valid: false, error: 'Invalid JID domain (expected: s.whatsapp.net, g.us, c.us)' };
    }

    const digits = numberPart.replace(/\D/g, '');
    if (digits.length < 9 || digits.length > 15) {
      return { valid: false, error: 'Invalid phone part in JID (9–15 digits expected)' };
    }

    return { valid: true, error: null };
  }

  /**
   * Validate array of phones / JIDs (for participants, bulk send, etc.)
   * @param {string[]} items
   * @param {boolean} [allowGroups=false]
   * @returns {{ valid: boolean, normalized: string[], invalid: string[], error?: string }}
   */
  static validatePhoneList(items, allowGroups = false) {
    if (!Array.isArray(items) || items.length === 0) {
      return { valid: false, normalized: [], invalid: [], error: 'Must provide non-empty array of phones/JIDs' };
    }

    const normalized = [];
    const invalid = [];

    for (const item of items) {
      if (allowGroups) {
        const jidCheck = Utilities.validateJid(item);
        if (jidCheck.valid) {
          normalized.push(item);
          continue;
        }
      }

      const phoneCheck = Utilities.normalizePhoneNumber(item);
      if (phoneCheck.valid) {
        normalized.push(phoneCheck.normalized + '@s.whatsapp.net');
      } else {
        invalid.push(item);
      }
    }

    if (invalid.length > 0) {
      return {
        valid: false,
        normalized,
        invalid,
        error: `Invalid entries: ${invalid.join(', ')}`
      };
    }

    return { valid: true, normalized, invalid: [], error: null };
  }

  /**
   * Validate group name (for creation/update)
   * @param {string} name
   * @returns {{ valid: boolean, error?: string }}
   */
  static validateGroupName(name) {
    if (!name || typeof name !== 'string') {
      return { valid: false, error: 'Group name must be a non-empty string' };
    }

    const trimmed = name.trim();
    if (trimmed.length < 3) {
      return { valid: false, error: 'Group name must be at least 3 characters' };
    }
    if (trimmed.length > 100) {
      return { valid: false, error: 'Group name cannot exceed 100 characters' };
    }

    if (/[<>{}[\]()$%#@^*]/.test(trimmed)) {
      return { valid: false, error: 'Group name contains invalid characters' };
    }

    return { valid: true, error: null };
  }

  /**
   * Normalize Baileys timestamp (number or {low, high})
   * @param {number|object} ts
   * @returns {number}
   */
  static formatTimestamp(ts) {
    if (typeof ts === 'number') return ts;
    if (ts && typeof ts === 'object' && 'low' in ts) return ts.low;
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Guess mimetype from Baileys content type
   * @param {string} contentType
   * @returns {string}
   */
  static guessMimeType(contentType) {
    const map = {
      imageMessage: 'image/jpeg',
      videoMessage: 'video/mp4',
      audioMessage: 'audio/ogg; codecs=opus',
      documentMessage: 'application/octet-stream',
      stickerMessage: 'image/webp'
    };
    return map[contentType] || 'application/octet-stream';
  }

  /**
   * Guess file extension from mimetype
   * @param {string} mimetype
   * @returns {string}
   */
  static guessExtension(mimetype) {
    const map = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'video/mp4': 'mp4', 'video/3gpp': '3gp',
      'audio/ogg': 'ogg', 'audio/ogg; codecs=opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
      'application/pdf': 'pdf'
    };
    return map[mimetype] || mimetype.split('/')[1]?.split(';')[0] || 'bin';
  }

  /**
   * Save media buffer to disk and return public URL path
   * @param {Buffer} buffer
   * @param {string} sessionId
   * @param {string} chatIdClean
   * @param {string} filename
   * @param {string} mediaFolder
   * @returns {string} public path
   */
  static saveMediaToDisk(buffer, sessionId, chatIdClean, filename, mediaFolder) {
    const dir = path.join(mediaFolder, chatIdClean);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const fullPath = path.join(dir, filename);
    fs.writeFileSync(fullPath, buffer);

    return `/media/${sessionId}/${chatIdClean}/${filename}`;
  }

  /**
   * Validate HTTP/HTTPS URL
   * @param {string} url
   * @returns {boolean}
   */
  static isValidHttpUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  /**
   * Generate unique bulk job ID
   * @returns {string}
   */
  static generateJobId() {
    return `bulk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Simple sleep/delay helper (returns Promise)
   * @param {number} ms
   * @returns {Promise<void>}
   */
  static sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Generate random delay between min and max milliseconds
   * @param {number} minMs
   * @param {number} maxMs
   * @returns {Promise<void>}
   */
  static async randomDelay(minMs = 800, maxMs = 2200) {
    const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    return Utilities.sleep(delay);
  }
}

module.exports = Utilities;