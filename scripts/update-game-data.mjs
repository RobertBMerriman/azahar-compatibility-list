#!/usr/bin/env node
// Builds data/games.json, which the site reads for extra information about each title in
// Azahar's compatibility list. Everything is keyed by Title ID, so matches are exact.
//
// Box art is saved as small WebP thumbnails in data/boxart/, using these sources in order:
//   1. data/boxart-overrides.json  { "<Title ID>": "<image URL>" } for manual fixes
//   2. GameTDB                     Title ID -> product code (hax0kartik/3dsdb) -> cover
//   3. libretro-thumbnails         product code -> No-Intro name (libretro-database) -> box art
//
// Each title's type (retail, eShop only, Virtual Console...) comes from its Title ID category,
// then Nintendo's eShop catalogue, then whether No-Intro lists it as a cartridge or download.
//
// Only titles without data are looked up, so after the first run very few requests are made.
// Titles that can't be found are retried after RETRY_MISSES_AFTER_DAYS.
//
// Usage:    node scripts/update-game-data.mjs [--out data] [--limit N]
// Requires: Node 18+ and cwebp (apt install webp / brew install webp)

import { execFile } from 'node:child_process';
import https from 'node:https';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const COMPAT_URL = 'https://raw.githubusercontent.com/azahar-emu/compatibility-list/refs/heads/master/compatibility_list.json';
const TITLEDB_URL = 'https://raw.githubusercontent.com/hax0kartik/3dsdb/master/jsons/list_';
const TITLEDB_REGIONS = ['US', 'GB', 'JP', 'KR', 'TW'];
const LIBRETRO_DATS = ['Nintendo - Nintendo 3DS.dat', 'Nintendo - Nintendo 3DS (Digital).dat']
    .map(f => 'https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/no-intro/' + encodeURIComponent(f));
const LIBRETRO_TREE = 'https://api.github.com/repos/libretro-thumbnails/Nintendo_-_Nintendo_3DS/git/trees/master?recursive=1';
const LIBRETRO_BOXARTS = 'https://raw.githubusercontent.com/libretro-thumbnails/Nintendo_-_Nintendo_3DS/master/Named_Boxarts/';
const GAMETDB = 'https://art.gametdb.com/3ds';
// Nintendo's eShop catalogue, still online for re-downloads
const SAMURAI = 'https://samurai.ctr.shop.nintendo.net/samurai/ws';

// Title ID categories (the first 8 hex digits) that aren't regular applications
const TITLE_ID_TYPES = {
    '00040002': 'demo', '0004000E': 'update', '0004008C': 'dlc',
    '00040010': 'system', '00040030': 'system', '00048004': 'dsiware',
};
// eShop platform IDs -> [type, New 3DS only]. Platform names are localised, so match on ID.
const ESHOP_PLATFORMS = {
    18: ['retail'], 103: ['retail'], 1002: ['retail', true],
    19: ['eshop'], 1001: ['eshop', true],
    24: ['vc-nes'], 21: ['vc-gb'], 22: ['vc-gbc'], 25: ['vc-gg'], 1004: ['vc-snes', true],
    43: ['video'], 63: ['update'],
};
const ESHOP_VIRTUAL_CONSOLE = '10'; // platform category
const ESHOP_DELAY_MS = 200;

// GameTDB groups covers by language; the last letter of a product code is its region
const GAMETDB_LANGS = { E: 'US', P: 'EN', J: 'JA', K: 'KO', W: 'ZH', C: 'ZH', D: 'DE', F: 'FR', S: 'ES', I: 'IT', H: 'NL', U: 'AU' };
const REGION_PREFERENCE = ['E', 'P'];

const WIDTH = 240; // 2x the size shown on cards
const RETRY_MISSES_AFTER_DAYS = 30;
const GAMETDB_DELAY_MS = 500;
const GAMETDB_MAX_FAILURES = 5; // consecutive network errors before GameTDB is skipped for this run
const USER_AGENT = 'azahar-compatibility-list (+https://github.com/Kahmenah/azahar-compatibility-list)';

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const args = process.argv.slice(2);
const argValue = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const OUT_DIR = argValue('--out') ?? 'data';
const LIMIT = Number(argValue('--limit') ?? Infinity);
const MANIFEST_PATH = path.join(OUT_DIR, 'games.json');
const BOXART_DIR = 'boxart';

async function fetchOk(url, headers = {}) {
    const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res;
}

async function readJson(file, fallback) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

const releaseIds = game => (game.releases || []).map(r => r.id && r.id.toUpperCase()).filter(Boolean);
const productCode = code => (code.match(/([A-Z0-9]{4})$/) || [])[1];
const daysSince = date => (Date.now() - Date.parse(date)) / 86400000;

// Title ID -> { code: product code such as "AMKE", region, uid: eShop content ID }
async function loadTitleDb() {
    const titles = new Map();
    for (const region of TITLEDB_REGIONS) {
        const list = await (await fetchOk(`${TITLEDB_URL}${region}.json`)).json();
        for (const entry of list) {
            const id = (entry.TitleID || '').toUpperCase();
            if (id && !titles.has(id)) {
                titles.set(id, { code: productCode(entry['Product Code'] || ''), region, uid: entry.UID });
            }
        }
    }
    return titles;
}

// Ignores case, accents, punctuation and region tags so "Pokémon: X (USA)" matches "Pokemon X"
const simplifyName = name => name.normalize('NFKD').replace(/\(.*?\)|\[.*?\]/g, '')
    .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// libretro box art file names, best region first, by product code and by simplified name,
// plus the simplified names of every cartridge (retail) and download (digital) No-Intro knows
async function loadLibretroIndex() {
    const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
    const tree = await (await fetchOk(LIBRETRO_TREE, headers)).json();
    const available = new Set(tree.tree
        .filter(f => f.path.startsWith('Named_Boxarts/') && f.path.endsWith('.png'))
        .map(f => f.path.slice('Named_Boxarts/'.length, -'.png'.length)));

    // libretro replaces these characters in thumbnail file names
    const fileName = name => name.replace(/[&*/:`<>?\\|"]/g, '_');
    const regionRank = name => ['(USA', '(World', '(Europe'].findIndex(r => name.includes(r)) >>> 0;

    const byCode = new Map();
    const retail = new Set();
    const digital = new Set();
    for (const [i, url] of LIBRETRO_DATS.entries()) {
        const dat = await (await fetchOk(url)).text();
        for (const block of dat.split(/\ngame \(/)) {
            const name = (block.match(/^\s*name "([^"]*)"/m) || [])[1];
            const serial = (block.match(/^\s*serial "([^"]*)"/m) || [])[1];
            if (name) (i === 0 ? retail : digital).add(simplifyName(name));
            if (!name || !serial || !available.has(fileName(name))) continue;
            for (const code of serial.split(',').map(s => productCode(s.trim())).filter(Boolean)) {
                if (!byCode.has(code)) byCode.set(code, []);
                byCode.get(code).push(fileName(name));
            }
        }
    }
    for (const names of byCode.values()) names.sort((a, b) => regionRank(a) - regionRank(b));

    const byName = new Map();
    for (const name of [...available].sort((a, b) => regionRank(a) - regionRank(b))) {
        if (!byName.has(simplifyName(name))) byName.set(simplifyName(name), name);
    }
    return { byCode, byName, retail, digital };
}

function findCandidates(game, ids, overrides, titleDb, libretro) {
    const candidates = ids.filter(id => overrides[id]).map(id => ({ source: 'override', url: overrides[id] }));

    const codes = [...new Set(ids.map(id => titleDb.get(id)?.code).filter(Boolean))];
    const rank = code => REGION_PREFERENCE.indexOf(code[3]) >>> 0;
    codes.sort((a, b) => rank(a) - rank(b));

    for (const code of codes) {
        const lang = GAMETDB_LANGS[code[3]] || 'EN';
        for (const size of ['coverM', 'cover']) candidates.push({ source: 'GameTDB', url: `${GAMETDB}/${size}/${lang}/${code}.jpg` });
    }

    // Exact product code first, then the same game released in another region
    let names = codes.flatMap(code => libretro.byCode.get(code) || []);
    if (!names.length) {
        const cores = new Set(codes.map(code => code.slice(0, 3)));
        names = [...libretro.byCode].filter(([code]) => cores.has(code.slice(0, 3))).flatMap(([, n]) => n);
    }
    // Without a product code, fall back to an exact (simplified) name match
    if (!codes.length && libretro.byName.has(simplifyName(game.title))) {
        names.push(libretro.byName.get(simplifyName(game.title)));
    }
    for (const name of new Set(names)) candidates.push({ source: 'libretro', url: LIBRETRO_BOXARTS + encodeURIComponent(name) + '.png' });
    return candidates;
}

const isImage = buf =>
    (buf[0] === 0x89 && buf[1] === 0x50) ||          // PNG
    (buf[0] === 0xff && buf[1] === 0xd8) ||          // JPEG
    buf.subarray(0, 4).toString() === 'RIFF';        // WebP

let gametdbFailures = 0;

// Returns the image bytes, null if the source doesn't have it, or throws if the source is unavailable
async function download(url) {
    const fromGametdb = url.startsWith(GAMETDB);
    if (fromGametdb) {
        if (gametdbFailures >= GAMETDB_MAX_FAILURES) throw new Error('GameTDB skipped');
        await sleep(GAMETDB_DELAY_MS);
    }
    let res;
    try {
        res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20000) });
        if (res.status >= 500 || res.status === 429) throw new Error(`${res.status} for ${url}`);
    } catch (err) {
        if (fromGametdb && ++gametdbFailures === GAMETDB_MAX_FAILURES) {
            console.warn('GameTDB is not responding, skipping it for the rest of this run');
        }
        throw err;
    }
    if (fromGametdb) gametdbFailures = 0;
    if (!res.ok) return null;

    const buf = Buffer.from(await res.arrayBuffer());
    if (isImage(buf)) return buf;

    // A few libretro thumbnails are git symlinks, which raw.githubusercontent.com serves as the target path
    if (url.startsWith(LIBRETRO_BOXARTS) && buf.length < 512) {
        const target = buf.toString().trim().split('/').map(encodeURIComponent).join('/');
        return download(new URL(target, LIBRETRO_BOXARTS).href);
    }
    return null;
}

async function saveWebp(buf, file, tmp) {
    const input = path.join(tmp, 'input');
    await writeFile(input, buf);
    await run('cwebp', ['-quiet', '-q', '80', '-resize', String(WIDTH), '0', input, '-o', file]);
}

// Downloads are shared between steps and only made when a step needs them
const once = load => { let promise; return () => (promise ??= load()); };
const getTitleDb = once(loadTitleDb);
const getLibretroIndex = once(loadLibretroIndex);

async function updateBoxart(games, manifest) {
    const overrides = await readJson(path.join(OUT_DIR, 'boxart-overrides.json'), {});
    const todo = games.filter(game => {
        const ids = releaseIds(game);
        if (!ids.length) return false;
        const overridden = ids.find(id => overrides[id]);
        if (overridden) return manifest.artSources[manifest.art[overridden]] !== overrides[overridden];
        if (ids.some(id => manifest.art[id])) return false;
        const missed = manifest.artMisses[ids[0]];
        return !missed || daysSince(missed) >= RETRY_MISSES_AFTER_DAYS;
    }).slice(0, LIMIT);

    console.log(`Box art: ${todo.length} titles to look up`);
    if (!todo.length) return;

    try {
        await run('cwebp', ['-version']);
    } catch {
        throw new Error('cwebp is required (apt install webp / brew install webp)');
    }

    const [titleDb, libretro] = await Promise.all([getTitleDb(), getLibretroIndex()]);
    await mkdir(path.join(OUT_DIR, BOXART_DIR), { recursive: true });
    const tmp = await mkdtemp(path.join(tmpdir(), 'boxart-'));
    const today = new Date().toISOString().slice(0, 10);
    const found = {};
    let missed = 0;

    try {
        for (const [i, game] of todo.entries()) {
            const ids = releaseIds(game);
            let source;
            let unavailable = false;
            for (const candidate of findCandidates(game, ids, overrides, titleDb, libretro)) {
                let buf;
                try {
                    buf = await download(candidate.url);
                } catch {
                    unavailable = true;
                    continue;
                }
                if (!buf) continue;
                const file = `${BOXART_DIR}/${ids[0]}.webp`;
                await saveWebp(buf, path.join(OUT_DIR, file), tmp);
                for (const id of ids) manifest.art[id] = file;
                manifest.artSources[file] = candidate.url;
                delete manifest.artMisses[ids[0]];
                source = candidate.source;
                break;
            }
            if (source) {
                found[source] = (found[source] || 0) + 1;
            } else {
                // Only remember a miss if every source answered, so outages are retried next run
                if (!unavailable) manifest.artMisses[ids[0]] = today;
                missed++;
            }
            console.log(`[${i + 1}/${todo.length}] ${source ? '✓' : '✗'} ${game.title}${source ? ` (${source})` : ''}`);

            // Save progress regularly so an interrupted run isn't wasted
            if (i % 25 === 24) await saveManifest(manifest);
        }
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }

    console.log('Box art found:', found, 'missing:', missed);
}

// Nintendo's servers use Nintendo's own certificate authority, which Node doesn't trust.
// This only reads public catalogue data, so verification is skipped for these requests only.
function fetchEshopTitle(region, uid) {
    return new Promise((resolve, reject) => {
        const req = https.get(`${SAMURAI}/${region}/title/${uid}`, {
            rejectUnauthorized: false,
            headers: { 'User-Agent': USER_AGENT },
            timeout: 20000,
        }, res => {
            if (res.statusCode === 404) return res.resume(), resolve(null);
            if (res.statusCode !== 200) return res.resume(), reject(new Error(`eShop returned ${res.statusCode}`));
            let body = '';
            res.setEncoding('utf8');
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
        });
        req.on('timeout', () => req.destroy(new Error('eShop request timed out')));
        req.on('error', reject);
    });
}

// Returns { type, new3ds }, null if unknown, or throws if the eShop couldn't be reached
async function findType(game, ids, titleDb, libretro) {
    const category = ids.map(id => TITLE_ID_TYPES[id.slice(0, 8)]).find(Boolean);
    if (category) return { type: category };

    const listed = ids.map(id => titleDb.get(id)).find(Boolean);
    if (listed) {
        await sleep(ESHOP_DELAY_MS);
        const xml = await fetchEshopTitle(listed.region, listed.uid);
        const [, platform, platformCategory] = (xml || '').match(/<platform id="(\d+)"[^>]*category="(\d+)"/) || [];
        if (ESHOP_PLATFORMS[platform]) {
            const [type, new3ds] = ESHOP_PLATFORMS[platform];
            return { type, new3ds };
        }
        if (platformCategory === ESHOP_VIRTUAL_CONSOLE) return { type: 'vc' };
    }

    if (libretro.retail.has(simplifyName(game.title))) return { type: 'retail' };
    if (libretro.digital.has(simplifyName(game.title))) return { type: 'eshop' };
    return null;
}

async function updateTypes(games, manifest) {
    const todo = games.filter(game => {
        const ids = releaseIds(game);
        if (!ids.length || ids.some(id => manifest.types[id])) return false;
        const missed = manifest.typeMisses[ids[0]];
        return !missed || daysSince(missed) >= RETRY_MISSES_AFTER_DAYS;
    }).slice(0, LIMIT);

    console.log(`Types: ${todo.length} titles to look up`);
    if (!todo.length) return;

    const [titleDb, libretro] = await Promise.all([getTitleDb(), getLibretroIndex()]);
    const today = new Date().toISOString().slice(0, 10);
    const found = {};
    let failed = 0;

    for (const [i, game] of todo.entries()) {
        const ids = releaseIds(game);
        let result;
        try {
            result = await findType(game, ids, titleDb, libretro);
        } catch (err) {
            // Retried next run
            console.log(`[${i + 1}/${todo.length}] ! ${game.title}: ${err.message}`);
            failed++;
            continue;
        }
        if (result) {
            for (const id of ids) {
                manifest.types[id] = result.type;
                if (result.new3ds) manifest.new3ds[id] = true;
            }
            delete manifest.typeMisses[ids[0]];
            found[result.type] = (found[result.type] || 0) + 1;
        } else {
            manifest.typeMisses[ids[0]] = today;
            found.unknown = (found.unknown || 0) + 1;
        }
        console.log(`[${i + 1}/${todo.length}] ${result ? result.type : '?'} ${game.title}`);

        if (i % 25 === 24) await saveManifest(manifest);
    }

    console.log('Types found:', found, 'failed:', failed);
}

async function saveManifest(manifest) {
    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 1) + '\n');
}

async function main() {
    await mkdir(OUT_DIR, { recursive: true });
    const manifest = await readJson(MANIFEST_PATH, {});
    manifest.art ??= {};
    manifest.artSources ??= {};
    manifest.artMisses ??= {};
    manifest.types ??= {};
    manifest.new3ds ??= {};
    manifest.typeMisses ??= {};

    const games = await (await fetchOk(COMPAT_URL)).json();
    console.log(`${games.length} titles in the compatibility list`);
    try {
        await updateTypes(games, manifest);
        await updateBoxart(games, manifest);
    } finally {
        await saveManifest(manifest);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
