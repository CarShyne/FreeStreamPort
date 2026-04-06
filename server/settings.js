import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

const DEFAULTS = {
    mediaFolders: ["/Volumes/2TB/Movies.2TB"],
    tvFolder: "/Volumes/2TB/Movies.2TB/TV Shows",
    preferredAudioLang: "eng",
    tmdbApiKey: "866794356a9e7ac61771ae56bd99e284",
    port: 3000
};

export function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
        }
    } catch(e) {}
    return { ...DEFAULTS };
}

export function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}
