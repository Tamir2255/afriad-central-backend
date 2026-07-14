const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Dynamic Production CORS configuration
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Database connection pool setup
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000
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
// 1. ISOLATED DATABASE INITIALIZATION (HOT FIXES APPLIED)
// ==========================================
const initializeDatabaseSchema = async () => {
    const client = await pool.connect();
    try {
        console.log("Initializing production database schema sync...");
        
        // Ensure Users Table exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) NOT NULL UNIQUE,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Ensure Wallets Table exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS wallets (
                id SERIAL PRIMARY KEY,
                advertiser_id INTEGER NOT NULL UNIQUE,
                ugx_balance DECIMAL(15, 2) DEFAULT 0.00,
                kes_balance DECIMAL(15, 2) DEFAULT 0.00,
                tzs_balance DECIMAL(15, 2) DEFAULT 0.00,
                rwf_balance DECIMAL(15, 2) DEFAULT 0.00,
                zar_balance DECIMAL(15, 2) DEFAULT 0.00,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Ensure Campaigns Table exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS campaigns (
                id SERIAL PRIMARY KEY,
                advertiser_id INTEGER NOT NULL,
                campaign_type VARCHAR(50) NOT NULL,
                title VARCHAR(255) NOT NULL,
                media_url TEXT NOT NULL,
                target_country VARCHAR(100) NOT NULL,
                currency VARCHAR(10) NOT NULL,
                total_units INTEGER NOT NULL,
                total_budget DECIMAL(15, 2) NOT NULL,
                remaining_budget DECIMAL(15, 2) NOT NULL,
                status VARCHAR(50) DEFAULT 'pending_admin_approval',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // HOT FIX: Force add columns if table exists but is missing fields (resolves the exact pg error)
        await client.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS campaign_type VARCHAR(50) DEFAULT 'classified';`);
        await client.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS total_units INTEGER DEFAULT 1;`);
        await client.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS remaining_budget DECIMAL(15, 2) DEFAULT 0.00;`);

        console.log("Database schema synchronized successfully!");
    } catch (err) {
        console.error("Critical error during database layout initialization:", err.message);
    } finally {
        client.release();
    }
};

// Start DB schema initialization
initializeDatabaseSchema();

// Helper JWT Authentication Middleware
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

// Standard API Health Check displaying our Brand Joined Logo configuration data
app.get('/', (req, res) => {
    res.json({
        message: "AfriAd Multicurrency Backend API is running successfully!",
        branding: {
            logo_style: "joined-double-a",
            primary_color: "#FF5A00",
            secondary_color: "#00B25C"
        }
    });
});

// ==========================================
// 2. AUTHENTICATION CONTROLLERS
// ==========================================

// Register User
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password, role } = req.body;
    const client = await pool.connect();

    try {
        if (!['advertiser', 'earner'].includes(role)) {
            return res.status(400).json({ error: "Role must be 'advertiser' or 'earner'" });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        await client.query('BEGIN');

        const userResult = await client.query(
            `INSERT INTO users (username, email, password_hash, role) 
             VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, created_at`,
            [username, email, passwordHash, role]
        );

        const newUser = userResult.rows[0];

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
        console.error("Registration error:", err.message);
        if (err.code === '23505') {
            return res.status(400).json({ error: "Username or Email already exists." });
        }
        res.status(500).send("Server error during registration.");
    } finally {
        client.release();
    }
});

// Login User
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: "Invalid credentials." });
        }

        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ error: "Invalid credentials." });
        }

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
        console.error("Login Error:", err.message);
        res.status(500).send("Server error during login.");
    }
});

// ==========================================
// 3. CAMPAIGN CREATION WITH ATOMIC ISOLATION
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
        return res.status(400).json({ error: `Unsupported currency: ${upperCurrency}` });
    }

    if (!PRICING_MATRIX[campaignType]) {
        return res.status(400).json({ error: "Invalid campaign format type." });
    }

    const normalizedAdvertiserId = Number(advertiserId);
    let validatedUnits = parseInt(totalUnits, 10) || 1;
    
    if (campaignType === 'classified' || campaignType === 'social_repost') {
        validatedUnits = 1; 
    }

    if (isNaN(normalizedAdvertiserId) || validatedUnits <= 0) {
        return res.status(400).json({ error: "Invalid advertiser reference or units." });
    }

    const unitRate = PRICING_MATRIX[campaignType][upperCurrency];
    const totalCampaignCost = parseFloat((unitRate * validatedUnits).toFixed(2));

    const client = await pool.connect();

    try {
        await client.query('BEGIN TRANSACTION ISOLATION LEVEL READ COMMITTED');

        const walletColumn = `${upperCurrency.toLowerCase()}_balance`;
        
        const walletResult = await client.query(
            `SELECT ${walletColumn} AS balance FROM wallets WHERE advertiser_id = $1 FOR UPDATE`, 
            [normalizedAdvertiserId]
        );

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

        // Deduct funds cleanly
        await client.query(
            `UPDATE wallets SET ${walletColumn} = ${walletColumn} - $1, updated_at = NOW() WHERE advertiser_id = $2`,
            [totalCampaignCost, normalizedAdvertiserId]
        );

        const insertCampaignQuery = `
            INSERT INTO campaigns (
                advertiser_id, campaign_type, title, media_url, 
                target_country, currency, total_units, total_budget, remaining_budget, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_admin_approval')
            RETURNING *
        `;
        
        const campaignResult = await client.query(insertCampaignQuery, [
            normalizedAdvertiserId, 
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
        console.error("DATABASE TRANSACTION REJECTED:", error.message);
        res.status(500).json({ 
            error: "Internal payment processing error occurred.",
            details: error.message 
        });
    } finally {
        client.release();
    }
});

// ==========================================
// 4. MOBILE MONEY & WEBHOOKS
// ==========================================

// Simulate Mobile Money deposit request
app.post('/api/payments/deposit', authenticateUser, async (req, res) => {
    const { amount, currency, phoneNumber, network } = req.body;

    if (!amount || !currency || !phoneNumber || !network) {
        return res.status(400).json({ error: "Missing deposit payment parameters." });
    }

    const upperCurrency = currency.toUpperCase();
    const allowedCurrencies = ['UGX', 'KES', 'TZS', 'RWF', 'ZAR'];
    if (!allowedCurrencies.includes(upperCurrency)) {
        return res.status(400).json({ error: "Unsupported currency." });
    }

    try {
        const transactionId = 'TXN-' + Math.random().toString(36).substr(2, 9).toUpperCase();
        console.log(`Payment initiated: ${amount} ${upperCurrency} via ${network} (${phoneNumber})`);

        res.status(200).json({
            message: "Mobile Money prompt sent to your phone. Please approve the transaction.",
            transactionId: transactionId,
            status: "pending"
        });
    } catch (err) {
        console.error("Deposit Initiation Error:", err.message);
        res.status(500).json({ error: "Error initiating payment." });
    }
});

// Webhook Receiver
app.post('/api/payments/webhook', async (req, res) => {
    const { advertiserId, amount, currency, status } = req.body;

    if (status !== 'successful') {
        return res.status(200).json({ message: "Transaction ignored (unsuccessful status)." });
    }

    const upperCurrency = currency.toUpperCase();
    const walletColumn = `${upperCurrency.toLowerCase()}_balance`;
    const normalizedAdvertiserId = Number(advertiserId);

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const checkWallet = await client.query(
            `SELECT * FROM wallets WHERE advertiser_id = $1 FOR UPDATE`, 
            [normalizedAdvertiserId]
        );

        if (checkWallet.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: "Target wallet not found." });
        }

        const updatedWallet = await client.query(
            `UPDATE wallets SET ${walletColumn} = ${walletColumn} + $1, updated_at = NOW() WHERE advertiser_id = $2 RETURNING *`,
            [amount, normalizedAdvertiserId]
        );

        await client.query('COMMIT');
        console.log(`SUCCESSFUL WEBHOOK: Credited ${amount} ${upperCurrency} to user ID ${normalizedAdvertiserId}`);
        res.status(200).json({ 
            message: "Wallet successfully credited.", 
            wallet: updatedWallet.rows[0] 
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Webhook transaction failed safely:", err.message);
        res.status(500).json({ error: "Internal webhook processing error." });
    } finally {
        client.release();
    }
});

// Start listening safely
app.listen(PORT, '0.0.0.0', () => {
    console.log(`AfriAd Production Server listening on port ${PORT}`);
});