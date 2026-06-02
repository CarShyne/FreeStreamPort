import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

export const APP_VERSION = '1.0.10';

const DEFAULTS = {
    mediaFolders: [process.env.MEDIA_FOLDER || "/media/movies"],
    tvFolder: process.env.TV_FOLDER || "/media/TV Shows",
    preferredAudioLang: "eng",
    tmdbApiKey: process.env.TMDB_API_KEY || "866794356a9e7ac61771ae56bd99e284",
    port: parseInt(process.env.PORT, 10) || 3000
};

function applyEnvOverrides(settings) {
    const next = { ...settings };
    if (process.env.MEDIA_FOLDER) next.mediaFolders = [process.env.MEDIA_FOLDER];
    if (process.env.TV_FOLDER) next.tvFolder = process.env.TV_FOLDER;
    if (process.env.TMDB_API_KEY) next.tmdbApiKey = process.env.TMDB_API_KEY;
    if (process.env.PORT) next.port = parseInt(process.env.PORT, 10) || 3000;
    next.pathsFromEnv = Boolean(process.env.MEDIA_FOLDER || process.env.TV_FOLDER);
    next.version = APP_VERSION;
    return next;
}

export function loadSettings() {
    let settings = { ...DEFAULTS };
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
        }
    } catch (e) {}
    return applyEnvOverrides(settings);
}

export function saveSettings(settings) {
    const merged = applyEnvOverrides({ ...loadSettings(), ...settings });
    delete merged.pathsFromEnv;
    delete merged.version;
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(merged, null, 2));
}
