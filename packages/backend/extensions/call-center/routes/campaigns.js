import { safeConsole } from '../../../src/services/safe-error-log.js';
/**
 * Campaign Management API Routes
 * CRUD operations + auto-dialer control
 */

import { Router } from 'express';
import { getDatabase } from '../../../src/db/index.js';
import { getCampaignManager } from '../services/campaign-manager.js';

const router = Router();

/**
 * GET /api/ext/call-center/campaigns
 * List all campaigns (with filters)
 */
router.get('/', async (req, res) => {
  try {
    const db = getDatabase();
    const { call_point_id, status, type } = req.query;

    let query = `SELECT * FROM call_campaigns WHERE 1=1`;
    const params = [];

    if (call_point_id) {
      query += ` AND call_point_id = ?`;
      params.push(call_point_id);
    }

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    if (type) {
      query += ` AND type = ?`;
      params.push(type);
    }

    query += ` ORDER BY created_at DESC`;

    const campaigns = await db.all(query, params);

    res.json({
      campaigns: campaigns.map(c => ({
        ...c,
        business_hours_only: c.business_hours_only === 1,
        ivr_options: c.ivr_options ? JSON.parse(c.ivr_options) : null
      }))
    });
  } catch (error) {
    console.error('[Campaigns API] Error listing campaigns:', error);
    res.status(500).json({ error: 'Failed to list campaigns' });
  }
});

/**
 * GET /api/ext/call-center/campaigns/:id
 * Get single campaign with statistics
 */
router.get('/:id', async (req, res) => {
  try {
    const campaignManager = getCampaignManager();
    const { id } = req.params;

    const result = await campaignManager.getCampaignStats(id);

    res.json({
      campaign: {
        ...result.campaign,
        business_hours_only: result.campaign.business_hours_only === 1,
        ivr_options: result.campaign.ivr_options ? JSON.parse(result.campaign.ivr_options) : null
      },
      stats: result.stats
    });
  } catch (error) {
    safeConsole.error('[Campaigns API] Error getting campaign:', error);
    res.status(500).json({ error: 'Failed to get campaign' });
  }
});

/**
 * POST /api/ext/call-center/campaigns
 * Create new campaign
 */
router.post('/', async (req, res) => {
  try {
    const campaignManager = getCampaignManager();

    const campaign = await campaignManager.createCampaign(req.body);

    res.status(201).json({
      campaign: {
        ...campaign,
        business_hours_only: campaign.business_hours_only === 1,
        ivr_options: campaign.ivr_options ? JSON.parse(campaign.ivr_options) : null
      }
    });
  } catch (error) {
    console.error('[Campaigns API] Error creating campaign:', error);
    res.status(500).json({ error: error.message || 'Failed to create campaign' });
  }
});

/**
 * PUT /api/ext/call-center/campaigns/:id
 * Update campaign (only if not running)
 */
router.put('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;

    // Check if campaign exists
    const existing = await db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [id]);

    if (!existing) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (existing.status === 'running') {
      return res.status(400).json({ error: 'Cannot modify running campaign. Pause it first.' });
    }

    const {
      name,
      message_template,
      agent_id,
      start_at,
      max_concurrent_calls,
      business_hours_only,
      retry_attempts,
      retry_delay_minutes,
      response_mode,
      ivr_options
    } = req.body;

    await db.run(
      `UPDATE call_campaigns SET
        name = COALESCE(?, name),
        message_template = COALESCE(?, message_template),
        agent_id = COALESCE(?, agent_id),
        start_at = COALESCE(?, start_at),
        max_concurrent_calls = COALESCE(?, max_concurrent_calls),
        business_hours_only = COALESCE(?, business_hours_only),
        retry_attempts = COALESCE(?, retry_attempts),
        retry_delay_minutes = COALESCE(?, retry_delay_minutes),
        response_mode = COALESCE(?, response_mode),
        ivr_options = COALESCE(?, ivr_options)
      WHERE id = ?`,
      [
        name || null,
        message_template || null,
        agent_id || null,
        start_at || null,
        max_concurrent_calls !== undefined ? max_concurrent_calls : null,
        business_hours_only !== undefined ? (business_hours_only ? 1 : 0) : null,
        retry_attempts !== undefined ? retry_attempts : null,
        retry_delay_minutes !== undefined ? retry_delay_minutes : null,
        response_mode || null,
        ivr_options ? JSON.stringify(ivr_options) : null,
        id
      ]
    );

    // Return updated campaign
    const updated = await db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [id]);

    res.json({
      campaign: {
        ...updated,
        business_hours_only: updated.business_hours_only === 1,
        ivr_options: updated.ivr_options ? JSON.parse(updated.ivr_options) : null
      }
    });
  } catch (error) {
    console.error('[Campaigns API] Error updating campaign:', error);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

/**
 * DELETE /api/ext/call-center/campaigns/:id
 * Delete campaign (only if not running)
 */
router.delete('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;

    // Check if campaign exists
    const existing = await db.get(`SELECT * FROM call_campaigns WHERE id = ?`, [id]);

    if (!existing) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (existing.status === 'running') {
      return res.status(400).json({ error: 'Cannot delete running campaign. Stop it first.' });
    }

    await db.run(`DELETE FROM call_campaigns WHERE id = ?`, [id]);

    res.json({ success: true, message: 'Campaign deleted' });
  } catch (error) {
    console.error('[Campaigns API] Error deleting campaign:', error);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

/**
 * POST /api/ext/call-center/campaigns/:id/contacts
 * Add contacts to campaign
 */
router.post('/:id/contacts', async (req, res) => {
  try {
    const campaignManager = getCampaignManager();
    const { id } = req.params;
    const { contacts } = req.body;

    if (!contacts || !Array.isArray(contacts)) {
      return res.status(400).json({ error: 'contacts array is required' });
    }

    const added = await campaignManager.addContacts(id, contacts);

    res.status(201).json({
      success: true,
      added,
      message: `Added ${added} contacts to campaign`
    });
  } catch (error) {
    console.error('[Campaigns API] Error adding contacts:', error);
    res.status(500).json({ error: 'Failed to add contacts' });
  }
});

/**
 * GET /api/ext/call-center/campaigns/:id/contacts
 * List campaign contacts
 */
router.get('/:id/contacts', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;
    const { status, call_result, limit = 100, offset = 0 } = req.query;

    let query = `SELECT * FROM campaign_contacts WHERE campaign_id = ?`;
    const params = [id];

    if (status) {
      query += ` AND status = ?`;
      params.push(status);
    }

    if (call_result) {
      query += ` AND call_result = ?`;
      params.push(call_result);
    }

    query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(parseInt(limit), parseInt(offset));

    const contacts = await db.all(query, params);

    res.json({
      contacts: contacts.map(c => ({
        ...c,
        custom_data: c.custom_data ? JSON.parse(c.custom_data) : null
      }))
    });
  } catch (error) {
    console.error('[Campaigns API] Error listing contacts:', error);
    res.status(500).json({ error: 'Failed to list contacts' });
  }
});

/**
 * POST /api/ext/call-center/campaigns/:id/start
 * Start campaign
 */
router.post('/:id/start', async (req, res) => {
  try {
    const campaignManager = getCampaignManager();
    const { id } = req.params;

    await campaignManager.startCampaign(id);

    res.json({
      success: true,
      message: 'Campaign started'
    });
  } catch (error) {
    safeConsole.error('[Campaigns API] Error starting campaign:', error);
    res.status(500).json({ error: error.message || 'Failed to start campaign' });
  }
});

/**
 * POST /api/ext/call-center/campaigns/:id/pause
 * Pause campaign
 */
router.post('/:id/pause', async (req, res) => {
  try {
    const campaignManager = getCampaignManager();
    const { id } = req.params;

    await campaignManager.pauseCampaign(id);

    res.json({
      success: true,
      message: 'Campaign paused'
    });
  } catch (error) {
    console.error('[Campaigns API] Error pausing campaign:', error);
    res.status(500).json({ error: 'Failed to pause campaign' });
  }
});

/**
 * POST /api/ext/call-center/campaigns/:id/resume
 * Resume paused campaign
 */
router.post('/:id/resume', async (req, res) => {
  try {
    const campaignManager = getCampaignManager();
    const { id } = req.params;

    await campaignManager.resumeCampaign(id);

    res.json({
      success: true,
      message: 'Campaign resumed'
    });
  } catch (error) {
    console.error('[Campaigns API] Error resuming campaign:', error);
    res.status(500).json({ error: 'Failed to resume campaign' });
  }
});

/**
 * GET /api/ext/call-center/campaigns/:id/analytics
 * Get campaign analytics
 */
router.get('/:id/analytics', async (req, res) => {
  try {
    const db = getDatabase();
    const { id } = req.params;
    const { days = 7 } = req.query;

    // Daily breakdown
    const daily = await db.all(
      `SELECT * FROM campaign_analytics
       WHERE campaign_id = ?
       ORDER BY date DESC
       LIMIT ?`,
      [id, parseInt(days)]
    );

    // Overall stats
    const overall = await db.get(
      `SELECT
        SUM(total_calls) as total_calls,
        SUM(answered_calls) as answered_calls,
        SUM(interested_count) as interested_count,
        SUM(not_interested_count) as not_interested_count,
        SUM(callback_requested) as callback_requested,
        SUM(total_cost) as total_cost,
        AVG(success_rate) as avg_success_rate,
        AVG(interest_rate) as avg_interest_rate
      FROM campaign_analytics
      WHERE campaign_id = ?`,
      [id]
    );

    res.json({
      daily,
      overall: {
        ...overall,
        avg_success_rate: overall.avg_success_rate ? parseFloat(overall.avg_success_rate.toFixed(2)) : 0,
        avg_interest_rate: overall.avg_interest_rate ? parseFloat(overall.avg_interest_rate.toFixed(2)) : 0,
        total_cost: overall.total_cost ? parseFloat(overall.total_cost.toFixed(2)) : 0
      }
    });
  } catch (error) {
    console.error('[Campaigns API] Error getting analytics:', error);
    res.status(500).json({ error: 'Failed to get analytics' });
  }
});

export default router;
