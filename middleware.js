const jwt = require('jsonwebtoken');
require('dotenv').config();

const authenticateUser = (req, res, next) => {
    // Get token from header
    const token = req.header('Authorization')?.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: "No token, authorization denied." });
    }

    try {
        // Verify token
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // Adds { id, role } to the request object
        next();
    } catch (err) {
        res.status(401).json({ error: "Token is not valid." });
    }
};

module.exports = authenticateUser;
// 3. CREATE AD CAMPAIGN ROUTE (Advertisers Only)
app.post('/api/campaigns/create', authenticateUser, async (req, res) => {
    // Lock this route down to advertisers only
    if (req.user.role !== 'advertiser') {
        return res.status(403).json({ error: "Access denied. Only advertisers can create campaigns." });
    }

    const { title, ad_type, ad_url, budget_total, cost_per_action } = req.body;
    const advertiserId = req.user.id;

    try {
        // 1. Validate ad_type input
        if (!['video', 'website_banner', 'social_share'].includes(ad_type)) {
            return res.status(400).json({ error: "Invalid ad type." });
        }

        // 2. Check if advertiser has enough money in their balance to cover the total budget
        const userCheck = await db.query('SELECT balance FROM users WHERE id = $1', [advertiserId]);
        const currentBalance = parseFloat(userCheck.rows[0].balance);

        if (currentBalance < parseFloat(budget_total)) {
            return res.status(400).json({ error: "Insufficient balance. Please top up your wallet." });
        }

        // 3. Deduct total budget from advertiser's balance
        await db.query(
            'UPDATE users SET balance = balance - $1 WHERE id = $2',
            [budget_total, advertiserId]
        );

        // 4. Insert the campaign into the database
        const newCampaign = await db.query(
            `INSERT INTO campaigns (advertiser_id, title, ad_type, ad_url, budget_total, budget_remaining, cost_per_action)
             VALUES ($1, $2, $3, $4, $5, $6, $7) 
             RETURNING *`,
            [advertiserId, title, ad_type, ad_url, budget_total, budget_total, cost_per_action]
        );

        res.status(201).json({
            message: "Campaign created and funded successfully!",
            campaign: newCampaign.rows[0]
        });

    } catch (err) {
        console.error(err.message);
        res.status(500).send("Server error");
    }
});