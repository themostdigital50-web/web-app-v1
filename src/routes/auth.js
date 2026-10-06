import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';
import requireRole from '../middleware/require-role.js';


const router = Router();

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: {message: 'Too many attempts. Please wait 15 minutes'}
});

function cleanText(value, maxLength) {
    return typeof value === 'string'? value.trim().slice(0, maxLength): '';

}

function validEmail(email) {
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function regenerateSession(request) {
    return new Promise((resolve, reject) => {
        request.session.regenerate((error) => {
            if(error) reject(error);
            else resolve();
        });
    });
}

function saveSession(requests) {
    return new Promise((resolve, reject) => {
        requests.session.save((error) => {
            if(error) reject(error);
            else resolve();

        })
    })
}

async function startSession(request, user) {
    await regenerateSession(request);
    request.session.user = {
        id: String(user.id),
        name: user.full_name,
        email: user.email,
        role: user.role,
        tenantId: String(user.tenant_id),
        tenantName: user.tenant_name,
    };
    await saveSession(request);
}

router.post('/register', authLimiter, async (request, response) => {
    const companyName = cleanText(request.body?.companyName, 120)
    const fullName = cleanText(request.body?.name, 120);
    const email = cleanText(request.body?.email, 254).toLowerCase();
    const password = typeof request.body?.password === 'string' 
    ? request.body.password
    : '';

    if( 
        !companyName ||
        !fullName ||
        !validEmail(email) ||
        password.length < 12 ||
        Buffer.byteLength(password, 'utf-8') > 72
    ){
        return response.status(400).json({
            message: 'Enter a company name, full name, a valid email and a password of 12-72 bytes.',

        });
    }

    const passwordHash = await bcrypt.hash(password, 12)
    const client = await pool.connect();
    let user;

    try{
        await client.query('Begin');
        const tenantResult = await client.query(
            'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name',
            [companyName],
        )

        const tenant = tenantResult.rows[0];

        const userResult = await client.query(
            `INSERT INTO users (tenant_id, full_name, email, password_hash, role)
            VALUES ($1, $2, $3, $4, 'tenant_admin')
            RETURNING id, tenant_id, full_name, email, password_hash, role`,
            [tenant.id, fullName, email, passwordHash],
        );
        user = {
            ...userResult.rows[0],
            tenant_name: tenant.name,
        };

        await client.query('Commit');

    }

    catch(error) {
        await client.query('Rollback')

        if(error.code === '23505') {
            return response.status(409).json({
                message: 'An account with that email already exists.',

            });
        }

        throw error;
    }
    finally{
        client.release();
    }

    await startSession(request, user);

    response.status(201).json({
        user: {
            id: String(user.id),
            name: user.full_name,
            email: user.email,
            role: user.role,
    },
    tenant: {
        id: String(user.tenant_id),
        name: user.tenant_name,
    },

});

});

router.post('/login', authLimiter, async (request, response) => {
    const email = cleanText(request.body?.email, 254).toLowerCase()
    const password = typeof request.body?.password === 'string'
    ? request.body.password
    : '';

    if(!validEmail(email) || !password || Buffer.byteLength(password, 'utf-8') >72) {
        return response.status(400).json({
            message: 'Enter a valid emaill and password to proceed',
        });
     }

    const result = await pool.query(
        `SELECT users.id, users.tenant_id, users.full_name, users.email,
                users.password_hash, users.role, tenants.name AS tenant_name
        From users
        JOIN tenants ON tenants.id = users.tenant_id
        WHERE LOWER(users.email) = $1
        LIMIT 1`,
        [email],
    );
    const user = result.rows[0];

    if(!user || !(await bcrypt.compare(password, user.password_hash))) {
        return response.status(401).json({
            message: 'Email or password is incorrect, try again',
        });
    }

    await startSession(request, user);

    response.json({
        user: {
            id: String(user.id),
            name: user.full_name,
            email: user.email,
            role: user.role,
        },
        tenant: {
            id: String(user.tenant_id),
            name: user.tenant_name,
        },

    })
})

router.get('/employees', requireRole('tenant_admin'), async (request, response) => {
    try {
        const result = await pool.query(
            `SELECT id, full_name, email, role, created_at
             FROM users
             WHERE tenant_id = $1
             ORDER BY created_at, id`,
            [request.session.user.tenantId],
        );
        response.json({
            employees: result.rows.map((user) => ({
                id: String(user.id),
                name: user.full_name,
                email: user.email,
                role: user.role,
                createdAt: user.created_at,
            })),
        });
    } catch (error) {
        console.error('Could not list company users:', error.message);
        response.status(500).json({ message: 'Could not load company users.' });
    }
});

router.post('/employees', requireRole('tenant_admin'), async (request, response) => {
    const fullName = cleanText(request.body?.name, 120);
    const email = cleanText(request.body?.email, 254).toLowerCase();
    const password = typeof request.body?.password === 'string' ? request.body.password : '';

    if (!fullName || !validEmail(email) || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
        return response.status(400).json({
            message: 'Enter a name, valid email, and password of 12–72 bytes.',
        });
    }

    try {
        const passwordHash = await bcrypt.hash(password, 12);
        const result = await pool.query(
            `INSERT INTO users (tenant_id, full_name, email, password_hash, role)
             VALUES ($1, $2, $3, $4, 'tenant_staff')
             RETURNING id, full_name, email, role, created_at`,
            [request.session.user.tenantId, fullName, email, passwordHash],
        );
        const employee = result.rows[0];
        response.status(201).json({
            employee: {
                id: String(employee.id),
                name: employee.full_name,
                email: employee.email,
                role: employee.role,
                createdAt: employee.created_at,
            },
        });
    } catch (error) {
        if (error.code === '23505') {
            return response.status(409).json({ message: 'An account with that email already exists.' });
        }
        console.error('Could not create staff account:', error.message);
        response.status(500).json({ message: 'Could not create staff account.' });
    }
});

router.patch('/tenant', requireRole('tenant_admin'), async (request, response) => {
    const companyName = cleanText(request.body?.companyName, 120);
    if (!companyName) {
        return response.status(400).json({ message: 'Company name must be 1–120 characters.' });
    }

    try {
        const result = await pool.query(
            'UPDATE tenants SET name = $1 WHERE id = $2 RETURNING id, name',
            [companyName, request.session.user.tenantId],
        );
        if (!result.rowCount) {
            return response.status(404).json({ message: 'Company was not found.' });
        }

        request.session.user.tenantName = result.rows[0].name;
        await saveSession(request);
        response.json({ tenant: { id: String(result.rows[0].id), name: result.rows[0].name } });
    } catch (error) {
        console.error('Could not update company settings:', error.message);
        response.status(500).json({ message: 'Could not update company settings.' });
    }
});

router.get('/me',(request, response) => {
    if(!request.session?.user) {
        return response.status(401).json({
            message: 'Please log in'
        });
    }
    const user = request.session.user;

   response.json({
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    },
    tenant: {
      id: user.tenantId,
      name: user.tenantName,
    },
    })
})

router.post('/logout', async (request, response) => {
    if(!request.session) {
        return response.status(204).end();
    }

    await new Promise((resolve, reject) => {
        request.session.destroy((error) => {
            if(error) reject(error)
            else resolve();
            
        })
    })

    response.clearCookie('stockroom.sid', {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
    });

    response.status(204).end()
})

export default router;