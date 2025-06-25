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
// *** C'EST CETTE LIGNE QUI SERT LES FICHIERS CSS ET IMAGES ***
// Elle indique à Express que le dossier 'src/dashboard/public' contient les fichiers statiques.
app.use(express.static(path.join(__dirname, 'src', 'dashboard', 'public')));
// Permet à Express de comprendre les données envoyées en JSON
app.use(express.json());
// Permet à Express de comprendre les données envoyées depuis un formulaire HTML
app.use(express.urlencoded({ extended: true }));


// --- CONNEXION À LA BASE DE DONNÉES ---
// (Le reste du code est inchangé...)
const mongoClient = new MongoClient(process.env.DATABASE_URL);
let db; 

mongoClient.connect()
    .then(() => {
        console.log('✅ Panel web connecté à la base de données MongoDB !');
        db = mongoClient.db('nexoprotect_db'); 
    })
    .catch(err => {
        console.error("❌ Erreur de connexion à MongoDB pour le panel:", err);
        process.exit(1);
    });


// --- ROUTES DE L'APPLICATION ---

// 1. Route principale : affiche la page d'accueil de votre panel
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'src', 'dashboard', 'views', 'index.html'));
});


// 2. Route de Callback 
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) {
        return res.status(400).send('Erreur : "code" manquant. Impossible de vous connecter.');
    }
    try {
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
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userResponse.json();
        res.send(`<h1>Bienvenue, ${userData.username}!</h1><p>Vous êtes maintenant connecté.</p>`);
    } catch (error) {
        console.error("Erreur critique dans la route /callback:", error);
        res.status(500).send('Une erreur interne est survenue.');
    }
});


// 3. Route pour enregistrer les paramètres
app.post('/save-settings', async (req, res) => {
    const { serverId, newPrefix } = req.body;
    if (!serverId || !newPrefix) {
        return res.status(400).json({ message: 'Données manquantes (serverId ou newPrefix).' });
    }
    if (!db) {
        return res.status(503).json({ message: 'Service temporairement indisponible (pas de connexion à la base de données).' });
    }
    try {
        const configCollection = db.collection('configurations');
        await configCollection.updateOne(
            { serverId: serverId },
            { $set: { prefix: newPrefix } },
            { upsert: true }
        );
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
