const BACKEND_URL = "https://afriad-central-backend.onrender.com"
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const authenticateUser = require('./middleware');
require('dotenv').config();

const app = express();

// Render overrides this value dynamically to port 10000 or others
const PORT = process.env.PORT || 10000;

// Enable CORS cleanly for production deployment environments
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// Test Route
app.get('/', (req, res) => {
    res.send('AfriAd Backend API is running successfully!');
});

// ==========================================
// 1. AUTHENTICATION ROUTES
// ==========================================

// Register User
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password, role } = req.body;

    try {
        if (!['advertiser', 'earner'].includes(role)) {
            return res.status(400).json({ error: "Role must be 'advertiser' or 'earner'" });
        }

        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        const newUser = await db.query(
            `INSERT INTO users (username, email, password_hash, role) 
             VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, balance, created_at`,
            [username, email, passwordHash, role]
        );

        res.status(201).json({ message: "User registered successfully!", user: newUser.rows[0] });
    } catch (err) {
        console.error(err.message);
        if (err.code === '23505') {
            return res.status(400).json({ error: "Username or Email already exists." });
        }
        res.status(500).send("Server error");
    }
});

// Login User
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        const userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: "Invalid credentials." });
        }

        const user = userResult.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ error: "Invalid credentials." });
        }

        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                balance: user.balance
            }
        });
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

// ==========================================
// 2. ADVERTISER ROUTES
// ==========================================

// Create Ad Campaign
app.post('/api/campaigns/create', authenticateUser, async (req, res) => {
    if (req.user.role !== 'advertiser') {
        return res.status(403).json({ error: "Access denied. Only advertisers can create campaigns." });
    }

    const { title, ad_type, ad_url, budget_total, cost_per_action } = req.body;
    const advertiserId = req.user.id;

    try {
        if (!['video', 'website_banner', 'social_share'].includes(ad_type)) {
            return res.status(400).json({ error: "Invalid ad type." });
        }

        const userCheck = await db.query('SELECT balance FROM users WHERE id = $1', [advertiserId]);
        const currentBalance = parseFloat(userCheck.rows[0].balance);

        if (currentBalance < parseFloat(budget_total)) {
            return res.status(400).json({ error: "Insufficient balance. Please top up your wallet." });
        }

        // Deduct budget from advertiser balance
        await db.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [budget_total, advertiserId]);

        // Create campaign
        const newCampaign = await db.query(
            `INSERT INTO campaigns (advertiser_id, title, ad_type, ad_url, budget_total, budget_remaining, cost_per_action)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [advertiserId, title, ad_type, ad_url, budget_total, budget_total, cost_per_action]
        );

        res.status(201).json({ message: "Campaign created successfully!", campaign: newCampaign.rows[0] });
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

// ==========================================
// 3. EARNER ROUTES
// ==========================================

// Fetch Available Campaigns for Earners
app.get('/api/campaigns/available', authenticateUser, async (req, res) => {
    if (req.user.role !== 'earner') {
        return res.status(403).json({ error: "Access denied. Only earners can view available tasks." });
    }

    try {
        const availableCampaigns = await db.query(
            `SELECT c.* FROM campaigns c
             WHERE c.status = 'active' AND c.budget_remaining >= c.cost_per_action
             AND c.id NOT IN (SELECT campaign_id FROM transactions WHERE earner_id = $1)`,
            [req.user.id]
        );

        res.json(availableCampaigns.rows);
    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

// Complete Ad Action / Claim Payout
app.post('/api/campaigns/complete', authenticateUser, async (req, res) => {
    if (req.user.role !== 'earner') {
        return res.status(403).json({ error: "Access denied. Only earners can complete tasks." });
    }

    const { campaign_id } = req.body;
    const earnerId = req.user.id;

    try {
        const campaignCheck = await db.query('SELECT * FROM campaigns WHERE id = $1', [campaign_id]);
        if (campaignCheck.rows.length === 0) {
            return res.status(404).json({ error: "Campaign not found." });
        }

        const campaign = campaignCheck.rows[0];

        if (campaign.status !== 'active' || parseFloat(campaign.budget_remaining) < parseFloat(campaign.cost_per_action)) {
            return res.status(400).json({ error: "Campaign is no longer active or is out of funds." });
        }

        const duplicateCheck = await db.query(
            'SELECT id FROM transactions WHERE earner_id = $1 AND campaign_id = $2',
            [earnerId, campaign_id]
        );
        if (duplicateCheck.rows.length > 0) {
            return res.status(400).json({ error: "You have already completed this ad task." });
        }

        const platformCutPercent = 0.20; 
        const advertiserCost = parseFloat(campaign.cost_per_action);
        const earnerPayout = advertiserCost * (1 - platformCutPercent);

        await db.query(
            'UPDATE campaigns SET budget_remaining = budget_remaining - $1 WHERE id = $2',
            [advertiserCost, campaign_id]
        );

        await db.query(
            'UPDATE users SET balance = balance + $1 WHERE id = $2',
            [earnerPayout, earnerId]
        );

        await db.query(
            `INSERT INTO transactions (earner_id, campaign_id, amount_earned, status)
             VALUES ($1, $2, $3, 'completed')`,
            [earnerId, campaign_id, earnerPayout]
        );

        if (parseFloat(campaign.budget_remaining) - advertiserCost < advertiserCost) {
            await db.query("UPDATE campaigns SET status = 'completed' WHERE id = $1", [campaign_id]);
        }

        res.json({ message: "Task verified! Earnings added to your wallet.", amountEarned: earnerPayout });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});

// Start Server dynamically mapping the port configuration
app.listen(PORT, () => {
    console.log(`Server running dynamically on port ${PORT}`);
});