const express = require('express');
const cors = require('cors');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg'); // Or your respective database driver (e.g., mongoose if MongoDB)

const app = express();

// 1. DYNAMIC PORT FOR RENDER
// Render injects its own port. Using process.env.PORT ensures it binds correctly.
const PORT = process.env.PORT || 10000;

// 2. PRODUCTION CORS SETTINGS
// Ensures your Vercel frontend is allowed to talk to your Render backend safely.
app.use(cors({
    origin: [
        /vercel\.app$/, // Allows all Vercel preview deployments dynamically
        "http://localhost:3000", // Safe fallback for local development
        "http://localhost:5173"
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// 3. FILE UPLOAD CONFIG (MULTER)
// This safely stores uploaded media files in Render's temp directory before serving/processing
const upload = multer({ dest: '/tmp/uploads' }); 

// 4. RAILWAY DATABASE CONNECTION (POSTGRESQL EXAMPLE)
// Uses the standard connection string provided in your Railway dashboard environment variables
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Required for SSL connections to Railway databases
    }
});

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_for_local_dev';

// ==========================================
// API ROUTE 1: REGISTER
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
    }

    try {
        // Query matching your Railway schema
        // Note: keeping default starting balances to 0.00 to prevent NaN errors on the dashboard
        const queryText = `
            INSERT INTO users (username, email, password, ugx_balance, kes_balance, tzs_balance, rwf_balance, zar_balance) 
            VALUES ($1, $2, $3, 0.00, 0.00, 0.00, 0.00, 0.00) 
            RETURNING id, username, email;
        `;
        const values = [username, email, password];
        const result = await pool.query(queryText, values);
        
        res.status(201).json({ message: 'Registration successful', user: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error occurred during registration.' });
    }
});

// ==========================================
// API ROUTE 2: LOGIN
// ==========================================
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    try {
        const queryText = `SELECT * FROM users WHERE email = $1 AND password = $2 LIMIT 1;`;
        const result = await pool.query(queryText, [email, password]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const user = result.rows[0];
        const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '24h' });
        
        // Return exactly what the premium dashboard expects (lower_case balance keys)
        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                ugx_balance: user.ugx_balance,
                kes_balance: user.kes_balance,
                tzs_balance: user.tzs_balance,
                rwf_balance: user.rwf_balance,
                zar_balance: user.zar_balance
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal Database Login Error' });
    }
});

// ==========================================
// API ROUTE 3: LAUNCH CAMPAIGN (WITH FILE UPLOAD)
// ==========================================
app.post('/api/campaigns/create', upload.single('mediaFile'), async (req, res) => {
    const { advertiserId, campaignType, title, targetCountry, currency, totalUnits } = req.body;
    
    // Check if a file was uploaded (optional fallback)
    const file = req.file; 
    const mediaUrl = file ? `/uploads/${file.filename}` : null;

    try {
        // 1. Fetch advertiser details
        const userQuery = await pool.query('SELECT * FROM users WHERE id = $1 LIMIT 1;', [advertiserId]);
        if (userQuery.rows.length === 0) {
            return res.status(404).json({ error: 'Advertiser not found.' });
        }
        
        const user = userQuery.rows[0];
        const currencyKey = `${currency.toLowerCase()}_balance`;
        const currentBalance = Number(user[currencyKey]);
        
        // Calculate basic baseline campaign cost (units * baseline modifier)
        const campaignCost = Number(totalUnits) * 10; 

        if (currentBalance < campaignCost) {
            return res.status(400).json({ error: `Insufficient funds in your ${currency} wallet.` });
        }

        const updatedBalance = currentBalance - campaignCost;

        // Start transactional updates
        await pool.query('BEGIN');

        // 2. Deduct funds from user's Railway record
        await pool.query(
            `UPDATE users SET ${currencyKey} = $1 WHERE id = $2;`,
            [updatedBalance, advertiserId]
        );

        // 3. Save Campaign to database
        const campaignQuery = `
            INSERT INTO campaigns (advertiser_id, campaign_type, title, target_country, currency, total_units, media_url, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')
            RETURNING id, title, total_units, currency;
        `;
        const campaignValues = [advertiserId, campaignType, title, targetCountry, currency, totalUnits, mediaUrl];
        const campaignResult = await pool.query(campaignQuery, campaignValues);

        await pool.commit();

        // 4. Return correct keys to frontend
        res.status(201).json({
            campaign: campaignResult.rows[0],
            newBalance: updatedBalance
        });

    } catch (err) {
        await pool.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ error: 'Failed to process transaction on database.' });
    }
});

// ==========================================
// API ROUTE 4: DEPOSITS
// ==========================================
app.post('/api/payments/deposit', async (req, res) => {
    const { amount, currency, phoneNumber } = req.body;

    try {
        // Process standard Mobile Money payment hook logic here...
        // e.g., triggering MTN/Airtel API
        const transactionId = "TXN_" + Math.random().toString(36).substr(2, 9).toUpperCase();

        res.json({
            message: `Mobile money payment request pushed successfully to ${phoneNumber}`,
            transactionId: transactionId
        });
    } catch (err) {
        res.status(500).json({ error: 'Payment request failed.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server listening dynamically on Port ${PORT}`);
});