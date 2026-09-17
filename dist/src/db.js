import pg from 'pg';
export function postgres(config) {
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
    const wrap = (client) => ({
        async query(text, values = []) {
            const result = await client.query(text, values);
            return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
    });
    return {
        ...wrap(pool),
        async transaction(fn) {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const result = await fn(wrap(client));
                await client.query('COMMIT');
                return result;
            }
            catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
            finally {
                client.release();
            }
        },
        close: () => pool.end(),
    };
}
//# sourceMappingURL=db.js.map