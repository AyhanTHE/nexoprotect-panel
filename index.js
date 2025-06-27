// =================================================================
//       INDEX.JS - CŒUR DE L'APPLICATION NEXOPROTECT
// =================================================================
// Ce fichier gère toutes les routes, la logique de session, la connexion
// à la base de données et les interactions avec les API de Discord et PayPal.
// =================================================================

// --- IMPORTS DES MODULES NÉCESSAIRES ---
const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');
const session = require('express-session');
const paypalSDK = require('@paypal/checkout-server-sdk');
require('dotenv').config();

// --- INITIALISATION & CONFIGURATION D'EXPRESS ---
const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'dashboard', 'views'));
app.set('trust proxy', 1);

// --- MIDDLEWARES ---
app.use(express.static(path.join(__dirname, 'src', 'dashboard', 'public')));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Configuration de la session utilisateur
app.use(session({
    secret: process.env.SESSION_SECRET || 'une-super-phrase-secrete-pour-nexoprotect',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true, 
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// --- DÉCLARATION DE LA VARIABLE DE BASE DE DONNÉES ---
let db;

// --- CONFIGURATION DU CLIENT PAYPAL ---
const Environment = process.env.NODE_ENV === 'production'
  ? paypalSDK.core.LiveEnvironment
  : paypalSDK.core.SandboxEnvironment;
const paypalClient = new paypalSDK.core.PayPalHttpClient(
    new Environment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
);

app.use((req, res, next) => {
    req.baseDomainUrl = `${req.protocol}://${req.get('host')}`;
    next();
});

// =================================================================
// --- ROUTES DE L'APPLICATION ---
// =================================================================

app.get('/', async (req, res) => {
    if (req.session.user) return res.redirect('/dashboard');

    try {
        if (!db) {
            console.error("ERREUR CRITIQUE: La connexion à la base de données n'est pas encore établie.");
            return res.status(500).send("Erreur interne du serveur: Base de données non connectée.");
        }

        const [vipCount, serverCount] = await Promise.all([
            db.collection('premiumsubscriptions').countDocuments({ vipExpires: { $gt: new Date() } }),
            db.collection('botGuilds').countDocuments()
        ]);

        const stats = {
            vipCount: vipCount,
            bannedCount: 0,
            serverCount: serverCount
        };

        res.render('index', { stats });

    } catch (error) {
        console.error("Erreur lors de la récupération des statistiques pour la page d'accueil:", error.message);
        res.render('index', {
            stats: { vipCount: 0, bannedCount: 0, serverCount: 0 }
        });
    }
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
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: process.env.REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok) {
            console.error("Erreur Discord Token Exchange:", tokenData);
            throw new Error(tokenData.error_description || 'Échec de l\'échange de token Discord.');
        }

        const userResponse = await fetch('https://discord.com/api/users/@me', { headers: { authorization: `Bearer ${tokenData.access_token}` } });
        const userData = await userResponse.json();
        if (!userResponse.ok) {
            console.error("Erreur Discord User Fetch:", userData);
            throw new Error('Échec de la récupération des informations utilisateur Discord.');
        }

        req.session.accessToken = tokenData.access_token;
        req.session.user = userData;
        req.session.save(err => {
            if (err) {
                console.error("Erreur lors de la sauvegarde de la session:", err);
                return res.status(500).send("Erreur lors de la sauvegarde de la session.");
            }
            res.redirect('/dashboard');
        });

    } catch (error) {
        console.error("Erreur critique dans /callback:", error);
        res.status(500).send('Une erreur interne est survenue lors de l\'authentification.');
    }
});

app.get('/dashboard', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    if (!db) {
        console.error("ERREUR: DB non connectée dans /dashboard");
        return res.status(500).send("Erreur serveur: DB non connectée.");
    }
    try {
        const premiumCollection = db.collection('premiumsubscriptions');
        const userDbInfo = await premiumCollection.findOne({ userId: req.session.user.id });
        const grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade, usedTrial: userDbInfo ? userDbInfo.usedTrial : false };

        const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', { headers: { authorization: `Bearer ${req.session.accessToken}` } });
        const userGuilds = await guildsResponse.json();
        if (!guildsResponse.ok) {
            console.error("Erreur Discord Guilds Fetch:", userGuilds);
            throw new Error('Échec de la récupération des serveurs de l\'utilisateur.');
        }

        const adminGuilds = Array.isArray(userGuilds) ? userGuilds.filter(g => (BigInt(g.permissions) & 8n) === 8n) : [];

        const botGuildsCollection = db.collection('botGuilds');
        const botGuilds = await botGuildsCollection.find({}, { projection: { guildId: 1 } }).toArray();
        const botGuildIds = new Set(botGuilds.map(g => g.guildId));

        // --- DÉBOGAGE POUR LE BOUTON "GÉRER" ---
        console.log("IDs des serveurs où le bot est (depuis DB):", Array.from(botGuildIds));
        // --- FIN DÉBOGAGE ---

        const guilds = adminGuilds.map(guild => {
            const botOnServer = botGuildIds.has(guild.id);
            // --- DÉBOGAGE POUR LE BOUTON "GÉRER" ---
            console.log(`Serveur ${guild.name} (ID: ${guild.id}) - Bot présent: ${botOnServer}`);
            // --- FIN DÉBOGAGE ---
            return { ...guild, botOnServer };
        });

        res.render('dashboard', { user, guilds });

    } catch (error) {
        console.error("Erreur lors de la préparation du dashboard:", error);
        res.status(500).send("Erreur lors du chargement du tableau de bord.");
    }
});

app.get('/manage/:guildId', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    if (!db) {
        console.error("ERREUR: DB non connectée dans /manage/:guildId");
        return res.status(500).send("Erreur serveur: DB non connectée.");
    }
    try {
        const discordApi = 'https://discord.com/api/v10';
        const botAuthHeader = { Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` };

        const [guildResponse, channelsResponse, rolesResponse, botMemberResponse] = await Promise.all([
            fetch(`${discordApi}/guilds/${req.params.guildId}`, { headers: botAuthHeader }),
            fetch(`${discordApi}/guilds/${req.params.guildId}/channels`, { headers: botAuthHeader }),
            fetch(`${discordApi}/guilds/${req.params.guildId}/roles`, { headers: botAuthHeader }),
            fetch(`${discordApi}/guilds/${req.params.guildId}/members/${process.env.CLIENT_ID}`, { headers: botAuthHeader })
        ]);

        if (!guildResponse.ok) {
            console.error(`Erreur Discord Guild Fetch pour ${req.params.guildId}:`, await guildResponse.text());
            return res.status(404).send('Serveur introuvable ou le bot n\'est pas dessus.');
        }
        if (!channelsResponse.ok) {
            console.error(`Erreur Discord Channels Fetch pour ${req.params.guildId}:`, await channelsResponse.text());
        }
        if (!rolesResponse.ok) {
            console.error(`Erreur Discord Roles Fetch pour ${req.params.guildId}:`, await rolesResponse.text());
        }

        const guildData = await guildResponse.json();
        const channelsData = channelsResponse.ok ? await channelsResponse.json() : [];
        const rolesData = rolesResponse.ok ? await rolesResponse.json() : [];
        const botMember = botMemberResponse.ok ? await botMemberResponse.json() : null;

        const [userDbInfo, guildSettings] = await Promise.all([
            db.collection('premiumsubscriptions').findOne({ userId: req.session.user.id }),
            db.collection('settings').findOne({ guildId: req.params.guildId })
        ]);
        const grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade };

        const textChannels = Array.isArray(channelsData) ? channelsData.filter(c => c.type === 0 || c.type === 5) : []; // 0: text, 5: announcement
        const categories = Array.isArray(channelsData) ? channelsData.filter(c => c.type === 4) : []; // 4: category
        
        const botHighestRolePosition = (botMember && Array.isArray(botMember.roles) && Array.isArray(rolesData)) ? botMember.roles.reduce((maxPos, roleId) => {
            const role = rolesData.find(r => r.id === roleId);
            return role && role.position !== undefined && role.position > maxPos ? role.position : maxPos;
        }, 0) : 0;
        
        const roles = Array.isArray(rolesData) ? rolesData
            .filter(role => role.name !== '@everyone' && !role.managed)
            .map(role => {
                let safeRoleName = role.name;
                try {
                    // Stringify le nom du rôle pour échapper les caractères spéciaux et emojis
                    // Puis supprimer les guillemets doubles ajoutés par JSON.stringify
                    // Cela garantit que la chaîne est sûre pour être insérée dans du JS client
                    safeRoleName = JSON.stringify(role.name);
                    safeRoleName = safeRoleName.substring(1, safeRoleName.length - 1);
                } catch (e) {
                    console.error(`Erreur lors de la sécurisation du nom de rôle "${role.name}":`, e);
                    // Fallback si JSON.stringify échoue, en échappant au moins les apostrophes
                    safeRoleName = role.name.replace(/'/g, "\\'"); 
                }

                return { 
                    id: role.id, 
                    name: safeRoleName, // Utilisez le nom de rôle sécurisé
                    color: `#${(role.color || 0).toString(16).padStart(6, '0')}`,
                    position: role.position,
                    canManage: role.position !== undefined && role.position < botHighestRolePosition 
                };
            })
            .sort((a, b) => b.position - a.position)
            : [];

        const defaultTicketsSettings = {
            categoryMode: 'create',
            categoryName: 'Tickets',
            existingCategoryId: null,
            logChannelMode: 'create',
            logChannelName: 'demandes-de-tickets',
            existingLogChannelId: null,
            validationEnabled: false,
            moderatorRoles: []
        };

        const settings = {
            welcome: {
                enabled: guildSettings?.welcome?.enabled ?? false,
                channelId: guildSettings?.welcome?.channelId ?? '',
                message: guildSettings?.welcome?.message ?? '',
                bannerUrl: guildSettings?.welcome?.bannerUrl ?? null
            },
            tickets: {
                categoryMode: guildSettings?.tickets?.categoryMode ?? defaultTicketsSettings.categoryMode,
                categoryName: guildSettings?.tickets?.categoryName ?? defaultTicketsSettings.categoryName,
                existingCategoryId: guildSettings?.tickets?.existingCategoryId ?? defaultTicketsSettings.existingCategoryId,
                logChannelMode: guildSettings?.tickets?.logChannelMode ?? defaultTicketsSettings.logChannelMode,
                logChannelName: guildSettings?.tickets?.logChannelName ?? defaultTicketsSettings.logChannelName,
                existingLogChannelId: guildSettings?.tickets?.existingLogChannelId ?? defaultTicketsSettings.existingLogChannelId,
                validationEnabled: guildSettings?.tickets?.validationEnabled ?? defaultTicketsSettings.validationEnabled,
                moderatorRoles: Array.isArray(guildSettings?.tickets?.moderatorRoles) ? guildSettings.tickets.moderatorRoles : defaultTicketsSettings.moderatorRoles
            }
        };

        console.log("--- Données envoyées à manage-server.ejs (Avec Tickets) ---");
        console.log("User:", { id: user.id, username: user.username, grade: user.grade });
        console.log("Guild:", { id: guildData.id, name: guildData.name });
        console.log("Channels Count (Text/Announce):", textChannels.length);
        console.log("Categories Count:", categories.length);
        console.log("Roles Count:", roles.length);
        console.log("Settings:", JSON.stringify(settings, null, 2));
        console.log("--------------------------------------------------");


        res.render('manage-server', { user, guild: guildData, channels: textChannels, roles, settings, categories });

    } catch (error) {
        console.error("Erreur de chargement de la page de gestion:", error);
        res.status(500).send("Erreur lors du chargement de la page de gestion. Veuillez réessayer.");
    }
});

// --- Routes Premium & Paiement ---
app.get('/premium', async (req, res) => {
    if (!req.session.user) return res.redirect('/');
    if (!db) {
        console.error("ERREUR: DB non connectée dans /premium");
        return res.status(500).send("Erreur serveur: DB non connectée.");
    }
    try {
        const premiumCollection = db.collection('premiumsubscriptions');
        const userDbInfo = await premiumCollection.findOne({ userId: req.session.user.id });
        const grade = (userDbInfo && userDbInfo.vipExpires && new Date(userDbInfo.vipExpires) > new Date()) ? "VIP" : "Utilisateur";
        const user = { ...req.session.user, grade, usedTrial: userDbInfo ? userDbInfo.usedTrial : false };
        res.render('premium', { user: user, message: req.query.message || null, stats: null });
    } catch (error) {
        console.error("Erreur lors du chargement de la page premium:", error);
        res.render('premium', { user: req.session.user || {}, message: req.query.message || null, stats: null });
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
            return_url: `${req.baseDomainUrl}/payment-success`, 
            cancel_url: `${req.baseDomainUrl}/payment-cancel`,
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
    if (!db) {
        console.error("ERREUR: DB non connectée dans /payment-success");
        return res.redirect('/premium?message=error-db');
    }
    const request = new paypalSDK.orders.OrdersCaptureRequest(req.query.token);
    request.requestBody({});
    try {
        const capture = await paypalClient.execute(request);
        const purchaseUnit = capture.result.purchase_units && capture.result.purchase_units[0];
        const captureDetails = purchaseUnit && purchaseUnit.payments && purchaseUnit.payments.captures && purchaseUnit.payments.captures[0];
        const userId = captureDetails && captureDetails.custom_id;

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
            throw new Error("ID utilisateur non trouvé dans la transaction PayPal ou structure de réponse inattendue.");
        }
    } catch (err) {
        console.error("❌ Erreur lors de la capture du paiement:", err.message);
        res.redirect('/premium?message=error');
    }
});

app.get('/payment-cancel', (req, res) => {
    res.redirect('/premium?message=cancelled');
});

// --- ROUTES API DIVERSES ---
app.post('/api/settings/:guildId/welcome', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Non authentifié' });
    if (!db) {
        console.error("ERREUR: DB non connectée dans /api/settings/:guildId/welcome");
        return res.status(500).json({ success: false, message: 'Erreur serveur: DB non connectée.' });
    }
    try {
        const { enabled, channelId, message, bannerUrl } = req.body;
        await db.collection('settings').updateOne(
            { guildId: req.params.guildId },
            { $set: { 
                'welcome.enabled': enabled,
                'welcome.channelId': channelId,
                'welcome.message': message,
                'welcome.bannerUrl': bannerUrl
            }},
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Erreur de sauvegarde des paramètres de bienvenue:", error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});

app.post('/api/settings/:guildId/tickets', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Non authentifié' });
    if (!db) {
        console.error("ERREUR: DB non connectée dans /api/settings/:guildId/tickets");
        return res.status(500).json({ success: false, message: 'Erreur serveur: DB non connectée.' });
    }
    try {
        const { 
            categoryMode, categoryName, existingCategoryId,
            logChannelMode, logChannelName, existingLogChannelId,
            validationEnabled, moderatorRoles
        } = req.body;

        if (!['create', 'select'].includes(categoryMode) || !['create', 'select'].includes(logChannelMode)) {
            return res.status(400).json({ success: false, message: 'Mode de catégorie ou de salon de logs invalide.' });
        }
        if (categoryMode === 'create' && !categoryName) {
            return res.status(400).json({ success: false, message: 'Le nom de la catégorie est requis en mode création.' });
        }
        if (categoryMode === 'select' && !existingCategoryId) {
            return res.status(400).json({ success: false, message: 'La catégorie existante est requise en mode sélection.' });
        }
        if (logChannelMode === 'create' && !logChannelName) {
            return res.status(400).json({ success: false, message: 'Le nom du salon de logs est requis en mode création.' });
        }
        if (logChannelMode === 'select' && !existingLogChannelId) {
            return res.status(400).json({ success: false, message: 'Le salon de logs existant est requis en mode sélection.' });
        }
        if (!Array.isArray(moderatorRoles)) {
            return res.status(400).json({ success: false, message: 'Les rôles modérateurs doivent être un tableau.' });
        }

        await db.collection('settings').updateOne(
            { guildId: req.params.guildId },
            { $set: { 
                'tickets.categoryMode': categoryMode,
                'tickets.categoryName': categoryName,
                'tickets.existingCategoryId': existingCategoryId,
                'tickets.logChannelMode': logChannelMode,
                'tickets.logChannelName': logChannelName,
                'tickets.existingLogChannelId': existingLogChannelId,
                'tickets.validationEnabled': validationEnabled,
                'tickets.moderatorRoles': moderatorRoles
            }},
            { upsert: true }
        );
        res.json({ success: true });
    } catch (error) {
        console.error("Erreur de sauvegarde des paramètres de tickets:", error);
        res.status(500).json({ success: false, message: 'Erreur serveur' });
    }
});


app.post('/api/claim-trial-vip', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ success: false, message: 'Non authentifié' });
    if (!db) {
        console.error("ERREUR: DB non connectée dans /api/claim-trial-vip");
        return res.status(500).json({ success: false, message: 'Erreur serveur: DB non connectée.' });
    }
    try {
        const premiumCollection = db.collection('premiumsubscriptions');
        const userDb = await premiumCollection.findOne({ userId: req.session.user.id });
        
        if ((userDb && userDb.vipExpires && new Date(userDb.vipExpires) > new Date()) || (userDb && userDb.usedTrial === true)) {
            console.log(`Tentative de réclamer VIP essai par ${req.session.user.id}: Déjà VIP ou essai utilisé.`);
            return res.status(403).json({ success: false, message: 'Déjà VIP ou essai utilisé.' });
        }

        const expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await premiumCollection.updateOne(
            { userId: req.session.user.id },
            { 
                $set: { 
                    vipExpires: expiryDate, 
                    usedTrial: true
                },
                $setOnInsert: { 
                    userId: req.session.user.id 
                }
            },
            { upsert: true }
        );
        console.log(`✅ Essai VIP activé pour ${req.session.user.id} jusqu'au ${expiryDate.toISOString()}`);
        res.json({ success: true });
    } catch (error) {
        console.error("Erreur lors de l'activation de l'essai VIP:", error);
        res.status(500).json({ success: false, message: 'Erreur interne du serveur.' });
    }
});

// =================================================================
// --- DÉMARRAGE DU SERVEUR ---
// =================================================================
async function startServer() {
    try {
        const mongoClient = new MongoClient(process.env.DATABASE_URL);
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