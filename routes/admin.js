const express = require('express');
const multer = require('multer');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { MINIMUM_FOLLOWERS } = require('../util/eligibility');

const upload = multer({ dest: '/tmp/uploads', limits: { fileSize: 20 * 1024 * 1024 } });

// ============================================================
// Social task proof review (video/banner is instant; social posts
// need a human to check the live link before funds clear)
// ============================================================
router.get('/pending-proofs', auth, requireRole('admin'), async (req, res) => {
    try {
        const result = await db.query(
            `SELECT t.id, t.proof_url, t.earner_amount, t.currency, t.created_at,
                    u.username AS earner_username, c.title AS campaign_title
             FROM tasks t
             JOIN users u ON u.id = t.earner_id
             JOIN campaigns c ON c.id = t.campaign_id
             WHERE t.status = 'pending_approval'
             ORDER BY t.created_at ASC`
        );
        res.json({ proofs: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch pending proofs.' });
    }
});

router.post('/verify-proof', auth, requireRole('admin'), async (req, res) => {
    const { taskId, approve } = req.body;
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const taskResult = await client.query(
            `SELECT * FROM tasks WHERE id = $1 AND status = 'pending_approval' FOR UPDATE`,
            [taskId]
        );
        if (!taskResult.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Task not found or already reviewed.' });
        }
        const task = taskResult.rows[0];

        if (approve) {
            await client.query(
                `UPDATE wallets SET pending_balance = pending_balance - $1, balance = balance + $1
                 WHERE user_id = $2 AND currency = $3`,
                [task.earner_amount, task.earner_id, task.currency]
            );
            await client.query(`UPDATE tasks SET status = 'approved', reviewed_at = NOW() WHERE id = $1`, [taskId]);
        } else {
            await client.query(
                `UPDATE wallets SET pending_balance = pending_balance - $1 WHERE user_id = $2 AND currency = $3`,
                [task.earner_amount, task.earner_id, task.currency]
            );
            await client.query(`UPDATE tasks SET status = 'rejected', reviewed_at = NOW() WHERE id = $1`, [taskId]);
        }

        await client.query('COMMIT');
        res.json({ message: `Proof ${approve ? 'approved' : 'rejected'}.` });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Failed to review proof.' });
    } finally {
        client.release();
    }
});

// ============================================================
// Content generation queue — campaigns where the advertiser paid
// the "generate for me" premium.
// ============================================================
router.get('/content-queue', auth, requireRole('admin'), async (req, res) => {
    try {
        const result = await db.query(
            `SELECT c.id, c.title, c.business_category, c.campaign_type, c.generation_brief, c.revision_notes,
                    c.currency, c.total_units, u.username AS advertiser_username, u.email AS advertiser_email
             FROM campaigns c
             JOIN users u ON u.id = c.advertiser_id
             WHERE c.status = 'pending_content' AND c.generation_status = 'pending_admin'
             ORDER BY c.created_at ASC`
        );
        res.json({ campaigns: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch content queue.' });
    }
});

router.post('/content-queue/:id/submit', auth, requireRole('admin'), upload.single('contentFile'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'A content file is required.' });
    }
    try {
        const result = await db.query(
            `UPDATE campaigns
             SET generated_media_url = $1, status = 'pending_customer_approval', generation_status = 'pending_customer_approval'
             WHERE id = $2 AND status = 'pending_content'
             RETURNING id, title`,
            [`/uploads/${req.file.filename}`, req.params.id]
        );
        if (!result.rows.length) {
            return res.status(404).json({ error: 'Campaign not found or not awaiting content.' });
        }
        res.json({ message: 'Content submitted to the customer for approval.', campaign: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to submit content.' });
    }
});

// ============================================================
// Social account verification — TikTok/X are manual for now (no paid
// scraping API yet, see util/socialVerify.js). An admin opens the
// profile, checks it meets the platform minimum, and approves or
// rejects. There's no tier to assign — meeting the minimum is a
// simple yes/no. YouTube mostly auto-verifies and won't land here
// unless YOUTUBE_API_KEY isn't configured.
// ============================================================
router.get('/social-accounts/pending', auth, requireRole('admin'), async (req, res) => {
    try {
        const result = await db.query(
            `SELECT sa.id, sa.platform, sa.handle, sa.profile_url, sa.created_at, u.username, u.email
             FROM social_accounts sa
             JOIN users u ON u.id = sa.user_id
             WHERE sa.verification_status = 'pending'
             ORDER BY sa.platform, sa.created_at ASC`
        );

        const grouped = { tiktok: [], youtube: [], twitter: [] };
        result.rows.forEach((row) => { if (grouped[row.platform]) grouped[row.platform].push(row); });

        res.json({ grouped, total: result.rows.length, minimums: MINIMUM_FOLLOWERS });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch pending social accounts.' });
    }
});

router.post('/social-accounts/:id/verify', auth, requireRole('admin'), async (req, res) => {
    const { approve, followersCount } = req.body;

    try {
        const result = await db.query(
            `UPDATE social_accounts
             SET verification_status = $1,
                 followers_count = $2,
                 verification_method = 'manual',
                 verified_at = NOW()
             WHERE id = $3
             RETURNING id, platform, verification_status, followers_count`,
            [approve ? 'verified' : 'rejected', followersCount ?? null, req.params.id]
        );
        if (!result.rows.length) {
            return res.status(404).json({ error: 'Social account not found.' });
        }
        res.json({ message: `Account ${approve ? 'verified' : 'rejected'}.`, account: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to review social account.' });
    }
});

// Quick overview of verified accounts per platform — for an admin dashboard summary card.
router.get('/social-accounts/summary', auth, requireRole('admin'), async (req, res) => {
    try {
        const result = await db.query(
            `SELECT platform, COUNT(*) AS count FROM social_accounts WHERE verification_status = 'verified' GROUP BY platform`
        );
        const summary = { tiktok: 0, youtube: 0, twitter: 0 };
        result.rows.forEach((row) => { summary[row.platform] = Number(row.count); });
        res.json({ summary });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to build summary.' });
    }
});

module.exports = router;
