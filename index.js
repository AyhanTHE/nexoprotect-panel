// =================================================================
//      INDEX.JS COMPLET AVEC INTÉGRATION PAYPAL (SANS WEBHOOKS)
// =================================================================

// --- IMPORTS ---
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const paypal = require('@paypal/checkout-server-sdk');
require('dotenv').config();

// --- INITIALISATION & CONFIGURATION ---
const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'dashboard', 'views'));

// --- MIDDLEWARES ---
app.use(express.static(path.join(__dirname, 'src', 'dashboard', 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'une-super-phrase-secrete-pour-nexoprotect',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, maxAge: 1000 * 60 * 60 * 24 }
}));

// --- CONNEXION À LA BASE DE DONNÉES ---
let db;
const mongoClient = new MongoClient(process.env.DATABASE_URL);
mongoClient.connect().then(() => {
    console.log('✅ Panel web connecté à la base de données MongoDB !');
    db = mongoClient.db('nexoprotect_db');
}).catch(err => console.error("❌ Erreur de connexion à MongoDB:", err));

// --- CONFIGURATION DU CLIENT PAYPAL ---
const Environment = process.env.NODE_ENV === 'production'
  ? paypal.core.LiveEnvironment
  : paypal.core.SandboxEnvironment;
const paypalClient = new paypal.core.PayPalHttpClient(
    new Environment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
);

// --- ROUTES DE L'APPLICATION (Authentification et Dashboard) ---

app.get('/', (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');
    res.render('index');
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Erreur: "code" manquant.');
    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code', code, redirect_uri: process.env.REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const tokenData = await tokenResponse.json();
        if (tokenData.error) throw new Error(tokenData.error_description);
        const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${tokenData.access_token}` } });
        const userData = await userResponse.json();
        req.session.accessToken = tokenData.access_token;
        req.session.user = userData;
        req.session.save(() => res.redirect('/dashboard'));
    } catch (error) {
        console.error("Erreur critique dans /callback:", error);
        res.status(500).send('Une erreur interne est survenue.');
    }
});

app.get('/dashboard', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    try {
        const usersCollection = db.collection('users');
        const userDbInfo = await usersCollection.findOne({ userId: req.session.user.id });
        const grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade };
        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', { headers: { authorization: `Bearer ${req.session.accessToken}` } });
        const userGuilds = await guildsResponse.json();
        const adminGuilds = userGuilds.filter(g => (BigInt(g.permissions) & 8n) === 8n);
        const botGuildsCollection = db.collection('botGuilds');
        const botGuilds = await botGuildsCollection.find({}, { projection: { guildId: 1 } }).toArray();
        const botGuildIds = new Set(botGuilds.map(g => g.guildId));
        const guilds = adminGuilds.map(guild => ({...guild, botOnServer: botGuildIds.has(guild.id)}));
        res.render('dashboard', { user, guilds });
    } catch (error) {
        console.error("Erreur lors de la préparation du dashboard:", error);
        res.status(500).send("Erreur lors du chargement du tableau de bord.");
    }
});

app.get('/manage/:guildId', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    try {
        const discordApi = 'https://discord.com/api/v10';
        const botAuthHeader = { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };
        const [guildResponse, channelsResponse, rolesResponse, botMemberResponse] = await Promise.all([
            fetch(`${discordApi}/guilds/${req.params.guildId}`, { headers: botAuthHeader }),
            fetch(`${discordApi}/guilds/${req.params.guildId}/channels`, { headers: botAuthHeader }),
            fetch(`${discordApi}/guilds/${req.params.guildId}/roles`, { headers: botAuthHeader }),
            fetch(`${discordApi}/guilds/${req.params.guildId}/members/${process.env.CLIENT_ID}`, { headers: botAuthHeader })
        ]);
        if (!guildResponse.ok) throw new Error('Impossible de récupérer les infos du serveur.');
        const [guildData, channelsData, rolesData] = await Promise.all([
            guildResponse.json(), channelsResponse.json(), rolesResponse.json()
        ]);
        const botMember = botMemberResponse.ok ? await botMemberResponse.json() : null;
        const [userDbInfo, guildSettings] = await Promise.all([
            db.collection('users').findOne({ userId: req.session.user.id }),
            db.collection('settings').findOne({ guildId: req.params.guildId })
        ]);
        const grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade };
        const textChannels = Array.isArray(channelsData) ? channelsData.filter(c => c.type === 0) : [];
        const botHighestRolePosition = (botMember && Array.isArray(botMember.roles)) ? botMember.roles.reduce((maxPos, roleId) => {
            const role = rolesData.find(r => r.id === roleId);
            return role && role.position > maxPos ? role.position : maxPos;
        }, 0) : 0;
        const roles = Array.isArray(rolesData) ? rolesData
            .filter(role => role.name !== '@everyone' && !role.managed)
            .map(role => ({ ...role, canManage: role.position < botHighestRolePosition }))
            : [];
        res.render('manage-server', {
            user, guild: guildData, channels: textChannels,
            roles, settings: guildSettings || {}
        });
    } catch (error) {
        console.error("Erreur de chargement de la page de gestion:", error);
        res.status(500).send("Erreur lors du chargement de la page de gestion.");
    }
});


// ===============================================
// --- ROUTES POUR LE PREMIUM ET PAYPAL ---
// ===============================================

// 1. AFFICHER LA PAGE PREMIUM
app.get('/premium', (req, res) => {
    if (!req.session.user) return res.redirect('/');
    res.render('premium', { user: req.session.user, message: req.query.message || null });
});

// 2. CRÉER LA COMMANDE PAYPAL (API)
app.post('/api/create-payment', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Non authentifié' });
    
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
            amount: { currency_code: 'EUR', value: '5.00' },
            description: `Abonnement Premium 1 mois pour ${req.session.user.username}`,
            custom_id: req.session.user.id // On stocke l'ID Discord pour le retrouver plus tard
        }],
        application_context: {
            brand_name: 'NexoProtect',
            return_url: `${process.env.REDIRECT_URI.replace('/callback', '')}/payment-success`,
            cancel_url: `${process.env.REDIRECT_URI.replace('/callback', '')}/payment-cancel`,
            user_action: 'PAY_NOW',
        },
    });

    try {
        const order = await paypalClient.execute(request);
        const approveUrl = order.result.links.find(link => link.rel === 'approve').href;
        res.json({ approveUrl });
    } catch (err) {
        console.error("Erreur de création de commande PayPal:", err.message);
        res.status(500).json({ error: "Erreur lors de la communication avec PayPal." });
    }
});

// 3. PAIEMENT RÉUSSI
app.get('/payment-success', async (req, res) => {
    if (!req.query.token) return res.redirect('/premium?message=error');

    const request = new paypal.orders.OrdersCaptureRequest(req.query.token);
    request.requestBody({});

    try {
        const capture = await paypalClient.execute(request);
        const purchaseUnit = capture.result.purchase_units[0];
        const userId = purchaseUnit.payments.captures[0].custom_id;

        if (userId) {
            const usersCollection = db.collection('users');
            const userDb = await usersCollection.findOne({ userId });
            
            const newExpiryDate = (userDb && userDb.vipExpires && new Date(userDb.vipExpires) > new Date())
                ? new Date(new Date(userDb.vipExpires).getTime() + 30 * 24 * 60 * 60 * 1000) // Ajoute 30 jours à la date existante
                : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // Ajoute 30 jours à maintenant

            await usersCollection.updateOne(
                { userId: userId },
                { $set: { vipExpires: newExpiryDate }, $setOnInsert: { userId: userId } },
                { upsert: true }
            );
            
            console.log(`✅ VIP activé/prolongé pour l'utilisateur ${userId} jusqu'au ${newExpiryDate.toISOString()}`);
            res.redirect('/premium?message=success');
        } else {
            throw new Error("ID utilisateur non trouvé dans la transaction PayPal.");
        }
    } catch (err) {
        console.error("Erreur lors de la capture du paiement:", err.message);
        res.redirect('/premium?message=error');
    }
});

// 4. PAIEMENT ANNULÉ
app.get('/payment-cancel', (req, res) => {
    res.redirect('/premium?message=cancelled');
});


// --- ROUTES API (Logique de sauvegarde existante) ---
app.post('/api/settings/:guildId/welcome', async (req, res) => { /* ... */ });
app.post('/api/settings/:guildId/autorole', async (req, res) => { /* ... */ });
app.post('/api/claim-vip', async (req, res) => { /* ... */ });


// --- DÉMARRAGE DU SERVEUR ---
app.listen(PORT, () => console.log(`✅ Serveur web du panel démarré et à l'écoute sur le port ${PORT}`));
