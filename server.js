require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.query('SELECT NOW()', async (err, res) => {
    if (err) {
        console.error('❌ Database connection error:', err);
    } else {
        console.log('✅ Database connected:', res.rows[0].now);
        
        // Auto-run migrations
        try {
            console.log('🔄 Running auto-migrations...');
            
            const fs = require('fs');
            const path = require('path');
            const sqlPath = path.join(__dirname, 'database', 'init.sql');
            
            if (fs.existsSync(sqlPath)) {
                const sql = fs.readFileSync(sqlPath, 'utf8');
                await pool.query(sql);
                console.log('✅ Migrations completed successfully!');
            } else {
                console.log('⚠️ Migration file not found, skipping...');
            }
        } catch (migrationError) {
            console.log('⚠️ Migration error (may be already applied):', migrationError.message);
        }
    }
});

// Middleware
app.use(cors({
    origin: ['https://linkiq.tech', 'https://www.linkiq.tech', 'https://linkiq-pro.vercel.app'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Auth Middleware
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ message: 'Token não fornecido' });
    }
    
    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Token inválido' });
        }
        req.user = user;
        next();
    });
};

// ============================================
// ROUTES
// ============================================

// Health check
app.get('/', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: '🚀 LinkIQ Backend API está rodando!',
        timestamp: new Date().toISOString()
    });
});

// ============================================
// AUTH ROUTES
// ============================================

// Signup
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { email, name, password } = req.body;
        
        if (!email || !name) {
            return res.status(400).json({ message: 'Email e nome são obrigatórios' });
        }
        
        // Check if email exists
        const existingUser = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );
        
        if (existingUser.rows.length > 0) {
            return res.status(400).json({ message: 'Email já cadastrado' });
        }
        
        // Check IP limit for free accounts (2 accounts per IP)
        const ip = req.ip || req.connection.remoteAddress;
        const ipCount = await pool.query(
            'SELECT COUNT(*) FROM users WHERE created_ip = $1 AND plan = $2',
            [ip, 'free']
        );
        
        if (parseInt(ipCount.rows[0].count) >= 2) {
            return res.status(403).json({ 
                message: '⚠️ Limite atingido: Máximo 2 contas gratuitas por IP.\n\n💎 Faça upgrade para o plano STARTER (R$ 97/mês) para criar mais projetos!' 
            });
        }
        
        // Hash password (if provided, otherwise create random)
        const hashedPassword = password 
            ? await bcrypt.hash(password, 10)
            : await bcrypt.hash(Math.random().toString(36), 10);
        
        // Insert user
        const result = await pool.query(
            'INSERT INTO users (name, email, password, plan, created_ip, created_at) VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING id, name, email, plan',
            [name, email, hashedPassword, 'free', ip]
        );
        
        const user = result.rows[0];
        
        // Generate token
        const token = jwt.sign(
            { id: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );
        
        res.status(201).json({
            message: 'Conta criada com sucesso!',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                plan: user.plan
            }
        });
        
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ message: 'Erro ao criar conta' });
    }
});

// Login
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        if (!email || !password) {
            return res.status(400).json({ message: 'Email e senha são obrigatórios' });
        }
        
        const result = await pool.query(
            'SELECT * FROM users WHERE email = $1',
            [email]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Credenciais inválidas' });
        }
        
        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ message: 'Credenciais inválidas' });
        }
        
        const token = jwt.sign(
            { id: user.id, email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '30d' }
        );
        
        res.json({
            message: 'Login realizado com sucesso!',
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                plan: user.plan
            }
        });
        
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Erro ao fazer login' });
    }
});

// ============================================
// USER ROUTES
// ============================================

// Get user profile
app.get('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, email, plan, company, created_at FROM users WHERE id = $1',
            [req.user.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Usuário não encontrado' });
        }
        
        const user = result.rows[0];
        
        // Get stats
        const projectsCount = await pool.query(
            'SELECT COUNT(*) FROM projects WHERE user_id = $1',
            [req.user.id]
        );
        
        const backlinksCount = await pool.query(
            'SELECT COUNT(*) FROM backlinks WHERE project_id IN (SELECT id FROM projects WHERE user_id = $1)',
            [req.user.id]
        );
        
        res.json({
            ...user,
            stats: {
                projects: parseInt(projectsCount.rows[0].count),
                backlinks: parseInt(backlinksCount.rows[0].count),
                checks: 0,
                alerts: 0
            }
        });
        
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ message: 'Erro ao buscar perfil' });
    }
});

// Update user profile
app.put('/api/user/profile', authenticateToken, async (req, res) => {
    try {
        const { name, company } = req.body;
        
        await pool.query(
            'UPDATE users SET name = $1, company = $2, updated_at = NOW() WHERE id = $3',
            [name, company, req.user.id]
        );
        
        res.json({ message: 'Perfil atualizado com sucesso!' });
        
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ message: 'Erro ao atualizar perfil' });
    }
});

// ============================================
// API KEYS ROUTES
// ============================================

// Save API keys
app.post('/api/user/api-keys', authenticateToken, async (req, res) => {
    try {
        const { keyType, keyValue } = req.body;
        
        if (!keyType || !keyValue) {
            return res.status(400).json({ message: 'Tipo e valor da chave são obrigatórios' });
        }
        
        // Encrypt key (simple base64, in production use proper encryption)
        const encryptedKey = Buffer.from(keyValue).toString('base64');
        
        // Upsert
        await pool.query(
            'INSERT INTO api_keys (user_id, key_type, key_value, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (user_id, key_type) DO UPDATE SET key_value = $3, updated_at = NOW()',
            [req.user.id, keyType, encryptedKey]
        );
        
        res.json({ message: 'API Key salva com sucesso!' });
        
    } catch (error) {
        console.error('Save API key error:', error);
        res.status(500).json({ message: 'Erro ao salvar API key' });
    }
});

// Get API keys status
app.get('/api/user/api-keys/status', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT key_type FROM api_keys WHERE user_id = $1',
            [req.user.id]
        );
        
        const statuses = {
            openai: false,
            sendgrid: false,
            ahrefs: false
        };
        
        result.rows.forEach(row => {
            statuses[row.key_type] = true;
        });
        
        res.json(statuses);
        
    } catch (error) {
        console.error('Get API keys status error:', error);
        res.status(500).json({ message: 'Erro ao buscar status das API keys' });
    }
});

// ============================================
// PROJECTS ROUTES
// ============================================

// Create project
app.post('/api/projects', authenticateToken, async (req, res) => {
    try {
        const { name, domain, urls } = req.body;
        
        if (!name || !domain) {
            return res.status(400).json({ message: 'Nome e domínio são obrigatórios' });
        }
        
        // Check plan limits
        const user = await pool.query('SELECT plan FROM users WHERE id = $1', [req.user.id]);
        const plan = user.rows[0].plan;
        
        const projectsCount = await pool.query(
            'SELECT COUNT(*) FROM projects WHERE user_id = $1',
            [req.user.id]
        );
        
        const limits = {
            free: 1,
            starter: 10,
            professional: 30,
            enterprise: 999999
        };
        
        if (parseInt(projectsCount.rows[0].count) >= limits[plan]) {
            return res.status(403).json({ 
                message: `Limite de projetos atingido para o plano ${plan.toUpperCase()}. Faça upgrade!` 
            });
        }
        
        // Create project
        const result = await pool.query(
            'INSERT INTO projects (user_id, name, domain, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
            [req.user.id, name, domain]
        );
        
        const project = result.rows[0];
        
        // Add URLs
        if (urls && urls.length > 0) {
            for (const url of urls) {
                await pool.query(
                    'INSERT INTO monitored_urls (project_id, url, created_at) VALUES ($1, $2, NOW())',
                    [project.id, url]
                );
            }
        }
        
        res.status(201).json({
            message: 'Projeto criado com sucesso!',
            project
        });
        
    } catch (error) {
        console.error('Create project error:', error);
        res.status(500).json({ message: 'Erro ao criar projeto' });
    }
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
    console.log(`🚀 Servidor rodando na porta ${PORT}`);
    console.log(`🌍 Ambiente: ${process.env.NODE_ENV}`);
    console.log(`🔗 Frontend: ${process.env.FRONTEND_URL}`);
});
