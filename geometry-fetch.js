// geometry-fetch.js — read the map's geometry text, gzipped on the published site.
//
// WHY
// ---
// GitHub Pages publishes this site byte for byte, and its deployment went from ~30
// seconds to a ten-minute timeout once the published site passed 1 GB (the geometry
// alone is 982 MB: 6,945 geom buckets, the 165 monolithic country files and the
// world/continent plane). So the published copy stores each geometry file gzipped
// and deletes the plain one — text paths compress about 5.3x, which brings the site
// to ~0.38 GB. The workbench keeps the plain files, because tools/build-geometry,
// validate-data, pilot-preview and benchmark-boundary read them directly.
//
// Hence: ask for .gz, fall back to the plain path. That costs one 404 per geometry
// file in the workbench and avoids a configuration line that could drift between
// the two copies (see MANUAL-TESTS.md: the .gz 404s are expected locally).
//
// Decompression is the platform's own: DecompressionStream('gzip') — Chrome and Edge
// 80+, Safari 16.4+, Firefox 113+. No library, and the compressed bytes are handled
// as a stream, so a 128 KB bucket is not buffered twice.
export async function fetchGeometryText(url)
{
	const gz = await fetch(`${url}.gz`);
	if (gz.ok && gz.body !== null)
	{
		// A response the server already labels Content-Encoding: gzip has been decoded
		// by the browser, so decompressing it again would throw. (GitHub Pages serves
		// .gz as octet-stream today; this is the guard for when it does not.)
		if (/gzip/i.test(gz.headers.get('content-encoding') || ''))
			return gz.text();
		if (typeof DecompressionStream === 'undefined')
			throw new Error('this browser cannot read the map geometry: no DecompressionStream');
		return new Response(gz.body.pipeThrough(new DecompressionStream('gzip'))).text();
	}
	const plain = await fetch(url);
	if (!plain.ok)
		throw new Error(`geometry ${url}: ${plain.status} plain, ${gz.status} gzipped`);
	return plain.text();
}
