import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
app.use(express.static(path.join(__dirname, '../client')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));

const MEDIA_FOLDER = process.env.MEDIA_FOLDER || "/Volumes/2TB/Movies.2TB";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "866794356a9e7ac61771ae56bd99e284";
const HLS_TMP = '/tmp/freestream-hls';

if (!fs.existsSync(HLS_TMP)) fs.mkdirSync(HLS_TMP, { recursive: true });

const metadataCache = {};
const activeStreams = {};

function resolveMediaPath(file, folders) {
    for (const folder of folders) {
        const p = path.join(folder, file);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function getLocalIP() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                return net.address;
            }
        }
    }
}

// Manual overrides for filenames that can't be parsed automatically
const MANUAL_OVERRIDES = {
    'Se7en(1995)1080p.BrRip.x264.YIFY.mp4': { title: 'Se7en', year: '1995' },
    'War.Of.The.Worlds.Revival.2025.1080p.WEBRip.x264.AAC5.1-[YTS.MX].mp4': { title: 'War of the Worlds Revival', year: '2025' },
    'Revo005.mkv': { title: 'Revo', year: null },
};

async function searchTMDB(title, year) {
    const queries = year
        ? [
            `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&year=${year}`,
            `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}&year=${parseInt(year)+1}`,
            `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`
          ]
        : [`https://api.themoviedb.org/3/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`];
    for (const url of queries) {
        const data = await fetch(url).then(r => r.json());
        if (data.results?.[0]) return data.results[0];
    }
    return null;
}

function parseFilename(filename) {
    let base = filename.replace(/\.(mkv|mp4|avi|mov)$/i, '');
    let year = null;

    // Match (1995) or [1995] with or without space before
    let m = base.match(/\s*[\[(]((?:19|20)\d{2})[\])]/);
    if (m) { year = m[1]; base = base.replace(m[0], '').trim(); }

    if (!year) {
        // Space before year: Title 2025 ...
        m = base.match(/^(.+?)\s((19|20)\d{2})(\s|$)/);
        if (m) { year = m[2]; base = m[1]; }
        else {
            // Dot before year: Title.2025....
            m = base.match(/^(.+?)\.((?:19|20)\d{2})(?:\.|$)/);
            if (m) { year = m[2]; base = m[1]; }
        }
    }

    const junk = /\b(\d{3,4}p|4K|UHD|WEB[-.]?DL|WEBRip|BluRay|BrRip|HDRip|HEVC|x265|x264|H\.?264|H\.?265|AAC|DDP|AC3|DD|BONE|RARBG|YTS|NeoNoir|DUAL|UNRATED|Extended|AMZN|IMAX|NF|iNTERNAL|Multi|SupaCvnt|RMTeam|BYNDR|FHC|RGB|Line|eztv|MeGusta|HC|10Bit|Subs|KINGDOM|6CH|S0\d+E\d+|Eng|ESub|DV|UpScaled|HDR10|HDR|ita|eng|NUeng|Licdom|iTA|KOR|aWEBRip|Dr4gon|YIFY|YG|LT|AM|AG|MX)\b.*/i;

    let title = base
        .replace(/\./g, ' ')
        .replace(junk, '')
        .replace(/\s*-\s*$/, '')
        .replace(/[-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return { title, year };
}

async function getMetadata(filename) {
    if (metadataCache[filename]) return metadataCache[filename];
    const { title, year } = MANUAL_OVERRIDES[filename] || parseFilename(filename);
    try {
        const movie = await searchTMDB(title, year);
        const result = movie ? {
            title: movie.title,
            year: year || movie.release_date?.split('-')[0],
            poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null,
            overview: movie.overview,
            rating: movie.vote_average,
            filename
        } : { title, year, poster: null, overview: null, rating: null, filename };
        metadataCache[filename] = result;
        return result;
    } catch (err) {
        return { title, year, poster: null, overview: null, rating: null, filename };
    }
}

app.get('/movies', async (req, res) => {
    try {
        const settings = loadSettings();
        const folders = settings.mediaFolders || [MEDIA_FOLDER];
        const allFiles = [];
        for (const folder of folders) {
            try {
                const files = fs.readdirSync(folder)
                    .filter(f => (f.endsWith('.mp4') || f.endsWith('.mkv')) && !f.startsWith('._'));
                files.forEach(f => allFiles.push({ file: f, folder }));
            } catch(e) { console.error('Cannot read folder:', folder); }
        }
        const movies = await Promise.all(allFiles.map(async ({ file: f, folder }) => {
            const meta = await getMetadata(f);
            const stat = fs.statSync(path.join(folder, f));
            meta.added = stat.mtimeMs;
            meta.folder = folder;
            return meta;
        }));
        res.json(movies);
    } catch (err) {
        res.status(500).json({ error: 'Could not read media folder' });
    }
});

// Open in VLC locally
app.get('/open', (req, res) => {
    const file = req.query.file;
    const settings = loadSettings();
    const folders = settings.mediaFolders || [MEDIA_FOLDER];
    let fullPath = null;
    for (const folder of folders) {
        const p = path.join(folder, file);
        if (fs.existsSync(p)) { fullPath = p; break; }
    }
    if (!fullPath) return res.status(404).send('File not found');
    exec(`open -a VLC "${fullPath}"`);
    res.send('ok');
});

// HLS streaming endpoint
app.get('/hls/:streamId/index.m3u8', (req, res) => {
    const { streamId } = req.params;
    const playlistPath = path.join(HLS_TMP, streamId, 'index.m3u8');

    // Wait up to 10s for playlist to appear
    let attempts = 0;
    const wait = setInterval(() => {
        if (fs.existsSync(playlistPath)) {
            clearInterval(wait);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.sendFile(playlistPath);
        } else if (++attempts > 20) {
            clearInterval(wait);
            res.status(404).send('Playlist not ready');
        }
    }, 500);
});

app.get('/hls/:streamId/:segment', (req, res) => {
    const { streamId, segment } = req.params;
    const segPath = path.join(HLS_TMP, streamId, segment);
    if (!fs.existsSync(segPath)) return res.status(404).send('Segment not found');
    res.setHeader('Content-Type', segment.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(segPath);
});

// Start HLS transcode
app.get('/start-stream', (req, res) => {
    const file = req.query.file;
    const tvfile = req.query.tvfile;
    const target = tvfile || file;
    const settings = loadSettings();
    let fullPath;
    if (tvfile) {
        const tvFolder = settings.tvFolder || TV_FOLDER;
        fullPath = path.join(tvFolder, decodeURIComponent(tvfile));
    } else {
        const folders = settings.mediaFolders || [MEDIA_FOLDER];
        fullPath = resolveMediaPath(file, folders);
    }
    if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });

    const streamId = Buffer.from(target).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    const outDir = path.join(HLS_TMP, streamId);

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    // Kill existing stream for this file
    if (activeStreams[streamId]) {
        activeStreams[streamId].kill();
        delete activeStreams[streamId];
    }

    const isMkv = target.toLowerCase().endsWith('.mkv');

    // Detect input codec
    let inputCodec = 'hevc';
    try {
        inputCodec = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1 "${fullPath}"`).toString().trim().replace('codec_name=','');
    } catch(e) {}
    console.log('Input codec:', inputCodec, 'for', fullPath);

    const videoArgs = inputCodec === 'h264'
        ? ['-c:v', 'copy']
        : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23'];

    const audioLang = settings.preferredAudioLang || 'eng';
    let audioMap = ['-map', '0:a:0']; // default first audio
    try {
        const probeResult = execSync(`ffprobe -v error -select_streams a -show_entries stream=index:stream_tags=language -of json "${fullPath}"`).toString();
        const streams = JSON.parse(probeResult).streams;
        const preferred = streams.find(s => s.tags?.language === audioLang);
        if (preferred) {
            const idx = streams.indexOf(preferred);
            audioMap = ['-map', `0:a:${idx}`];
            console.log(`Using audio track ${idx} (${audioLang})`);
        }
    } catch(e) {}

    const ffmpeg = spawn('ffmpeg', [
        '-i', fullPath,
        '-map', '0:v:0',
        ...audioMap,
        ...videoArgs,
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2',
        '-hls_time', '4',
        '-hls_list_size', '0',
        '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(outDir, 'seg%03d.ts'),
        path.join(outDir, 'index.m3u8')
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    activeStreams[streamId] = ffmpeg;
    console.log('Starting FFmpeg for:', fullPath);
    ffmpeg.stderr.on('data', d => console.error('[FFmpeg]', d.toString().slice(0, 100)));
    ffmpeg.on('error', err => console.error('[FFmpeg spawn error]', err));
    ffmpeg.on('close', () => delete activeStreams[streamId]);

    res.json({ streamId, url: `/hls/${streamId}/index.m3u8` });
});

// Range request support for MP4
app.get('/stream-mp4', (req, res) => {
    const file = req.query.file;
    const settings = loadSettings();
    const folders = settings.mediaFolders || [MEDIA_FOLDER];
    const fullPath = resolveMediaPath(file, folders);
    if (!fullPath) return res.status(404).send('File not found');
    const stat = fs.statSync(fullPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;
        const fileStream = fs.createReadStream(fullPath, { start, end });
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4',
        });
        fileStream.pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(fullPath).pipe(res);
    }
});

app.use('/media', express.static(MEDIA_FOLDER));

app.listen(PORT, () => {
    console.log(`FreeStream running: http://localhost:${PORT}`);
    console.log(`Local IP: ${getLocalIP()}`);
});

// TV Shows endpoint
const TV_FOLDER = "/Volumes/2TB/Movies.2TB/TV Shows";

async function getTVMetadata(showName) {
    if (metadataCache['tv_' + showName]) return metadataCache['tv_' + showName];
    try {
        const url = `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(showName)}`;
        const data = await fetch(url).then(r => r.json());
        const show = data.results?.[0];
        const result = show ? {
            title: show.name,
            poster: show.poster_path ? `https://image.tmdb.org/t/p/w500${show.poster_path}` : null,
            overview: show.overview,
            rating: show.vote_average,
            type: 'tv',
            showName
        } : { title: showName, poster: null, overview: null, rating: null, type: 'tv', showName };
        metadataCache['tv_' + showName] = result;
        return result;
    } catch(err) {
        return { title: showName, poster: null, overview: null, rating: null, type: 'tv', showName };
    }
}

app.get('/tvshows', async (req, res) => {
    try {
        const shows = fs.readdirSync(TV_FOLDER)
            .filter(f => fs.statSync(`${TV_FOLDER}/${f}`).isDirectory());
        const metadata = await Promise.all(shows.map(getTVMetadata));
        res.json(metadata);
    } catch(err) {
        res.status(500).json({ error: 'Could not read TV folder' });
    }
});

app.get('/tvshows/episodes', (req, res) => {
    const show = req.query.show;
    const showPath = `${TV_FOLDER}/${show}`;
    try {
        const episodes = [];
        const scanDir = (dir, prefix) => {
            fs.readdirSync(dir).forEach(f => {
                const full = path.join(dir, f);
                if (fs.statSync(full).isDirectory()) {
                    scanDir(full, prefix ? prefix + '/' + f : f);
                } else if ((f.endsWith('.mp4') || f.endsWith('.mkv')) && !f.startsWith('._')) {
                    episodes.push({ file: prefix ? prefix + '/' + f : f, name: f });
                }
            });
        };
        scanDir(showPath, '');
        episodes.sort((a, b) => a.file.localeCompare(b.file));
        res.json(episodes);
    } catch(err) {
        res.status(500).json({ error: 'Could not read show folder' });
    }
});

app.use('/tv-media', express.static(TV_FOLDER));

app.get('/clear-cache', (req, res) => {
    Object.keys(metadataCache).forEach(k => delete metadataCache[k]);
    res.send('Cache cleared');
});

// Settings
import { loadSettings, saveSettings } from './settings.js';

app.get('/api/settings', (req, res) => {
    res.json(loadSettings());
});

app.post('/api/settings', express.json(), (req, res) => {
    saveSettings(req.body);
    res.json({ ok: true });
});

// Native folder picker via AppleScript
app.get('/pick-folder', async (req, res) => {
    try {
        const { execSync } = await import('child_process');
        const result = execSync(`osascript -e 'POSIX path of (choose folder with prompt "Select Media Folder")'`).toString().trim();
        res.json({ path: result });
    } catch(e) {
        res.json({ path: null });
    }
});
