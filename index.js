// =================================================================
//                 INDEX.JS POUR LE PANEL WEB (RENDER.COM)
// =================================================================
// Ce fichier est le point d'entrée de votre serveur web.
// Son rôle est de :
// 1. Servir votre site web (les pages HTML/CSS/JS).
// 2. Gérer la connexion des utilisateurs via Discord (OAuth2).
// 3. Se connecter à la base de données pour LIRE et ÉCRIRE les configurations.
// =================================================================

// --- IMPORTS ---
// Pour créer le serveur web
const express = require('express'); 
// Pour gérer les chemins de fichiers (ex: trouver votre index.html)
const path = require('path'); 
// Pour communiquer avec l'API de Discord
const fetch = require('node-fetch'); 
// Pour se connecter à votre base de données MongoDB
const { MongoClient } = require('mongodb'); 
// Pour charger les variables secrètes depuis le fichier .env (ou l'environnement de Render)
require('dotenv').config(); 

// --- INITIALISATION ---
const app = express();
// Render.com fournit le port via process.env.PORT
const PORT = process.env.PORT || 3000; 

// --- MIDDLEWARES ---
// Indique à Express où trouver vos fichiers CSS, JS (côté client) et images
app.use(express.static(path.join(__dirname, 'src', 'dashboard', 'public')));
// Permet à Express de comprendre les données envoyées en JSON
app.use(express.json());
// Permet à Express de comprendre les données envoyées depuis un formulaire HTML
app.use(express.urlencoded({ extended: true }));


// --- CONNEXION À LA BASE DE DONNÉES ---
// On récupère l'URL de connexion depuis les variables d'environnement pour la sécurité
const mongoClient = new MongoClient(process.env.DATABASE_URL);
let db; // On déclare la variable 'db' pour qu'elle soit accessible partout dans ce fichier

mongoClient.connect()
    .then(() => {
        console.log('✅ Panel web connecté à la base de données MongoDB !');
        // 'nexoprotect_db' est le nom de votre base de données. Vous pouvez le changer.
        db = mongoClient.db('nexoprotect_db'); 
    })
    .catch(err => {
        console.error("❌ Erreur de connexion à MongoDB pour le panel:", err);
        // Si la connexion échoue, on arrête le processus pour éviter des erreurs plus loin
        process.exit(1);
    });


// --- ROUTES DE L'APPLICATION ---

// 1. Route principale : affiche la page d'accueil de votre panel
app.get('/', (req, res) => {
    // res.sendFile envoie un fichier au navigateur de l'utilisateur
    res.sendFile(path.join(__dirname, 'src', 'dashboard', 'views', 'index.html'));
});


// 2. Route de Callback (le code que tu as posté, parfaitement intégré ici)
// C'est ici que Discord redirige l'utilisateur après qu'il a autorisé l'application.
app.get('/callback', async (req, res) => {
    // On récupère le code d'autorisation temporaire fourni par Discord
    const code = req.query.code;
    if (!code) {
        return res.status(400).send('Erreur : "code" manquant. Impossible de vous connecter.');
    }

    try {
        // On échange ce code contre un "access token" permanent (ou presque)
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: process.env.CLIENT_ID,
                client_secret: process.env.CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: process.env.REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const tokenData = await tokenResponse.json();
        if (tokenData.error) {
            console.error("Erreur d'échange de token:", tokenData.error);
            return res.status(400).send('Une erreur est survenue lors de l\'authentification avec Discord.');
        }

        // On utilise l'access token pour récupérer les infos de l'utilisateur
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userResponse.json();

        // **À FAIRE PLUS TARD** :
        // - Stocker 'tokenData' dans une session pour garder l'utilisateur connecté.
        // - Récupérer les serveurs de l'utilisateur (guilds).
        // - Rediriger l'utilisateur vers son tableau de bord : res.redirect('/dashboard');

        res.send(`<h1>Bienvenue, ${userData.username}!</h1><p>Vous êtes maintenant connecté.</p>`);

    } catch (error) {
        console.error("Erreur critique dans la route /callback:", error);
        res.status(500).send('Une erreur interne est survenue.');
    }
});


// 3. Route pour enregistrer les paramètres (exemple : changer le préfixe)
app.post('/save-settings', async (req, res) => {
    // **SÉCURITÉ** : Normalement, vous devriez vérifier si l'utilisateur est connecté
    // et s'il a bien les permissions d'administrer ce serveur.

    // On récupère les données envoyées par le formulaire du panel
    const { serverId, newPrefix } = req.body;

    if (!serverId || !newPrefix) {
        return res.status(400).json({ message: 'Données manquantes (serverId ou newPrefix).' });
    }
    if (!db) {
        return res.status(503).json({ message: 'Service temporairement indisponible (pas de connexion à la base de données).' });
    }

    try {
        const configCollection = db.collection('configurations');
        // 'updateOne' avec 'upsert: true' crée le document s'il n'existe pas,
        // ou le met simplement à jour. C'est parfait.
        await configCollection.updateOne(
            { serverId: serverId },
            { $set: { prefix: newPrefix, lastUpdatedBy: "ID_UTILISATEUR_ICI" } }, // On pourrait stocker qui a fait la modif
            { upsert: true }
        );
        console.log(`Configuration mise à jour pour le serveur ${serverId}. Nouveau préfixe : ${newPrefix}`);
        res.status(200).json({ message: 'Configuration enregistrée avec succès !' });
    } catch (error) {
        console.error("Erreur lors de la sauvegarde de la configuration:", error);
        res.status(500).json({ message: 'Erreur interne du serveur lors de la sauvegarde.' });
    }
});


// --- DÉMARRAGE DU SERVEUR ---
app.listen(PORT, () => {
    console.log(`✅ Serveur web du panel démarré et à l'écoute sur le port ${PORT}`);
});
