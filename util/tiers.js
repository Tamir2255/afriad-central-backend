// ============================================================
// util/tiers.js
// Follower-count thresholds and tier logic for earners.
//
// Two ways an account gets a tier:
//   1. AUTOMATIC — an exact followers_count is known (from an auto-verify
//      API, e.g. YouTube) and the tier is derived from it.
//   2. MANUAL — an admin reviewed a TikTok/X profile by eye (no paid
//      scraping API yet) and assigned a bucket directly via manual_tier,
//      without needing an exact number. manual_tier always wins when set.
//
// Buckets:
//   - TikTok / YouTube: below 100 = ineligible, 100-500 = micro, 500+ = standard
//   - X (Twitter):      below 1000 = ineligible, 1000-5000 = micro, 5000+ = standard
//     (10x scaling assumption on the X thresholds — confirm with Tamir if wrong)
// ============================================================

const THRESHOLDS = {
    tiktok:  { min: 100,  standardAt: 500 },
    youtube: { min: 100,  standardAt: 500 },
    twitter: { min: 1000, standardAt: 5000 }
};

const MICRO_TIER_MAX_CAMPAIGN_UNITS = 100;
const VALID_MANUAL_TIERS = ['below_min', 'micro', 'standard'];

function tierForAccount(account) {
    // Manual admin assignment always takes priority (used for TikTok/X
    // until a paid scraping API is wired in).
    if (account.manual_tier) {
        return account.manual_tier === 'below_min' ? 'ineligible' : account.manual_tier;
    }
    const t = THRESHOLDS[account.platform];
    if (!t || account.followers_count == null) return 'ineligible';
    if (account.followers_count < t.min) return 'ineligible';
    return account.followers_count >= t.standardAt ? 'standard' : 'micro';
}

// An earner's overall tier is the BEST tier across all their verified accounts.
function overallTier(socialAccounts) {
    let best = 'ineligible';
    for (const acc of socialAccounts) {
        if (acc.verification_status !== 'verified') continue;
        const t = tierForAccount(acc);
        if (t === 'standard') return 'standard';
        if (t === 'micro') best = 'micro';
    }
    return best;
}

function canAccessCampaign(tier, campaignTotalUnits) {
    if (tier === 'ineligible') return false;
    if (tier === 'standard') return true;
    return Number(campaignTotalUnits) <= MICRO_TIER_MAX_CAMPAIGN_UNITS;
}

module.exports = {
    THRESHOLDS, MICRO_TIER_MAX_CAMPAIGN_UNITS, VALID_MANUAL_TIERS,
    tierForAccount, overallTier, canAccessCampaign
};
