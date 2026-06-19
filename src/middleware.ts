import { Request, Response, NextFunction } from 'express';
import { cache } from './cache';
import crypto from 'crypto';

export function cacheMiddleware(ttl: number = 3600) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Generate cache key from request
    const cacheKey = crypto
      .createHash('md5')
      .update(`${req.method}:${req.originalUrl}:${JSON.stringify(req.body || {})}`)
      .digest('hex');

    // Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('X-Cache-Key', cacheKey);
      return res.json(cached);
    }

    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json method to cache response
    res.json = function(body: any) {
      cache.set(cacheKey, body, ttl);
      res.setHeader('X-Cache', 'MISS');
      res.setHeader('X-Cache-Key', cacheKey);
      return originalJson(body);
    };

    next();
  };
}

export function rateLimitMiddleware(maxRequests: number = 100, windowMs: number = 60000) {
  const requests = new Map<string, number[]>();

  return (req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    
    const userRequests = requests.get(ip) || [];
    const recentRequests = userRequests.filter(time => now - time < windowMs);

    if (recentRequests.length >= maxRequests) {
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: Math.ceil((recentRequests[0] + windowMs - now) / 1000)
      });
    }

    recentRequests.push(now);
    requests.set(ip, recentRequests);
    next();
  };
}
