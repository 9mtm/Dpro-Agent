import { safeConsole } from '../../../src/services/safe-error-log.js';
/**
 * Campaign Manager
 * Auto-dialer for outbound call campaigns (sales, notifications, surveys)
 */

import { getDatabase } from '../../../src/db/index.js';

class CampaignManager {
  constructor() {
    this.db = getDatabase();
    this.activeDialers = new Map(); // Map<campaignId, intervalId>
  }

  /**
   * Create new campaign
   * @param {Object} campaignData - Campaign configuration
   * @returns {Promise<Object>} Created campaign
   */
  async createCampaign(campaignData) {
    try {
      const {
        name,
        call_point_id,
        type,
        message_template,
        agent_id = null,
        start_at = null,
        max_concurrent_calls = 3,
        business_hours_only = true,
        retry_attempts = 2,
        retry_delay_minutes = 30,
        response_mode = 'ivr',
        ivr_options = null,
        created_by = null,
        contacts = []
      } = campaignData;

      // Validate required fields
      if (!name || !call_point_id || !type || !message_template) {
        throw new Error('Missing required fields: name, call_point_id, type, message_template');
      }

      // Generate ID
      const id = `campaign_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Insert campaign
      await this.db.run(
        `INSERT INTO call_campaigns (
          id, name, call_point_id, type, message_template, agent_id,
          status, start_at, max_concurrent_calls, business_hours_only,
          retry_attempts, retry_delay_minutes, response_mode, ivr_options,
          created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          id, name, call_point_id, type, message_template, agent_id,
          start_at, max_concurrent_calls, business_hours_only ? 1 : 0,
          retry_attempts, retry_delay_minutes, response_mode,
          ivr_options ? JSON.stringify(ivr_options) : null,
          created_by
        ]
      );

      // Add contacts if provided
      if (contacts && contacts.length > 0) {
        await this.addContacts(id, contacts);
      }

      // Get created campaign
      const campaign = await this.db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [id]);

      safeConsole.log(`[CampaignManager] Created campaign: ${name} (${id})`);
      return campaign;
    } catch (error) {
      console.error('[CampaignManager] Error creating campaign:', error);
      throw error;
    }
  }

  /**
   * Add contacts to campaign
   * @param {string} campaignId - Campaign ID
   * @param {Array} contacts - Array of contact objects
   * @returns {Promise<number>} Number of contacts added
   */
  async addContacts(campaignId, contacts) {
    try {
      let added = 0;

      for (const contact of contacts) {
        const contactId = `contact_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        await this.db.run(
          `INSERT INTO campaign_contacts (
            id, campaign_id, phone_number, name, email, custom_data,
            status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP)`,
          [
            contactId,
            campaignId,
            contact.phone_number,
            contact.name || null,
            contact.email || null,
            contact.custom_data ? JSON.stringify(contact.custom_data) : null
          ]
        );

        added++;
      }

      safeConsole.log(`[CampaignManager] Added ${added} contacts to campaign ${campaignId}`);
      return added;
    } catch (error) {
      console.error('[CampaignManager] Error adding contacts:', error);
      throw error;
    }
  }

  /**
   * Start campaign (manual or scheduled)
   * @param {string} campaignId - Campaign ID
   * @returns {Promise<boolean>} Success
   */
  async startCampaign(campaignId) {
    try {
      const campaign = await this.db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [campaignId]);

      if (!campaign) {
        throw new Error(`Campaign not found: ${campaignId}`);
      }

      if (campaign.status === 'running') {
        safeConsole.log(`[CampaignManager] Campaign already running: ${campaignId}`);
        return true;
      }

      // Update status
      await this.db.run(
        `UPDATE call_campaigns
         SET status = 'running', started_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [campaignId]
      );

      // Start auto-dialer
      this.runAutoDialer(campaignId);

      safeConsole.log(`[CampaignManager] Started campaign: ${campaign.name} (${campaignId})`);
      return true;
    } catch (error) {
      safeConsole.error('[CampaignManager] Error starting campaign:', error);
      throw error;
    }
  }

  /**
   * Pause campaign
   * @param {string} campaignId - Campaign ID
   * @returns {Promise<boolean>} Success
   */
  async pauseCampaign(campaignId) {
    try {
      await this.db.run(
        `UPDATE call_campaigns SET status = 'paused' WHERE id = ?`,
        [campaignId]
      );

      // Stop auto-dialer
      this.stopAutoDialer(campaignId);

      safeConsole.log(`[CampaignManager] Paused campaign: ${campaignId}`);
      return true;
    } catch (error) {
      console.error('[CampaignManager] Error pausing campaign:', error);
      throw error;
    }
  }

  /**
   * Resume paused campaign
   * @param {string} campaignId - Campaign ID
   * @returns {Promise<boolean>} Success
   */
  async resumeCampaign(campaignId) {
    try {
      await this.db.run(
        `UPDATE call_campaigns SET status = 'running' WHERE id = ?`,
        [campaignId]
      );

      // Restart auto-dialer
      this.runAutoDialer(campaignId);

      safeConsole.log(`[CampaignManager] Resumed campaign: ${campaignId}`);
      return true;
    } catch (error) {
      console.error('[CampaignManager] Error resuming campaign:', error);
      throw error;
    }
  }

  /**
   * Auto-dialer - processes pending contacts in batches
   * @param {string} campaignId - Campaign ID
   */
  async runAutoDialer(campaignId) {
    try {
      // Check if already running
      if (this.activeDialers.has(campaignId)) {
        console.log(`[CampaignManager] Auto-dialer already running for ${campaignId}`);
        return;
      }

      const campaign = await this.db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [campaignId]);

      if (!campaign || campaign.status !== 'running') {
        return;
      }

      console.log(`[CampaignManager] Starting auto-dialer for campaign: ${campaign.name}`);

      // Process contacts every 10 seconds
      const intervalId = setInterval(async () => {
        await this.processBatch(campaignId, campaign.max_concurrent_calls);
      }, 10000);

      this.activeDialers.set(campaignId, intervalId);

      // Initial batch
      await this.processBatch(campaignId, campaign.max_concurrent_calls);
    } catch (error) {
      console.error('[CampaignManager] Error running auto-dialer:', error);
    }
  }

  /**
   * Stop auto-dialer
   * @param {string} campaignId - Campaign ID
   */
  stopAutoDialer(campaignId) {
    const intervalId = this.activeDialers.get(campaignId);
    if (intervalId) {
      clearInterval(intervalId);
      this.activeDialers.delete(campaignId);
      safeConsole.log(`[CampaignManager] Stopped auto-dialer for ${campaignId}`);
    }
  }

  /**
   * Process batch of contacts
   * @param {string} campaignId - Campaign ID
   * @param {number} batchSize - How many calls to make
   */
  async processBatch(campaignId, batchSize) {
    try {
      const campaign = await this.db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [campaignId]);

      if (!campaign || campaign.status !== 'running') {
        this.stopAutoDialer(campaignId);
        return;
      }

      // Get pending contacts (including retries)
      const now = new Date().toISOString();
      const contacts = await this.db.all(
        `SELECT * FROM campaign_contacts
         WHERE campaign_id = ?
           AND status IN ('pending', 'no_answer', 'busy')
           AND call_attempts < ?
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY
           CASE WHEN status = 'pending' THEN 0 ELSE 1 END,
           created_at ASC
         LIMIT ?`,
        [campaignId, campaign.retry_attempts + 1, now, batchSize]
      );

      if (contacts.length === 0) {
        // No more contacts - complete campaign
        await this.db.run(
          `UPDATE call_campaigns
           SET status = 'completed', completed_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [campaignId]
        );
        this.stopAutoDialer(campaignId);
        console.log(`[CampaignManager] Campaign completed: ${campaign.name}`);
        return;
      }

      // Make calls (in parallel)
      console.log(`[CampaignManager] Processing batch of ${contacts.length} contacts for ${campaign.name}`);

      await Promise.all(contacts.map(contact => this.initiateCall(campaign, contact)));
    } catch (error) {
      console.error('[CampaignManager] Error processing batch:', error);
    }
  }

  /**
   * Initiate call to single contact
   * @param {Object} campaign - Campaign object
   * @param {Object} contact - Contact object
   */
  async initiateCall(campaign, contact) {
    try {
      console.log(`[CampaignManager] Calling ${contact.phone_number} (${contact.name || 'Unknown'})`);

      // Update contact status
      await this.db.run(
        `UPDATE campaign_contacts
         SET status = 'calling',
             call_attempts = call_attempts + 1,
             last_call_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [contact.id]
      );

      // NOTE: Actual Twilio call initiation will be in the Twilio service
      // This is a placeholder that marks the contact as ready for calling
      // The actual call will be made by the webhook system

      console.log(`[CampaignManager] Contact ${contact.id} marked for calling`);
    } catch (error) {
      console.error(`[CampaignManager] Error initiating call to ${contact.phone_number}:`, error);

      // Mark as failed
      await this.db.run(
        `UPDATE campaign_contacts
         SET status = 'failed'
         WHERE id = ?`,
        [contact.id]
      );
    }
  }

  /**
   * Update contact result after call
   * @param {string} contactId - Contact ID
   * @param {Object} result - Call result data
   */
  async updateContactResult(contactId, result) {
    try {
      const {
        status,
        call_result = null,
        call_duration_seconds = null,
        notes = null,
        call_session_id = null
      } = result;

      // Calculate next retry time if needed
      let next_retry_at = null;
      if (status === 'no_answer' || status === 'busy') {
        const contact = await this.db.get(`SELECT * FROM campaign_contacts WHERE id = ?`, [contactId]);
        const campaign = await this.db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [contact.campaign_id]);

        if (contact.call_attempts < campaign.retry_attempts) {
          const retryDate = new Date();
          retryDate.setMinutes(retryDate.getMinutes() + campaign.retry_delay_minutes);
          next_retry_at = retryDate.toISOString();
        }
      }

      await this.db.run(
        `UPDATE campaign_contacts
         SET status = ?,
             call_result = ?,
             call_duration_seconds = ?,
             notes = ?,
             call_session_id = ?,
             next_retry_at = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [status, call_result, call_duration_seconds, notes, call_session_id, next_retry_at, contactId]
      );

      safeConsole.log(`[CampaignManager] Updated contact ${contactId}: ${status}${call_result ? ` - ${call_result}` : ''}`);
    } catch (error) {
      console.error('[CampaignManager] Error updating contact result:', error);
      throw error;
    }
  }

  /**
   * Get campaign statistics
   * @param {string} campaignId - Campaign ID
   * @returns {Promise<Object>} Statistics
   */
  async getCampaignStats(campaignId) {
    try {
      const campaign = await this.db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [campaignId]);

      if (!campaign) {
        throw new Error(`Campaign not found: ${campaignId}`);
      }

      const stats = await this.db.get(
        `SELECT
          COUNT(*) as total_contacts,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
          SUM(CASE WHEN status = 'calling' THEN 1 ELSE 0 END) as calling,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN call_result = 'interested' THEN 1 ELSE 0 END) as interested,
          SUM(CASE WHEN call_result = 'not_interested' THEN 1 ELSE 0 END) as not_interested,
          SUM(CASE WHEN call_result = 'requested_callback' THEN 1 ELSE 0 END) as callback_requested,
          AVG(call_duration_seconds) as avg_duration
        FROM campaign_contacts
        WHERE campaign_id = ?`,
        [campaignId]
      );

      const successRate = stats.completed > 0
        ? ((stats.interested + stats.callback_requested) / stats.completed * 100).toFixed(1)
        : 0;

      return {
        campaign,
        stats: {
          ...stats,
          success_rate: parseFloat(successRate),
          progress_percentage: campaign.total_contacts > 0
            ? ((stats.completed / campaign.total_contacts) * 100).toFixed(1)
            : 0
        }
      };
    } catch (error) {
      safeConsole.error('[CampaignManager] Error getting campaign stats:', error);
      throw error;
    }
  }
}

// Singleton instance
let instance = null;

/**
 * Get CampaignManager instance
 * @returns {CampaignManager}
 */
export function getCampaignManager() {
  if (!instance) {
    instance = new CampaignManager();
  }
  return instance;
}

export default CampaignManager;
