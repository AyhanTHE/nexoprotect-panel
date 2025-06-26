// =================================================================
//      INDEX.JS AVEC AJOUT DES STATISTIQUES SUR LA PAGE D'ACCUEIL
// =================================================================

// --- IMPORTS ---
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const paypalSDK = require('@paypal/checkout-server-sdk');
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

// --- DÉCLARATION DE LA DB ---
let db;

// --- CONFIGURATION DU CLIENT PAYPAL ---
const Environment = process.env.NODE_ENV === 'production'
  ? paypalSDK.core.LiveEnvironment
  : paypalSDK.core.SandboxEnvironment;
const paypalClient = new paypalSDK.core.PayPalHttpClient(
    new Environment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
);

// --- ROUTES DE L'APPLICATION ---

// MODIFIÉ : La route de la page d'accueil récupère maintenant les statistiques
app.get('/', async (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');

    try {
        // Ajout d'une vérification pour s'assurer que la DB est prête
        if (!db) {
            throw new Error("La connexion à la base de données n'est pas encore établie.");
        }

        const [vipCount, serverCount] = await Promise.all([
            db.collection('premiumsubscriptions').countDocuments({ vipExpires: { $gt: new Date() } }),
            db.collection('botGuilds').countDocuments()
            // NOTE : Le nombre de bannis est un placeholder. Vous devrez implémenter la logique pour le récupérer.
        ]);

        const stats = {
            vipCount: vipCount,
            bannedCount: 0, // Placeholder
            serverCount: serverCount
        };

        res.render('index', { stats }); // On envoie les stats à la page index.ejs

    } catch (error) {
        console.error("Erreur lors de la récupération des statistiques pour la page d'accueil:", error.message);
        // En cas d'erreur, on affiche la page avec des stats par défaut
        res.render('index', {
            stats: { vipCount: 0, bannedCount: 0, serverCount: 0 }
        });
    }
});


app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });
app.get('/callback', async (req, res) => { const code = req.query.code; if (!code) return res.status(400).send('Erreur: "code" manquant.'); try { const tokenResponse = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', body: new URLSearchParams({ client_id: process.env.CLIENT_ID, client_secret: process.env.CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.REDIRECT_URI, }), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, }); const tokenData = await tokenResponse.json(); if (tokenData.error) throw new Error(tokenData.error_description); const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${tokenData.access_token}` } }); const userData = await userResponse.json(); req.session.accessToken = tokenData.access_token; req.session.user = userData; req.session.save(() => res.redirect('/dashboard')); } catch (error) { console.error("Erreur critique dans /callback:", error); res.status(500).send('Une erreur interne est survenue.'); } });

app.get('/dashboard', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    try {
        const premiumCollection = db.collection('premiumsubscriptions');
        const userDbInfo = await premiumCollection.findOne({ userId: req.session.user.id });
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
        const [guildResponse, channelsResponse, rolesResponse, botMemberResponse] = await Promise.all([ fetch(`${discordApi}/guilds/${req.params.guildId}`, { headers: botAuthHeader }), fetch(`${discordApi}/guilds/${req.params.guildId}/channels`, { headers: botAuthHeader }), fetch(`${discordApi}/guilds/${req.params.guildId}/roles`, { headers: botAuthHeader }), fetch(`${discordApi}/guilds/${req.params.guildId}/members/${process.env.CLIENT_ID}`, { headers: botAuthHeader }) ]);
        if (!guildResponse.ok) throw new Error('Impossible de récupérer les infos du serveur.');
        const [guildData, channelsData, rolesData] = await Promise.all([ guildResponse.json(), channelsResponse.json(), rolesResponse.json() ]);
        const botMember = botMemberResponse.ok ? await botMemberResponse.json() : null;
        const [userDbInfo, guildSettings] = await Promise.all([
            db.collection('premiumsubscriptions').findOne({ userId: req.session.user.id }),
            db.collection('settings').findOne({ guildId: req.params.guildId })
        ]);
        const grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade };
        const textChannels = Array.isArray(channelsData) ? channelsData.filter(c => c.type === 0) : [];
        const botHighestRolePosition = (botMember && Array.isArray(botMember.roles)) ? botMember.roles.reduce((maxPos, roleId) => { const role = rolesData.find(r => r.id === roleId); return role && role.position > maxPos ? role.position : maxPos; }, 0) : 0;
        const roles = Array.isArray(rolesData) ? rolesData .filter(role => role.name !== '@everyone' && !role.managed) .map(role => ({ ...role, canManage: role.position < botHighestRolePosition })) : [];
        res.render('manage-server', { user, guild: guildData, channels: textChannels, roles, settings: guildSettings || {} });
    } catch (error) {
        console.error("Erreur de chargement de la page de gestion:", error);
        res.status(500).send("Erreur lors du chargement de la page de gestion.");
    }
});

// --- ROUTES PREMIUM ET PAYPAL (SANS WEBHOOKS) ---
app.get('/premium', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    try {
        const [userDbInfo, vipCount, serverCount] = await Promise.all([
            db.collection('premiumsubscriptions').findOne({ userId: req.session.user.id }),
            db.collection('premiumsubscriptions').countDocuments({ vipExpires: { $gt: new Date() } }),
            db.collection('botGuilds').countDocuments()
        ]);
        const grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade };
        const stats = {
            vipCount: vipCount,
            bannedCount: 0,
            serverCount: serverCount
        };
        res.render('premium', {
            user: user,
            message: req.query.message || null,
            stats: stats
        });
    } catch (error) {
        console.error("Erreur lors du chargement de la page premium:", error);
        res.render('premium', {
            user: req.session.user,
            message: req.query.message || null,
            stats: { vipCount: 0, bannedCount: 0, serverCount: 0 }
        });
    }
});

app.post('/api/create-payment', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'Non authentifié' });
    const request = new paypalSDK.orders.OrdersCreateRequest();
    request.prefer("return=representation");
    request.requestBody({
        intent: 'CAPTURE',
        purchase_units: [{
            amount: { currency_code: 'EUR', value: '5.00' }, 
            description: `Abonnement Premium 1 mois pour ${req.session.user.username}`,
            custom_id: req.session.user.id
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

app.get('/payment-success', async (req, res) => {
    if (!req.query.token) return res.redirect('/premium?message=error');
    const request = new paypalSDK.orders.OrdersCaptureRequest(req.query.token);
    request.requestBody({});
    try {
        const capture = await paypalClient.execute(request);
        const purchaseUnit = capture.result.purchase_units[0];
        const userId = purchaseUnit.payments.captures[0].custom_id;
        if (userId) {
            const premiumCollection = db.collection('premiumsubscriptions');
            const userDb = await premiumCollection.findOne({ userId });
            const newExpiryDate = (userDb && userDb.vipExpires && new Date(userDb.vipExpires) > new Date())
                ? new Date(new Date(userDb.vipExpires).getTime() + 30 * 24 * 60 * 60 * 1000)
                : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            await premiumCollection.updateOne(
                { userId: userId },
                { $set: { vipExpires: newExpiryDate }, $setOnInsert: { userId: userId } },
                { upsert: true }
            );
            console.log(`✅ [SUCCESS PAGE] VIP activé/prolongé pour l'utilisateur ${userId} jusqu'au ${newExpiryDate.toISOString()}`);
            res.redirect('/premium?message=success');
        } else {
            throw new Error("ID utilisateur non trouvé dans la transaction PayPal.");
        }
    } catch (err) {
        console.error("❌ Erreur lors de la capture du paiement:", err.message);
        res.redirect('/premium?message=error');
    }
});

app.get('/payment-cancel', (req, res) => {
    res.redirect('/premium?message=cancelled');
});

// --- ROUTES API EXISTANTES ---
app.post('/api/settings/:guildId/welcome', async (req, res) => { /* ... */ });
app.post('/api/settings/:guildId/autorole', async (req, res) => { /* ... */ });
app.post('/api/claim-vip', async (req, res) => { /* ... */ });


// --- CONNEXION À LA DB & DÉMARRAGE DU SERVEUR ---
const mongoClient = new MongoClient(process.env.DATABASE_URL);

async function startServer() {
    try {
        await mongoClient.connect();
        console.log('✅ Panel web connecté à la base de données MongoDB !');
        db = mongoClient.db('nexoprotect_db');
        
        app.listen(PORT, () => {
            console.log(`✅ Serveur web du panel démarré et à l'écoute sur le port ${PORT}`);
        });
    } catch (err) {
        console.error("❌ Erreur critique de connexion, le serveur ne peut pas démarrer:", err);
        process.exit(1);
    }
}

startServer();
