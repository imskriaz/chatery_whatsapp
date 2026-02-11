// src/services/whatsapp/ChatManager.js

const Utilities = require('./Utilities');

class ChatManager {
  constructor(session) {
    this.session = session;
    this.socket = session.socket;
    this.sessionId = session.sessionId;
    this.db = session.db;
    this.username = session.username;
  }

  /**
   * Get overview / list of chats (personal + groups)
   * @param {number} [limit=50]
   * @param {number} [offset=0]
   * @param {'all'|'unread'|'archived'|'pinned'} [filter='all']
   * @returns {Promise<{ success: boolean, message: string, data?: any, error?: string }>}
   */
  async getChatsOverview(limit = 50, offset = 0, filter = 'all') {
    try {
      if (!this.db) {
        return { success: false, message: 'Database not initialized' };
      }

      // Basic input validation
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return { success: false, message: 'Limit must be integer between 1 and 200' };
      }
      if (!Number.isInteger(offset) || offset < 0) {
        return { success: false, message: 'Offset must be non-negative integer' };
      }

      const validFilters = ['all', 'unread', 'archived', 'pinned'];
      if (!validFilters.includes(filter)) {
        return { success: false, message: `Invalid filter. Allowed: ${validFilters.join(', ')}` };
      }

      // You should adjust this query to match your actual DB schema
      let query = `
        SELECT 
          co.chat_id, 
          c.name, 
          c.is_group, 
          co.last_message_preview, 
          co.unread_count, 
          c.last_message_timestamp,
          c.archived, 
          c.pinned, 
          c.muted_until
        FROM chats_overview co
        LEFT JOIN chats c 
          ON c.session_id = co.session_id 
          AND c.id = co.chat_id
        WHERE co.session_id = ?
      `;
      const params = [this.sessionId];

      if (filter === 'unread')   query += ` AND co.unread_count > 0`;
      if (filter === 'archived') query += ` AND c.archived = 1`;
      if (filter === 'pinned')   query += ` AND c.pinned = 1`;

      query += ` 
        ORDER BY c.pinned DESC, c.last_message_timestamp DESC 
        LIMIT ? OFFSET ?
      `;
      params.push(limit, offset);

      const rows = await this.db.mysqlQuery(query, params);

      const chats = rows.map(row => ({
        chatId: row.chat_id,
        name: row.name || null,
        isGroup: !!row.is_group,
        lastMessagePreview: row.last_message_preview 
          ? JSON.parse(row.last_message_preview) 
          : null,
        unreadCount: row.unread_count || 0,
        lastMessageTimestamp: row.last_message_timestamp,
        archived: !!row.archived,
        pinned: !!row.pinned,
        mutedUntil: row.muted_until || 0
      }));

      return {
        success: true,
        message: 'Chats overview retrieved',
        data: {
          totalReturned: chats.length,
          limit,
          offset,
          filter,
          chats
        }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] getChatsOverview failed:`, err.message);
      return { success: false, message: 'Failed to get chats overview', error: err.message };
    }
  }

  /**
   * Get detailed info about a single chat (personal or group)
   * @param {string} chatId - phone, group ID or full JID
   */
  async getChatInfo(chatId) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      if (!chatId) {
        return { success: false, message: 'chatId is required' };
      }

      const jid = Utilities.toJid(chatId);
      if (!jid) {
        return { success: false, message: 'Invalid chat ID / phone number' };
      }

      const isGroup = Utilities.isGroupJid(jid);

      let profilePicture = null;
      try {
        profilePicture = await this.socket.profilePictureUrl(jid, 'image');
      } catch (e) {
        // silent fail - no pp or error
      }

      if (isGroup) {
        const metadata = await this.socket.groupMetadata(jid).catch(() => null);
        if (!metadata) {
          return { success: false, message: 'Failed to load group metadata' };
        }

        return {
          success: true,
          message: 'Group info retrieved',
          data: {
            id: jid,
            name: metadata.subject || null,
            isGroup: true,
            profilePicture,
            owner: metadata.owner || null,
            creation: metadata.creation 
              ? new Date(metadata.creation * 1000).toISOString() 
              : null,
            description: metadata.desc || null,
            participantsCount: metadata.participants?.length || 0,
            participants: metadata.participants?.map(p => ({
              id: p.id,
              isAdmin: !!p.admin,
              isSuperAdmin: p.admin === 'superadmin'
            })) || []
          }
        };
      } 

      // Personal chat
      else {
        const phone = jid.split('@')[0];

        let status = null;
        try {
          const st = await this.socket.fetchStatus(jid);
          status = st?.status || null;
        } catch {}

        let isRegistered = false;
        try {
          const [result] = await this.socket.onWhatsApp(phone);
          isRegistered = !!result?.exists;
        } catch {}

        return {
          success: true,
          message: 'Personal chat info retrieved',
          data: {
            id: jid,
            phone,
            isGroup: false,
            profilePicture,
            status,
            isRegistered
          }
        };
      }
    } catch (err) {
      console.error(`[${this.sessionId}] getChatInfo failed:`, err.message);
      return { success: false, message: 'Failed to get chat info', error: err.message };
    }
  }

  /**
   * Mark all unread messages in a chat as read
   * @param {string} chatId
   */
  async markChatRead(chatId) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(chatId);
      if (!jid) {
        return { success: false, message: 'Invalid chat ID' };
      }

      const isGroup = Utilities.isGroupJid(jid);

      // Get recent messages from DB (adjust limit if needed)
      const messages = await this.db.getMessages?.(jid, 200) || [];

      const keysToRead = [];
      for (const msg of messages) {
        if (msg?.key && !msg.key.fromMe && msg.key.id) {
          const key = {
            remoteJid: jid,
            id: msg.key.id
          };
          if (isGroup && msg.key.participant) {
            key.participant = msg.key.participant;
          }
          keysToRead.push(key);
        }
      }

      if (keysToRead.length > 0) {
        await this.socket.readMessages(keysToRead);
      }

      return {
        success: true,
        message: 'Chat marked as read',
        data: {
          chatId: jid,
          isGroup,
          markedCount: keysToRead.length
        }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] markChatRead failed:`, err.message);
      return { success: false, message: 'Failed to mark chat as read', error: err.message };
    }
  }

  /**
   * Archive or unarchive a chat
   * @param {string} chatId
   * @param {boolean} [archive=true]
   */
  async archiveChat(chatId, archive = true) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(chatId);
      if (!jid) {
        return { success: false, message: 'Invalid chat ID' };
      }

      // Baileys archive method (for archive/unarchive)
      await this.socket.sendMessage(jid, { 
        archive: { 
          archived: archive,
          messageTimestamp: Math.floor(Date.now() / 1000)
        }
      });

      // Optional: update local DB overview
      // await this.db.updateChatOverview?.(this.sessionId, jid, { archived: archive ? 1 : 0 });

      return {
        success: true,
        message: archive ? 'Chat archived' : 'Chat unarchived',
        data: { chatId: jid, archived: archive }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] archiveChat failed:`, err.message);
      return { success: false, message: 'Failed to archive/unarchive chat', error: err.message };
    }
  }

  /**
   * Pin or unpin a chat
   * @param {string} chatId
   * @param {boolean} [pin=true]
   */
  async pinChat(chatId, pin = true) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(chatId);
      if (!jid) {
        return { success: false, message: 'Invalid chat ID' };
      }

      await this.socket.pinChat(jid, pin);

      // Optional DB update
      // await this.db.updateChatOverview?.(this.sessionId, jid, { pinned: pin ? 1 : 0 });

      return {
        success: true,
        message: pin ? 'Chat pinned' : 'Chat unpinned',
        data: { chatId: jid, pinned: pin }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] pinChat failed:`, err.message);
      return { success: false, message: 'Failed to pin/unpin chat', error: err.message };
    }
  }

  /**
   * Mute or unmute chat
   * @param {string} chatId
   * @param {number} [durationMs=0] - 0 = unmute, >0 = mute duration in ms
   */
  async muteChat(chatId, durationMs = 0) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(chatId);
      if (!jid) {
        return { success: false, message: 'Invalid chat ID' };
      }

      const muted = durationMs > 0;
      const expiration = muted 
        ? Math.floor((Date.now() + durationMs) / 1000) 
        : null;

      await this.socket.sendMessage(jid, { 
        mute: { 
          muted,
          muteExpiration: expiration
        }
      });

      // Optional DB update
      // await this.db.updateChatOverview?.(this.sessionId, jid, { muted_until: expiration || 0 });

      return {
        success: true,
        message: muted ? 'Chat muted' : 'Chat unmuted',
        data: { 
          chatId: jid, 
          mutedUntil: expiration ? new Date(expiration * 1000).toISOString() : null 
        }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] muteChat failed:`, err.message);
      return { success: false, message: 'Failed to mute/unmute chat', error: err.message };
    }
  }

  /**
   * Clear/delete chat messages (for this device)
   * Note: Baileys currently supports delete-for-me only in most versions
   * @param {string} chatId
   * @param {boolean} [deleteForEveryone=false] - limited support
   */
  async clearChat(chatId, deleteForEveryone = false) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(chatId);
      if (!jid) {
        return { success: false, message: 'Invalid chat ID' };
      }

      // Simple delete-for-me (Baileys method)
      await this.socket.sendMessage(jid, { delete: { remoteJid: jid } });

      // Optional: clean DB messages
      // await this.db.clearChatMessages?.(this.sessionId, jid);

      return {
        success: true,
        message: deleteForEveryone 
          ? 'Attempted to clear chat for everyone (limited support)'
          : 'Chat cleared for this device',
        data: { chatId: jid, deleteForEveryone }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] clearChat failed:`, err.message);
      return { success: false, message: 'Failed to clear chat', error: err.message };
    }
  }
}

module.exports = ChatManager;