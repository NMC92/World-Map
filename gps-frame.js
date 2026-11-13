// gps-frame.js — where a latitude/longitude sits on this map.
//
// Pure maths, no DOM and no jQuery, so tools/test-gps-frame.mjs can run it under
// node and check it against known coordinates.
//
// WHY A FRAME AT ALL
// ------------------
// The app's SVG is one map: pins, parish outlines and the GPS marker all live in
// its viewBox units. The pin tools fit, and now the marker uses, the same Web
// Mercator frame:
//
//     X = ax · mx(lon) + bx          mx(lon) = R · lon·π/180
//     Y = by − ay · my(lat)          my(lat) = R · ln(tan(π/4 + lat·π/360))
//
// with R the Web Mercator sphere radius. Y grows downwards, as the SVG does.
//
// THE CONSTANTS (re-fit 2026-11-09)
// ---------------------------------
// One fit over every strict pin↔OSM-node pair, instead of one per parish:
//   105 pairs, 4 parishes — Cascais e Estoril 10, Carcavelos e Parede 18,
//   Colares 24, Sintra 53 — matched by name under the strict rule of
//   tools/pin-node-matches.mjs (specific names, point features, unique both ways).
//   Each pair is the teardrop TIP (the end of the 4th cubic in the pin's `D`, the
//   point tools/benchmark-boundary.mjs measures) against the node, so a lat/lon
//   from here lands where the pins are drawn, not at the photo's corner.
//
//   ax and ay agree to 0.05 % — one map, one scale; the difference is fit noise.
//     1 viewBox unit ≈ 838 Mercator m ≈ 653 ground m at 38.8° N.
//
//   Residuals, ground metres at 38.8° N (the pairs whose nodes sit inside the
//   parish polygon, which the strict rule already requires):
//     inliers   104 of 105
//     median    12.2
//     p95       39.4
//     max       47.5
//   The dropped pair is the known wrong name match "Sociedade Filamórnica
//   \"Os Aliados\"", 1009 m off; it was wrong when the benchmark built it too.
//
//   Against the looser snapshot name pairs (the other parishes, NOT used in the
//   fit) the per-parish median is 12–93 m, with two small samples at 161 m
//   (Freiria, 3 pairs) and 237 m (Parque das Nações, 1 pair). Sintra's loose pairs
//   are ~1 km out: the loose rule keeps area features and ambiguous names, which
//   is exactly the noise the strict rule removes.
//
// NOT VERIFIED: how far this extrapolates beyond the Cascais–Sintra region the
// pairs span (~25 km). The parish lookup now covers all 3,119 Portuguese level-8
// parishes, so a fix anywhere in the country gets an answer, but away from the
// fitted region that answer comes from the same linear Mercator assumed, not
// measured: it can be a parish (or two) out at the far end of the country. Treat
// the marker as "which street/parish on this map", not a survey instrument, and do
// not extend it to another country without its own fit.
export const R = 6378137;

export const FRAME = Object.freeze({
	ax: 0.001193597703758483,
	bx: 28671.638727892387,
	ay: 0.0011895558227040508,
	by: 22297.686861079936,
});

/** Web Mercator x of a longitude, in metres. */
export function mercatorX(lon) {
	return R * lon * Math.PI / 180;
}

/** Web Mercator y of a latitude, in metres, growing north. */
export function mercatorY(lat) {
	return R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
}

/** lat/lon (WGS84 degrees) → { x, y } in the map's viewBox units (the ground point). */
export function lonLatToXY(lon, lat) {
	return {
		x: FRAME.ax * mercatorX(lon) + FRAME.bx,
		y: FRAME.by - FRAME.ay * mercatorY(lat),
	};
}

/**
 * Ground metres per viewBox unit at a latitude.
 *
 * Mercator is conformal, so the same figure applies to both axes at that latitude;
 * the 38.8° factor is what turns the Mercator metres of the fit into ground metres.
 */
export function metresPerUnit(lat) {
	return Math.cos(lat * Math.PI / 180) / FRAME.ax;
}

/** A GPS accuracy in metres, as a radius in viewBox units. */
export function accuracyRadius(metres, lat) {
	return metres / metresPerUnit(lat);
}

/** Distance in ground metres between two { x, y } map points, at a latitude. */
export function mapDistanceMetres(from, to, lat) {
	const dx = (to.x - from.x) / FRAME.ax;
	const dy = (to.y - from.y) / FRAME.ay;
	return Math.hypot(dx, dy) * Math.cos(lat * Math.PI / 180);
}

/**
 * The rings of a path made of lines and moves, scaled.
 *
 * The stored geometry (AuxFiles/<CC>/geom/*.txt, and the `d` the app builds paths
 * from) uses only M/L/H/V/Z in absolute or relative form — measured over every
 * row of PT's split geometry. A curve would have to be flattened, and flattening
 * it by its control points would move a boundary by metres, so anything else
 * throws rather than answering a parish question with a wrong polygon.
 *
 * `scale` is the app's resizeVar (60): stored rows are in the map's raw units and
 * the app draws them with transform="scale(60)".
 */
export function ringsOfPath(d, scale = 1) {
	const tokens = [];
	// Any letter is a command: an unsupported one must reach the throw below rather
	// than be read as the numbers of an implicit lineto (which is what a C, S or A
	// in the middle of a polygon would otherwise become).
	const re = /([A-Za-z])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
	let match;
	while ((match = re.exec(d)) !== null)
		tokens.push(match[1] === undefined ? Number(match[2]) : match[1]);

	const rings = [];
	let i = 0, cmd = null, x = 0, y = 0, ring = null;
	const num = () => {
		if (typeof tokens[i] !== 'number')
			throw new Error(`path: expected a number, found "${tokens[i]}"`);
		return tokens[i++];
	};
	while (i < tokens.length)
	{
		if (typeof tokens[i] === 'string')
		{
			cmd = tokens[i++];
			continue;
		}
		if (cmd === null)
			throw new Error('path: number without a command');
		if (cmd === 'Z' || cmd === 'z')
		{
			if (ring !== null)
				rings.push(ring);
			ring = null;
			cmd = null;
			continue;
		}
		const rel = cmd !== cmd.toUpperCase();
		const upper = cmd.toUpperCase();
		let nx, ny;
		if (upper === 'M' || upper === 'L')
		{
			const a = num(), b = num();
			nx = rel ? x + a : a;
			ny = rel ? y + b : b;
		}
		else if (upper === 'H')
		{
			const a = num();
			nx = rel ? x + a : a;
			ny = y;
		}
		else if (upper === 'V')
		{
			const b = num();
			nx = x;
			ny = rel ? y + b : b;
		}
		else
			throw new Error(`path: unsupported command ${cmd} (only M/L/H/V/Z lines flatten safely)`);
		x = nx;
		y = ny;
		if (upper === 'M')
		{
			ring = [[x, y]];
			// The pairs that follow a moveto are implicit linetos.
			cmd = rel ? 'l' : 'L';
		}
		else
		{
			if (ring === null)
				throw new Error('path: segment before a move');
			ring.push([x, y]);
		}
	}
	if (ring !== null)
		rings.push(ring);
	return scale === 1 ? rings : rings.map(ring2 => ring2.map(([px, py]) => [px * scale, py * scale]));
}

/**
 * The bounding box of a set of rings, as [minX, minY, maxX, maxY].
 *
 * Used by tools/build-pt-bbox.mjs to write the shortlist index, and by the tests to
 * check that index against the outline it describes. The app compares against these
 * boxes in the stored (raw) units — before the scale(resizeVar) transform — so a fix
 * is divided by the scale before the lookup. A bbox is deliberately conservative: it
 * can only add candidates, and pointInRings makes the actual decision.
 */
export function bboxOfRings(rings) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const ring of rings)
		for (const [x, y] of ring)
		{
			if (x < minX) minX = x;
			if (x > maxX) maxX = x;
			if (y < minY) minY = y;
			if (y > maxY) maxY = y;
		}
	return [minX, minY, maxX, maxY];
}

/**
 * The ids whose bbox contains a point, as an array of the index's own keys.
 *
 * `bboxes` is the `parishes` object of AuxFiles/PT/geom/bbox.json: numeric relation
 * id → [minX, minY, maxX, maxY] in raw map units. A fix in drawn viewBox units comes
 * in as x / resizeVar, y / resizeVar. No vertex is read here: the caller fetches
 * only the bucket(s) that hold these ids.
 */
export function shortlistByBbox(x, y, bboxes) {
	const hits = [];
	for (const id in bboxes)
	{
		const box = bboxes[id];
		if (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3])
			hits.push(id);
	}
	return hits;
}

/**
 * The chain of elements to click, top to bottom: world → continent → country →
 * district → … → the parish itself.
 *
 * The app only draws a child when its parent is clicked, so the click path must
 * start at the world (whose path Earth.svg already has) and go one level at a time
 * down to the parish. The parish's ancestors come from the country file's own
 * Id_Parent links; the walk stops where that file does, because the country
 * relation lives in the manifest, together with the world and the continent.
 *
 * `record` is the parish's country-file record, `countryById` maps the country
 * file's Id_Child to its records, and `manifest` is the world/continent/country
 * list. Throws rather than guessing if any link is missing.
 */
export function parishChain(record, countryById, manifest) {
	const chain = [];
	let cursor = record;
	let countryId = null;
	while (cursor !== undefined)
	{
		chain.unshift(cursor.Id_Child);
		const parent = countryById.get(cursor.Id_Parent);
		if (parent === undefined)
		{
			// The first parent the country file does not hold is the country relation.
			countryId = cursor.Id_Parent;
			break;
		}
		cursor = parent;
	}
	if (countryId === null)
		throw new Error('the parish has no country in its parent chain');
	const country = manifest.find(element => element.Id_Child === countryId);
	if (country === undefined)
		throw new Error(`no manifest record for ${countryId}`);
	const world = manifest.find(element => parseInt(element.AdminLevel_Child) === 0);
	if (world === undefined)
		throw new Error('no world record in the manifest');
	// A country can have several parents; the first one is its continent here.
	const continentId = String(country.Id_Parent).split(', ')[0];
	chain.unshift(countryId);
	chain.unshift(world.Id_Child, continentId);
	return chain;
}

/**
 * Even-odd containment, the rule the app fills its paths with.
 *
 * All rings are XOR-ed together, so a hole inside an outer ring answers "outside",
 * exactly as the painted polygon does. The test point is in viewBox units, so pass
 * rings already scaled (ringsOfPath(d, 60) for a stored geometry row).
 */
export function pointInRings(x, y, rings) {
	let inside = false;
	for (const ring of rings)
	{
		for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
		{
			const [xi, yi] = ring[i], [xj, yj] = ring[j];
			if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi)
				inside = !inside;
		}
	}
	return inside;
}
