import { Router } from 'express';
import { db } from '../db/client';

const DEFAULTS: Record<string, number> = {
    oauth_access_token_lifetime: 3600,
    oauth_refresh_token_lifetime: 2592000,
    session_lifetime: 86400,
};

const RANGES: Record<string, [number, number]> = {
    oauth_access_token_lifetime: [900, 86400],
    oauth_refresh_token_lifetime: [86400, 31536000],
    session_lifetime: [3600, 2592000],
};

export async function getUserSetting(userId: string, key: string): Promise<number> {
    const result = await db.query(
        `SELECT setting_value FROM user_settings WHERE user_id = $1 AND setting_key = $2`,
        [userId, key]
    );
    if (result.rows.length > 0) return parseInt(result.rows[0].setting_value);
    return DEFAULTS[key] ?? 3600;
}

export const settingsRouter = Router();

settingsRouter.get('/api/settings', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT setting_key, setting_value FROM user_settings WHERE user_id = $1`,
            [req.userId]
        );

        const settings: Record<string, number> = { ...DEFAULTS };
        for (const row of result.rows) {
            settings[row.setting_key] = parseInt(row.setting_value);
        }

        res.json({ settings, ranges: RANGES, defaults: DEFAULTS });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

settingsRouter.put('/api/settings', async (req, res) => {
    try {
        const { key, value } = req.body;
        if (!key || value === undefined) {
            return res.status(400).json({ error: 'key and value are required' });
        }

        if (!DEFAULTS.hasOwnProperty(key)) {
            return res.status(400).json({ error: `Unknown setting: ${key}` });
        }

        const numValue = parseInt(value);
        const [min, max] = RANGES[key];
        if (isNaN(numValue) || numValue < min || numValue > max) {
            return res.status(400).json({ error: `Value must be between ${min} and ${max}` });
        }

        await db.query(
            `INSERT INTO user_settings (user_id, setting_key, setting_value)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, setting_key) DO UPDATE SET setting_value = $3`,
            [req.userId, key, numValue.toString()]
        );

        res.json({ ok: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});
