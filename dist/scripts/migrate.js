import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { configFromEnv } from '../src/config.js';
import { postgres } from '../src/db.js';
const db = postgres(configFromEnv());
try {
    await db.transaction(async (sql) => {
        await sql.query("SELECT pg_advisory_xact_lock(hashtextextended('lex-schema-migration',0))");
        await sql.query('CREATE SCHEMA IF NOT EXISTS lex; CREATE TABLE IF NOT EXISTS lex.schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
        for (const name of (await readdir('migrations')).filter((n) => n.endsWith('.sql')).sort()) {
            const text = await readFile('migrations/' + name, 'utf8');
            const checksum = createHash('sha256').update(text).digest('hex');
            const row = (await sql.query('SELECT checksum FROM lex.schema_migrations WHERE name=$1', [name])).rows[0];
            if (row) {
                if (row.checksum !== checksum)
                    throw Error('Applied migration changed: ' + name);
                continue;
            }
            await sql.query(text);
            await sql.query('INSERT INTO lex.schema_migrations(name,checksum) VALUES($1,$2)', [
                name,
                checksum,
            ]);
            console.log('Applied ' + name);
        }
    });
}
finally {
    await db.close();
}
//# sourceMappingURL=migrate.js.map