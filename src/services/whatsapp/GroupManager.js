// src/services/whatsapp/GroupManager.js

class GroupManager {
  constructor(session) {
    this.session = session;
    this.socket = session.socket;
    this.sessionId = session.sessionId;
    this.db = session.db;
    this.username = session.username;
  }

  // ────────────────────────────────────────────────
  // Cached group fetch (shared across methods)
  // ────────────────────────────────────────────────
  async _getCachedGroups(forceRefresh = false) {
    const now = Date.now();

    // Return from cache if valid and not forcing refresh
    if (
      !forceRefresh &&
      this.session._groupCache &&
      this.session._groupCache.expires > now
    ) {
      return this.session._groupCache.data;
    }

    // Safety check: socket must exist and have the required method
    if (!this.socket || typeof this.socket.groupFetchAllParticipating !== 'function') {
      console.warn(
        `[${this.sessionId}] Socket not ready or groupFetchAllParticipating unavailable — returning empty groups`
      );
      return {};
    }

    try {
      const data = await this.socket.groupFetchAllParticipating().catch((err) => {
        console.warn(`[${this.sessionId}] groupFetchAllParticipating failed: ${err.message}`);
        return {};
      });

      // Update cache
      this.session._groupCache = {
        data,
        expires: now + this.session._groupCacheTTL,
      };

      return data;
    } catch (err) {
      console.error(`[${this.sessionId}] Unexpected error in _getCachedGroups: ${err.message}`);
      return {};
    }
  }

  // ────────────────────────────────────────────────
  // Sync group-related data (called from session initial sync)
  // ────────────────────────────────────────────────
  async _syncGroupRelatedData() {
    try {
      // Extra safety: skip entirely if socket is missing
      if (!this.socket) {
        console.warn(`[${this.sessionId}] Socket missing — skipping group sync`);
        return;
      }

      const groups = await this._getCachedGroups();

      for (const group of Object.values(groups)) {
        const jid = group.id;

        // 1. Store basic chat metadata
        if (this.db?.storeChat) {
          await this.db.storeChat(this.sessionId, this.username, jid, group);
        }

        // 2. Store chat overview / list preview
        await this.db.storeChatOverview(this.sessionId, this.username, {
          chat_id: jid,
          last_message_timestamp: group.lastMessageTimestamp || Math.floor(Date.now() / 1000),
          unread_count: group.unreadCount || 0,
          is_pinned: !!group.pin,
          is_archived: !!group.archive,
          is_muted: !!group.mute,
          mute_end: group.muteExpiration || null,
          labels: group.labels || [],
        });

        // 3. Store full group metadata
        await this.db.storeGroupMetadata(this.sessionId, this.username, jid, group);
      }

      console.log(
        `[${this.sessionId}] Synced ${Object.keys(groups).length} groups (chat + overview + metadata)`
      );
    } catch (err) {
      console.warn(`[${this.sessionId}] Group sync failed: ${err.message}`);
    }
  }

  // ────────────────────────────────────────────────
  // Group Creation
  // ────────────────────────────────────────────────
  async createGroup(name, participants) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      if (!name || !Array.isArray(participants) || participants.length === 0) {
        return { success: false, message: 'Group name and at least one participant required' };
      }

      const participantJids = participants.map((p) => this.session.normalizeJid(p));
      const group = await this.socket.groupCreate(name, participantJids);

      return {
        success: true,
        message: 'Group created successfully',
        data: {
          groupId: group.id,
          subject: name,
          participants: participantJids,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      console.error(`[${this.sessionId}] createGroup failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  // ────────────────────────────────────────────────
  // Participant Management
  // ────────────────────────────────────────────────
  async addParticipants(groupId, participants) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const gid = this.session.normalizeJid(groupId, true);
      const participantJids = participants.map((p) => this.session.normalizeJid(p));

      await this.socket.groupParticipantsUpdate(gid, participantJids, 'add');

      return { success: true, message: 'Participants added' };
    } catch (error) {
      console.error(`[${this.sessionId}] addParticipants failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async removeParticipants(groupId, participants) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const gid = this.session.normalizeJid(groupId, true);
      const participantJids = participants.map((p) => this.session.normalizeJid(p));

      await this.socket.groupParticipantsUpdate(gid, participantJids, 'remove');

      return { success: true, message: 'Participants removed' };
    } catch (error) {
      console.error(`[${this.sessionId}] removeParticipants failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async promoteParticipants(groupId, participants) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const gid = this.session.normalizeJid(groupId, true);
      const participantJids = participants.map((p) => this.session.normalizeJid(p));

      await this.socket.groupParticipantsUpdate(gid, participantJids, 'promote');

      return { success: true, message: 'Participants promoted to admin' };
    } catch (error) {
      console.error(`[${this.sessionId}] promoteParticipants failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async demoteParticipants(groupId, participants) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const gid = this.session.normalizeJid(groupId, true);
      const participantJids = participants.map((p) => this.session.normalizeJid(p));

      await this.socket.groupParticipantsUpdate(gid, participantJids, 'demote');

      return { success: true, message: 'Participants demoted' };
    } catch (error) {
      console.error(`[${this.sessionId}] demoteParticipants failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  // ────────────────────────────────────────────────
  // Invite Link Management
  // ────────────────────────────────────────────────
  async joinByInvite(inviteCode) {
    try {
      const code = inviteCode.replace(/^https?:\/\/chat\.whatsapp\.com\//, '');
      const groupId = await this.socket.groupAcceptInvite(code);

      return {
        success: true,
        message: 'Joined group successfully',
        data: { groupId, inviteCode: code },
      };
    } catch (error) {
      console.error(`[${this.sessionId}] joinByInvite failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async getInviteCode(groupId) {
    try {
      const gid = this.session.normalizeJid(groupId, true);
      const code = await this.socket.groupInviteCode(gid);

      return {
        success: true,
        message: 'Invite code retrieved',
        data: {
          groupId: gid,
          inviteCode: code,
          inviteLink: `https://chat.whatsapp.com/${code}`,
        },
      };
    } catch (error) {
      console.error(`[${this.sessionId}] getInviteCode failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async revokeInvite(groupId) {
    try {
      const gid = this.session.normalizeJid(groupId, true);
      const newCode = await this.socket.groupRevokeInvite(gid);

      return {
        success: true,
        message: 'Invite code revoked and new one generated',
        data: {
          groupId: gid,
          newInviteCode: newCode,
          newInviteLink: `https://chat.whatsapp.com/${newCode}`,
        },
      };
    } catch (error) {
      console.error(`[${this.sessionId}] revokeInvite failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  // ────────────────────────────────────────────────
  // Group Info Retrieval
  // ────────────────────────────────────────────────
  async getAllGroups(refresh = false) {
    try {
      const groups = await this._getCachedGroups(refresh);
      const list = Object.values(groups).map((g) => ({
        id: g.id,
        subject: g.subject,
        subjectOwner: g.subjectOwner,
        subjectTime: g.subjectTime,
        desc: g.desc,
        descId: g.descId,
        restrict: g.restrict,
        announce: g.announce,
        isViewOnce: g.isViewOnce,
        size: g.size,
        participantsCount: g.participants?.length || 0,
        creation: g.creation,
        owner: g.owner,
      }));

      return {
        success: true,
        message: 'Groups retrieved',
        data: { count: list.length, groups: list },
      };
    } catch (error) {
      console.error(`[${this.sessionId}] getAllGroups failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async getMetadata(groupId) {
    try {
      const gid = this.session.normalizeJid(groupId, true);

      if (!this.socket || typeof this.socket.groupMetadata !== 'function') {
        return { success: false, message: 'Socket not ready for group metadata' };
      }

      const metadata = await this.socket.groupMetadata(gid);

      return {
        success: true,
        message: 'Group metadata retrieved',
        data: {
          id: metadata.id,
          subject: metadata.subject,
          subjectOwner: metadata.subjectOwner,
          subjectTime: metadata.subjectTime,
          desc: metadata.desc,
          descId: metadata.descId,
          restrict: metadata.restrict,
          announce: metadata.announce,
          isViewOnce: metadata.isViewOnce,
          size: metadata.size,
          participants: metadata.participants?.map((p) => ({
            id: p.id,
            admin: p.admin || null,
            isSuperAdmin: p.admin === 'superadmin',
          })),
          creation: metadata.creation,
          owner: metadata.owner,
        },
      };
    } catch (error) {
      console.error(`[${this.sessionId}] getMetadata failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  // ────────────────────────────────────────────────
  // Group Settings
  // ────────────────────────────────────────────────
  async updateSettings(groupId, settings) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const gid = this.session.normalizeJid(groupId, true);

      // Example settings: { announce: true, restrict: false, slowmode: 3600 }
      const promises = [];

      if ('announce' in settings) {
        promises.push(
          this.socket.groupSettingUpdate(gid, settings.announce ? 'announcement' : 'not_announcement')
        );
      }

      if ('restrict' in settings) {
        promises.push(
          this.socket.groupSettingUpdate(gid, settings.restrict ? 'locked' : 'unlocked')
        );
      }

      await Promise.all(promises);

      return { success: true, message: 'Group settings updated' };
    } catch (error) {
      console.error(`[${this.sessionId}] updateSettings failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async updateSubject(groupId, newSubject) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const gid = this.session.normalizeJid(groupId, true);
      await this.socket.groupUpdateSubject(gid, newSubject);

      return { success: true, message: 'Group subject updated' };
    } catch (error) {
      console.error(`[${this.sessionId}] updateSubject failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async updateDescription(groupId, newDesc) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const gid = this.session.normalizeJid(groupId, true);
      await this.socket.groupUpdateDescription(gid, newDesc);

      return { success: true, message: 'Group description updated' };
    } catch (error) {
      console.error(`[${this.sessionId}] updateDescription failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }

  async leave(groupId) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const gid = this.session.normalizeJid(groupId, true);
      await this.socket.groupLeave(gid);

      return { success: true, message: 'Left the group' };
    } catch (error) {
      console.error(`[${this.sessionId}] leave failed: ${error.message}`);
      return { success: false, message: error.message };
    }
  }
}

module.exports = GroupManager;