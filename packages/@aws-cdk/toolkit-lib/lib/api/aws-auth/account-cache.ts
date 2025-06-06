import * as path from 'path';
import * as fs from 'fs-extra';
import type { Account } from './sdk-provider';
import { cdkCacheDir } from '../../util';

/**
 * Disk cache which maps access key IDs to account IDs.
 * Usage:
 *   cache.get(accessKey) => accountId | undefined
 *   cache.put(accessKey, accountId)
 */
export class AccountAccessKeyCache {
  /**
   * Max number of entries in the cache, after which the cache will be reset.
   */
  public static readonly MAX_ENTRIES = 1000;

  /**
   * The default path used for the accounts access key cache
   */
  public static get DEFAULT_PATH(): string {
    // needs to be a getter because cdkCacheDir can be set via env variable and might change
    return path.join(cdkCacheDir(), 'accounts_partitions.json');
  }

  private readonly cacheFile: string;

  private readonly debug: (msg: string) => Promise<void>;

  /**
   * @param filePath - Path to the cache file
   */
  constructor(filePath: string = AccountAccessKeyCache.DEFAULT_PATH, debugFn: (msg: string) => Promise<void>) {
    this.cacheFile = filePath;
    this.debug = debugFn;
  }

  /**
   * Tries to fetch the account ID from cache. If it's not in the cache, invokes
   * the resolver function which should retrieve the account ID and return it.
   * Then, it will be stored into disk cache returned.
   *
   * Example:
   *
   *    const accountId = cache.fetch(accessKey, async () => {
   *      return await fetchAccountIdFromSomewhere(accessKey);
   *    });
   */
  public async fetch<A extends Account>(accessKeyId: string, resolver: () => Promise<A>) {
    // try to get account ID based on this access key ID from disk.
    const cached = await this.get(accessKeyId);
    if (cached) {
      await this.debug(`Retrieved account ID ${cached.accountId} from disk cache`);
      return cached;
    }

    // if it's not in the cache, resolve and put in cache.
    const account = await resolver();
    if (account) {
      await this.put(accessKeyId, account);
    }

    return account;
  }

  /** Get the account ID from an access key or undefined if not in cache */
  public async get(accessKeyId: string): Promise<Account | undefined> {
    const map = await this.loadMap();
    return map[accessKeyId];
  }

  /** Put a mapping between access key and account ID */
  public async put(accessKeyId: string, account: Account) {
    let map = await this.loadMap();

    // nuke cache if it's too big.
    if (Object.keys(map).length >= AccountAccessKeyCache.MAX_ENTRIES) {
      map = {};
    }

    map[accessKeyId] = account;
    await this.saveMap(map);
  }

  private async loadMap(): Promise<{ [accessKeyId: string]: Account }> {
    try {
      return await fs.readJson(this.cacheFile);
    } catch (e: any) {
      // File doesn't exist or is not readable. This is a cache,
      // pretend we successfully loaded an empty map.
      if (e.code === 'ENOENT' || e.code === 'EACCES') {
        return {};
      }
      // File is not JSON, could be corrupted because of concurrent writes.
      // Again, an empty cache is fine.
      if (e instanceof SyntaxError) {
        return {};
      }
      throw e;
    }
  }

  private async saveMap(map: { [accessKeyId: string]: Account }) {
    try {
      await fs.ensureFile(this.cacheFile);
      await fs.writeJson(this.cacheFile, map, { spaces: 2 });
    } catch (e: any) {
      // File doesn't exist or file/dir isn't writable. This is a cache,
      // if we can't write it then too bad.
      if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EROFS') {
        return;
      }
      throw e;
    }
  }
}
