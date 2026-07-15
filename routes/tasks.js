const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/auth');

// Fixed earner payouts per completed video view, matching the platform's rate card.
const VIDEO_EARNER_RATES = { UGX: 26, KES: 0.9, TZS: 18, RWF: 9, ZAR: 0.13 };
const BANNER_PUBLISHER_SPLIT = 0.6;
const SOCIAL_INFLUENCER_SPLIT = 0.65;

function requireEarner(req, res, next) {
    if (req.user.role !== 'earner') {
        return res.status(403).json({ error: 'Only earner accounts can complete tasks.' });
    }
    next();
}

// ---- Video ads: frontend calls this after a secure, non-skippable 30s watch loop ----
router.post('/verify-video', auth, requireEarner, async (req, res) => {
    const { campaignId } = req.body;
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const campaignResult = await client.query(
            `SELECT * FROM campaigns WHERE id = $1 AND campaign_type = 'video_cpv' AND status = 'active' FOR UPDATE`,
            [campaignId]
        );
        if (!campaignResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'This campaign is no longer available.' });
        }
        const campaign = campaignResult.rows[0];

        if (Number(campaign.remaining_budget) < Number(campaign.unit_cost)) {
            await client.query(`UPDATE campaigns SET status = 'completed' WHERE id = $1`, [campaignId]);
            await client.query('COMMIT');
            return res.status(400).json({ error: 'Campaign budget has been exhausted.' });
        }

        const earnerAmount = VIDEO_EARNER_RATES[campaign.currency];
        const newRemaining = Number(campaign.remaining_budget) - Number(campaign.unit_cost);

        await client.query(
            `UPDATE campaigns SET remaining_budget = $1, status = $2 WHERE id = $3`,
            [newRemaining, newRemaining <= 0 ? 'completed' : 'active', campaignId]
        );
        await client.query(
            `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2 AND currency = $3`,
            [earnerAmount, req.user.id, campaign.currency]
        );
        await client.query(
            `INSERT INTO tasks (campaign_id, earner_id, task_type, earner_amount, advertiser_deduction, currency, status)
             VALUES ($1,$2,'video',$3,$4,$5,'approved')`,
            [campaignId, req.user.id, earnerAmount, campaign.unit_cost, campaign.currency]
        );

        await client.query('COMMIT');
        res.json({ message: 'Video verified. Earnings credited instantly.', amountEarned: earnerAmount, currency: campaign.currency });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Video verification failed.' });
    } finally {
        client.release();
    }
});

// ---- Website banners: click registered by the publisher's embed script ----
router.post('/register-click', auth, requireEarner, async (req, res) => {
    const { campaignId } = req.body;
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const campaignResult = await client.query(
            `SELECT * FROM campaigns WHERE id = $1 AND campaign_type = 'banner_cpc' AND status = 'active' FOR UPDATE`,
            [campaignId]
        );
        if (!campaignResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'This campaign is no longer available.' });
        }
        const campaign = campaignResult.rows[0];

        if (Number(campaign.remaining_budget) < Number(campaign.unit_cost)) {
            await client.query(`UPDATE campaigns SET status = 'completed' WHERE id = $1`, [campaignId]);
            await client.query('COMMIT');
            return res.status(400).json({ error: 'Campaign budget has been exhausted.' });
        }

        const publisherAmount = Number((campaign.unit_cost * BANNER_PUBLISHER_SPLIT).toFixed(4));
        const newRemaining = Number(campaign.remaining_budget) - Number(campaign.unit_cost);

        await client.query(
            `UPDATE campaigns SET remaining_budget = $1, status = $2 WHERE id = $3`,
            [newRemaining, newRemaining <= 0 ? 'completed' : 'active', campaignId]
        );
        await client.query(
            `UPDATE wallets SET balance = balance + $1 WHERE user_id = $2 AND currency = $3`,
            [publisherAmount, req.user.id, campaign.currency]
        );
        await client.query(
            `INSERT INTO tasks (campaign_id, earner_id, task_type, earner_amount, advertiser_deduction, currency, status)
             VALUES ($1,$2,'banner',$3,$4,$5,'approved')`,
            [campaignId, req.user.id, publisherAmount, campaign.unit_cost, campaign.currency]
        );

        await client.query('COMMIT');
        res.json({ message: 'Click registered.', amountEarned: publisherAmount, currency: campaign.currency });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Click registration failed.' });
    } finally {
        client.release();
    }
});

// ---- Social reposts: funds sit in pending_balance until an admin reviews the live link ----
router.post('/submit-social-proof', auth, requireEarner, async (req, res) => {
    const { campaignId, proofUrl } = req.body;
    if (!proofUrl) {
        return res.status(400).json({ error: 'A live post URL is required.' });
    }

    try {
        const campaignResult = await db.query(
            `SELECT * FROM campaigns WHERE id = $1 AND campaign_type = 'social_flat' AND status = 'active'`,
            [campaignId]
        );
        if (!campaignResult.rows.length) {
            return res.status(404).json({ error: 'This campaign is no longer available.' });
        }
        const campaign = campaignResult.rows[0];
        const earnerAmount = Number((campaign.unit_cost * SOCIAL_INFLUENCER_SPLIT).toFixed(2));

        await db.query(
            `INSERT INTO tasks (campaign_id, earner_id, task_type, earner_amount, advertiser_deduction, currency, proof_url, status)
             VALUES ($1,$2,'social',$3,$4,$5,$6,'pending_approval')`,
            [campaignId, req.user.id, earnerAmount, campaign.unit_cost, campaign.currency, proofUrl]
        );
        await db.query(
            `UPDATE wallets SET pending_balance = pending_balance + $1 WHERE user_id = $2 AND currency = $3`,
            [earnerAmount, req.user.id, campaign.currency]
        );

        res.status(201).json({ message: 'Proof submitted. Funds will move to your withdrawable balance once an admin approves it.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to submit proof.' });
    }
});

router.get('/mine', auth, requireEarner, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, task_type, earner_amount, currency, status, proof_url, created_at
             FROM tasks WHERE earner_id = $1 ORDER BY created_at DESC LIMIT 50`,
            [req.user.id]
        );
        res.json({ tasks: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch tasks.' });
    }
});

module.exports = router;
