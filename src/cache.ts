export interface CacheEntry {
  key: string;
  value: any;
  ttl: number;
  createdAt: number;
}

export class CacheManager {
  private cache = new Map<string, CacheEntry>();
  private readonly DEFAULT_TTL = 3600; // 1 hour

  set(key: string, value: any, ttl: number = this.DEFAULT_TTL): void {
    this.cache.set(key, {
      key,
      value,
      ttl,
      createdAt: Date.now()
    });
  }

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const age = Date.now() - entry.createdAt;
    if (age > entry.ttl * 1000) {
      this.cache.delete(key);
      return null;
    }

    return entry.value;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  getStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys())
    };
  }

  // Clean expired entries
  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.createdAt;
      if (age > entry.ttl * 1000) {
        this.cache.delete(key);
      }
    }
  }
}

// Global cache instance
export const cache = new CacheManager();

// Cleanup every 5 minutes
setInterval(() => cache.cleanup(), 5 * 60 * 1000);
