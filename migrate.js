require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function runMigration() {
    try {
        console.log('🔄 Conectando ao banco de dados...');
        
        // Ler arquivo SQL
        const sqlPath = path.join(__dirname, 'database', 'init.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        
        console.log('📝 Executando migração...');
        
        // Executar SQL
        await pool.query(sql);
        
        console.log('✅ Migração concluída com sucesso!');
        console.log('📊 Verificando tabelas criadas...');
        
        // Listar tabelas
        const result = await pool.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
            ORDER BY table_name;
        `);
        
        console.log('📋 Tabelas criadas:');
        result.rows.forEach(row => {
            console.log(`   ✓ ${row.table_name}`);
        });
        
        await pool.end();
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Erro na migração:', error);
        await pool.end();
        process.exit(1);
    }
}

runMigration();
