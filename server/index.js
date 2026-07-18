import express from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { exec, spawn, execSync, execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { loadSettings, saveSettings, APP_VERSION } from './settings.js';
import {
    authMiddleware,
    handleLogin,
    handleLogout,
    handleAuthStatus,
    createMediaToken,
} from './auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileP = promisify(execFile);

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

app.post('/api/auth/login', express.json(), handleLogin);
app.post('/api/auth/logout', handleLogout);
app.get('/api/auth/status', handleAuthStatus);
app.use(authMiddleware);

app.use((req, res, next) => {
    if (req.path === '/' || req.path === '/index.html' || req.path === '/app.js') {
        res.setHeader('Cache-Control', 'no-store');
    }
    next();
});

app.use(express.static(path.join(__dirname, '../client')));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules')));

const MEDIA_FOLDER = process.env.MEDIA_FOLDER || "/Volumes/2TB/Movies.2TB";
const TV_FOLDER = process.env.TV_FOLDER || "/Volumes/2TB/Movies.2TB/TV Shows";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "866794356a9e7ac61771ae56bd99e284";
const HLS_TMP = '/tmp/freestream-hls';
const HLS_SEGMENT_SEC = 4;
const HLS_GOP = HLS_SEGMENT_SEC * 24;

if (!fs.existsSync(HLS_TMP)) fs.mkdirSync(HLS_TMP, { recursive: true });

// Auto-detect the best available FFmpeg hardware encoder on any host.
// Override order with FREESTREAM_HW_ENCODER=nvenc,amf,qsv or force FREESTREAM_HW_ENCODER=software
const HW_ENCODER_ENV = (process.env.FREESTREAM_HW_ENCODER || '').trim();
const HW_ENCODER_SOFTWARE = HW_ENCODER_ENV.toLowerCase() === 'software';
const DEFAULT_ENCODER_ORDER = ['nvenc', 'qsv', 'amf', 'videotoolbox', 'v4l2m2m'];
const HW_ENCODER_PRIORITY = HW_ENCODER_SOFTWARE
    ? []
    : (HW_ENCODER_ENV || DEFAULT_ENCODER_ORDER.join(','))
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);

const HW_ENCODER_MAP = {
    v4l2m2m: 'h264_v4l2m2m',
    nvenc: 'h264_nvenc',
    qsv: 'h264_qsv',
    amf: 'h264_amf',
    videotoolbox: 'h264_videotoolbox',
};

function nvidiaGpuPresent() {
    return fs.existsSync('/dev/nvidia0') || fs.existsSync('/dev/nvidiactl');
}

function driPresent() {
    return fs.existsSync('/dev/dri/renderD128') || fs.existsSync('/dev/dri/card0');
}

function v4l2DevicesPresent() {
    try {
        return fs.readdirSync('/dev').some(name => /^video\d+$/.test(name));
    } catch {
        return false;
    }
}

// Pi 5 has no hardware video *encoder* (its /dev/video* nodes are HEVC decode only),
// so h264_v4l2m2m must never be selected there.
function isRaspberryPi5() {
    try {
        return fs.readFileSync('/proc/device-tree/model', 'utf8').includes('Raspberry Pi 5');
    } catch {
        return false;
    }
}

function encoderRequirementsMet(name) {
    switch (name) {
        case 'nvenc':
            return nvidiaGpuPresent();
        case 'qsv':
        case 'amf':
            return driPresent();
        case 'videotoolbox':
            return process.platform === 'darwin';
        case 'v4l2m2m':
            return v4l2DevicesPresent() && !isRaspberryPi5();
        default:
            return false;
    }
}

function loadFfmpegEncoders() {
    try {
        return execSync('ffmpeg -hide_banner -encoders 2>/dev/null', { encoding: 'utf8' });
    } catch {
        return '';
    }
}

function probeAvailableEncoders(ffmpegEncoders) {
    const available = [];
    for (const name of DEFAULT_ENCODER_ORDER) {
        const codec = HW_ENCODER_MAP[name];
        if (codec && ffmpegEncoders.includes(codec) && encoderRequirementsMet(name)) {
            available.push(name);
        }
    }
    return available;
}

function detectHwEncoder(ffmpegEncoders, available) {
    if (HW_ENCODER_SOFTWARE) return null;
    for (const name of HW_ENCODER_PRIORITY) {
        if (available.includes(name)) return name;
    }
    return null;
}

function getEncoderInfo() {
    return {
        platform: `${process.platform}/${process.arch}`,
        videoEncoder: videoEncoderLabel,
        hardwareEncoder: hwEncoder,
        availableEncoders: availableHwEncoders,
        encoderOrder: HW_ENCODER_PRIORITY.length ? HW_ENCODER_PRIORITY : DEFAULT_ENCODER_ORDER,
        softwareFallback: !hwEncoder,
    };
}

const ffmpegEncoders = loadFfmpegEncoders();
const availableHwEncoders = probeAvailableEncoders(ffmpegEncoders);
const hwEncoder = detectHwEncoder(ffmpegEncoders, availableHwEncoders);
const videoEncoderLabel = hwEncoder ? `${hwEncoder}/${HW_ENCODER_MAP[hwEncoder]}` : 'libx264 (software)';
const HLS_HEAD_START_SEGMENTS = Number(process.env.FREESTREAM_HLS_HEAD_START)
    || (!hwEncoder ? 6 : 4);
const HLS_HEAD_START_COPY_SEGMENTS = 3;

console.log(`Platform: ${process.platform}/${process.arch}`);
console.log(`Available HW encoders: ${availableHwEncoders.length ? availableHwEncoders.join(', ') : 'none'}`);
console.log(`Video encoder: ${videoEncoderLabel}`);
if (!hwEncoder) {
    console.warn('No hardware encoder available — using libx264. Pass GPU/V4L2 devices into Docker or run natively for HW accel.');
}
if (HW_ENCODER_ENV && !HW_ENCODER_SOFTWARE) {
    console.log(`HW encoder priority: ${HW_ENCODER_PRIORITY.join(' → ')}`);
}

function countHlsSegments(outDir) {
    try {
        return fs.readdirSync(outDir).filter(f => f.endsWith('.ts')).length;
    } catch {
        return 0;
    }
}

function waitForHeadStart(outDir, minSegments, timeoutMs) {
    return new Promise(resolve => {
        const deadline = Date.now() + timeoutMs;
        const tick = () => {
            if (countHlsSegments(outDir) >= minSegments) return resolve(true);
            if (Date.now() >= deadline) return resolve(false);
            setTimeout(tick, 400);
        };
        tick();
    });
}

function buildDecodeArgs(forEncoder = hwEncoder) {
    if (!forEncoder) {
        if (process.platform === 'darwin') return ['-hwaccel', 'videotoolbox'];
        if (nvidiaGpuPresent()) return ['-hwaccel', 'cuda'];
        // Note: no drm_prime here — software encoders can't consume DRM frames
        return ['-hwaccel', 'auto'];
    }
    switch (forEncoder) {
        case 'v4l2m2m':
            return v4l2DevicesPresent()
                ? ['-hwaccel', 'drm', '-hwaccel_output_format', 'drm_prime']
                : ['-hwaccel', 'auto'];
        case 'nvenc':
            return nvidiaGpuPresent() ? ['-hwaccel', 'cuda'] : ['-hwaccel', 'auto'];
        case 'qsv':
            return driPresent() ? ['-hwaccel', 'qsv'] : ['-hwaccel', 'auto'];
        case 'amf':
            return fs.existsSync('/dev/dri/renderD128')
                ? ['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD128']
                : ['-hwaccel', 'auto'];
        case 'videotoolbox':
            return ['-hwaccel', 'videotoolbox'];
        default:
            return ['-hwaccel', 'auto'];
    }
}

const TRANSCODE_SCALE_HD = "scale='min(1280,iw):min(720,ih):force_original_aspect_ratio=decrease'";
const TRANSCODE_SCALE_SD = "scale='min(854,iw):min(480,ih):force_original_aspect_ratio=decrease'";

function getTranscodeScale() {
    if (!hwEncoder) return TRANSCODE_SCALE_SD;
    return TRANSCODE_SCALE_HD;
}

function buildTranscodeKeyframeArgs() {
    return ['-g', String(HLS_GOP), '-keyint_min', String(HLS_GOP), '-sc_threshold', '0'];
}

function buildHwTranscodeArgs(encoder) {
    const keyframeArgs = buildTranscodeKeyframeArgs();
    const scale = getTranscodeScale();
    switch (encoder) {
        case 'v4l2m2m':
            return [
                '-c:v', 'h264_v4l2m2m',
                '-b:v', '2500k', '-maxrate', '3000k', '-bufsize', '6000k',
                '-vf', scale,
                '-num_output_buffers', '32',
                '-num_capture_buffers', '32',
                ...keyframeArgs,
            ];
        case 'nvenc':
            return [
                '-c:v', 'h264_nvenc',
                '-preset', 'p5', '-tune', 'll',
                '-b:v', '3M', '-maxrate', '4M', '-bufsize', '8M',
                '-vf', scale,
                '-profile:v', 'high', '-level', '4.1',
                ...keyframeArgs,
            ];
        case 'qsv':
            return [
                '-c:v', 'h264_qsv',
                '-preset', 'veryfast',
                '-global_quality', '28',
                '-b:v', '3M', '-maxrate', '4M', '-bufsize', '8M',
                '-vf', scale,
                '-profile:v', 'high', '-level', '4.1',
                ...keyframeArgs,
            ];
        case 'amf':
            return [
                '-c:v', 'h264_amf',
                '-quality', 'speed',
                '-rc', 'vbr_latency',
                '-b:v', '3M', '-maxrate', '4M', '-bufsize', '8M',
                '-vf', scale,
                '-profile:v', 'high', '-level', '4.1',
                ...keyframeArgs,
            ];
        case 'videotoolbox':
            return [
                '-c:v', 'h264_videotoolbox',
                '-b:v', '3M', '-maxrate', '4M', '-bufsize', '8M',
                '-vf', scale,
                '-profile:v', 'high', '-level', '4.1',
                ...keyframeArgs,
            ];
        default:
            return null;
    }
}

async function probeVideoCodec(fullPath) {
    try {
        const { stdout } = await execFileP('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1', fullPath,
        ]);
        return stdout.trim().replace('codec_name=', '');
    } catch {
        return 'hevc';
    }
}

async function getAudioMap(fullPath, settings) {
    const audioLang = settings.preferredAudioLang || 'eng';
    let audioMap = ['-map', '0:a:0'];
    try {
        const { stdout } = await execFileP('ffprobe', [
            '-v', 'error', '-select_streams', 'a',
            '-show_entries', 'stream=index:stream_tags=language',
            '-of', 'json', fullPath,
        ]);
        const streams = JSON.parse(stdout).streams;
        const preferred = streams.find(s => s.tags?.language === audioLang);
        if (preferred) {
            const idx = streams.indexOf(preferred);
            audioMap = ['-map', `0:a:${idx}`];
            console.log(`Using audio track ${idx} (${audioLang})`);
        }
    } catch (_) {}
    return audioMap;
}

function buildVideoArgs(inputCodec, isMkv) {
    if (inputCodec === 'h264') {
        return isMkv
            ? ['-c:v', 'copy']
            : ['-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb'];
    }

    if (hwEncoder) {
        const hwArgs = buildHwTranscodeArgs(hwEncoder);
        if (hwArgs) return hwArgs;
    }

    // No zerolatency: it disables frame threading, which badly hurts encode speed
    return [
        '-c:v', 'libx264', '-preset', 'ultrafast',
        '-crf', '30', '-threads', '0', '-vf', getTranscodeScale(),
        '-pix_fmt', 'yuv420p', ...buildTranscodeKeyframeArgs(),
    ];
}

function getEncodedDuration(outDir) {
    const playlistPath = path.join(outDir, 'index.m3u8');
    if (!fs.existsSync(playlistPath)) {
        return countHlsSegments(outDir) * HLS_SEGMENT_SEC;
    }
    try {
        const playlist = fs.readFileSync(playlistPath, 'utf8');
        const matches = playlist.match(/#EXTINF:([\d.]+)/g);
        if (!matches) return countHlsSegments(outDir) * HLS_SEGMENT_SEC;
        return matches.reduce((sum, line) => sum + parseFloat(line.split(':')[1]), 0);
    } catch {
        return countHlsSegments(outDir) * HLS_SEGMENT_SEC;
    }
}

const metadataCache = {};
const activeStreams = {};
const activeByFile = {};
const streamLastAccess = {};
const backgroundRemuxes = new Set();
const STREAM_IDLE_MS = 2 * 60 * 1000;

function touchStream(streamId) {
    streamLastAccess[streamId] = Date.now();
}

// Kill FFmpeg jobs nobody is watching (player closed / tab gone)
setInterval(() => {
    const now = Date.now();
    for (const [id, proc] of Object.entries(activeStreams)) {
        if (now - (streamLastAccess[id] || 0) > STREAM_IDLE_MS) {
            console.log('[Reaper] Killing idle FFmpeg for stream', id);
            proc.kill('SIGTERM');
            delete activeStreams[id];
        }
    }
}, 30 * 1000);

// Prune stale HLS/cache dirs so /tmp doesn't fill up.
// Dirs with a cached play.mp4 are kept 7 days, plain segment dirs 24h.
function pruneHlsTmp() {
    let entries;
    try { entries = fs.readdirSync(HLS_TMP); } catch { return; }
    for (const dir of entries) {
        const full = path.join(HLS_TMP, dir);
        try {
            if (!fs.statSync(full).isDirectory() || activeStreams[dir]) continue;
            let newest = 0;
            let hasCache = false;
            for (const f of fs.readdirSync(full)) {
                const st = fs.statSync(path.join(full, f));
                if (st.mtimeMs > newest) newest = st.mtimeMs;
                if (f === 'play.mp4') hasCache = true;
            }
            const maxAge = (hasCache ? 7 * 24 : 24) * 3600 * 1000;
            if (Date.now() - newest > maxAge) {
                console.log('[Prune] Removing stale stream dir', dir);
                fs.rmSync(full, { recursive: true, force: true });
            }
        } catch {}
    }
}
pruneHlsTmp();
setInterval(pruneHlsTmp, 6 * 3600 * 1000);

function getMediaFolders(settings) {
    if (process.env.MEDIA_FOLDER) return [process.env.MEDIA_FOLDER];
    const folders = settings?.mediaFolders?.filter(Boolean);
    return folders?.length ? folders : [MEDIA_FOLDER];
}

function checkFolder(folder) {
    const normalized = folder.replace(/\/+$/, '');
    try {
        if (!fs.existsSync(normalized)) return { path: folder, ok: false, error: 'Path not found — is the drive connected?' };
        if (!fs.statSync(normalized).isDirectory()) return { path: folder, ok: false, error: 'Path is not a folder' };
        return { path: normalized, ok: true };
    } catch (e) {
        return { path: folder, ok: false, error: e.message };
    }
}

function getAccessibleMediaFolders(settings) {
    const configured = getMediaFolders(settings);
    const checked = configured.map(checkFolder);
    return {
        folders: checked.filter(f => f.ok).map(f => f.path),
        status: checked
    };
}

function logFolderStatus(settings) {
    if (process.env.MEDIA_FOLDER) console.log(`MEDIA_FOLDER (env): ${process.env.MEDIA_FOLDER}`);
    if (process.env.TV_FOLDER) console.log(`TV_FOLDER (env): ${process.env.TV_FOLDER}`);
    const media = getAccessibleMediaFolders(settings);
    const tv = checkFolder(getTvFolder(settings));
    media.status.forEach(f => {
        if (!f.ok) console.warn(`Media folder unavailable: ${f.path} (${f.error})`);
    });
    if (!tv.ok) console.warn(`TV folder unavailable: ${tv.path} (${tv.error})`);
    if (media.folders.length) console.log(`Media folders ready: ${media.folders.join(', ')}`);
    if (tv.ok) console.log(`TV folder ready: ${tv.path}`);
}

function getTvFolder(settings) {
    return process.env.TV_FOLDER || settings?.tvFolder || TV_FOLDER;
}

function resolveFilePath(file, tvfile, settings) {
    if (tvfile) {
        return path.join(getTvFolder(settings), decodeURIComponent(tvfile));
    }
    return resolveMediaPath(file, getMediaFolders(settings));
}

function mimeForPath(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp4') return 'video/mp4';
    if (ext === '.mkv') return 'video/x-matroska';
    return 'application/octet-stream';
}

function resolveMediaPath(file, folders) {
    const normalized = file.split('/').join(path.sep);
    for (const folder of folders) {
        const p = path.join(folder, normalized);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function scanMediaFiles(dir, rootDir = dir, results = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        return results;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('._')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const lower = entry.name.toLowerCase();
            if (lower === 'tv shows' || lower === 'tvshows') continue;
            scanMediaFiles(full, rootDir, results);
        } else if (/\.(mp4|mkv)$/i.test(entry.name)) {
            results.push({
                file: path.relative(rootDir, full).split(path.sep).join('/'),
                folder: rootDir
            });
        }
    }
    return results;
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
    const basename = path.basename(filename);
    const { title, year } = MANUAL_OVERRIDES[basename] || MANUAL_OVERRIDES[filename] || parseFilename(basename);
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
        const { folders, status } = getAccessibleMediaFolders(settings);
        if (!folders.length) {
            return res.status(503).json({
                error: 'No media folders available',
                folders: status,
                hint: 'Connect your drive and check the path in Settings (gear icon).'
            });
        }
        const allFiles = [];
        for (const folder of folders) {
            scanMediaFiles(folder).forEach(item => allFiles.push(item));
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
    const folders = getMediaFolders(settings);
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
function serveHlsPlaylist(res, playlistPath, token) {
    let body = fs.readFileSync(playlistPath, 'utf8');
    if (!body.includes('#EXT-X-START:')) {
        body = body.replace(
            '#EXTM3U\n',
            '#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n'
        );
    }
    // Propagate the media token to segment URLs (iOS fetches them cookie-less)
    if (token && /^[a-f0-9]+$/i.test(token)) {
        body = body.split('\n').map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) return line;
            return `${trimmed}?token=${token}`;
        }).join('\n');
    }
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(body);
}

app.get('/hls/:streamId/index.m3u8', (req, res) => {
    const { streamId } = req.params;
    touchStream(streamId);
    const playlistPath = path.join(HLS_TMP, streamId, 'index.m3u8');

    // Wait up to 10s for playlist to appear
    let attempts = 0;
    const wait = setInterval(() => {
        if (fs.existsSync(playlistPath)) {
            clearInterval(wait);
            serveHlsPlaylist(res, playlistPath, req.query.token);
        } else if (++attempts > 20) {
            clearInterval(wait);
            res.status(404).send('Playlist not ready');
        }
    }, 500);
});

function sendHlsSegment(res, segPath, segment) {
    res.setHeader('Content-Type', segment.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(segPath);
}

app.get('/hls/:streamId/:segment', (req, res) => {
    const { streamId, segment } = req.params;
    touchStream(streamId);
    const segPath = path.join(HLS_TMP, streamId, segment);

    if (fs.existsSync(segPath)) {
        return sendHlsSegment(res, segPath, segment);
    }

    // Segment may still be encoding — wait briefly instead of 404-stalling the player
    let attempts = 0;
    const wait = setInterval(() => {
        if (res.writableEnded) {
            clearInterval(wait);
            return;
        }
        if (fs.existsSync(segPath)) {
            clearInterval(wait);
            sendHlsSegment(res, segPath, segment);
        } else if (++attempts > 100) {
            clearInterval(wait);
            res.status(404).send('Segment not found');
        }
    }, 100);
    req.on('close', () => clearInterval(wait));
});

function sendMp4Range(req, res, fullPath) {
    const stat = fs.statSync(fullPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = (end - start) + 1;
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': 'video/mp4',
        });
        fs.createReadStream(fullPath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
        });
        fs.createReadStream(fullPath).pipe(res);
    }
}

function waitForFfmpeg(ffmpeg) {
    return new Promise((resolve, reject) => {
        ffmpeg.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exited ${code}`));
        });
        ffmpeg.on('error', reject);
    });
}

function cachedMp4IsValid(mp4Path, sourcePath) {
    try {
        if (!fs.existsSync(mp4Path)) return false;
        const mp4Stat = fs.statSync(mp4Path);
        const srcStat = fs.statSync(sourcePath);
        return mp4Stat.size > 65536 && mp4Stat.mtimeMs >= srcStat.mtimeMs;
    } catch {
        return false;
    }
}

async function remuxToCachedMp4(fullPath, mp4Path, audioMap) {
    const tmpPath = mp4Path + '.part';
    const ffmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-probesize', '32M', '-analyzeduration', '10M',
        '-i', fullPath,
        '-map', '0:v:0',
        ...audioMap,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
        '-max_muxing_queue_size', '9999',
        '-movflags', '+faststart',
        '-f', 'mp4',
        '-y', tmpPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    ffmpeg.stderr.on('data', d => console.error('[Remux]', d.toString().slice(0, 120)));
    await waitForFfmpeg(ffmpeg);
    fs.renameSync(tmpPath, mp4Path);
}

// Build the seekable MP4 cache without blocking playback (first play streams via HLS copy)
function buildCachedMp4InBackground(fullPath, mp4Path, audioMap) {
    if (backgroundRemuxes.has(mp4Path)) return;
    backgroundRemuxes.add(mp4Path);
    console.log('[Remux] Building cached MP4 in background for:', fullPath);
    remuxToCachedMp4(fullPath, mp4Path, audioMap)
        .then(() => console.log('[Remux] Cached MP4 ready:', mp4Path))
        .catch(err => {
            console.warn('[Remux] Background cache failed:', err.message);
            try { fs.unlinkSync(mp4Path + '.part'); } catch {}
        })
        .finally(() => backgroundRemuxes.delete(mp4Path));
}

app.get('/stream-cache/:streamId/play.mp4', (req, res) => {
    const mp4Path = path.join(HLS_TMP, req.params.streamId, 'play.mp4');
    if (!fs.existsSync(mp4Path)) return res.status(404).send('Not ready');
    sendMp4Range(req, res, mp4Path);
});

app.get('/hls/:streamId/status', (req, res) => {
    const { streamId } = req.params;
    touchStream(streamId);
    const outDir = path.join(HLS_TMP, streamId);
    const segments = countHlsSegments(outDir);
    const encodedSeconds = getEncodedDuration(outDir);
    res.json({
        segments,
        encodedSeconds,
        segmentDuration: HLS_SEGMENT_SEC,
        encoding: Boolean(activeStreams[streamId]),
        videoEncoder: videoEncoderLabel,
    });
});

// Fast remux for H.264 — streams fragmented MP4 without HLS segment overhead
app.get('/stream-remux', async (req, res) => {
    const { file, tvfile } = req.query;
    const settings = loadSettings();
    const fullPath = resolveFilePath(file, tvfile, settings);
    if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).send('File not found');

    const audioMap = await getAudioMap(fullPath, settings);
    const ffmpeg = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        '-probesize', '32M', '-analyzeduration', '10M',
        '-i', fullPath,
        '-map', '0:v:0',
        ...audioMap,
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
        '-max_muxing_queue_size', '9999',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-f', 'mp4', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    console.log('[Remux] Streaming:', fullPath);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    ffmpeg.stdout.pipe(res);
    ffmpeg.stderr.on('data', d => console.error('[Remux]', d.toString().slice(0, 120)));
    ffmpeg.on('error', err => {
        console.error('[Remux spawn error]', err);
        if (!res.headersSent) res.status(500).end();
    });
    const cleanup = () => { if (!ffmpeg.killed) ffmpeg.kill('SIGTERM'); };
    req.on('close', cleanup);
    res.on('close', cleanup);
});

// Start HLS transcode
app.get('/start-stream', async (req, res) => {
    const file = req.query.file;
    const tvfile = req.query.tvfile;
    const target = tvfile || file;
    const startAt = Math.max(0, Math.floor(Number(req.query.t) || 0));
    const settings = loadSettings();
    const fullPath = resolveFilePath(file, tvfile, settings);
    if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });

    const baseId = Buffer.from(target).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    const streamId = startAt > 0 ? `${baseId}t${startAt}` : baseId;
    const outDir = path.join(HLS_TMP, streamId);

    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const isMkv = target.toLowerCase().endsWith('.mkv');
    const inputCodec = await probeVideoCodec(fullPath);
    const isCopyMode = inputCodec === 'h264';
    const audioMap = await getAudioMap(fullPath, settings);
    const mp4Path = path.join(HLS_TMP, baseId, 'play.mp4');

    console.log('Input codec:', inputCodec, 'encoder:', videoEncoderLabel, 'copyMode:', isCopyMode, 'startAt:', startAt, 'for', fullPath);

    const mediaToken = createMediaToken();

    if (isCopyMode && cachedMp4IsValid(mp4Path, fullPath)) {
        console.log('[Remux] Using cached MP4 for:', fullPath);
        return res.json({
            mode: 'mp4',
            streamId: baseId,
            url: `/stream-cache/${baseId}/play.mp4?token=${mediaToken}`,
            copyMode: true,
        });
    }

    // Kill any previous FFmpeg session for this file (any offset) and clear stale segments
    const prevId = activeByFile[target];
    if (prevId && activeStreams[prevId]) {
        activeStreams[prevId].kill('SIGTERM');
        delete activeStreams[prevId];
    }
    activeByFile[target] = streamId;
    for (const f of fs.readdirSync(outDir)) {
        if (f.endsWith('.ts') || f.endsWith('.m3u8')) {
            fs.unlinkSync(path.join(outDir, f));
        }
    }

    // H.264: start streaming via HLS copy immediately (segmenting is I/O-bound and fast).
    // The seekable MP4 cache is built in the background for future plays.
    if (isCopyMode && startAt === 0) {
        buildCachedMp4InBackground(fullPath, mp4Path, audioMap);
    }

    const videoArgs = buildVideoArgs(inputCodec, isMkv);
    const headStartTarget = isCopyMode ? HLS_HEAD_START_COPY_SEGMENTS : HLS_HEAD_START_SEGMENTS;

    const ffmpegArgs = [
        '-hide_banner', '-loglevel', 'error',
        ...buildDecodeArgs(isCopyMode ? null : hwEncoder),
        '-probesize', '32M', '-analyzeduration', '10M',
        ...(startAt > 0 ? ['-ss', String(startAt)] : []),
        '-i', fullPath,
        '-map', '0:v:0',
        ...audioMap,
        ...videoArgs,
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ac', '2',
        '-max_muxing_queue_size', '9999',
    ];

    if (!isCopyMode) {
        ffmpegArgs.push('-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_SEC})`);
    }

    ffmpegArgs.push(
        '-hls_time', String(HLS_SEGMENT_SEC),
        '-hls_list_size', '0',
        '-hls_playlist_type', 'event',
        '-hls_flags', 'independent_segments+append_list',
        '-hls_segment_filename', path.join(outDir, 'seg%03d.ts'),
        path.join(outDir, 'index.m3u8')
    );

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });

    activeStreams[streamId] = ffmpeg;
    touchStream(streamId);
    console.log('Starting FFmpeg HLS for:', fullPath);
    ffmpeg.stderr.on('data', d => console.error('[FFmpeg]', d.toString().slice(0, 100)));
    ffmpeg.on('error', err => console.error('[FFmpeg spawn error]', err));
    ffmpeg.on('close', () => delete activeStreams[streamId]);

    // Let FFmpeg build a head-start buffer before the player begins consuming
    const headStart = await waitForHeadStart(outDir, headStartTarget, 90000);
    if (!headStart) {
        console.warn('[HLS] Head-start timeout for', streamId, '- starting with', countHlsSegments(outDir), 'segments');
    } else {
        console.log('[HLS] Head-start ready:', countHlsSegments(outDir), 'segments for', streamId, '(transcode)');
    }

    res.json({
        mode: 'hls',
        streamId,
        url: `/hls/${streamId}/index.m3u8?token=${mediaToken}`,
        encodedSeconds: getEncodedDuration(outDir),
        copyMode: isCopyMode,
        startOffset: startAt,
    });
});

// Media token for direct-play URLs (iOS native player sends no cookies)
app.get('/api/media-token', (req, res) => {
    res.json({ token: createMediaToken() });
});

// Range request support for MP4
app.get('/stream-mp4', (req, res) => {
    const file = req.query.file;
    const settings = loadSettings();
    const fullPath = resolveMediaPath(file, getMediaFolders(settings));
    if (!fullPath) return res.status(404).send('File not found');
    sendMp4Range(req, res, fullPath);
});

app.get('/download', (req, res) => {
    const { file, tvfile } = req.query;
    if (!file && !tvfile) return res.status(400).send('Missing file parameter');
    const settings = loadSettings();
    const fullPath = resolveFilePath(file, tvfile, settings);
    if (!fullPath || !fs.existsSync(fullPath)) return res.status(404).send('File not found');

    const basename = path.basename(fullPath);
    const stat = fs.statSync(fullPath);
    res.setHeader('Content-Type', mimeForPath(fullPath));
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `attachment; filename="${basename.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(basename)}`);
    fs.createReadStream(fullPath).pipe(res);
});

app.use('/media', express.static(MEDIA_FOLDER));

app.listen(PORT, () => {
    const settings = loadSettings();
    logFolderStatus(settings);
    console.log(`FreeStream v${APP_VERSION} running: http://localhost:${PORT}`);
    console.log(`Local IP: ${getLocalIP()}`);
});

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
        const tvFolder = getTvFolder(loadSettings());
        const shows = fs.readdirSync(tvFolder)
            .filter(f => fs.statSync(path.join(tvFolder, f)).isDirectory());
        const metadata = await Promise.all(shows.map(getTVMetadata));
        res.json(metadata);
    } catch(err) {
        console.error('Cannot read TV folder:', err.message);
        res.status(500).json({ error: 'Could not read TV folder' });
    }
});

app.get('/tvshows/episodes', (req, res) => {
    const show = req.query.show;
    const tvFolder = getTvFolder(loadSettings());
    const showPath = path.join(tvFolder, show);
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

app.use('/tv-media', (req, res, next) => {
    express.static(getTvFolder(loadSettings()))(req, res, next);
});

app.get('/clear-cache', (req, res) => {
    Object.keys(metadataCache).forEach(k => delete metadataCache[k]);
    res.send('Cache cleared');
});

app.get('/api/version', (req, res) => {
    res.json({ version: APP_VERSION });
});

app.get('/api/settings', (req, res) => {
    res.json(loadSettings());
});

app.get('/api/status', (req, res) => {
    const settings = loadSettings();
    const media = getAccessibleMediaFolders(settings);
    res.json({
        version: APP_VERSION,
        mediaFolders: media.status,
        tvFolder: checkFolder(getTvFolder(settings)),
        encoding: getEncoderInfo(),
    });
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
