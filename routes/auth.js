const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const router = express.Router();
const db = require('../db');

const ALLOWED_ROLES = ['advertiser', 'earner'];
const CURRENCIES = ['UGX', 'KES', 'TZS', 'RWF', 'ZAR'];

router.post('/register', async (req, res) => {
    const { username, email, password, role } = req.body;

    if (!username || !email || !password) {
        return res.status(400).json({ error: 'All fields are required.' });
    }
    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const userRole = ALLOWED_ROLES.includes(role) ? role : 'advertiser';

    try {
        const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length) {
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const result = await db.query(
            `INSERT INTO users (username, email, password_hash, role)
             VALUES ($1, $2, $3, $4)
             RETURNING id, username, email, role`,
            [username, email, passwordHash, userRole]
        );
        const user = result.rows[0];

        // Seed a zeroed wallet row per currency (used by earners for balance/pending_balance)
        for (const currency of CURRENCIES) {
            await db.query(
                `INSERT INTO wallets (user_id, currency, balance, pending_balance) VALUES ($1, $2, 0, 0)`,
                [user.id, currency]
            );
        }

        res.status(201).json({ message: 'Registration successful', user });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error occurred during registration.' });
    }
});

router.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        if (!result.rows.length) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const user = result.rows[0];
        const match = await bcrypt.compare(password, user.password_hash);
        if (!match) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const walletsResult = await db.query(
            'SELECT currency, balance, pending_balance FROM wallets WHERE user_id = $1',
            [user.id]
        );
        const wallets = {};
        walletsResult.rows.forEach((w) => {
            wallets[w.currency] = { balance: Number(w.balance), pending: Number(w.pending_balance) };
        });

        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({
            token,
            user: { id: user.id, username: user.username, email: user.email, role: user.role, wallets }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Internal database login error.' });
    }
});

module.exports = router;
