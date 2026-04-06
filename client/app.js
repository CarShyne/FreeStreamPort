let allMovies = [];
let currentMovie = null;

async function loadMovies() {
    const res = await fetch('/movies');
    allMovies = await res.json();
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
    currentMovie = movie;
    document.getElementById('m-poster').src = movie.poster || '';
    document.getElementById('m-poster').style.display = movie.poster ? 'block' : 'none';
    document.getElementById('m-title').textContent = movie.title || movie.filename;
    document.getElementById('m-year').textContent = movie.year || '';
    document.getElementById('m-rating').textContent = movie.rating ? '⭐ ' + movie.rating.toFixed(1) + ' / 10' : '';
    document.getElementById('m-overview').textContent = movie.overview || 'No description available.';

    const actions = document.querySelector('.modal-actions');
    if (movie.type === 'tv') {
        const res = await fetch('/tvshows/episodes?show=' + encodeURIComponent(movie.showName));
        const episodes = await res.json();
        actions.innerHTML = '<div style="display:flex;flex-direction:column;gap:6px;width:100%;max-height:200px;overflow-y:auto;padding-right:4px;">' +
            episodes.map(ep => `<button onclick="playEpisode('${movie.showName.replace(/'/g,"\'")}','${ep.file.replace(/'/g,"\'")}')"
                style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:8px;color:#e0e0e0;font-family:'Advent Pro',sans-serif;font-size:12px;padding:8px 12px;text-align:left;cursor:pointer;transition:background 0.15s;"
                onmouseover="this.style.background='rgba(0,212,255,0.1)'" onmouseout="this.style.background='rgba(255,255,255,0.06)'">
                ${ep.name}
            </button>`).join('') +
        '</div>';
    } else {
        actions.innerHTML = '<button class="btn-play" onclick="playMovie()"><svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>Play</button>';
    }

    document.getElementById('modal').style.display = 'flex';
}

function playEpisode(show, episode) {
    const file = encodeURIComponent(show + '/' + episode);
    window.open('/player.html?tvfile=' + file, '_blank');
}

function closeModal() {
    document.getElementById('modal').style.display = 'none';
}

function playMovie() {
    if (!currentMovie) return;
    window.open('/player.html?file=' + encodeURIComponent(currentMovie.filename), '_blank');
}

document.getElementById('search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    renderGrid(allMovies.filter(m => (m.title || m.filename).toLowerCase().includes(q)));
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
});

loadMovies();

async function setSection(section, btn) {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    if (section === 'tvshows') {
        const res = await fetch('/tvshows');
        const shows = await res.json();
        renderGrid(shows);
    } else {
        renderGrid(allMovies.filter(m => !m.filename?.toLowerCase().includes('tv shows') && !m.filename?.toLowerCase().includes('tvshows')));
    }
}

function toggleSort(e) {
    e.stopPropagation();
    document.getElementById('sort-dropdown').classList.toggle('open');
}

function selectSort(method, label) {
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
    const res = await fetch('/api/settings');
    const settings = await res.json();

    // Populate folders
    const list = document.getElementById('media-folders-list');
    list.innerHTML = '';
    settings.mediaFolders.forEach(folder => addFolderRow(folder));

    document.getElementById('tv-folder').value = settings.tvFolder || '';
    document.getElementById('audio-lang').value = settings.preferredAudioLang || 'eng';
    document.getElementById('tmdb-key').value = settings.tmdbApiKey || '';
    document.getElementById('server-port').value = settings.port || 3000;

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
        const res = await fetch('/pick-folder');
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
    });

    closeSettings();
    alert('Settings saved! Restart the server for folder changes to take effect.');
}
