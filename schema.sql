-- ============================================================
-- AfriAd Platform — PostgreSQL Schema (Railway)
-- Run this once against your Railway database before first deploy.
-- ============================================================

CREATE TYPE user_role AS ENUM ('advertiser', 'earner', 'admin');
CREATE TYPE currency_code AS ENUM ('UGX', 'KES', 'TZS', 'RWF', 'ZAR');
CREATE TYPE campaign_status AS ENUM ('unpaid', 'active', 'completed', 'rejected');
CREATE TYPE task_status AS ENUM ('approved', 'pending_approval', 'rejected');

CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50) NOT NULL,
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role          user_role NOT NULL DEFAULT 'advertiser',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per user per currency. Used by earners (balance/pending_balance).
-- Advertisers don't spend from this — they pay per campaign via checkout.
CREATE TABLE wallets (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    currency        currency_code NOT NULL,
    balance         NUMERIC(14,2) NOT NULL DEFAULT 0.00,   -- withdrawable
    pending_balance NUMERIC(14,2) NOT NULL DEFAULT 0.00,   -- awaiting admin approval
    UNIQUE (user_id, currency)
);

CREATE TABLE campaigns (
    id               SERIAL PRIMARY KEY,
    advertiser_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    campaign_type    VARCHAR(30) NOT NULL,  -- classified | banner_cpc | video_cpv | social_flat
    title            VARCHAR(255) NOT NULL,
    target_country   VARCHAR(50) NOT NULL,
    currency         currency_code NOT NULL,
    unit_cost        NUMERIC(14,4) NOT NULL,
    total_units      INTEGER NOT NULL,
    remaining_budget NUMERIC(14,2) NOT NULL,
    media_url        TEXT,
    destination_url  TEXT,
    invoice_ref      VARCHAR(50) UNIQUE NOT NULL,
    status           campaign_status NOT NULL DEFAULT 'unpaid',
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tasks (
    id                   SERIAL PRIMARY KEY,
    campaign_id          INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    earner_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task_type            VARCHAR(30) NOT NULL, -- video | banner | social
    earner_amount        NUMERIC(14,4) NOT NULL,
    advertiser_deduction NUMERIC(14,4) NOT NULL,
    currency             currency_code NOT NULL,
    proof_url            TEXT,
    status               task_status NOT NULL DEFAULT 'approved',
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reviewed_at          TIMESTAMPTZ
);

CREATE TABLE payouts (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount        NUMERIC(14,2) NOT NULL,
    currency      currency_code NOT NULL,
    phone_number  VARCHAR(20),
    network       VARCHAR(20),
    provider_ref  VARCHAR(100),
    status        VARCHAR(20) NOT NULL DEFAULT 'processing',
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_campaigns_advertiser ON campaigns(advertiser_id);
CREATE INDEX idx_campaigns_status_type ON campaigns(status, campaign_type);
CREATE INDEX idx_tasks_earner ON tasks(earner_id);
CREATE INDEX idx_tasks_campaign ON tasks(campaign_id);

-- After deploying, promote yourself to admin manually, e.g.:
-- UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
