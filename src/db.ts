import pg from 'pg';
import type { Config } from './config.js';
export interface Result<T> {
  rows: T[];
  rowCount: number;
}
export interface Sql {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Result<T>>;
}
export interface Database extends Sql {
  transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export function postgres(config: Config): Database {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.poolSize,
    ssl: config.databaseSsl
      ? {
          rejectUnauthorized: true,
          ...(config.databaseCa ? { ca: config.databaseCa.replace(/\\n/g, '\n') } : {}),
        }
      : false,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    statement_timeout: 15000,
    application_name: 'statelines-lex',
  });
  pool.on('error', (error) => console.error('Idle database connection failed:', error.message));
  const wrap = (client: pg.Pool | pg.PoolClient): Sql => ({
    async query<T>(text: string, values: unknown[] = []) {
      const result = await client.query(text, values);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
    },
  });
  return {
    ...wrap(pool),
    async transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
