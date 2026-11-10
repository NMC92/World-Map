// sw.js — the offline shell.
//
// WHY ONLINE FIRST
// ----------------
// Stale caches have cost this project more debugging than any bug: a served file
// can be new while the tab, or the service worker's copy, is old. So the network is
// asked first whenever it is there, and the cache answers only when it fails. The
// cache exists to make the last parish work with no connection, not to be fast.
//
// WHAT IS CACHED
// --------------
//   - the app shell (SHELL below), at install, under a cache whose name carries the
//     app's build marker read from Earth.js — a new build starts clean;
//   - the world/continent plane, in one shared cache, as it is fetched;
//   - the LAST-VISITED country's data only: AuxFiles/<CC>/(geom/*, <CC>.json,
//     Pins.json). Entering another country deletes the previous one's cache, so
//     storage stays at about one country.
//   - NOT the pin images: they are cross-origin (bucket-wm8), huge, and irrelevant
//     to opening the map (v1 of this worker).
//
// The shell cache refreshes when this file changes (the browser only re-installs a
// worker whose bytes changed), so a shell-only change in Earth.js keeps the old
// offline copy until the next worker update; online users get the new file anyway,
// because the network is asked first every time.

const SHELL = [
	'./',
	'index.html',
	'Earth.js',
	'gps-frame.js',
	'geometry-fetch.js',
	'Earth.css',
	'Earth.svg',
	'jquery-3.5.1.min.js',
	'papaparse.min.js',
	'Loading.gif',
	'manifest.json',
	'icon-192.png',
	'icon-512.png',
];
const PLANE = new Set([
	'AuxFiles/Earth+Continents+Countries.json',
	// The workbench serves the plane plain, the published copy gzipped: both names.
	'AuxFiles/Continents+Countries.txt',
	'AuxFiles/Continents+Countries.txt.gz',
	'AuxFiles/Pins.json',
]);
const SHELL_PREFIX = 'mappu-shell-';
const DATA_PREFIX = 'mappu-data-';
const PLANE_CACHE = 'mappu-plane';

/** The build marker in Earth.js. Its cache name is what ties the shell to a build. */
async function buildName()
{
	try
	{
		const response = await fetch('Earth.js', { cache: 'reload' });
		const match = (await response.text()).match(/__mappuBuild = '([^']+)'/);
		if (match !== null)
			return match[1];
	}
	catch (error) { /* offline install: the shell list will fail anyway */ }
	return 'unknown';
}

self.addEventListener('install', event =>
{
	event.waitUntil((async () =>
	{
		const cache = await caches.open(SHELL_PREFIX + await buildName());
		// cache: 'reload' bypasses the HTTP cache, so a new worker never precaches
		// the browser's stale copy of the app it is meant to replace.
		await cache.addAll(SHELL.map(url => new Request(url, { cache: 'reload' })));
		await self.skipWaiting();
	})());
});

self.addEventListener('activate', event =>
{
	event.waitUntil((async () =>
	{
		const current = SHELL_PREFIX + await buildName();
		for (const name of await caches.keys())
		{
			if (name.startsWith(SHELL_PREFIX) && name !== current && current !== SHELL_PREFIX + 'unknown')
				await caches.delete(name);
		}
		await self.clients.claim();
	})());
});

/** The country a cached URL belongs to, or null for something we do not keep. */
function countryOf(pathname)
{
	const at = pathname.indexOf('/AuxFiles/');
	if (at === -1)
		return null;
	const match = pathname.slice(at).match(/^\/AuxFiles\/([A-Z]{2})\/(geom\/[^/]+|[^/]+\.json)$/);
	if (match === null)
		return null;
	const file = match[2];
	// The country's own records only: a bare <CC>.txt is the whole-country geometry
	// (tens of MB) and is not what "the last parish works offline" needs.
	if (file.startsWith('geom/') || file === 'Pins.json' || file === `${match[1]}.json`)
		return match[1];
	return null;
}

async function remember(request, response)
{
	const path = new URL(request.url).pathname;
	const country = countryOf(path);
	if (country !== null)
	{
		await (await caches.open(DATA_PREFIX + country)).put(request, response);
		// One country at a time: drop the previous one's data.
		for (const name of await caches.keys())
		{
			if (name.startsWith(DATA_PREFIX) && name !== DATA_PREFIX + country)
				await caches.delete(name);
		}
	}
	else
		await (await caches.open(PLANE_CACHE)).put(request, response);
}

/**
 * Whether a URL is worth keeping, decided BEFORE the body is cloned: a 66 MB
 * unsplit country file must not be teed through memory just to be thrown away.
 */
function cacheable(pathname)
{
	if (countryOf(pathname) !== null)
		return true;
	const at = pathname.indexOf('/AuxFiles/');
	return at !== -1 && PLANE.has(pathname.slice(at + 1));
}

self.addEventListener('fetch', event =>
{
	const request = event.request;
	if (request.method !== 'GET')
		return;
	if (new URL(request.url).origin !== self.location.origin)
		return; // the pin images come from the bucket: leave them to the browser
	event.respondWith((async () =>
	{
		try
		{
			const response = await fetch(request);
			// waitUntil, not a bare promise: the worker can be stopped as soon as the
			// response is handed back, and a cache write must not be cut off by that.
			if (response.ok && cacheable(new URL(request.url).pathname))
				event.waitUntil(remember(request, response.clone()).catch(() => { /* cache is an extra, never a gate */ }));
			return response;
		}
		catch (error)
		{
			const cached = await caches.match(request, { ignoreSearch: true });
			if (cached !== undefined)
				return cached;
			if (request.mode === 'navigate')
			{
				const shell = await caches.match('index.html');
				if (shell !== undefined)
					return shell;
			}
			return new Response('Offline, and this file was not cached.', {
				status: 503,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			});
		}
	})());
});
