// src/services/whatsapp/GroupManager.js

const Utilities = require('./Utilities');

class GroupManager {
  constructor(session) {
    this.session = session;
    this.socket = session.socket;
    this.sessionId = session.sessionId;
    this.db = session.db;
    this.username = session.username;
  }

  /**
   * Create a new WhatsApp group
   * @param {string} name - Group subject (3–100 chars recommended)
   * @param {string[]} participants - Array of phone numbers or JIDs
   * @returns {Promise<{ success: boolean, message: string, data?: any, error?: string }>}
   */
  async createGroup(name, participants) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      // Validate group name
      const nameCheck = Utilities.validateGroupName(name);
      if (!nameCheck.valid) {
        return { success: false, message: nameCheck.error };
      }

      // Validate participants
      const listCheck = Utilities.validatePhoneList(participants);
      if (!listCheck.valid) {
        return { success: false, message: listCheck.error };
      }

      if (listCheck.normalized.length === 0) {
        return { success: false, message: 'At least one valid participant required' };
      }

      const group = await this.socket.groupCreate(name, listCheck.normalized);

      return {
        success: true,
        message: 'Group created successfully',
        data: {
          groupId: group.id,
          subject: name,
          participants: listCheck.normalized,
          creationTime: new Date().toISOString()
        }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] createGroup failed:`, err.message);
      return { success: false, message: 'Failed to create group', error: err.message };
    }
  }

  /**
   * Get all groups where this account is a participant
   * @returns {Promise<{ success: boolean, message: string, data?: any }>}
   */
  async getAllGroups() {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const groups = await this.socket.groupFetchAllParticipating();

      const formatted = Object.values(groups).map(g => ({
        id: g.id,
        subject: g.subject || null,
        subjectOwner: g.subjectOwner || null,
        subjectTime: g.subjectTime ? new Date(g.subjectTime * 1000).toISOString() : null,
        desc: g.desc || null,
        size: g.size || 0,
        creation: g.creation ? new Date(g.creation * 1000).toISOString() : null,
        owner: g.owner || null,
        participantsCount: g.participants?.length || 0
      }));

      return {
        success: true,
        message: 'Groups retrieved',
        data: {
          count: formatted.length,
          groups: formatted
        }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] getAllGroups failed:`, err.message);
      return { success: false, message: 'Failed to fetch groups', error: err.message };
    }
  }

  /**
   * Get detailed metadata for a specific group
   * @param {string} groupId - Group JID or short ID
   * @returns {Promise<{ success: boolean, message: string, data?: any }>}
   */
  async getGroupMetadata(groupId) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jidCheck = Utilities.validateJid(groupId);
      if (!jidCheck.valid && !Utilities.isGroupJid(groupId)) {
        const normalized = Utilities.toJid(groupId, true);
        if (!normalized) {
          return { success: false, message: 'Invalid group ID' };
        }
        groupId = normalized;
      }

      const metadata = await this.socket.groupMetadata(groupId);

      return {
        success: true,
        message: 'Group metadata retrieved',
        data: {
          id: metadata.id,
          subject: metadata.subject,
          subjectOwner: metadata.subjectOwner,
          subjectTime: metadata.subjectTime ? new Date(metadata.subjectTime * 1000).toISOString() : null,
          desc: metadata.desc,
          descId: metadata.descId,
          restrict: metadata.restrict,
          announce: metadata.announce,
          size: metadata.size,
          creation: metadata.creation ? new Date(metadata.creation * 1000).toISOString() : null,
          owner: metadata.owner,
          participants: metadata.participants?.map(p => ({
            id: p.id,
            admin: p.admin || null,
            isSuperAdmin: p.admin === 'superadmin'
          })) || []
        }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] getGroupMetadata failed:`, err.message);
      return { success: false, message: 'Failed to get group metadata', error: err.message };
    }
  }

  /**
   * Add participants to a group
   * @param {string} groupId
   * @param {string[]} participants - phones or JIDs
   */
  async addParticipants(groupId, participants) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      const listCheck = Utilities.validatePhoneList(participants);
      if (!listCheck.valid) {
        return { success: false, message: listCheck.error };
      }

      const result = await this.socket.groupParticipantsUpdate(
        jid,
        listCheck.normalized,
        'add'
      );

      return {
        success: true,
        message: 'Participants added',
        data: { groupId: jid, results: result }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] addParticipants failed:`, err.message);
      return { success: false, message: 'Failed to add participants', error: err.message };
    }
  }

  /**
   * Remove participants from a group
   * @param {string} groupId
   * @param {string[]} participants
   */
  async removeParticipants(groupId, participants) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      const listCheck = Utilities.validatePhoneList(participants);
      if (!listCheck.valid) {
        return { success: false, message: listCheck.error };
      }

      const result = await this.socket.groupParticipantsUpdate(
        jid,
        listCheck.normalized,
        'remove'
      );

      return {
        success: true,
        message: 'Participants removed',
        data: { groupId: jid, results: result }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] removeParticipants failed:`, err.message);
      return { success: false, message: 'Failed to remove participants', error: err.message };
    }
  }

  /**
   * Promote participants to admin
   * @param {string} groupId
   * @param {string[]} participants
   */
  async promoteParticipants(groupId, participants) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      const listCheck = Utilities.validatePhoneList(participants);
      if (!listCheck.valid) {
        return { success: false, message: listCheck.error };
      }

      const result = await this.socket.groupParticipantsUpdate(
        jid,
        listCheck.normalized,
        'promote'
      );

      return {
        success: true,
        message: 'Participants promoted',
        data: { groupId: jid, results: result }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] promoteParticipants failed:`, err.message);
      return { success: false, message: 'Failed to promote participants', error: err.message };
    }
  }

  /**
   * Demote admins to regular members
   * @param {string} groupId
   * @param {string[]} participants
   */
  async demoteParticipants(groupId, participants) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      const listCheck = Utilities.validatePhoneList(participants);
      if (!listCheck.valid) {
        return { success: false, message: listCheck.error };
      }

      const result = await this.socket.groupParticipantsUpdate(
        jid,
        listCheck.normalized,
        'demote'
      );

      return {
        success: true,
        message: 'Participants demoted',
        data: { groupId: jid, results: result }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] demoteParticipants failed:`, err.message);
      return { success: false, message: 'Failed to demote participants', error: err.message };
    }
  }

  /**
   * Update group subject (name)
   * @param {string} groupId
   * @param {string} subject
   */
  async updateSubject(groupId, subject) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const nameCheck = Utilities.validateGroupName(subject);
      if (!nameCheck.valid) {
        return { success: false, message: nameCheck.error };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      await this.socket.groupUpdateSubject(jid, subject);

      return {
        success: true,
        message: 'Group subject updated',
        data: { groupId: jid, subject }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] updateSubject failed:`, err.message);
      return { success: false, message: 'Failed to update subject', error: err.message };
    }
  }

  /**
   * Update group description
   * @param {string} groupId
   * @param {string} description
   */
  async updateDescription(groupId, description) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      await this.socket.groupUpdateDescription(jid, description || '');

      return {
        success: true,
        message: 'Group description updated',
        data: { groupId: jid, description: description || '' }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] updateDescription failed:`, err.message);
      return { success: false, message: 'Failed to update description', error: err.message };
    }
  }

  /**
   * Update group settings (announcement / locked)
   * @param {string} groupId
   * @param {'announcement'|'not_announcement'|'locked'|'unlocked'} setting
   */
  async updateSettings(groupId, setting) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const validSettings = ['announcement', 'not_announcement', 'locked', 'unlocked'];
      if (!validSettings.includes(setting)) {
        return { success: false, message: `Invalid setting. Allowed: ${validSettings.join(', ')}` };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      await this.socket.groupSettingUpdate(jid, setting);

      return {
        success: true,
        message: 'Group settings updated',
        data: { groupId: jid, setting }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] updateSettings failed:`, err.message);
      return { success: false, message: 'Failed to update settings', error: err.message };
    }
  }

  /**
   * Update group profile picture
   * @param {string} groupId
   * @param {string} imageUrl - public URL to image
   */
  async updateProfilePicture(groupId, imageUrl) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      if (!Utilities.isValidHttpUrl(imageUrl)) {
        return { success: false, message: 'Invalid image URL' };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      await this.socket.updateProfilePicture(jid, { url: imageUrl });

      return {
        success: true,
        message: 'Group profile picture updated',
        data: { groupId: jid }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] updateProfilePicture failed:`, err.message);
      return { success: false, message: 'Failed to update profile picture', error: err.message };
    }
  }

  /**
   * Leave a group
   * @param {string} groupId
   */
  async leaveGroup(groupId) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      await this.socket.groupLeave(jid);

      return {
        success: true,
        message: 'Left group successfully',
        data: { groupId: jid }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] leaveGroup failed:`, err.message);
      return { success: false, message: 'Failed to leave group', error: err.message };
    }
  }

  /**
   * Join group via invite code/link
   * @param {string} inviteCode - code or full chat.whatsapp.com/... link
   */
  async joinByInvite(inviteCode) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      let code = inviteCode;
      if (inviteCode.includes('chat.whatsapp.com/')) {
        code = inviteCode.split('chat.whatsapp.com/')[1];
      }

      if (!code || code.length < 10) {
        return { success: false, message: 'Invalid invite code' };
      }

      const groupId = await this.socket.groupAcceptInvite(code);

      return {
        success: true,
        message: 'Joined group successfully',
        data: { groupId, inviteCode: code }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] joinByInvite failed:`, err.message);
      return { success: false, message: 'Failed to join group', error: err.message };
    }
  }

  /**
   * Get current invite code for a group
   * @param {string} groupId
   */
  async getInviteCode(groupId) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      const code = await this.socket.groupInviteCode(jid);

      return {
        success: true,
        message: 'Invite code retrieved',
        data: {
          groupId: jid,
          inviteCode: code,
          inviteLink: `https://chat.whatsapp.com/${code}`
        }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] getInviteCode failed:`, err.message);
      return { success: false, message: 'Failed to get invite code', error: err.message };
    }
  }

  /**
   * Revoke current invite code and generate new one
   * @param {string} groupId
   */
  async revokeInvite(groupId) {
    try {
      if (!this.socket || this.session.connectionStatus !== 'connected') {
        return { success: false, message: 'Session not connected' };
      }

      const jid = Utilities.toJid(groupId, true);
      if (!jid || !Utilities.isGroupJid(jid)) {
        return { success: false, message: 'Invalid group JID' };
      }

      const newCode = await this.socket.groupRevokeInvite(jid);

      return {
        success: true,
        message: 'Invite code revoked and new one generated',
        data: {
          groupId: jid,
          newInviteCode: newCode,
          newInviteLink: `https://chat.whatsapp.com/${newCode}`
        }
      };
    } catch (err) {
      console.error(`[${this.sessionId}] revokeInvite failed:`, err.message);
      return { success: false, message: 'Failed to revoke invite', error: err.message };
    }
  }
}

module.exports = GroupManager;