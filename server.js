const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==========================================
// 1. SYSTEM PRICING MATRIX
// ==========================================
const PRICING_MATRIX = {
    classified: {
        UGX: 7500,
        KES: 260,
        TZS: 5200,
        RWF: 2600,
        ZAR: 37
    },
    banner_cpc: {
        UGX: 112,
        KES: 3.9,
        TZS: 78,
        RWF: 39,
        ZAR: 0.55
    },
    video_ad: {
        UGX: 150,
        KES: 5.2,
        TZS: 104,
        RWF: 52,
        ZAR: 0.74
    },
    social_repost: {
        UGX: 37500,
        KES: 1300,
        TZS: 26000,
        RWF: 13000,
        ZAR: 185
    }
};

// ==========================================
// 2. CAMPAIGN CREATION CONTROLLER
// ==========================================
app.post('/api/campaigns/create', async (req, res) => {
    const { 
        advertiserId, 
        campaignType, 
        title, 
        mediaUrl, 
        targetCountry, 
        currency, 
        totalUnits 
    } = req.body;

    // A. Validation Layer
    if (!advertiserId || !campaignType || !title || !mediaUrl || !targetCountry || !currency) {
        return res.status(400).json({ error: "Missing required campaign registration parameters." });
    }

    const upperCurrency = currency.toUpperCase();
    const allowedCurrencies = ['UGX', 'KES', 'TZS', 'RWF', 'ZAR'];
    if (!allowedCurrencies.includes(upperCurrency)) {
        return res.status(400).json({ error: `Unsupported currency. Choose from: ${allowedCurrencies.join(', ')}` });
    }

    if (!PRICING_MATRIX[campaignType]) {
        return res.status(400).json({ error: "Invalid campaign format type provided." });
    }

    // Assign unit structures based on campaign types
    let validatedUnits = parseInt(totalUnits) || 1;
    if (campaignType === 'classified' || campaignType === 'social_repost') {
        validatedUnits = 1; // Forced flat rates
    }

    if (validatedUnits <= 0) {
        return res.status(400).json({ error: "Units must be greater than zero." });
    }

    // B. Calculate Cost
    const unitRate = PRICING_MATRIX[campaignType][upperCurrency];
    const totalCampaignCost = unitRate * validatedUnits;

    // Get a client from the pool to run a controlled transaction block
    const client = await pool.connect();

    try {
        // C. Start PostgreSQL Isolation Transaction
        await client.query('BEGIN');

        // D. Row-level Lock on Wallet to block concurrent race conditions
        const walletColumn = `${upperCurrency.toLowerCase()}_balance`;
        const walletQuery = `
            SELECT ${walletColumn} AS balance 
            FROM wallets 
            WHERE advertiser_id = $1 
            FOR UPDATE
        `;
        
        const walletResult = await client.query(walletQuery, [advertiserId]);

        if (walletResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Wallet not found for this advertiser ID." });
        }

        const currentBalance = parseFloat(walletResult.rows[0].balance);

        if (currentBalance < totalCampaignCost) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: "Insufficient funds.", 
                required: totalCampaignCost, 
                available: currentBalance, 
                currency: upperCurrency 
            });
        }

        // E. Safely Deduct Funds
        const deductQuery = `
            UPDATE wallets 
            SET ${walletColumn} = ${walletColumn} - $1, updated_at = NOW() 
            WHERE advertiser_id = $2
        `;
        await client.query(deductQuery, [totalCampaignCost, advertiserId]);

        // F. Insert New Campaign
        const insertCampaignQuery = `
            INSERT INTO campaigns (
                advertiser_id, campaign_type, title, media_url, 
                target_country, currency, total_units, total_budget, remaining_budget, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_admin_approval')
            RETURNING *
        `;
        
        const campaignResult = await client.query(insertCampaignQuery, [
            advertiserId, 
            campaignType, 
            title, 
            mediaUrl, 
            targetCountry, 
            upperCurrency, 
            validatedUnits, 
            totalCampaignCost, 
            totalCampaignCost
        ]);

        // G. Commit Transaction
        await client.query('COMMIT');

        res.status(201).json({
            message: "Campaign initialized successfully and is pending admin validation.",
            campaign: campaignResult.rows[0],
            newBalance: currentBalance - totalCampaignCost
        });

    } catch (error) {
        // Safe Rollback in case of code or network level failures
        await client.query('ROLLBACK');
        console.error("Transaction Aborted Safely:", error);
        res.status(500).json({ error: "An internal payment transaction error occurred." });
    } finally {
        // Release client back to pool
        client.release();
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Financial API processing server active on port ${PORT}`);
});