import express from 'express';
import session from 'express-session'
import connectPgSimple from 'connect-pg-simple';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDatabaseConnection, pool } from './db.js';
import authRoutes from './routes/auth.js';
import productRoutes from "./routes/products.js";
import invoiceRoutes from "./routes/invoices.js";
import analyticsRoutes from "./routes/analytics.js";
import helmet from "helmet";

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PgSessionStore = connectPgSimple(session);
const production = process.env.NODE_ENV === 'production';

function requirePageAuth(request, response, next) {
    if (!request.session?.user?.id || !request.session.user.tenantId) {
        return response.redirect('/login.html');
    }

    next();
}


if(!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length <= 32 ){
    throw new Error('Set a random SESSION_SECRET of at least 32 characters in backend/db.env');
}

app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '20kb' }));

app.use(session({
    name: 'stockroom.sid',
    secret: process.env.SESSION_SECRET,
    store: new PgSessionStore({
        pool,
        createTableIfMissing: true,
    }),
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: production,
        sameSite: 'lax',
        maxAge: 8* 60 * 60 * 1000,
    },

}))

for(const filename of ['index.html', 'login.html', 'styles.css', 'auth.js', 'app.js']){
    const route = filename === 'index.html' ? '/' : `/${filename}`;
    app.get(route, ...(filename === 'index.html' ? [requirePageAuth] : []), (_request, response) => {
        response.sendFile(path.join(projectRoot, filename));
    });
}
app.get("/index.html", requirePageAuth, (_request, response) => {
  response.sendFile(path.join(projectRoot, "index.html"));
});

app.get("/api/health", async (_request, response) => {
  try {
    await checkDatabaseConnection();
    response.json({ status: "ok", database: "connected" });
  } catch (error) {
    console.error("Database check failed:", error.message);
    response.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.use('/api/auth', authRoutes);
app.use("/api/products", productRoutes);
app.use("/api/invoices", invoiceRoutes);
app.use("/api/analytics", analyticsRoutes);

app.use((error, _request, response, _next) => {
  if (response.headersSent) return;
  if (error.type === "entity.parse.failed") {
    return response.status(400).json({ message: "Request body must contain valid JSON." });
  }
  console.error("Unhandled request error:", error.message);
  response.status(500).json({ message: "The server could not complete the request." });
});

async function start() {
  try {
    await checkDatabaseConnection();
    app.listen(port, host, () => {
      console.log(`Server ready at http://${host}:${port}`);
    });
  } catch (error) {
    console.error("Could not connect to PostgreSQL:", error.message);
    await pool.end();
    process.exitCode = 1;
  }

}

start();