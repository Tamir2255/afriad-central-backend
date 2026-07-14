const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// Set production/development dynamic port
const PORT = process.env.PORT || 5000;

// Enable CORS cleanly for cross-platform request handling
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Database connection pool setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Helper validation middleware
const authenticateUser = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: "Access denied. Token missing." });
    }

    try {
        const verified = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
        req.user = verified;
        next();
    } catch (err) {
        res.status(403).json({ error: "Invalid token." });
    }
};

// Test Route
app.get('/', (req, res) => {
    res.send('AfriAd Multicurrency Backend API is running successfully!');
});

// ==========================================
// SYSTEM PRICING MATRIX
// ==========================================
const PRICING_MATRIX = {
    classified: { UGX: 7500, KES: 260, TZS: 5200, RWF: 2600, ZAR: 37 },
    banner_cpc: { UGX: 112, KES: 3.9, TZS: 78, RWF: 39, ZAR: 0.55 },
    video_ad: { UGX: 150, KES: 5.2, TZS: 104, RWF: 52, ZAR: 0.74 },
    social_repost: { UGX: 37500, KES: 1300, TZS: 26000, RWF: 13000, ZAR: 185 }
};

// ==========================================
// 1. UPDATED AUTHENTICATION ROUTES
// ==========================================

// Register User (With automatic Multi-Currency Wallet Initializer)
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password, role } = req.body;
    const client = await pool.connect();

    try {
        if (!['advertiser', 'earner'].includes(role)) {
            return res.status(400).json({ error: "Role must be 'advertiser' or 'earner'" });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Start registration transaction to ensure wallet is ALWAYS created alongside user
        await client.query('BEGIN');

        const userResult = await client.query(
            `INSERT INTO users (username, email, password_hash, role) 
             VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, created_at`,
            [username, email, passwordHash, role]
        );

        const newUser = userResult.rows[0];

        // Create the user's multi-currency wallet profile initialized at 0.00 balances
        await client.query(
            `INSERT INTO wallets (advertiser_id, ugx_balance, kes_balance, tzs_balance, rwf_balance, zar_balance) 
             VALUES ($1, 0.00, 0.00, 0.00, 0.00, 0.00)`,
            [newUser.id]
        );

        await client.query('COMMIT');

        res.status(201).json({ 
            message: "User registered successfully with secure multi-currency wallet!", 
            user: newUser 
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err.message);
        if (err.code === '23505') {
            return res.status(400).json({ error: "Username or Email already exists." });
        }
        res.status(500).send("Server error during registration.");
    } finally {
        client.release();
    }
});

// Login User (Resolves balance objects from the wallets table)
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Find user first
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: "Invalid credentials." });
        }

        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ error: "Invalid credentials." });
        }

        // Retrieve wallet state linked to user
        const walletResult = await pool.query('SELECT * FROM wallets WHERE advertiser_id = $1', [user.id]);
        let userWallet = { ugx_balance: 0, kes_balance: 0, tzs_balance: 0, rwf_balance: 0, zar_balance: 0 };

        if (walletResult.rows.length > 0) {
            userWallet = walletResult.rows[0];
        }

        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET || 'fallback_secret',
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                ugx_balance: userWallet.ugx_balance,
                kes_balance: userWallet.kes_balance,
                tzs_balance: userWallet.tzs_balance,
                rwf_balance: userWallet.rwf_balance,
                zar_balance: userWallet.zar_balance
            }
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error during login.");
    }
});

// ==========================================
// 2. CONCURRENCY CONTROL CAMPAIGN ROUTE
// ==========================================
app.post('/api/campaigns/create', authenticateUser, async (req, res) => {
    const { 
        advertiserId, 
        campaignType, 
        title, 
        mediaUrl, 
        targetCountry, 
        currency, 
        totalUnits 
    } = req.body;

    if (!advertiserId || !campaignType || !title || !mediaUrl || !targetCountry || !currency) {
        return res.status(400).json({ error: "Missing required campaign parameters." });
    }

    const upperCurrency = currency.toUpperCase();
    const allowedCurrencies = ['UGX', 'KES', 'TZS', 'RWF', 'ZAR'];
    if (!allowedCurrencies.includes(upperCurrency)) {
        return res.status(400).json({ error: `Unsupported currency.` });
    }

    if (!PRICING_MATRIX[campaignType]) {
        return res.status(400).json({ error: "Invalid campaign format type." });
    }

    let validatedUnits = parseInt(totalUnits) || 1;
    if (campaignType === 'classified' || campaignType === 'social_repost') {
        validatedUnits = 1; 
    }

    if (validatedUnits <= 0) {
        return res.status(400).json({ error: "Units must be greater than zero." });
    }

    const unitRate = PRICING_MATRIX[campaignType][upperCurrency];
    const totalCampaignCost = unitRate * validatedUnits;

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Row-level locks to prevent double spend
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
            return res.status(404).json({ error: "Wallet database profile not found." });
        }

        const currentBalance = parseFloat(walletResult.rows[0].balance);

        if (currentBalance < totalCampaignCost) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: "Insufficient funds to launch this campaign.", 
                required: totalCampaignCost, 
                available: currentBalance, 
                currency: upperCurrency 
            });
        }

        // Deduct funds from database
        const deductQuery = `
            UPDATE wallets 
            SET ${walletColumn} = ${walletColumn} - $1, updated_at = NOW() 
            WHERE advertiser_id = $2
        `;
        await client.query(deductQuery, [totalCampaignCost, advertiserId]);

        // Create campaign record
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

        await client.query('COMMIT');

        res.status(201).json({
            message: "Campaign initialized successfully and is pending admin validation.",
            campaign: campaignResult.rows[0],
            newBalance: currentBalance - totalCampaignCost
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Transaction Aborted:", error);
        res.status(500).json({ error: "Internal payment processing error occurred." });
    } finally {
        client.release();
    }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`AfriAd Dynamic Server running on port ${PORT}`);
});