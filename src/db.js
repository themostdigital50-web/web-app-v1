import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: 'db.env'});

const { Pool } = pg;
export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
})

export async function checkDatabaseConnection(){
    await pool.query('SELECT 1');
}