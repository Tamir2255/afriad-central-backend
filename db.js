const { Pool } = require('pg');
require('dotenv').config();

// This automatically selects DATABASE_URL from Railway (live) or your .env file (local)
const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => {
    console.log('Database connected successfully!');
});

pool.on('error', (err) => {
    console.error('Unexpected database connection error:', err);
});

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool // Exporting pool in case you need to close connections or run direct tests
};