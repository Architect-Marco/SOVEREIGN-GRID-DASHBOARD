/* 
   PROJECT: SOVEREIGN-GRID V20.0 (DECENTRALIZED)
   ARCHITECT: MARCO
   PATCH: CDX-07 (HAN) - ASSET ROUTER & NOIR SECTOR UI
   STANDARD: NOIR SECTOR V7.7.9
*/

// --- MASTER SYSTEM LOGIC V20.0 ---
const sbnAudio = new Audio();
window.RADIO_SYNC_URL = 'https://restless-star-2afa.djpolomaco.workers.dev';
window.RADIO_SYNC_SECRET = 'r7Kx9mQz2wPvT4bNyL8jH1sFdA6cE3uGiR5oV0k';
const GITHUB_BASE = "https://raw.githubusercontent.com/djpolomaco/sovereign-grid-dashboard/main/assets/";

// --- CDX-07: DECENTRALIZED ASSET UPLINK HELPER ---
async function uploadToGithub(file, folder) {
    const reader = new FileReader();
    return new Promise((resolve, reject) => {
        reader.onload = async () => {
            const base64Content = reader.result.split(',')[1];
            const fileName = `${Date.now()}-${file.name.replace(/\s+/g, '_')}`;
            
            try {
                const resp = await fetch(window.RADIO_SYNC_URL, {
                    method: 'PUT',
                    body: JSON.stringify({
                        fileName: fileName,
                        content: base64Content,
                        folder: folder
                    })
                });

                if (resp.ok) {
                    const finalUrl = `${GITHUB_BASE}${folder}/${fileName}?t=${Date.now()}`;
                    console.log(`%c[CDX-07] UPLINK SUCCESS: ${finalUrl}`, "color: #00ffc3;");
                    resolve(finalUrl);
                } else {
                    const err = await resp.text();
                    alert("Uplink Failure: " + err);
                    reject(err);
                }
            } catch (err) {
                console.error("Worker fetch failed", err);
                reject(err);
            }
        };
        reader.readAsDataURL(file);
    });
}

// ============================================================
// SOCIAL LINKS
// ============================================================
window.socialLinkKeys = ['facebook', 'instagram', 'x', 'tiktok', 'youtube', 'suno'];

window.loadSocialLinks = function() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('sbn-social-links') || '{}'); } catch (e) { saved = {}; }
    window.socialLinkKeys.forEach(key => {
        const url = saved[key];
        if (url) {
            const a = document.getElementById('social-link-' + key);
            if (a) a.href = url;
        }
    });
};

window.openSocialLinksModal = function() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('sbn-social-links') || '{}'); } catch (e) { saved = {}; }
    window.socialLinkKeys.forEach(key => {
        const input = document.getElementById('social-input-' + key);
        if (input) input.value = saved[key] || '';
    });
    document.getElementById('social-links-modal').classList.remove('hidden');
};

window.closeSocialLinksModal = function() {
    document.getElementById('social-links-modal').classList.add('hidden');
};

window.saveSocialLinks = function() {
    const data = {};
    window.socialLinkKeys.forEach(key => {
        const input = document.getElementById('social-input-' + key);
        const url = input ? input.value.trim() : '';
        if (url) {
            data[key] = url;
            const a = document.getElementById('social-link-' + key);
            if (a) a.href = url;
        }
    });
    try { localStorage.setItem('sbn-social-links', JSON.stringify(data)); } catch (e) { console.error('Could not save social links:', e); }
    window.closeSocialLinksModal();
};

window.waves = {};
window.currentMasterUrl = null;
window.playlist = [];
window.currentTrackIndex = -1;

// 1. GLOBAL NAVIGATION
window.SBN_PAGE_MAP = {
    home: 'home.html', create: 'create.html', splitter: 'splitter-mastering.html',
    daw: 'daw.html', epk: 'soul-forge.html', gallery: 'gallery.html', station: 'radio-station.html'
};
window.switchView = function(v) {
    const dest = window.SBN_PAGE_MAP[v];
    if (dest) window.location.href = dest;
};

// ============================================================
// ASSET HANDLERS (REWIRED BY CDX-07 FOR DECENTRALIZATION)
// ============================================================

// --- 1. PROFILE / AVATAR HANDLER (FIXED FOR DIV) ---
window.handleAvatarUpload = async function(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
        const url = await uploadToGithub(file, 'home');
        localStorage.setItem('sbn-avatar-pic', url);
        window.applyAvatarPic(url);
    } catch (e) { console.error("Avatar Uplink Error", e); }
    event.target.value = '';
};

window.applyAvatarPic = function(url) {
    ['sidebar-avatar', 'home-avatar'].forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.backgroundImage = `url('${url}')`;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        el.classList.add('has-photo');
        const fallback = el.querySelector('.upload-fallback');
        if (fallback) fallback.style.display = 'none';
    });
};

window.loadAvatarPic = function() {
    try {
        const saved = localStorage.getItem('sbn-avatar-pic');
        if (saved && saved.startsWith('http')) window.applyAvatarPic(saved);
    } catch (err) { console.error('Could not load avatar:', err); }
};

// --- 2. STATION COVER HANDLER (FIXED FOR DIV) ---
window.handleStationCoverUpload = async function(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
        const url = await uploadToGithub(file, window.currentStationKey);
        localStorage.setItem('sbn-station-cover-' + window.currentStationKey, url);
        const box = document.getElementById('station-cover');
        if (box) {
            box.style.backgroundImage = `url('${url}')`;
            box.style.backgroundSize = 'cover';
            box.style.backgroundPosition = 'center';
            box.classList.add('has-photo');
        }
    } catch (e) { console.error("Station Cover Uplink Error", e); }
    event.target.value = '';
};

// --- 3. SONG COVER ART HANDLER (CREATE SECTION) ---
window.handleCoverUpload = async function(event) {
    const file = event.target.files[0];
    const id = window.pendingCoverUploadId;
    if (!file || !id) return;
    try {
        const url = await uploadToGithub(file, 'create');
        const creation = window.creations.find(c => c.id === id);
        if (creation) {
            creation.coverArt = url;
            window.renderCreations();
            window.saveCreations();
        }
    } catch (e) { console.error("Song Art Uplink Error", e); }
    event.target.value = '';
};

// ============================================================
// RADIO STATION LOGIC (REFACTORED FOR STATION-SPECIFIC DATA)
// ============================================================
window.STATION_META = {
    wkor: {
        id: 'WKOR-FM-001', frequency: '107.9 FM',
        defaultName: '107.9 W-K-O-R FM - Broadcast',
        defaultBio: '107.9 W-K-O-R FM — THE SICK TEAM BROADCAST.',
        defaultGenres: 'Electronic, Techno, House',
        defaultTracks: [],
    },
    cdfm: {
        id: 'CDFM-FM-001', frequency: '108.8 FM',
        defaultName: '108.8 CDFM - Chinese Dance FM',
        defaultBio: '108.8 CDFM — THE SICK TEAM BROADCAST.',
        defaultGenres: 'Mandopop, Dance',
        defaultTracks: [],
    },
};
window.currentStationKey = window.currentStationKey || 'wkor';

window.loadStationForKey = function(key) {
    const meta = window.STATION_META[key];
    if (!meta) return;
    window.currentStationKey = key;

    const stationLabel = document.getElementById('station-display-name');
    if (stationLabel) stationLabel.textContent = key.toUpperCase();

    // Load Station Cover (Fixed for Div and Remote URL)
    const box = document.getElementById('station-cover');
    const cover = localStorage.getItem('sbn-station-cover-' + key);
    if (box) {
        if (cover && cover.startsWith('http')) {
            box.style.backgroundImage = `url('${cover}')`;
            box.style.backgroundSize = 'cover';
            box.classList.add('has-photo');
        } else {
            box.style.backgroundImage = '';
            box.classList.remove('has-photo');
        }
    }

    // Load Station Details
    try {
        const info = JSON.parse(localStorage.getItem('sbn-station-info-' + key) || 'null');
        const name = (info && info.name) || meta.defaultName;
        const bio = (info && info.bio) || meta.defaultBio;
        const genres = (info && info.genres) || meta.defaultGenres;
        
        const nameDisp = document.getElementById('station-name-display');
        const bioDisp = document.getElementById('station-bio-display');
        if (nameDisp) nameDisp.innerText = name;
        if (bioDisp) bioDisp.innerText = bio;
        
        window.renderStationGenres(genres);
    } catch (e) { console.error("Error loading station info", e); }
};

window.renderStationGenres = function(genresCsv) {
    const wrap = document.getElementById('station-genres');
    if (!wrap) return;
    const genres = genresCsv.split(',').map(g => g.trim()).filter(Boolean);
    wrap.innerHTML = genres.map(g => `<span class="bg-white/5 border border-white/10 text-gray-300 text-[9px] font-black uppercase tracking-widest px-2.5 py-1 rounded">${g}</span>`).join('');
};

window.loadStation = function() {
    window.loadStationForKey(window.currentStationKey);
};

// ============================================================
// SYSTEM BOOT (CDX-07)
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    console.log("%c📡 SBN MASTER V20.0 ONLINE (DECENTRALIZED)", "color: #00f2ff; font-weight: bold;");
    
    // Purge logic for migration (Clears local Base64 ghosts)
    if (localStorage.getItem('sbn-avatar-pic') && localStorage.getItem('sbn-avatar-pic').startsWith('data:image')) {
        console.warn("[CDX-07] Old Base64 detected. System clearing legacy blobs...");
        localStorage.removeItem('sbn-avatar-pic');
    }

    // Inits
    window.loadAvatarPic();
    window.loadStation();
    window.loadSocialLinks();
    
    // Existing logic placeholders
    if (typeof window.loadCreations === 'function') window.loadCreations();
    if (typeof window.loadPressKits === 'function') window.loadPressKits();
});

// --- REMAINING LOGIC PLACEHOLDERS (Keep your existing track logic) ---
window.formatTime = function(seconds) {
    if (!isFinite(seconds) || isNaN(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return m + ':' + String(s).padStart(2, '0');
};
