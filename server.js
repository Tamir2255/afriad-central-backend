const authenticateUser = require('./middleware');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Test Route to verify server is live
app.get('/', (req, res) => {
    res.send('AdPlatform Backend API is running successfully!');
});

// 1. REGISTER USER ROUTE
app.post('/api/auth/register', async (req, res) => {
    const { username, email, password, role } = req.body;

    try {
        // Validate role input
        if (!['advertiser', 'earner'].includes(role)) {
            return res.status(400).json({ error: "Role must be 'advertiser' or 'earner'" });
        }

        // Hash the password
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(password, salt);

        // Insert user into PostgreSQL database
        const newUser = await db.query(
            `INSERT INTO users (username, email, password_hash, role) 
             VALUES ($1, $2, $3, $4) RETURNING id, username, email, role, balance, created_at`,
            [username, email, passwordHash, role]
        );

        res.status(201).json({ message: "User registered successfully!", user: newUser.rows[0] });
    } catch (err) {
        console.error(err.message);
        if (err.code === '23505') { // Unique violation error code in PostgreSQL
            return res.status(400).json({ error: "Username or Email already exists." });
        }
        res.status(500).send("Server error");
    }
});

// 2. LOGIN USER ROUTE
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    try {
        // Check if user exists
        const userResult = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            return res.status(400).json({ error: "Invalid credentials." });
        }

        const user = userResult.rows[0];

        // Verify password
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) {
            return res.status(400).json({ error: "Invalid credentials." });
        }

        // Generate JWT token
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

// Start Server
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});