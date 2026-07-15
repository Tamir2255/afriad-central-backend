const express = require('express');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');

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
            // Move funds out of pending_balance into the withdrawable balance.
            await client.query(
                `UPDATE wallets SET pending_balance = pending_balance - $1, balance = balance + $1
                 WHERE user_id = $2 AND currency = $3`,
                [task.earner_amount, task.earner_id, task.currency]
            );
            await client.query(`UPDATE tasks SET status = 'approved', reviewed_at = NOW() WHERE id = $1`, [taskId]);
        } else {
            // Reverse the pending hold — no funds move to withdrawable balance.
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

module.exports = router;
