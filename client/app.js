let allMovies = [];
let currentMovie = null;
let authenticated = false;

const fetchOpts = { credentials: 'same-origin' };

function showLogin() {
    authenticated = false;
    document.body.classList.add('login-required');
    document.getElementById('logout-btn')?.classList.remove('visible');
    document.getElementById('login-error').textContent = '';
    setTimeout(() => document.getElementById('login-user')?.focus(), 100);
}

function hideLogin() {
    authenticated = true;
    document.body.classList.remove('login-required');
    document.getElementById('logout-btn')?.classList.add('visible');
    document.getElementById('login-error').textContent = '';
}

function requireAuth() {
    if (!authenticated) showLogin();
    return authenticated;
}

async function initAuth() {
    showLogin();
    try {
        const res = await fetch('/api/auth/status', fetchOpts);
        const data = await res.json();
        if (data.authenticated) {
            hideLogin();
            loadMovies();
        }
    } catch {
        document.getElementById('login-error').textContent = 'Could not reach server';
    }
}

async function submitLogin(e) {
    e.preventDefault();
    const username = document.getElementById('login-user').value.trim();
    const password = document.getElementById('login-pass').value;
    const errEl = document.getElementById('login-error');
    const btn = document.getElementById('login-submit');
    errEl.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    try {
        const remember = document.getElementById('login-remember')?.checked ?? true;
        const res = await fetch('/api/auth/login', {
            ...fetchOpts,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, remember }),
        });
        const data = await res.json();
        if (!res.ok) {
            errEl.textContent = data.error || 'Sign in failed';
            return;
        }
        hideLogin();
        loadMovies();
    } catch {
        errEl.textContent = 'Could not reach server';
    } finally {
        btn.disabled = false;
        btn.textContent = 'Sign In';
    }
}

async function logout() {
    await fetch('/api/auth/logout', { ...fetchOpts, method: 'POST' });
    allMovies = [];
    currentMovies = [];
    document.getElementById('grid').innerHTML = '';
    document.getElementById('login-pass').value = '';
    showLogin();
}

async function loadMovies() {
    if (!authenticated) return;
    const res = await fetch('/movies', fetchOpts);
    const data = await res.json();
    if (!res.ok) {
        const grid = document.getElementById('grid');
        grid.innerHTML = `<div style="grid-column:1/-1;padding:40px;text-align:center;color:#888;">
            <p style="color:#ff6b6b;margin-bottom:8px;">${data.error || 'Could not load library'}</p>
            <p style="font-size:13px;margin-bottom:16px;">${data.hint || ''}</p>
            <button class="btn-play" onclick="openSettings()">Open Settings</button>
        </div>`;
        return;
    }
    allMovies = data;
    currentMovies = allMovies.filter(m => !m.filename?.toLowerCase().includes('tv shows'));
    renderGrid(currentMovies);
}

function renderGrid(movies) {
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    movies.forEach(movie => {
        const card = document.createElement('div');
        card.className = 'card';
        card.innerHTML = `
            <div class="card-poster">
                ${movie.poster
                    ? `<img src="${movie.poster}" alt="${movie.title}" loading="lazy">`
                    : `<div class="no-poster">${movie.title || movie.filename}</div>`}
                <div class="card-hover">
                    <div class="play-icon">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="white"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    </div>
                </div>
            </div>
            <div class="card-info">
                <div class="card-title">${movie.title || movie.filename}</div>
                ${movie.year ? `<div class="card-year">${movie.year}</div>` : ''}
            </div>
        `;
        card.addEventListener('click', () => openModal(movie));
        grid.appendChild(card);
    });
}

async function openModal(movie) {
    if (!requireAuth()) return;
    currentMovie = movie;
    document.getElementById('m-poster').src = movie.poster || '';
    document.getElementById('m-poster').style.display = movie.poster ? 'block' : 'none';
    document.getElementById('m-title').textContent = movie.title || movie.filename;
    document.getElementById('m-year').textContent = movie.year || '';
    document.getElementById('m-rating').textContent = movie.rating ? '⭐ ' + movie.rating.toFixed(1) + ' / 10' : '';
    document.getElementById('m-overview').textContent = movie.overview || 'No description available.';

    const actions = document.querySelector('.modal-actions');
    if (movie.type === 'tv') {
        const res = await fetch('/tvshows/episodes?show=' + encodeURIComponent(movie.showName), fetchOpts);
        const episodes = await res.json();
        actions.innerHTML = '<div style="display:flex;flex-direction:column;gap:6px;width:100%;max-height:200px;overflow-y:auto;padding-right:4px;">' +
            episodes.map(ep => `<button onclick="playEpisode('${movie.showName.replace(/'/g,"\'")}','${ep.file.replace(/'/g,"\'")}')"
                style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#e0e0e0;font-family:'Advent Pro',sans-serif;font-size:12px;padding:8px 12px;text-align:left;cursor:pointer;transition:background 0.15s;"
                onmouseover="this.style.background='rgba(0,212,255,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.06)'">
                ${ep.name}
            </button>`).join('') +
        '</div>';
    } else {
        actions.innerHTML = `
            <div class="modal-actions-row">
                <button class="btn-play" onclick="playMovie()">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    Play
                </button>
                <button class="btn-play btn-download" onclick="downloadMovie()">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>
                    Download
                </button>
            </div>`;
    }

    document.getElementById('modal').style.display = 'flex';
}

function playEpisode(show, episode) {
    if (!requireAuth()) return;
    const file = encodeURIComponent(show + '/' + episode);
    window.open('/player.html?tvfile=' + file, '_blank');
}

function closeModal() {
    document.getElementById('modal').style.display = 'none';
}

function playMovie() {
    if (!requireAuth() || !currentMovie) return;
    window.open('/player.html?file=' + encodeURIComponent(currentMovie.filename), '_blank');
}

function downloadMovie() {
    if (!requireAuth() || !currentMovie) return;
    const a = document.createElement('a');
    a.href = '/download?file=' + encodeURIComponent(currentMovie.filename);
    a.download = currentMovie.filename.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
}

document.getElementById('search').addEventListener('input', e => {
    if (!authenticated) return;
    const q = e.target.value.toLowerCase();
    renderGrid(allMovies.filter(m => (m.title || m.filename).toLowerCase().includes(q)));
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
});

initAuth();

async function setSection(section, btn) {
    if (!requireAuth()) return;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (section === 'tvshows') {
        const res = await fetch('/tvshows', fetchOpts);
        const shows = await res.json();
        renderGrid(shows);
    } else {
        renderGrid(allMovies.filter(m => !m.filename?.toLowerCase().includes('tv shows') && !m.filename?.toLowerCase().includes('tvshows')));
    }
}

function toggleSort(e) {
    if (!requireAuth()) return;
    e.stopPropagation();
    document.getElementById('sort-dropdown').classList.toggle('open');
}

function selectSort(method, label) {
    if (!requireAuth()) return;
    document.getElementById('sort-label').textContent = label;
    document.getElementById('sort-dropdown').classList.remove('open');
    document.querySelectorAll('.sort-option').forEach(o => o.classList.remove('active'));
    event.target.classList.add('active');
    sortMovies(method);
}

document.addEventListener('click', () => {
    document.getElementById('sort-dropdown')?.classList.remove('open');
});

function sortMovies(method) {
    console.log('sortMovies called:', method, 'currentMovies:', currentMovies.length);
    if (!currentMovies.length) {
        currentMovies = allMovies.filter(m => !m.filename?.toLowerCase().includes('tv shows'));
    }
    let sorted = [...currentMovies];
    if (method === 'year-desc') sorted.sort((a, b) => (b.year || 0) - (a.year || 0));
    else if (method === 'year-asc') sorted.sort((a, b) => (a.year || 0) - (b.year || 0));
    else if (method === 'title-asc') sorted.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    else if (method === 'title-desc') sorted.sort((a, b) => (b.title || '').localeCompare(a.title || ''));
    else if (method === 'rating-desc') sorted.sort((a, b) => (b.rating || 0) - (a.rating || 0));
    else if (method === 'added-desc') sorted.sort((a, b) => (b.added || 0) - (a.added || 0));
    renderGrid(sorted);
}

// Settings
async function openSettings() {
    if (!requireAuth()) return;
    const res = await fetch('/api/settings', fetchOpts);
    const settings = await res.json();

    // Populate folders
    const list = document.getElementById('media-folders-list');
    list.innerHTML = '';
    settings.mediaFolders.forEach(folder => addFolderRow(folder));

    document.getElementById('tv-folder').value = settings.tvFolder || '';
    document.getElementById('audio-lang').value = settings.preferredAudioLang || 'eng';
    document.getElementById('tmdb-key').value = settings.tmdbApiKey || '';
    document.getElementById('server-port').value = settings.port || 3000;
    document.getElementById('app-version').textContent = settings.version ? `v${settings.version}` : '';

    const pathsLocked = settings.pathsFromEnv;
    document.querySelectorAll('#media-folders-list .settings-input, #tv-folder').forEach(el => {
        el.readOnly = pathsLocked;
        el.title = pathsLocked ? 'Paths are set by Docker environment variables' : '';
    });

    document.getElementById('settings-modal').style.display = 'flex';
}

function closeSettings() {
    document.getElementById('settings-modal').style.display = 'none';
}

function addFolderRow(value = '') {
    const list = document.getElementById('media-folders-list');
    const row = document.createElement('div');
    row.className = 'settings-folder-item';
    row.innerHTML = `
        <input class="settings-input" type="text" value="${value}" placeholder="/Volumes/drive/Movies">
        <button class="settings-remove-btn" onclick="this.parentElement.remove()">×</button>
    `;
    list.appendChild(row);
}

async function addFolder() {
    try {
        const res = await fetch('/pick-folder', fetchOpts);
        const { path } = await res.json();
        addFolderRow(path || '');
    } catch(e) {
        addFolderRow('');
    }
}

async function saveSettings() {
    const folders = [...document.querySelectorAll('#media-folders-list .settings-input')]
        .map(i => i.value.trim()).filter(Boolean);

    const settings = {
        mediaFolders: folders,
        tvFolder: document.getElementById('tv-folder').value.trim(),
        preferredAudioLang: document.getElementById('audio-lang').value,
        tmdbApiKey: document.getElementById('tmdb-key').value.trim(),
        port: parseInt(document.getElementById('server-port').value) || 3000
    };

    await fetch('/api/settings', {
        ...fetchOpts,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
    });

    closeSettings();
    alert('Settings saved! Restart the server for folder changes to take effect.');
}
