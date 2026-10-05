#!/usr/bin/env node
// Builds data/games.json, which the site reads for extra information about each title in
// Azahar's compatibility list. Everything is keyed by Title ID, so matches are exact.
// data/lookup-state.json records where art came from and what couldn't be found, for later runs.
//
// Box art is saved as small WebP thumbnails in data/boxart/, using these sources in order:
//   1. data/boxart-overrides.json  { "<Title ID>": "<image URL>" } for manual fixes
//   2. GameTDB                     Title ID -> product code (hax0kartik/3dsdb) -> cover
//   3. libretro-thumbnails         product code -> No-Intro name (libretro-database) -> box art
//
// Only titles without data are looked up, so after the first run very few requests are made.
// Titles that can't be found are retried after RETRY_MISSES_AFTER_DAYS.
//
// Usage:    node scripts/update-game-data.mjs [--out data] [--limit N]
// Requires: Node 18+ and cwebp (apt install webp / brew install webp)

import { execFile } from 'node:child_process';
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
const GAMES_PATH = path.join(OUT_DIR, 'games.json');
const STATE_PATH = path.join(OUT_DIR, 'lookup-state.json');
// What the site reads; everything else in the manifest is only needed by this script
const PUBLIC_KEYS = ['art'];
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
// Position in a preference list, with anything not listed sorted last
const preference = (list, matches) => {
    const i = list.findIndex(matches);
    return i === -1 ? list.length : i;
};

// Title ID -> { code: product code such as "AMKE" }
async function loadTitleDb() {
    const titles = new Map();
    for (const region of TITLEDB_REGIONS) {
        const list = await (await fetchOk(`${TITLEDB_URL}${region}.json`)).json();
        for (const entry of list) {
            const id = (entry.TitleID || '').toUpperCase();
            if (id && !titles.has(id)) {
                titles.set(id, { code: productCode(entry['Product Code'] || '') });
            }
        }
    }
    return titles;
}

// Ignores case, accents, punctuation and region tags so "Pokémon: X (USA)" matches "Pokemon X"
const simplifyName = name => name.normalize('NFKD').replace(/\(.*?\)|\[.*?\]/g, '')
    .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');

// libretro box art file names, best region first, by product code and by simplified name
async function loadLibretroIndex() {
    const headers = process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
    const tree = await (await fetchOk(LIBRETRO_TREE, headers)).json();
    if (tree.truncated) console.warn('The libretro-thumbnails file list was truncated, so some box art may be missed');
    const available = new Set(tree.tree
        .filter(f => f.path.startsWith('Named_Boxarts/') && f.path.endsWith('.png'))
        .map(f => f.path.slice('Named_Boxarts/'.length, -'.png'.length)));

    // libretro replaces these characters in thumbnail file names
    const fileName = name => name.replace(/[&*/:`<>?\\|"]/g, '_');
    const regionRank = name => preference(['(USA', '(World', '(Europe'], region => name.includes(region));

    const byCode = new Map();
    for (const url of LIBRETRO_DATS) {
        const dat = await (await fetchOk(url)).text();
        for (const block of dat.split(/\ngame \(/)) {
            const name = (block.match(/^\s*name "([^"]*)"/m) || [])[1];
            const serial = (block.match(/^\s*serial "([^"]*)"/m) || [])[1];
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
    return { byCode, byName };
}

function findCandidates(game, ids, overrides, titleDb, libretro) {
    const candidates = ids.filter(id => overrides[id]).map(id => ({ source: 'override', url: overrides[id] }));

    const codes = [...new Set(ids.map(id => titleDb.get(id)?.code).filter(Boolean))];
    const rank = code => preference(REGION_PREFERENCE, region => region === code[3]);
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

    const [titleDb, libretro] = await Promise.all([loadTitleDb(), loadLibretroIndex()]);
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

// Kept in two files so the site doesn't download the bookkeeping
async function saveManifest(manifest) {
    const pick = keys => Object.fromEntries(keys.map(key => [key, manifest[key]]));
    const stateKeys = Object.keys(manifest).filter(key => !PUBLIC_KEYS.includes(key));
    await writeFile(GAMES_PATH, JSON.stringify(pick(PUBLIC_KEYS), null, 1) + '\n');
    await writeFile(STATE_PATH, JSON.stringify(pick(stateKeys), null, 1) + '\n');
}

async function main() {
    await mkdir(OUT_DIR, { recursive: true });
    const manifest = { ...await readJson(STATE_PATH, {}), ...await readJson(GAMES_PATH, {}) };
    manifest.art ??= {};
    manifest.artSources ??= {};
    manifest.artMisses ??= {};

    const list = await (await fetchOk(COMPAT_URL)).json();
    const games = Array.isArray(list) ? list : Object.values(list);
    console.log(`${games.length} titles in the compatibility list`);
    try {
        await updateBoxart(games, manifest);
    } finally {
        await saveManifest(manifest);
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
