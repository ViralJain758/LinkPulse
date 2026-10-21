import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

export const query = (text, params) => pool.query(text, params);

// Postgres error code for unique_violation
export const isUniqueViolation = (err) => err?.code === '23505';

// Postgres error code for foreign_key_violation (e.g. the folder was deleted mid-request)
export const isForeignKeyViolation = (err) => err?.code === '23503';
