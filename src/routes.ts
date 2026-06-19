import { Router } from 'express';
import { cache } from './cache';
import { cacheMiddleware, rateLimitMiddleware } from './middleware';

const router = Router();

// Cache stats endpoint
router.get('/cache/stats', (req, res) => {
  const stats = cache.getStats();
  res.json(stats);
});

// Clear cache endpoint
router.post('/cache/clear', (req, res) => {
  cache.clear();
  res.json({ message: 'Cache cleared successfully' });
});

// Health check
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    cache: cache.getStats()
  });
});

export default router;
