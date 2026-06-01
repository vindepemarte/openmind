import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { db } from '../db/client';

export const apiKeysRouter = Router();

apiKeysRouter.get('/api/keys', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT id, name, created_at, last_used_at FROM api_keys
             WHERE user_id = $1 ORDER BY created_at DESC`,
            [req.userId]
        );
        res.json(result.rows);
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

apiKeysRouter.post('/api/keys', async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: 'name is required' });

        const rawKey = 'om_' + randomBytes(16).toString('hex');
        const keyHash = createHash('sha256').update(rawKey).digest('hex');

        const result = await db.query(
            `INSERT INTO api_keys (user_id, key_hash, name)
             VALUES ($1, $2, $3) RETURNING id, name, created_at`,
            [req.userId, keyHash, name]
        );

        res.json({
            ...result.rows[0],
            key: rawKey,
            warning: 'Save this key now. It cannot be shown again.'
        });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});

apiKeysRouter.delete('/api/keys/:id', async (req, res) => {
    try {
        const result = await db.query(
            `DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id`,
            [req.params.id, req.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'API key not found' });
        }

        res.json({ deleted: true });
    } catch (error: any) {
        res.status(500).json({ error: error.message });
    }
});
