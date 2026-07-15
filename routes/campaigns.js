const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();
const db = require('../db');
const auth = require('../middleware/auth');
const { createCheckoutLink } = require('../paymentGateway');

const upload = multer({ dest: '/tmp/uploads', limits: { fileSize: 10 * 1024 * 1024 } });

// Stable rate matrix — the single source of truth for pricing.
// Mirrors the numbers shown on the marketing site's pricing calculator.
const UNIT_RATES = {
    classified:  { UGX: 7500,  KES: 260,  TZS: 5200,  RWF: 2600,  ZAR: 37   },
    banner_cpc:  { UGX: 112,   KES: 3.9,  TZS: 78,    RWF: 39,    ZAR: 0.55 },
    video_cpv:   { UGX: 150,   KES: 5.2,  TZS: 104,   RWF: 52,    ZAR: 0.74 },
    social_flat: { UGX: 37500, KES: 1300, TZS: 26000, RWF: 13000, ZAR: 185  }
};
const FLAT_TYPES = ['classified', 'social_flat'];
const VALID_COUNTRIES = ['Uganda', 'Kenya', 'Tanzania', 'Rwanda', 'South Africa'];

// Advertisers pay per campaign — there is no wallet buffer on this side.
router.post('/create', auth, upload.single('mediaFile'), async (req, res) => {
    if (req.user.role !== 'advertiser') {
        return res.status(403).json({ error: 'Only advertiser accounts can launch campaigns.' });
    }

    const { campaignType, title, targetCountry, currency, totalUnits, destinationUrl } = req.body;

    if (!title || !VALID_COUNTRIES.includes(targetCountry)) {
        return res.status(400).json({ error: 'A valid title and target country are required.' });
    }
    if (!UNIT_RATES[campaignType] || !UNIT_RATES[campaignType][currency]) {
        return res.status(400).json({ error: 'Unsupported campaign type or currency for this region.' });
    }

    const units = FLAT_TYPES.includes(campaignType) ? 1 : Math.max(1, parseInt(totalUnits, 10) || 0);
    const unitCost = UNIT_RATES[campaignType][currency];
    const totalCost = Number((unitCost * units).toFixed(2));
    const mediaUrl = req.file ? `/uploads/${req.file.filename}` : null;
    const invoiceRef = 'AFRIAD_' + crypto.randomBytes(6).toString('hex').toUpperCase();

    try {
        const campaignResult = await db.query(
            `INSERT INTO campaigns
                (advertiser_id, campaign_type, title, target_country, currency, unit_cost, total_units, remaining_budget, media_url, destination_url, invoice_ref, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'unpaid')
             RETURNING id, title, currency, campaign_type, total_units, invoice_ref, status`,
            [req.user.id, campaignType, title, targetCountry, currency, unitCost, units, totalCost, mediaUrl, destinationUrl || null, invoiceRef]
        );
        const campaign = campaignResult.rows[0];

        const userResult = await db.query('SELECT email FROM users WHERE id = $1', [req.user.id]);

        const checkoutLink = await createCheckoutLink({
            amount: totalCost,
            currency,
            email: userResult.rows[0].email,
            txRef: invoiceRef,
            redirectUrl: `${process.env.FRONTEND_ADVERTISER_URL || ''}/dashboard.html?invoice=${invoiceRef}`
        });

        res.status(201).json({ campaign, totalCost, checkoutLink });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create campaign.' });
    }
});

router.get('/mine', auth, async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, campaign_type, title, target_country, currency, unit_cost, total_units, remaining_budget, status, invoice_ref, created_at
             FROM campaigns WHERE advertiser_id = $1 ORDER BY created_at DESC`,
            [req.user.id]
        );
        res.json({ campaigns: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch campaigns.' });
    }
});

// Public feed of live campaigns an earner can complete, grouped by task type.
router.get('/available/:taskType', async (req, res) => {
    const typeMap = { video: 'video_cpv', banner: 'banner_cpc', social: 'social_flat' };
    const campaignType = typeMap[req.params.taskType];
    if (!campaignType) return res.status(400).json({ error: 'Invalid task type.' });

    try {
        const result = await db.query(
            `SELECT id, title, currency, media_url, destination_url, unit_cost, remaining_budget
             FROM campaigns
             WHERE campaign_type = $1 AND status = 'active' AND remaining_budget > 0
             ORDER BY created_at DESC LIMIT 20`,
            [campaignType]
        );
        res.json({ campaigns: result.rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to fetch available campaigns.' });
    }
});

module.exports = router;
