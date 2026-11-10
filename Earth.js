// Bumped whenever Earth.js changes, so the console can prove which build is
// running. A stale cached bundle has already cost one round of debugging.
window.__mappuBuild = '2026-11-10-gps-nearest-line';

// The lat/lon → map-frame maths, the parish point-in-polygon and the click chain
// are in their own module so node can check them: tools/test-gps-frame.mjs. See
// gps-frame.js for the fit constants and their residuals.
import { lonLatToXY, accuracyRadius, mapDistanceMetres, ringsOfPath, pointInRings, parishChain } from './gps-frame.js';
// Geometry is gzipped on the published site (the site has to stay under 1 GB) and
// plain in the workbench; this asks for the .gz and falls back.
import { fetchGeometryText } from './geometry-fetch.js';

let CC = '';

// Where pin images are served from. Empty means "same directory": the workbench
// keeps AuxFiles/imgs/ on disk. The published copy sets the bucket root, whose
// keys are the same paths without the AuxFiles/imgs/ prefix.
const IMG_ROOT = 'https://storage.googleapis.com/bucket-wm8/';

$(function()
{
	$('#span').hide();
	if(CC !== '' && CC !== undefined)
	{
		//alert("!");
		//Operations.sortJsonCountry(CC);
		//Operations.sortGlobalJson();
		//Operations.sortTxtCountry(CC);
		//Operations.compareJsonTxt(CC);
	}
	
	/**
	 * Sort key that keeps an accented letter immediately after its plain form:
	 * "A" before "Á" before "B". NFD splits a letter into base + combining marks;
	 * a low sentinel after each letter's marks makes the plain letter win at that
	 * position, and the next letter still decides between two plain (or two
	 * accented) letters. A localeCompare cannot do this: it compares the whole
	 * word's base letters first, so "Águas" would sort before "Amoreira".
	 */
	function accentSortKey(name)
	{
		const key = [];
		let cluster = '';
		for (const ch of name.normalize('NFD').toLowerCase())
		{
			if (ch >= '\u0300' && ch <= '\u036f')
			{
				cluster += ch;
				continue;
			}
			if (cluster !== '')
				key.push(cluster, '\u0001');
			cluster = ch;
		}
		if (cluster !== '')
			key.push(cluster, '\u0001');
		return key.join('');
	}

	function orderPins(pins)
	{
		let auxPins = [];
		for(let i = 0; i < pins.length; i++)
			auxPins.push(pins[i]);
		
		auxPins.sort(function(a, b)
		{
			const ka = accentSortKey(a.Name), kb = accentSortKey(b.Name);
			if(ka < kb)
				return -1;
			if(ka > kb)
				return 1;
			return 0;
		});
		return auxPins;
	}
		
	function now()
	{
		return typeof window.performance !== 'undefined'
		? window.performance.now()
		: 0;
	}
	
	$('#svg-map').on('load', function(a) 
	{
		const txt1 = 'AuxFiles/', txt2 = 'Continents+Countries', txt3 = '.txt', txt4 = '.json', txt5 = 'imgs/', txt6 = '.png', txt7='Earth+Continents+Countries',txt8='/Pins', $map = $(a.target.contentDocument), $paths = $map.find('path'), pathsAsValues = Object.values($paths).slice(0,1),
		mapSvg = $map[0].children[0], mapWidth = $map[0].children[0].getBBox().width, mapHeight = $map[0].children[0].getBBox().height, htmlPaths = $map[0].querySelector('svg');
		let global = [], clicked = [], childrenElements = [], filterElems = [], jsonCountry = [], loaded = [], txtSorted  = [], txtAux = [], parsed = [], loadedPins = [], jsonLoaded = {CC: '', Id: undefined, JsonData: undefined, Name: ''}, txtLoaded = {CC: '', Id: undefined, Name: '', TxtData: undefined}, loadedBuckets = {}, countryElementById = {}, 
		transContinental = ['AM', 'AZ', 'CY', 'EG', 'GE', 'ID', 'KZ', 'RU', 'TR'],
		emptyCountries = ['AI', 'IO', 'PN', 'VA'],
		smallC = ['AD', 'GI', 'LI', 'MC', 'SM', 'VA'],
		start, end, globalJson, countryCode = '', second = '', diffCCode = false, loader = false, progressBar = document.getElementById("progress-bar"), progressValue = document.getElementById("progress-value"), zooming = false, pinClicked = false, containerLoaded = false, resizeVar = 60;
		
		/**
		 * Where a pin's image lives.
		 *
		 * PREFERRED: the path stored on the pin record itself. tools/add-pin-images.mjs
		 * derives it from the imgs/ tree and verifies every one resolves, so a pin now
		 * resolves the same way however you reach it.
		 *
		 * FALLBACK: the original route-based path, built from the click chain. Kept for
		 * pins that predate the field and for the 413 pins that genuinely have no image,
		 * which store Image: "" - so nothing that worked before can break.
		 *
		 * Why this matters: Morocco sits in two continents and several elements have two
		 * parents, so the same pin can be reached by different routes. The old path
		 * depended on the route, so the image 404'd unless you arrived the expected way.
		 *
		 * The result is relative to the site while IMG_ROOT is empty (the workbench);
		 * the published copy prefixes the bucket root, whose keys drop AuxFiles/imgs/.
		 */
		function buildPathImgs(globEl, foundPin)
		{
			let strPath;
			if(foundPin.Image !== undefined && foundPin.Image !== null && foundPin.Image !== '')
				strPath = foundPin.Image;
			else
			{
				strPath = txt1 + txt5;
				for(let i = 0; i < clicked.length; i++)
					strPath += clicked[i].Element.Id + '/';
				strPath += `${foundPin.Id}${txt6}`;
			}
			return IMG_ROOT === '' ? strPath : IMG_ROOT + strPath.replace(/^AuxFiles\/imgs\//, '');
		}

		/**
		 * "Hide pins without pictures" toggle.
		 *
		 * A pin has a picture when its record carries a non-empty Image, which is the
		 * same test buildPathImgs uses before falling back to the route-based path.
		 * A first visit opens with the picture-less backlog hidden, so the published
		 * map shows the finished set; a stored choice always wins, and unticking the
		 * box is how the backlog is worked through on site.
		 */
		const HIDE_NO_IMAGE_KEY = 'mappu.hidePinsWithoutImages';
		let hidePinsWithoutImages = true;
		try
		{
			const stored = window.localStorage.getItem(HIDE_NO_IMAGE_KEY);
			if(stored !== null)
				hidePinsWithoutImages = stored === '1';
		}
		catch (e) { /* storage can be blocked; keep the default */ }

		function pinHasImage(foundPin)
		{
			return foundPin.Image !== undefined && foundPin.Image !== null && foundPin.Image !== '';
		}

		/**
		 * "Only pins without pictures" toggle — the photo-hunting view.
		 *
		 * The inverse of the toggle above: it shows the backlog and nothing else, so a
		 * walk through a parish is a list of places still to photograph. It cannot be on
		 * at the same time as "Hide pins without pictures" — the two views are opposites —
		 * so ticking one unticks the other. Like the others, the choice is remembered.
		 */
		const ONLY_NO_IMAGE_KEY = 'mappu.onlyPinsWithoutImages';
		let onlyPinsWithoutImages = false;
		try { onlyPinsWithoutImages = window.localStorage.getItem(ONLY_NO_IMAGE_KEY) === '1'; }
		catch (e) { /* storage can be blocked; keep the default */ }

		/**
		 * "Highlights only" toggle.
		 *
		 * A pin is a highlight unless its record carries Highlight: false. Only the
		 * service/institution pins are marked that way; every pin with a picture is a
		 * highlight by construction, and the image-less highlights are the photo
		 * backlog. The filter stacks with the picture filter, so together they give:
		 * pictures only, highlights (with or without pictures), or everything. The
		 * choice is remembered per browser; the default is to show every pin.
		 */
		const HIGHLIGHTS_ONLY_KEY = 'mappu.highlightsOnly';
		let highlightsOnly = false;
		try { highlightsOnly = window.localStorage.getItem(HIGHLIGHTS_ONLY_KEY) === '1'; }
		catch (e) { /* storage can be blocked; keep the default */ }

		function pinIsHighlight(foundPin)
		{
			return foundPin.Highlight !== false;
		}

		function pinIsVisible(foundPin)
		{
			return (!hidePinsWithoutImages || pinHasImage(foundPin))
				&& (!onlyPinsWithoutImages || !pinHasImage(foundPin))
				&& (!highlightsOnly || pinIsHighlight(foundPin));
		}
		
		function showLoader()
		{
			loader = true;
			$("#reset" ).prop("disabled", true);
			$("#back" ).prop("disabled", true);
			$("#span").hide();
			$("#loader").show();
			$("#progress-bar").show();
			progressBar.value = 0;
			$("#progress-value").show();
			progressValue.innerHTML = "0%";
		}

		function hideLoader()
		{
			$("#loader").hide();
			$("#progress-bar").hide();
			$("#progress-value").hide();
			$("#reset" ).prop("disabled", false);
			$("#back" ).prop("disabled", false);
			$("#span").show();
			if(!zooming)
			{
				$("#reset" ).prop("disabled", false);
				$("#back" ).prop("disabled", false);
			}
			loader = false;
		}
		
		function binarySearchGlobal(array, targetValue)
		{
			let min = 0, max = array.length - 1, guess, guessValue;

			while(min <= max)
			{
				guess = Math.floor((max + min) / 2);
				guessValue = parseInt(array[guess].Element.Id);

				if(guessValue === targetValue)
					return array[guess];
				else if(guessValue < targetValue)
					min = guess + 1;
				else
					max = guess - 1;
			}
			return -1;
		}
		
		function binarySearch(array, targetValue)
		{
			let min = 0, max = array.length - 1, guess, guessValue;

			while(min <= max)
			{
				guess = Math.floor((max + min) / 2);
				guessValue = array[guess];
				
				if(guessValue === targetValue)
					return array[guess];
				else if(guessValue < targetValue)
					min = guess + 1;
				else
					max = guess - 1;
			}
			return -1;
		}

		function copyToClipboard(text) 
		{
			function success(value)
			{
				//alert('Copied!');
				console.log('Copied!');
				//console.log('Resolved: ', value);
			}
			function error(err)
			{
				//alert('Error: ' + err);
				console.error('Error: ', err);
			}
			
			if(navigator.clipboard)
			{ 	// default: modern asynchronous API
				console.log('Attempting to copy:');
				console.log(text);
				return navigator.clipboard.writeText(text).then(success, error).catch(error);
			}
			else if(window.clipboardData && window.clipboardData.setData)
			{ 	// for IE11
				window.clipboardData.setData('Text', text);
				return Promise.resolve();
			}
			else
			{
				// workaround: create dummy input
				const input = h('input', { type: 'text' });
				input.value = text;
				document.body.append(input);
				input.focus();
				input.select();
				document.execCommand('copy');
				input.remove();
				return Promise.resolve();
			}
		}

		function cloneArray(sourceArray)
		{
			return(JSON.parse(JSON.stringify(sourceArray)));
		}
		
		function naturalSort(array)
		{
			const rx = /(\d+)|(\D+)/g;
			const rd = /\d+/;
			return array.sort(function (as, bs)
			{
				let a = String(as).toLowerCase().match(rx);
				let b = String(bs).toLowerCase().match(rx);
				while (a.length && b.length)
				{
					const a1 = a.shift();
					const b1 = b.shift();
					if (rd.test(a1) || rd.test(b1))
					{
						if (!rd.test(a1)) return 1;
						if (!rd.test(b1)) return -1;
						if (a1 != b1) return a1 - b1;
					}
					else if (a1 != b1)
					{
						return a1 > b1 ? 1 : -1;
					}
				}
				return a.length - b.length;
			});
		}

		function updateProgressBar(cur, tot)
		{
			let value = Math.floor(cur * 100 / tot);
			if(value > 100)
				value = 100;
		    progressBar.value = value;
		    progressValue.innerHTML = `${value}%(${cur}/${tot})`;
		}
		
		function onlyUnique(value, index, self) 
		{
			return self.indexOf(value) === index;
		}

		function nonUnique(value, index, self) 
		{
			return self.indexOf(value) !== index;
		}
	
		/**
		 * The country code an element belongs to, found by walking up its parent chain.
		 *
		 * MEASURED HOT SPOT, and the second half of the ~17.8 s stall on re-clicking a
		 * loaded bottom element. A Chrome call tree showed findCountryCode at 13.2 s
		 * (67.6%) of the click, with the $(el.Path).attr('d') reads inside applyEvList
		 * adding another ~1.4 s.
		 *
		 * The cost is the same shape as hidePath's: this function is RECURSIVE, and
		 * every level re-runs a `global.filter` over the whole `global` array - 21,568
		 * records for GB - to find the next parent. Depth times length, on every click.
		 *
		 * The fix is memoisation, which is sound here because the answer for a given
		 * element is a pure function of the hierarchy: the chain from an element to its
		 * country does not depend on which other elements happen to be loaded. So a
		 * result, once computed, stays correct.
		 *
		 * The memo is keyed by the element it was REQUESTED for, and the walk records
		 * the answer for every element it passes through on the way up - so the first
		 * deep lookup makes all shorter lookups on the same chain free.
		 *
		 * Invalidation: `global` is rebuilt wholesale when a country is (re)loaded, and
		 * that is the only thing that can change an element's chain. Keying the cache on
		 * global.length catches every rebuild, since reloading a country always changes
		 * how many records are registered. The resolved code is also stored with the
		 * element's own id so a stale entry cannot be returned for a different element.
		 */
		let fccMemo = { len: -1, byId: Object.create(null) };
		function findCountryCode(element, _memoKey)
		{
			if(element === undefined)
				return countryCode;
			const selfId = element.Element && element.Element.Id_Child;
			if(_memoKey === undefined)
				_memoKey = selfId;
			if(global.length !== fccMemo.len)
				fccMemo = { len: global.length, byId: Object.create(null) };
			if(selfId !== undefined && fccMemo.byId[selfId] !== undefined)
				return fccMemo.byId[selfId];
			const remember = value =>
			{
				if(_memoKey !== undefined)
					fccMemo.byId[_memoKey] = value;
				return value;
			};
			if(parseInt(element.Element.AdminLevel_Child) < 2)
				return remember('');
			if(element.Element.CountryCode_Child !== undefined && element.Element.CountryCode_Child !== '' && parseInt(element.Element.AdminLevel_Child) === 2)
				return remember(element.Element.CountryCode_Child);
			let parentEl = global.filter(el => 
			{
				// An entry with no Element cannot be a parent. `global` is meant to hold
				// { Element, Path, D, Parents, Children } records, but anything pushed
				// without an Element makes this callback throw
				// "Cannot read properties of undefined (reading 'Id_Child')".
				if(el === null || el === undefined || el.Element === undefined)
					return false;
				return el.Element.Id_Child === element.Element.Id_Parent || element.Element.Id_Parent.split(', ').find(el2 => el2 === el.Element.Id_Child);
			});
			if(parentEl.length > 1)
				return remember(findCountryCode(parentEl[parentEl.length-1], _memoKey));

			// When the global chain does not contain this element's parent, fall back to
			// the country file, which has the whole hierarchy. Without this, parentEl is
			// empty, parentEl[0] is undefined, and the recursive call dereferences
			// .Element on undefined - "Cannot read properties of undefined (reading
			// 'Element')" at line 222.
			//
			// This happens deep in a split country: an intermediate element such as an
			// L7 municipality may never have been drawn, so it is absent from global,
			// and the walk cannot climb past it.
			if(parentEl.length === 0)
			{
				// Climb through the country file rather than global.
				//
				// The chain ends at the COUNTRY relation itself - Queluz e Belas ->
				// Sintra -> Lisboa -> relation/295480 - and that last one is a level-2
				// record, which lives in the MANIFEST, not in the country file. So the
				// walk cannot stop on "AdminLevel === 2"; it has to recognise the
				// country relation and return its code. Stopping on level 2 alone never
				// terminates, because the country file holds only levels 4 and deeper.
				const climb = node =>
				{
					const seen = new Set();
					while(node && node.Element && !seen.has(node.Element.Id_Child))
					{
						seen.add(node.Element.Id_Child);
						if(parseInt(node.Element.AdminLevel_Child) === 2)
							return node.Element.CountryCode_Child;
						const parentId = (node.Element.Id_Parent || '').split(', ')[0];
						if(parentId === '')
							break;
						const parent = countryElementById[parentId];
						if(parent !== undefined)
						{
							node = parent;
							continue;
						}
						// Not in the country file: it should be the country relation.
						const country = globalJson.find(g => g.Id_Child === parentId);
						if(country !== undefined)
							return country.CountryCode_Child;
						break;
					}
					return '';
				};
				return remember(climb(global.find(g => g.Element.Id_Child === element.Element.Id_Child) || element));
			}

			return remember(findCountryCode(parentEl[0], _memoKey));
		}
		
		function bringToTop(targetElement)
		{
		  let parent = targetElement.parentNode;
		  parent.appendChild(targetElement);
		}

		function pinsForCurrentRegion()
		{
			return loadedPins.filter(pin => pin.Element_Id === clicked.at(-1).Element.Id);
		}

		function setOtherPinsVisible(keepPin, visible)
		{
			pinsForCurrentRegion()
			.filter(pin => pin !== keepPin)
			.forEach(pin =>
			{
				if(visible && pinIsVisible(pin))
				{
					$(pin.Path).show();
					$(pin.Img).show();
				}
				else
				{
					$(pin.Path).hide();
					$(pin.Img).hide();
				}
			});
		}

		function syncPinSelect(keepPin)
		{
			// The options carry the pin Id as their value, so select by value rather
			// than by a position in a differently-ordered list. Falls back to the
			// positional lookup if the value is not found.
			const sel = $(document).find('select')[0];
			if(sel === undefined)
				return;
			const wanted = String(keepPin.Id);
			let at = -1;
			for(let i = 0; i < sel.options.length; i++)
			{
				if(String(sel.options[i].value) === wanted)
				{
					at = i;
					break;
				}
			}
			if(at === -1)
				at = orderPins(pinsForCurrentRegion()).indexOf(keepPin) + 1;
			sel.options.selectedIndex = at;
		}

		function onPinHoverIn(keepPin)
		{
			if(!pinClicked)
				setOtherPinsVisible(keepPin, false);
		}

		function onPinHoverOut(keepPin)
		{
			if(!pinClicked)
				setOtherPinsVisible(keepPin, true);
		}

		function onPinClick(keepPin, zoomTarget)
		{
			if(pinClicked)
			{
				setOtherPinsVisible(keepPin, true);
				pinClicked = false;
			}
			else
			{
				setOtherPinsVisible(keepPin, false);
				pinClicked = true;
			}
			syncPinSelect(keepPin);
			zoomOnElement(zoomTarget, a.target.contentDocument);
			span.innerHTML = `Highlight selected: ${keepPin.Name}`;
		}
		
		/**
		 * Load the pins for the region currently being shown.
		 *
		 * Declared here, alongside applyEvList, rather than inside it: both
		 * applyEvList (via the legacy country-file path) and
		 * renderChildrenFromGeometry call it, so it has to be in their shared scope.
		 *
		 * The path depends on the level: a country's pins live in
		 * AuxFiles/<CC>/Pins.json, while the world and the continents use the single
		 * AuxFiles/Pins.json. Only two countries currently ship a Pins.json, so the
		 * other 212 produce a 404 and log "No pins in <name>...".
		 */
		function loadPins(globEl)
		{
			let pinsPath = parseInt(globEl.Element.AdminLevel_Child) > 1
			? `${txt1}${countryCode}${txt8}${txt4}`
			: `${txt1}${txt8}${txt4}`;
			$.getJSON(pinsPath, function($pinsFile)
			{
				if($pinsFile.length > 0)
					$pinsFile.forEach((pin) =>
					{
						// Deduplicate by VALUE, not by identity.
						//
						// This used to be loadedPins.includes(pin), which compares object
						// references. $.getJSON builds a fresh object graph on every call, so
						// no reference ever matched and the same pins were appended again on
						// every drill-down - three clicks meant every pin appeared three
						// times in the dropdown.
						//
						// A pin's identity is its parent element plus its own id, which is
						// also what the image path uses.
						if(parseInt(pin.Element_Id) === -1)
							return;
						if(loadedPins.some(seen => String(seen.Element_Id) === String(pin.Element_Id)
							&& String(seen.Id) === String(pin.Id)))
							return;
						loadedPins.push(pin);
					});
			})
			.fail(function()
			{
				console.log(`No pins in ${globEl.Element.Name_Child}...`);
			});
		}

		// Announce the build once, unprompted. It is also readable as
		// window.__mappuBuild, but a silent marker is no use when the question is
		// "which build am I running?" - and a stale cached bundle already cost a round
		// of debugging once.
		console.log(`[mappu] build ${window.__mappuBuild}`);

		// Report every uncaught error with where it came from. The browser's own
		// console shows only the innermost frame plus a minified-ish stack, which
		// twice sent us looking at the wrong function. This prints the chain and the
		// build marker so we always know which code is actually running.
		function describeError(e)
		{
			const err = e.error || e.reason || e;
			const parts = [];
			parts.push(`build=${window.__mappuBuild || '(none)'}`);
			parts.push(`message=${e.message || (err && err.message) || String(err)}`);
			if(e.filename !== undefined)
				parts.push(`at=${e.filename}:${e.lineno}:${e.colno}`);
			parts.push(`countryCode=${countryCode}`);
			// globEl is NOT in scope here - it is a parameter of several inner
			// functions, and referring to it here threw "globEl is not defined"
			// inside the error handler itself, so nothing was ever reported.
			// Reach the same information through variables that ARE in scope.
			let current = null;
			try { current = clicked.length ? clicked[clicked.length - 1].Element : null; } catch (ignored) { current = null; }
			parts.push(`current=${current ? `${current.Id_Child} L${current.AdminLevel_Child} "${current.Name_Child}"` : '(none)'}`);
			try { parts.push(`clicked=${clicked.map(c => c.Element.Id_Child).join('>') || '(none)'}`); } catch (ignored) { /* keep going */ }
			parts.push(`global=${global.length}`);
			try
			{
				const broken = global.filter(g => !g || !g.Element).length;
				parts.push(`globalMissingElement=${broken}`);
			} catch (ignored) { /* keep going */ }
			parts.push(`pathsAsValues=${pathsAsValues.length}`);
			try
			{
				const broken = pathsAsValues.filter(p => !p || p.id === undefined).length;
				parts.push(`pathsAsValuesBroken=${broken}`);
			} catch (ignored) { /* keep going */ }

			console.error('=== uncaught error ===');
			for (const p of parts) console.error('  ' + p);
			if(err && err.stack)
			{
				console.error('  stack:');
				for (const f of String(err.stack).split('\n').slice(0, 8)) console.error('    ' + f.trim());
			}
		}
		window.addEventListener('error', describeError);
		window.addEventListener('unhandledrejection', describeError);

		/**
		 * The shared tail of all three loading paths.
		 *
		 * NEXT-STEPS.md item A. These three used to carry their own near-identical
		 * copy of this loop, which is why `loadPins` was fixed in one copy and not
		 * another and why the pathsAsValues guard had to be applied at three sites.
		 * The copies diverged four times before this consolidation; they cannot now.
		 *
		 *   A  the cached branch                 (children from ChildrenIndexes, rows from txtLoaded.TxtData)
		 *   B  loadLegacyWholeCountryFile        (children from ChildrenIndexes, rows from the fetched <CC>.txt)
		 *   C  renderChildrenFromGeometry        (children from the Children id list, geometry by relation id)
		 *
		 * The paths already exist in the SVG by the time this runs; what they were
		 * built from is the caller's business. `geometryOf(globEl, foundChild)` is the
		 * single injected difference, and it returns the geometry string to draw or
		 * undefined to skip. Each caller passes its own, because the lookups are
		 * genuinely different and one of them carries an offset that the others must
		 * not have (DATA-FORMAT.md section 3.2).
		 *
		 * Options, all defaulting to the B behaviour:
		 *   loadedList      array the newly-loaded ids are pushed to (A/B/C all keep one)
		 *   counter         the array whose length drives the progress bar; A passes a
		 *                   THROWAWAY one, because A's denominator counts "newly
		 *                   created this pass" while B and C count "processed this
		 *                   pass". That asymmetry is real, is asserted by the paths
		 *                   suite, and is preserved here rather than quietly unified.
		 *                   Passing null counts every child, as C does.
		 *   worldZOrder     run the relation/10 + relation/20 bringToTop block
		 *   loadPins        refresh the pin list after registering
		 *   guardMissingGeometry
		 *                   skip a child with no geometry. C's first loop does this
		 *                   today but its second does not, which is latent defect F8 -
		 *                   see the note at the C call site.
		 */
		/**
		 * Builds the SVG paths for a batch of children and appends them.
		 *
		 * This was duplicated verbatim in two places - inside the cached branch and
		 * inside loadLegacyWholeCountryFile - which is exactly the drift NEXT-STEPS.md
		 * warns about. The single real difference is how a row is looked up:
		 *
		 *   A  rowOf(i) -> txtLoaded.TxtData[indexes[i] - rowOffset]
		 *   B  rowOf(i) -> parsedData.data[indexes[i] - planeOffset]
		 *
		 * and which hierarchy array the record comes from.
		 *
		 * FIXED WHILE CONSOLIDATING: this used to pair `jsonData` and `pathData` by a
		 * shared index `i` while filtering them with TWO INDEPENDENT predicates - one
		 * on the record's Id, one on the row's parsed relation id. Those agree only
		 * while `loaded` holds exactly the children already drawn, which stopped being
		 * true once the cached branch began serving the world/continent plane, because
		 * its bulk push adds children that do not have a path yet. The arrays then ran
		 * to different lengths and the load threw with no path drawn.
		 *
		 * The two sides are now computed together, so a record is always paired with
		 * its own row. `loaded` is checked once, on the record, which is the same
		 * predicate the tail uses when deciding whether to register a child.
		 */
		function addToDocumentFragment(globEl, data, indexes, jsonOf, rowOf)
		{
			let fragment = document.createDocumentFragment(), pathData = [];
			// Keep the pair together: a record with no row, or a row with no geometry,
			// drops the whole pair rather than shifting everything after it.
			for (let i = 0; i < indexes.length; i++)
			{
				const record = jsonOf(indexes[i]);
				if(record === undefined || binarySearch(loaded, record.Id) !== -1)
					continue;
				const row = rowOf(i);
				if(row === undefined || row[0] === undefined)
					continue;
				pathData.push(row);
				fragment.appendChild(makeChildPath(record, row[0]));
			}
			htmlPaths.append(fragment);
			end = now();
			printStats(`Finished creating Paths for ${globEl.Element.Name_Child}!`);
		}

		/** Creates one child path element. Shared by the fragment builder alone. */
		function makeChildPath(record, d)
		{
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttributeNS(null, "d", d);
			path.setAttributeNS(null, "id", record.Id_Child);
			path.setAttributeNS(null, "transform", `scale(${resizeVar}, ${resizeVar})`);
			applyStyle(record, path);
			return path;
		}

		function registerChildren(globEl, children, geometryOf, opts)
		{
			opts = opts || {};
			const loadedList = opts.loadedList;
			// Counter semantics, preserved per caller rather than unified by accident:
			//   counter supplied -> counts children NEWLY created this pass (path A)
			//   counter null     -> counts children PROCESSED this pass (paths B and C)
			// That is why path A's bar reads 0%(0/N) on a re-entry: every child is
			// already in `loaded`, so nothing is newly created. The paths suite asserts
			// this, so do not move the push below out of that block without deciding to
			// change the behaviour deliberately.
			const counter = opts.counter || null;
			const total = children.length;

			start = now();
			let childrenImported = [];
			for(let i = 0; i < children.length; i++)
			{
				let foundChild = children[i], pathTemp = htmlPaths.children.namedItem(foundChild.Id_Child),
				globalElem = binarySearchGlobal(global, foundChild.Id);
				if(globalElem === -1)
				{
					global.push({ Element: foundChild, Path: pathTemp, D: dAttr(pathTemp), Parents: [globEl], Children: []});//Don't forget to push other parents when element has multiple parents
					globalElem = global.at(-1);
					globalElem.Parents[0].Children.push(globalElem);//Don't forget to push Children to other parents
				}
				else
					showPath(globalElem.Path, globalElem.D);
				if(binarySearch(loaded, foundChild.Id) === -1)
				{
					if(opts.guardMissingGeometry && geometryOf(globEl, foundChild, i) === undefined)
						continue;
					if(loadedList)
						loadedList.push(foundChild.Id_Child);
					loaded.push(foundChild.Id);
					// Never store a missing path: namedItem returns null when the element is

					// not in the SVG, and a null here makes every pathsAsValues.find() throw.

					if(pathTemp !== null && pathTemp !== undefined)

						pathsAsValues.push(pathTemp);
					addEvListener(pathTemp, global.length-1);
					if(counter)
						counter.push(foundChild.Id_Child);
				}
				childrenImported.push(foundChild.Id_Child);
				updateProgressBar(counter ? counter.length : childrenImported.length, total);
			}
			if(opts.worldZOrder && globEl.Element.Id === 3)
			{
				bringToTop(htmlPaths.children.namedItem('relation/20'));
				bringToTop(htmlPaths.children.namedItem('relation/10'));
			}
			global = global.sort((a,b) =>  a.Element.Id-b.Element.Id);
			loaded.sort((a,b) =>  a-b);
			end = now();
			printStats(`Finished creating var infos for ${globEl.Element.Name_Child}!`);
			hideLoader();
			span.innerHTML = globEl.Element.Name_Child;
			if(opts.loadPins)
				loadPins(globEl);
		}

		function applyEvList(globEl, element)
		{
			// loadPins used to be declared here. It is now at the same level as
			// applyEvList, because renderChildrenFromGeometry calls it too and a
			// function declared inside applyEvList is not in scope there - the call
			// threw "ReferenceError: loadPins is not defined" at the very end of every
			// split-country load. The paths were already drawn by then, which is why
			// the map still looked correct.
			if(parseInt(globEl.Element.AdminLevel_Child) > 12/*|| childrenElements.length < 1*/)
			{
				span.innerHTML = globEl.Element.Name_Child;
				return;
			}
			clicked.forEach((clk) =>
			{
				if(parseInt(clk.Element.AdminLevel_Child) > parseInt(globEl.Element.AdminLevel_Child))
				{
					loadedPins.filter(pin => pin.Element_Id === clicked.at(-1).Element.Id)
					.forEach(el =>
					{
						$(el.Path).hide();
						$(el.Img).hide();
					});
					clicked.splice(clicked.indexOf(clk, 1));
				}
			});
			if(clicked.length === 0)
				clicked.push(globEl);
			else
			{
				if(globEl.Element.Id_Child !== clicked.at(-1).Element.Id_Child)
				{
					pinClicked = false;
					$(container).text('');
					loadedPins/*.filter(pin => pin.Element_Id === clicked.at(-1).Element.Id)*/
					.forEach(el =>
					{
						$(el.Path).hide();
						$(el.Img).hide();
					});
					if(parseInt(globEl.Element.AdminLevel_Child) === parseInt(clicked.at(-1).Element.AdminLevel_Child))
					{
						clicked.splice(clicked.indexOf(clicked.at(-1)), 1);
						clicked.push(globEl);
					}
					else if(parseInt(globEl.Element.AdminLevel_Child) > parseInt(clicked.at(-1).Element.AdminLevel_Child))
						clicked.push(globEl);
				}
			}
			if(parseInt(globEl.Element.AdminLevel_Child) >= 0 && $('#back').css('display') === 'none')
				$('#back').show();
			
			switch (parseInt(globEl.Element.AdminLevel_Child))
			{
				case 0:
				case 1:
				case 2:
				case 3:
				case 4:
				case 5:
				case 6:
				case 7:
				case 8:
				case 9:
				case 10:
				case 11:
				case 12:
					global.filter(el2 => parseInt(el2.Element.AdminLevel_Child) > parseInt(globEl.Element.AdminLevel_Child)
					&& el2.Element.Id_Parent !== globEl.Element.Id_Parent
					&& dAttr(el2.Path) !== ''
					|| parseInt(el2.Element.AdminLevel_Child) < parseInt(globEl.Element.AdminLevel_Child)//To prevent cases of childless siblings that are visually on top of lower admin parents in the same space
					&& el2.Element.Id_Parent === globEl.Element.Id_Parent).forEach((elem) =>
					{
						hidePath(elem.Path);
					});
					
					global.filter(el2 => el2.Element.Id_Parent === globEl.Element.Id_Parent
					&& parseInt(el2.Element.AdminLevel_Child) >= parseInt(globEl.Element.AdminLevel_Child)
					&& dAttr(el2.Path) === ''
					&& (parseInt(globEl.Element.AdminLevel_Child) !== 2)).forEach((elem) =>
					{
						showPath(elem.Path, elem.D);
					});
					if(childrenElements.length > 0)
					{
						let boundingRect = globEl.Path.getBBox();
						if(parseInt(globEl.Element.AdminLevel_Child) > 1 && boundingRect.width < mapWidth/2 && boundingRect.height < mapHeight/2)
							zoomOnElement(globEl, a.target.contentDocument);
						hidePath(globEl.Path);
					}
					else
					{
						hideLoader();
						span.innerHTML = globEl.Element.Name_Child;
						let matchingPins = pinsForCurrentRegion();
						if(matchingPins.length > 0)
						{
							let fragment = document.createDocumentFragment();
							pinClicked = false;
							
							matchingPins = orderPins(matchingPins);
							let sel = document.createElement("select"), optionAux = document.createElement("option");
							
							if($('#container').children().length === 0)
							{
								optionAux.value = null;
								optionAux.text = "Please choose an option:";
								sel.appendChild(optionAux);
							}
							
							matchingPins.forEach((foundPin, index) =>
							{
								if($('#container').children().length === 0 && pinIsVisible(foundPin))
								{
									let opt = document.createElement("option");
									opt.value = foundPin.Id;
									opt.text = foundPin.Name;
									sel.appendChild(opt);
								}
								
								if(foundPin.Path === undefined)
								{
									console.log("Pin(s) found!");
									let pathPin = document.createElementNS("http://www.w3.org/2000/svg", "path"), imgPin = document.createElementNS("http://www.w3.org/2000/svg", "image");
									
									pathPin.setAttributeNS(null, "d", foundPin.D);
									pathPin.setAttributeNS(null, "id", `pin/${foundPin.Element_Id}-${foundPin.Id}`);
									pathPin.setAttributeNS(null, "class", `pin`);
									pathPin.setAttributeNS(null, "name", foundPin.Name);
									
									let pathImgs = buildPathImgs(globEl, foundPin);
									imgPin.setAttributeNS('http://www.w3.org/1999/xlink', "xlink:href", pathImgs);
									imgPin.setAttributeNS(null, "width", foundPin.Width);
									imgPin.setAttributeNS(null, "height", foundPin.Height);
									imgPin.setAttributeNS(null, "id", `image/${foundPin.Element_Id}-${foundPin.Id}`);
									imgPin.setAttributeNS(null, "x", foundPin.X);
									imgPin.setAttributeNS(null, "y", foundPin.Y);
									imgPin.setAttributeNS(null, "class", "img");
									
									pathPin.addEventListener('mouseover', () => onPinHoverIn(foundPin));
									pathPin.addEventListener('mouseout', () => onPinHoverOut(foundPin));
									pathPin.addEventListener('click', () => onPinClick(foundPin, pathPin));
									imgPin.addEventListener('mouseover', () => onPinHoverIn(foundPin));
									imgPin.addEventListener('mouseout', () => onPinHoverOut(foundPin));
									imgPin.addEventListener('click', () => onPinClick(foundPin, pathPin));
									
									foundPin.Path = pathPin;
									foundPin.Img = imgPin;
									
									fragment.appendChild(pathPin);
									fragment.appendChild(imgPin);
									if(!pinIsVisible(foundPin))
									{
										$(pathPin).hide();
										$(imgPin).hide();
									}
								}
								else
								{
									if(pinIsVisible(foundPin))
									{
										if($(foundPin.Path).css('display') === 'none')
										{
											$(foundPin.Path).show();
											$(foundPin.Img).show();
										}
									}
									else
									{
										$(foundPin.Path).hide();
										$(foundPin.Img).hide();
									}
								}
							});
							if($('#container').children().length === 0)
							{
								let label = document.createElement("label");
								label.innerHTML = "Highlights: "
								$('#container')[0].appendChild(label).appendChild(sel);
								sel.addEventListener("change", op =>
								{
									// Resolve by the option's VALUE, not by its position.
									//
									// This used to be orderPins(pinsForCurrentRegion())[selectedIndex-1],
									// which assumes the options were appended in sorted order. They are
									// appended in file order, so choosing a name selected a DIFFERENT
									// pin whenever the two orders disagreed - e.g. Avenidas Novas, where
									// the first option reads "Estação São Sebastião..." but index 1
									// resolved to "Estação CP Entrecampos".
									//
									// The option value already carries the pin's Id, so use it.
									const wanted = String(op.target.value);
									let selectedPin = pinsForCurrentRegion().find(pin => String(pin.Id) === wanted);
									if(selectedPin === undefined)
										selectedPin = orderPins(pinsForCurrentRegion())[op.target.selectedIndex-1];
									if(selectedPin !== undefined && selectedPin.Id !== undefined)
									{
										setOtherPinsVisible(selectedPin, false);
										pinClicked = true;
										$(selectedPin.Path).show();
										$(selectedPin.Img).show();
										zoomOnElement(selectedPin.Path, a.target.contentDocument);
										span.innerHTML = `Highlight: ${sel.options[op.target.selectedIndex].innerText}`;
									}
								});
							}
							else
								$(document).find('select')[0].options.selectedIndex = 0;
							
							htmlPaths.append(fragment);
							zoomOnElement(globEl, a.target.contentDocument);
						}
						else
						{
							let par = clicked.at(-2);
							showPath(par.Path, par.D);
							zoomOnElement(par, a.target.contentDocument);
							hidePath(par.Path);
						}
						return;
					}
					let elsLoaded = childrenElements.filter(el => binarySearchGlobal(global, el.Id) !== -1).filter(el => el.CountryCode_Child === globEl.Element.CountryCode_Child);
					if(elsLoaded.length > 0 && elsLoaded[0].Id_Parent.split(', ').length < 1)
					{
						elsLoaded.forEach((el, index) =>
						{
							let pathToShow = binarySearchGlobal(global, el.Id);
							showPath(pathToShow.Path, pathToShow.D);
						});
						if(elsLoaded.length !== childrenElements.length && elsLoaded.find(fNTC => transContinental.find(tCont => tCont !== fNTC.CountryCode_Child) !== undefined))
							alert(`Number of elements loaded from memory is different than number of children! Loaded from memory: ${elsLoaded.length}, number of children(childrenElements.map(childEl => childEl.Id_Child )): ${childrenElements.length}`);
						hideLoader();
						span.innerHTML = globEl.Element.Name_Child;
					}
					// The cached branch below rebuilds the country's rows by position from
					// txtLoaded.TxtData. The split path deliberately leaves TxtData
					// undefined, because it does not build a full row set - so this branch
					// must not be taken for a split country. Without the TxtData check it
					// runs anyway and dies at "data[el][1]" while spreading `undefined`.
					//
					// Regression guard: this branch can only serve a parent whose whole
					// file was loaded, so require the rows to actually be present.
					//
					// It now serves the WORLD/CONTINENT plane as well as countries. Level
					// 0/1 records have CountryCode_Child === '' and index the MANIFEST, so
					// the plane is selected below.
					//
					// A -1 ROW OFFSET IS REQUIRED, and getting it wrong is subtle. `indexes`
					// holds the CHILDREN's indices, and for a level 0/1 parent those are
					// manifest positions. manifest[i]'s geometry is row i-1 of
					// Continents+Countries.txt, which has 224 rows to the manifest's 225
					// records because the world itself (index 0) has no outline. So a child
					// at manifest index 220 needs row 219; using row 220 runs off the end and
					// the load throws. Verified against all 225 records: row[i-1] matches
					// 224, row[i] matches none
					// (tools/harness/verify-plane-offset.cjs).
					else if(txtLoaded.Id !== undefined && txtLoaded.TxtData !== undefined
					&& (globEl.Element.CountryCode_Child === ''
						? txtLoaded.CC === ''
						: globEl.Element.CountryCode_Child === txtLoaded.CC))
					{
						let childrenLoaded = [];
						start = now();
						const isWorldPlane = parseInt(globEl.Element.AdminLevel_Child) < 2;
						const plane = isWorldPlane ? globalJson : jsonCountry;
						const rowOffset = isWorldPlane ? 1 : 0;
						const indexes = childrenElements.map(el => el.Index);
						addToDocumentFragment(globEl, txtLoaded.TxtData, indexes,
							item => plane[item],
							i => txtLoaded.TxtData[indexes[i] - rowOffset]);
						// A is the only caller whose progress denominator counts "newly
						// created this pass", so it passes a throwaway counter. See
						// registerChildren for why that asymmetry is preserved.
						registerChildren(globEl, childrenElements,
							(g, child, i) => txtLoaded.TxtData[indexes[i] - rowOffset],
							{ loadedList: childrenLoaded, counter: [], guardMissingGeometry: true });
						// The world/continent plane DID refresh the pin list because it
						// always went through the live path, which calls loadPins. Now that
						// this branch can serve it, the call has to happen here too or
						// clicking a continent would silently stop loading its pins. This is
						// the F3 asymmetry made real: the cached branch has never called
						// loadPins, and at level 2+ it gets away with it only because the
						// two countries that have pins are both split and take path C.
						if(isWorldPlane)
							loadPins(globEl);
						return;
					}
					else
					{
						let childrenImported = [];
						let fileToLoad = (parseInt(globEl.Element.AdminLevel_Child) < 2) ? `${txt1}${txt2}${txt3}`
						: `${txt1+countryCode}/${countryCode}${txt3}`;

						// Split countries fetch only the files holding the children being drawn.
						// If there is no geom/ folder this calls loadSplitGeometry's fallback,
						// which is the original single-.txt path, unchanged.
						function loadLegacyWholeCountryFile()
						{
						start = now();
						// Geometry is gzipped in the published copy and plain in the
						// workbench; fetchGeometryText asks for the .gz and falls back.
						fetchGeometryText(fileToLoad)
						.then(text =>
						{
							end = now();
							printStats(`Finished loading txt for ${globEl.Element.Name_Child}!`);
							start = now();
							let parsedData = Papa.parse(text, { delimiter: ':' });
							// Retain the row set for the world/continent plane too.
							//
							// This used to run only when AdminLevel_Child === 2, so every
							// Planet and Continent click re-downloaded and re-parsed the whole
							// 8,027,755-byte Continents+Countries.txt - measured at 30.62 MB for
							// four clicks, and a 7-9 ms re-parse even on an immediate re-entry of
							// the continent already open. The file is IDENTICAL every time: both
							// the world and every continent draw from it, with their children
							// resolved from the manifest.
							//
							// CC stays '' at level 0/1 - those records have no country code - and
							// that is what lets the cached branch's guard match them, since it
							// compares jsonLoaded.CC with CountryCode_Child and both are ''.
							[txtLoaded.CC, txtLoaded.Id, txtLoaded.Name, txtLoaded.TxtData] =
								[globEl.Element.CountryCode_Child, globEl.Element.Id, globEl.Element.Name_Child, parsedData.data];
							if(parseInt(globEl.Element.AdminLevel_Child) === 2)
								[jsonLoaded.CC, jsonLoaded.Id, jsonLoaded.JsonData, jsonLoaded.Name] = [txtLoaded.CC, txtLoaded.Id, jsonCountry, txtLoaded.Name];
							const indexes = childrenElements.map(el => el.Index);
							// B keeps the level<2 offset that A must not have, and is the
							// only caller that runs the world z-order block and refreshes the
							// pin list. No counter: B counts children PROCESSED, so
							// registerChildren's internal counter drives the bar.
							const planeOffset = + (parseInt(globEl.Element.AdminLevel_Child) < 2);
							addToDocumentFragment(globEl, parsedData.data, indexes,
								item => (planeOffset ? globalJson : jsonCountry)[item],
								i => parsedData.data[indexes[i] - planeOffset]);
							registerChildren(globEl, childrenElements,
								(g, child, i) => parsedData.data[indexes[i] - planeOffset],
								{ loadedList: childrenImported, worldZOrder: true, loadPins: true,
								  guardMissingGeometry: true });
							return;
						})
						.catch(error => console.error(error));
						}

						// Now decide which path to take. loadSplitGeometry fetches the
						// geom/index.json asynchronously, so it is handed this fallback to
						// run itself when the country has no geom/ folder. Countries under
						// 4 MB were never split, so most countries take the fallback.
						loadSplitGeometry(globEl, loadLegacyWholeCountryFile);
						return;
					}
					break;
				default:
					console.log(`${JSON.stringify(element)}`);
			}
			
		}
			
		/**
		 * Hide a path by clearing its `d`.
		 *
		 * MEASURED HOT SPOT. Clicking an already-loaded bottom element (Planet > Europe
		 * > UK > Northern Ireland > Broughderg > Broughderg) blocked for ~17.5 s, and a
		 * Chrome profile put essentially all of it here: the call tree was
		 * `applyEvList -> hidePath -> $(path).attr -> access -> setAttribute`, sampled
		 * thousands of times, with ZERO Layout and ZERO Recalculate Style.
		 *
		 * Two things were wrong, and both are fixed by not using jQuery:
		 *
		 *   1. `$(path).attr('d', '')` allocates a jQuery object and runs the whole
		 *      `attr` access pipeline (get/set dispatch, hooks, camelCase mapping) to
		 *      perform a single `setAttribute`. Over the loops in applyEvList, which
		 *      scan `global` - 21,568 records for GB - that overhead dominates.
		 *
		 *   2. It is IDEMPOTENT. applyEvList hides every sibling and descendant on each
		 *      click, so most of those writes set `d` to `''` when it is ALREADY `''`.
		 *      A read-then-skip guard turns those into a compare.
		 *
		 * Setting the attribute directly is equivalent - `d` is a plain SVG attribute
		 * with no jQuery normalisation involved - and the guard makes the repeated
		 * calls in those loops nearly free.
		 */
		/**
		 * Read an element's `d` without throwing on a missing path.
		 *
		 * WHY THIS EXISTS. The reads in applyEvList's `global.filter(...)` predicates were
		 * `$(el.Path).attr('d')`, and jQuery's rule is that `$(anything)` never throws:
		 * `$(null)` is an EMPTY COLLECTION, so `.attr('d')` on it returns undefined. That
		 * leniency is load-bearing. In the F8 latent case (a bucket with a missing row)
		 * path C reaches addEvListener with a NULL element, and the original code
		 * survived it: `$(null).attr('d')` yielded undefined, `undefined !== ''` was
		 * true, and hidePath's own guard then no-opped. A bare `el.Path.getAttribute`
		 * throws `Cannot read properties of null` instead, which the harness caught as a
		 * regression the moment the reads were converted.
		 *
		 * So the null tolerance is preserved here rather than at each call site. It
		 * returns undefined for a missing element and null for a missing attribute -
		 * both falsy, and the call sites only ever compare against '' - which makes it
		 * exactly equivalent to the jQuery read while doing no allocation.
		 */
		function dAttr(el)
		{
			return (el === undefined || el === null) ? undefined : el.getAttribute('d');
		}

		function hidePath(path)
		{
			if(path === undefined || path === null)
				return;
			if(path.getAttribute('d') === '')
				return;
			path.setAttribute('d', '');
		}

		function showPath(path, value)
		{
			if(path === undefined || path === null)
				return;
			// Written to match the browser, where an element that has never had a `d`
			// reports `null` from getAttribute. A `null` argument would mean "remove the
			// attribute", which is not what any caller here means, so it is ignored
			// rather than silently emptying the path.
			if(value === undefined || value === null)
				return;
			if(path.getAttribute('d') === value)
				return;
			path.setAttribute('d', value);
		}
		
		function addEvListener(element, index)
		{
			let globEl = global.at(-1);
			
			globEl.Path.addEventListener('click', el =>
			{
				function svgPoint(element, x, y)
				{
					var pt = $map.children()[0].createSVGPoint();
					pt.x = x;
					pt.y = y;
					return pt.matrixTransform(element.getScreenCTM().inverse());
				}

				var t = el.target;
				var x = el.clientX;
				var y = el.clientY;
				var target = $map.children()[0];
				var svgP = svgPoint(target, x, y);
				
				//console.log("The Pixel clicked was: " + svgP.x + ", " + svgP.y);
				
				if(loader)
					return;
				if(parseInt(globEl.Element.AdminLevel_Child) === 0)
					$('#reset').show();
				$('#span').show();
				let CC = findCountryCode(globEl);
				countryCode = (CC !== '') ? CC : 'undefined';
				if(parseInt(globEl.Element.AdminLevel_Child) <= 1)
				{
					childrenElements = globEl.Element.ChildrenIndexes.split(", ").map(el => globalJson[el]);
					showLoader();
					applyEvList(globEl, globEl.Path);
				}
				else
				{	
					
					if(emptyCountries.find(elem => elem === globEl.Element.CountryCode_Child) === undefined && globEl.Element.CountryCode_Child !== "")
					{
						// The cache record is created at :43 with the field `CC` and filled in at
						// :614 as `CC` — this guard was reading `CountryCode_Child`, which never
						// exists on it, so the test was always false and this whole branch was
						// dead code: every re-entry re-downloaded and re-parsed the country.
						//
						// It is safe to enable now, and this was NOT true before the data fixes:
						// the branch below indexes the country file directly (jsonCountry[el] and
						// data[el], with no offset), which is only correct because level 2+ uses a
						// single index plane. That has been verified exhaustively — 3,156
						// ChildrenIndexes/child pairs and 690,082 records, all exact — and this
						// branch was shown to produce identical paths and geometry to the live
						// branch across all 1,334 parent elements that can reach it.
						if(jsonLoaded.Id !== undefined && String(jsonLoaded.CC) === String(globEl.Element.CountryCode_Child))
						{
							// WHICH PLANE - the world/continent records index the MANIFEST,
							// level 2+ index the country file. This branch originally assumed
							// jsonCountry always, which is empty at level 0/1, so the plane is
							// selected here. See DATA-FORMAT.md section 3.1.
							const isWorldPlane = parseInt(globEl.Element.AdminLevel_Child) < 2;
							const plane = isWorldPlane ? globalJson : jsonCountry;
							if(parseInt(globEl.Element.AdminLevel_Child) === 2)
							{
								global.filter(el => parseInt(el.Element.AdminLevel_Child) < 3
								&& el.Element.Id_Child !== globEl.Element.Id_Child
								&& dAttr(el.Path) !== '').forEach(elem => hidePath(elem.Path))
							}
							// The guard means "this parent's paths are not registered yet", not
							// "this parent's own record is in `loaded`". Testing the parent was
							// wrong: the world's bulk push over the manifest adds EVERY record,
							// continents included, so by the time a continent was clicked its own
							// id was already in `loaded` and the push was skipped - leaving the
							// continent with no paths registered at all. Measured: Europe drew
							// 0 of its 69 countries. Test the children instead.
							const childrenRegistered = childrenElements.length > 0
								&& binarySearchGlobal(global, childrenElements[0].Id) !== -1;
							if(!childrenRegistered)
							{
								// ------------------------------------------------------------------
								// WHY A SET, AND WHY IT IS NOT JUST AN OPTIMISATION
								//
								// This loop used to test membership with a linear scan PER ELEMENT:
								//
								//     if(path !== undefined && global.find(el => el.Element.Id_Child === path.id) === undefined)
								//         global.push(...);
								//
								// `global` is the accumulated hierarchy - 21,568 records for GB - so
								// that is O(plane x global) on EVERY click, and because the push
								// grows `global` inside the loop it is genuinely quadratic: roughly
								// 4.6e8 comparisons for GB. A Chrome profile measured 13.5 s here
								// (75.7% of the click), attributed to the anonymous callback at this
								// forEach, with `applyEvList` itself only 0.5 ms.
								//
								// A Set of the ids already present gives the same answer in O(1) per
								// element. It is built ONCE from the array BEFORE the loop, and the
								// loop then adds each id to it as it pushes - so the set always
								// reflects what is in `global` at that moment, exactly as the linear
								// scan did.
								//
								// The very first version of this fix added only `registered.add()`
								// on push and forgot to seed the set from the existing contents,
								// which would have re-pushed every element already present. The
								// seed below is the part that makes it equivalent.
								// ------------------------------------------------------------------
								const registered = new Set();
								for(let i = 0; i < global.length; i++)
								{
									const cur = global[i];
									if(cur !== null && cur !== undefined && cur.Element !== undefined)
										registered.add(cur.Element.Id_Child);
								}
								// ==============================================================
								// Index pathsAsValues by id rather than scanning it per row - see
								// the long note below. Measured with a temporary probe: the
								// per-row scan was 21,568 x 6,022 ~ 1.3e8 comparisons per click,
								// 16,220 ms; this Map takes 4-8 ms.
								// ==============================================================
								const pathById = new Map();
								for(let i = 0; i < pathsAsValues.length; i++)
								{
									const pp = pathsAsValues[i];
									if(pp !== null && pp !== undefined && pp.id !== undefined)
										pathById.set(pp.id, pp);
								}
								plane.forEach((element, index) => 
								{	
									const path = pathById.get(element.Id_Child);
									if(path !== undefined && !registered.has(path.id))
									{
										global.push({ Element: element, Index: index, Path: path, D: dAttr(path), Parents: undefined, Children: []});
										registered.add(path.id);
									}
								});
								global = global.sort((a,b) =>  a.Element.Id-b.Element.Id);
							}
							childrenElements = (globEl.Element.ChildrenIndexes !== "") ? globEl.Element.ChildrenIndexes.split(", ").map(el => plane[el]) : "";
							if(childrenElements.length > 0)
								showLoader();
							applyEvList(globEl, globEl.Path);
							return 0;
						}
						else
						{
							$.getJSON(`${txt1}${countryCode}/${countryCode}${txt4}`, function($jsonCountry)
							{
								if(parseInt(globEl.Element.AdminLevel_Child) === 2)
								{
									global.filter(el => parseInt(el.Element.AdminLevel_Child) < 3
									&& el.Element.Id_Child !== globEl.Element.Id_Child
									&& dAttr(el.Path) !== '').forEach(elem => hidePath(elem.Path))
								}
								jsonCountry = $jsonCountry;
								
								if(binarySearch(loaded, globEl.Element.Id) === -1)
								{
									// Same quadratic membership test as the cached branch above -
									// a linear `global.find` per element, with `global` growing
									// inside the loop. Set-seeded once, then maintained on push.
									const registered = new Set();
									for(let i = 0; i < global.length; i++)
									{
										const cur = global[i];
										if(cur !== null && cur !== undefined && cur.Element !== undefined)
											registered.add(cur.Element.Id_Child);
									}
									// Same id->path index as the cached branch (see the note
									// there): the per-row linear scan of pathsAsValues was
									// the quadratic half of this loop.
									const pathById = new Map();
									for(let i = 0; i < pathsAsValues.length; i++)
									{
										const pp = pathsAsValues[i];
										if(pp !== null && pp !== undefined && pp.id !== undefined)
											pathById.set(pp.id, pp);
									}
									jsonCountry.forEach((element, index) => 
									{	
										const path = pathById.get(element.Id_Child);
										if(path !== undefined && !registered.has(path.id))
										{
											global.push({ Element: element, Index: index, Path: path, D: dAttr(path), Parents: undefined, Children: []});
											registered.add(path.id);
											global = global.sort((a,b) =>  a.Element.Id-b.Element.Id);
										}
									});
								}
								childrenElements = (globEl.Element.ChildrenIndexes !== "") ? globEl.Element.ChildrenIndexes.split(", ").map(el => jsonCountry[el]) : "";
								if(childrenElements.length > 0)
									showLoader();
								applyEvList(globEl, globEl.Path);
								return 0;
							})
							.always(function()
							{
								span.innerHTML = globEl.Element.Name_Child;
							});
						}
					}
					else
						span.innerHTML = globEl.Element.Name_Child;
				}
				
			});
		}
		
		/**
		 * Styles a path for an element. Throws a useful message rather than a bare
		 * "Cannot read properties of undefined" if it is handed nothing - this call
		 * site was reporting exactly that with no clue which argument was at fault.
		 */
		function applyStyle(element, path)
		{
			if(element === undefined || element === null || element.AdminLevel_Child === undefined)
				throw new Error(`applyStyle: element is ${element === null ? 'null' : typeof element} `
					+ `(AdminLevel_Child=${element ? element.AdminLevel_Child : 'n/a'}); `
					+ `path is ${path === undefined ? 'undefined' : typeof path}; `
					+ `countryCode=${countryCode}; chain=${clicked.map(c => c.Element.Id_Child).join(' > ')}`);
			if(path === undefined || path === null)
				throw new Error(`applyStyle: path is ${path === null ? 'null' : typeof path} for ${element.Id_Child} (${element.Name_Child})`);
			// A path that exists but has no classList is not an SVGElement - it is a
			// jQuery object, a collection, or something else passed by mistake. Name it
			// rather than letting classList.add fail further down with no context.
			if(path.classList === undefined)
				throw new Error(`applyStyle: path for ${element.Id_Child} (${element.Name_Child}) has no classList`
					+ ` (constructor ${path.constructor ? path.constructor.name : '?'},`
					+ ` isJQuery ${typeof jQuery !== 'undefined' && path instanceof jQuery},`
					+ ` length ${path.length}, tagName ${path.tagName})`
					+ `; countryCode=${countryCode}; chain=${clicked.map(c => c.Element.Id_Child).join(' > ')}`);
			if(parseInt(element.AdminLevel_Child) === 2 && smallC.find(elem => elem === element.CountryCode_Child) !== undefined)
				path.classList.add('style-8');
			else if(parseInt(element.AdminLevel_Child) >= 4)
			{
				switch(countryCode)
				{
					case 'PT':
						diffCCode = false;
						switch(element.AdminLevel_Child)
						{
							case '4':
							case '6':
								path.classList.add('style-4');
								break;
							case '7':
								path.classList.add('style-6');
								break;
							case '8':
								path.classList.add('style-7');
								break;
							case '10':
								path.classList.add('style-8');
								break;
							default:
								path.classList.add('style-8');
						}
						break;
					case 'AD':
					case 'GI':
					case 'LI':
					case 'MC':
					case 'SM':
						diffCCode = false;
						path.classList.add('style-8');
						break;
					case 'FR':
						if(element.CountryCode_Child === 'GF' || element.CountryCode_Parent === 'NC' || diffCCode)
						{
							if(!diffCCode)
								diffCCode = true;
							path.classList.add('style-5');
						}
						else
						{
							diffCCode = false;
							path.classList.add(`style-${element.AdminLevel_Child}`);
						}
						break;
					default:
						diffCCode = false;
						path.classList.add(`style-${element.AdminLevel_Child}`);
				}
			}
			else
			{
				diffCCode = false;
				path.classList.add(`style-${element.AdminLevel_Child}`);
			}
			return path;
		}
		
		function lerp(start, end, t) {
		  return start * (1 - t) + end * t;
		}

		function animateZoom(svg, startViewBox, endViewBox, duration) {
		  const startTime = performance.now();

		  function step(timestamp) {
			const elapsed = timestamp - startTime;
			const progress = Math.min(elapsed / duration, 1);
			const currentViewBox = startViewBox.map((val, i) => lerp(val, endViewBox[i], progress));

			svg.children[0].setAttribute('viewBox', currentViewBox.join(' '));

			if (progress < 1) {
			  requestAnimationFrame(step);
			}
		  }

		  requestAnimationFrame(step);
		}

		function zoomOnElement(e, svg)
		{
			zooming = true;
			$("#reset" ).prop("disabled", true);
			$("#back" ).prop("disabled", true);
			let boundingRect;
			if(e.classList !== undefined && e.classList.length > 0 && e.classList.contains('pin'))
			{
				boundingRect = e.getBBox();
				$("#reset" ).prop("disabled", false);
				$("#back" ).prop("disabled", false);
				zooming = false;
				let viewBox = `${boundingRect.x*0.9999875} ${boundingRect.y*0.999975} ${boundingRect.width*3.33} ${boundingRect.height*3.33}`
				svg.children[0].setAttribute(`viewBox`, viewBox);
			}
			else
			{
				boundingRect = e.Path.getBBox();
				if(parseInt(e.Element.AdminLevel_Child) > 1)
				{
					$("#reset" ).prop("disabled", false);
					$("#back" ).prop("disabled", false);
					zooming = false;
					let viewBox = `${boundingRect.x*resizeVar} ${boundingRect.y*resizeVar*0.99998375} ${boundingRect.width*1.08*resizeVar} ${boundingRect.height*1.18*resizeVar}`
					svg.children[0].setAttribute(`viewBox`, viewBox);
				}
				else
				{
					svg.children[0].setAttribute(`viewBox`, `0 0 ${mapWidth} ${mapHeight}`);
					$("#reset" ).prop("disabled", false);
					$("#back" ).prop("disabled", false);
					zooming = false;
				}
			}
			
		}

		function resetZoom(svg)
		{
			$(container).text('');
			clicked = [];
			pinClicked = false
			let pinsToHide = loadedPins.filter(el => dAttr(el.Path) !== '');
			pinsToHide.forEach((pinToHide) => 
			{
				$(pinToHide.Path).hide();
				$(pinToHide.Img).hide();
			});
			loadedPins = [];
			$('#back').hide();
			jsonLoaded = {CC: '', Id: undefined, jsonData: undefined, Name: ''};
			txtLoaded = {CC: '', Id: undefined, Name: '', TxtData: undefined};
			// Release the split-path geometry as well. Reset returns to the world view,
			// so nothing loaded here is still on screen.
			loadedBuckets = {};
			let elsToRemove = global.filter(el2 => parseInt(el2.Element.AdminLevel_Child) > 0 && dAttr(el2.Path) !== '');
			elsToRemove.forEach((elToRemove) => { hidePath(elToRemove.Path); });
			if(elsToRemove.length > 0)
			{
				showPath(global[0].Path, global[0].D);
				svg.children[0].setAttribute(`viewBox`, `0 0 ${mapWidth} ${mapHeight}`);
				$('#reset').hide();
				$('#span').hide();
			}
		}
		
		function printStats(msg)
		{
			if(msg)
				console.log(msg);
			console.log("Time:", (end-start || "(Unknown; your browser does not support the Performance API)"), "ms");
		}

		$('#reset').on('click', function()
		{
			hideLoader();
			resetZoom($map[0]);
		});

		/**
		 * Rebuild the "Highlights" menu from the current parish, keeping only pins the
		 * picture filter allows. Called when the hide/show box changes; the menu is
		 * built filtered when a parish is entered as well.
		 */
		function refreshPinHighlightOptions()
		{
			let containerEl = $('#container')[0];
			let sel = containerEl ? containerEl.querySelector('select') : null;
			if(sel === null)
				return;
			sel.options.length = 0;
			let optionAux = document.createElement("option");
			optionAux.value = null;
			optionAux.text = "Please choose an option:";
			sel.appendChild(optionAux);
			orderPins(pinsForCurrentRegion()).filter(pinIsVisible).forEach(pin =>
			{
				let opt = document.createElement("option");
				opt.value = pin.Id;
				opt.text = pin.Name;
				sel.appendChild(opt);
			});
			sel.selectedIndex = 0;
		}

		/** Apply both pin filters to the current parish and rebuild the Highlights menu. */
		function applyPinFilters()
		{
			pinClicked = false;
			let current = clicked.at(-1);
			if(current !== undefined)
				span.innerHTML = current.Element.Name_Child;
			loadedPins.filter(pin => current !== undefined && pin.Element_Id === current.Element.Id).forEach(pin =>
			{
				if(pin.Path === undefined)
					return;
				if(pinIsVisible(pin))
				{
					$(pin.Path).show();
					$(pin.Img).show();
				}
				else
				{
					$(pin.Path).hide();
					$(pin.Img).hide();
				}
			});
			refreshPinHighlightOptions();
		}

		$('#hide-no-image').prop('checked', hidePinsWithoutImages);
		$('#hide-no-image').on('change', function()
		{
			hidePinsWithoutImages = this.checked;
			try { window.localStorage.setItem(HIDE_NO_IMAGE_KEY, hidePinsWithoutImages ? '1' : '0'); }
			catch (e) { /* storage can be blocked; the toggle still works this session */ }
			// The opposite view cannot be on at the same time.
			if(hidePinsWithoutImages && onlyPinsWithoutImages)
			{
				onlyPinsWithoutImages = false;
				$('#only-no-image').prop('checked', false);
				try { window.localStorage.setItem(ONLY_NO_IMAGE_KEY, '0'); }
				catch (e) { /* storage can be blocked; the toggle still works this session */ }
			}
			applyPinFilters();
		});

		$('#only-no-image').prop('checked', onlyPinsWithoutImages);
		$('#only-no-image').on('change', function()
		{
			onlyPinsWithoutImages = this.checked;
			try { window.localStorage.setItem(ONLY_NO_IMAGE_KEY, onlyPinsWithoutImages ? '1' : '0'); }
			catch (e) { /* storage can be blocked; the toggle still works this session */ }
			if(onlyPinsWithoutImages && hidePinsWithoutImages)
			{
				hidePinsWithoutImages = false;
				$('#hide-no-image').prop('checked', false);
				try { window.localStorage.setItem(HIDE_NO_IMAGE_KEY, '0'); }
				catch (e) { /* storage can be blocked; the toggle still works this session */ }
			}
			applyPinFilters();
		});

		$('#highlights-only').prop('checked', highlightsOnly);
		$('#highlights-only').on('change', function()
		{
			highlightsOnly = this.checked;
			try { window.localStorage.setItem(HIGHLIGHTS_ONLY_KEY, highlightsOnly ? '1' : '0'); }
			catch (e) { /* storage can be blocked; the toggle still works this session */ }
			applyPinFilters();
		});

		/**
		 * GPS marker — the "you are here" dot (c1), and the nearest pin (c2).
		 *
		 * The dot, the accuracy circle and the parish answer all live in the app's own
		 * frame: the SVG's viewBox units, the latitude/longitude → X/Y fit of
		 * gps-frame.js, and the parish outlines the app itself draws. That matters more
		 * than it sounds — OSM's current boundary sits tens of metres away from the
		 * stored outline (benchmark-boundary.mjs), so a fresh download would answer a
		 * different question than the map on screen.
		 *
		 * The position never leaves the browser: no request carries it, and the only
		 * network traffic is the parish data (hierarchy, index, geometry buckets), which
		 * is public and cached after the first Locate.
		 *
		 * The view is moved by dispatching the same clicks a user would make
		 * (world → continent → country → … → parish), not by setting a viewBox: the app
		 * owns the zoom, the pin list, the Highlights menu and Back, and a hand-made
		 * zoom would leave all four behind. Each click is on an SVG path the app already
		 * registered, so the normal handlers do the work.
		 *
		 * Locate works on a secure context only (Pages over https, or 127.0.0.1): that
		 * is a browser rule, not a choice here.
		 */
		const GPS_FOLLOW_KEY = 'mappu.gpsFollow';
		// The frame is fitted to Portuguese pins, so the parish lookup is PT-only. A
		// country without pins would need its own fit and its own mapped-parish set.
		const GPS_COUNTRY = 'PT';
		// The dot's radius, in viewBox units: ≈ 65 ground metres at this latitude,
		// a quarter of a pin's 0.2575 width, about 4 screen px at parish zoom.
		const GPS_DOT_R = 0.1;
		// The pin record stores the image's top-left corner; the ground point is the
		// teardrop's tip, a constant offset on the shared template `D`. Measured over
		// every pin (0.122–0.135 × 0.416–0.445), so the nearest-pin distance carries
		// ~10 m of slack, which is well inside the frame's own 12 m median residual.
		const PIN_TIP_DX = 0.130, PIN_TIP_DY = 0.434;

		let gpsFollow = false;
		try { gpsFollow = window.localStorage.getItem(GPS_FOLLOW_KEY) === '1'; }
		catch (e) { /* storage can be blocked; keep the default */ }
		let gpsWatch = null;       // the geolocation watch, once started
		let gpsFix = null;         // the newest { lat, lon, accuracy }
		let gpsMarker = null;      // { group, halo, dot } in the SVG document
		let gpsNavigating = false; // the click chain is running
		let gpsForceNext = false;  // the next fix should move the view (a Locate press)
		let gpsParishId = '';     // the parish the view was last sent to
		let gpsParishes = null;    // promise of the parish index, fetched once

		/**
		 * The status area: one line of text, and an optional second line under it.
		 *
		 * The nearest pin is the second line so a long pin name never pushes the parish
		 * label off the row. Every other caller passes text only, which clears the
		 * second line — otherwise "Locating…" or an error would sit above a stale pin.
		 */
		function gpsStatus(text, nearest)
		{
			$('#gps-status').text(text);
			$('#gps-nearest').text(nearest === undefined || nearest === null ? '' : nearest);
		}

		function gpsFollowLabel()
		{
			$('#gps-follow').text(gpsFollow ? 'Follow: on' : 'Follow: off')
				.attr('aria-pressed', gpsFollow ? 'true' : 'false');
		}

		/** Polls an app state the click path only reaches asynchronously. */
		function gpsWaitFor(test, what, timeout)
		{
			const limit = timeout === undefined ? 20000 : timeout;
			return new Promise((resolve, reject) =>
			{
				const started = now();
				function probe()
				{
					let ready = false;
					try { ready = test(); }
					catch (e) { ready = false; }
					if (ready)
					{
						resolve();
						return;
					}
					if (now() - started > limit)
					{
						reject(new Error(`timed out waiting for ${what}`));
						return;
					}
					window.setTimeout(probe, 100);
				}
				probe();
			});
		}

		/**
		 * Resolves when the app is idle: the loader has been hidden *and* the app's own
		 * `loader` flag is false (the click handler checks the flag, not the element),
		 * for a moment, so a click is not dispatched into a load that is still settling.
		 * Some loads only reveal the loader one round trip after the click, hence the
		 * quiet window rather than a poll.
		 */
		function gpsIdle()
		{
			return new Promise(resolve =>
			{
				const started = now();
				let quietSince = null;
				let warned = false;
				function probe()
				{
					if (loader === false && $('#loader').is(':hidden'))
					{
						if (quietSince === null)
							quietSince = now();
						if (now() - quietSince > 300)
						{
							resolve();
							return;
						}
					}
					else
						quietSince = null;
					// A load that never ends must not hang the navigation silently.
					if (!warned && now() - started > 45000)
					{
						warned = true;
						console.warn('[gps] the map has looked busy for 45 s; clicking anyway');
					}
					window.setTimeout(probe, 100);
				}
				probe();
			});
		}

		function gpsPath(id)
		{
			return $map[0].getElementById(id);
		}

		function gpsClickPath(id)
		{
			const path = gpsPath(id);
			if (path === null)
				throw new Error(`no SVG path for ${id}`);
			const view = $map[0].defaultView;
			path.dispatchEvent(new view.MouseEvent('click', { bubbles: true, cancelable: true, view }));
		}

		/**
		 * One step of the normal click path: click, wait for the app to have opened that
		 * element (`clicked` ends with it, which happens on the loader-free and the
		 * loaded branches alike), then waiting for its child to be drawn.
		 *
		 * A step is retried once: a click can be swallowed by a load that was still
		 * settling even after gpsIdle, and the retry is what makes a second Locate on a
		 * cold tab reliable.
		 */
		async function gpsClickStep(id, nextId)
		{
			const attempt = async () =>
			{
				await gpsIdle();
				// The path must exist (it need not be visible: a hidden ancestor is
				// still a click target — the handler, not the paint, does the work).
				await gpsWaitFor(() => gpsPath(id) !== null, `the map to have ${id}`);
				const path = gpsPath(id);
				console.log(`[gps] click ${id}${nextId === undefined ? '' : ' for ' + nextId}`
					+ ` (path ${path === null ? 'missing' : path.getAttribute('d') === '' ? 'hidden' : 'drawn'},`
					+ ` loader=${loader}, clicked=${clicked.length ? clicked.map(el => el.Element.Id_Child).join(' > ') : '-'})`);
				gpsClickPath(id);
				try
				{
					await gpsWaitFor(() => clicked.length > 0
						&& clicked[clicked.length - 1].Element.Id_Child === id,
						`the map to open ${id}`, 15000);
				}
				catch (error)
				{
					console.warn(`[gps] the click on ${id} did not open it; clicked=${clicked.length ? clicked.map(el => el.Element.Id_Child).join(' > ') : '-'}`);
					throw error;
				}
				if (nextId === undefined)
					return;
				await gpsWaitFor(() =>
				{
					const pathNext = gpsPath(nextId);
					return pathNext !== null && (pathNext.getAttribute('d') || '') !== '';
				}, `the map to draw ${nextId}`);
			};
			try { await attempt(); }
			catch (error) { await attempt(); }
		}

		/**
		 * The parishes the position is tested against: the mapped region, meaning the
		 * parishes that have pins. It is the area the frame was fitted to, and their
		 * outlines are 3 of PT's ~56 geometry buckets rather than the whole country.
		 *
		 * Fetched once per page: PT.json (names and the parent chain), the geometry
		 * index, and Pins.json (which parishes are mapped). The app fetches PT.json and
		 * Pins.json itself when the country is opened, so the browser serves them from
		 * its cache the second time.
		 */
		function loadGpsParishes()
		{
			if (gpsParishes !== null)
				return gpsParishes;
			gpsParishes = Promise.all([
				fetch(`${txt1}${GPS_COUNTRY}/${GPS_COUNTRY}${txt4}`).then(response => response.json()),
				fetch(`${txt1}${GPS_COUNTRY}/geom/index.json`).then(response => response.json()),
				fetch(`${txt1}${GPS_COUNTRY}${txt8}${txt4}`).then(response => response.json()),
			]).then(([country, index, pins]) =>
			{
				const byId = new Map(country.map(record => [record.Id_Child, record]));
				const mapped = [...new Set(pins.map(pin => `relation/${pin.Element_Id}`))];
				const buckets = [...new Set(mapped
					.map(id => index.elements[id])
					.filter(name => name !== undefined))];
				return Promise.all(buckets.map(name =>
					fetchGeometryText(`${txt1}${GPS_COUNTRY}/geom/${name}`)
				)).then(texts =>
				{
					const geometry = new Map();
					for (const text of texts)
					{
						for (const line of text.split('\n'))
						{
							const cut = line.lastIndexOf(':');
							if (cut <= 0)
								continue;
							geometry.set(line.slice(cut + 1).trim(), line.slice(0, cut));
						}
					}
					const parishes = [];
					for (const id of mapped)
					{
						const record = byId.get(id);
						const d = geometry.get(id.slice('relation/'.length));
						if (record === undefined || d === undefined)
							continue;
						const rings = ringsOfPath(d, resizeVar);
						// Bounding-box area, only to break an overlap in favour of the
						// more specific outline; a loop rather than Math.max(...) because
						// a detailed parish can carry thousands of vertices.
						let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
						for (const ring of rings)
						{
							for (const [x, y] of ring)
							{
								if (x < minX) minX = x;
								if (x > maxX) maxX = x;
								if (y < minY) minY = y;
								if (y > maxY) maxY = y;
							}
						}
						parishes.push({ id, name: record.Name_Child, record, rings, area: (maxX - minX) * (maxY - minY) });
					}
					console.log(`[gps] ${parishes.length} mapped parishes from ${buckets.length} geometry buckets`);
					return { byId, parishes };
				});
			}).catch(error =>
			{
				// A failed lookup must be retryable: forget the promise, report once.
				gpsParishes = null;
				throw error;
			});
			return gpsParishes;
		}

		/** The mapped parish containing { x, y }, or null. Overlaps: the smaller wins. */
		async function gpsParishAt(x, y)
		{
			const data = await loadGpsParishes();
			let found = null;
			for (const parish of data.parishes)
			{
				if (!pointInRings(x, y, parish.rings))
					continue;
				if (found === null || parish.area < found.area)
					found = parish;
			}
			return found;
		}

		/**
		 * Move the view to a parish along the normal click path.
		 *
		 * Only the steps the app does not already have open are clicked, so going to a
		 * sibling parish is one click rather than a trip back to the world. The parish
		 * click needs its pins in memory first: its handler lists them synchronously and
		 * an empty list opens the parent instead (applyEvList's no-pins branch).
		 *
		 * The chain itself (world → continent → country → … → parish) is built by
		 * parishChain in gps-frame.js, where tools/test-gps-frame.mjs can check it: the
		 * first version of it here put the continent before the world and left the
		 * country out, which clicked Europe (a path that only exists after a world
		 * click) and stalled for the whole timeout.
		 */
		async function gpsOpenParish(parish)
		{
			console.log(`[gps] opening ${parish.name}: manifest ${Array.isArray(globalJson) ? globalJson.length : 'not loaded'},`
				+ ` clicked ${clicked.length}, world path ${gpsPath('relation/3') === null ? 'missing' : 'present'}`);
			await gpsWaitFor(() => Array.isArray(globalJson) && globalJson.length > 0, 'the world manifest');
			const data = await loadGpsParishes();
			const chain = parishChain(parish.record, data.byId, globalJson);
			const parishNumber = parish.id.slice('relation/'.length);
			const open = clicked.map(element => element.Element.Id_Child);
			let from = 0;
			while (from < chain.length && chain[from] === open[from])
				from++;
			console.log(`[gps] ${parish.name}: chain ${chain.join(' > ')}, open ${open.length ? open.join(' > ') : '-'}, from ${from}`);

			if (from === chain.length)
			{
				const current = global.find(element => element.Element.Id_Child === parish.id);
				console.log(`[gps] the view is already at ${parish.name}; ${current === undefined ? 'but its path is not registered' : 're-centring'}`);
				if (current !== undefined)
					zoomOnElement(current, $map[0]);
				return;
			}

			for (let i = from; i < chain.length; i++)
			{
				const id = chain[i];
				const next = chain[i + 1];
				if (next === undefined)
				{
					await gpsWaitFor(
						() => loadedPins.some(pin => String(pin.Element_Id) === parishNumber),
						`the pins of ${parish.name}`);
					await gpsWaitFor(() =>
					{
						const path = gpsPath(id);
						return path !== null && (path.getAttribute('d') || '') !== '';
					}, `the outline of ${parish.name}`);
				}
				await gpsClickStep(id, next);
				if (next === undefined)
					return;
			}
		}

		/** Draw or move the marker. Re-appended so it stays above later-drawn pins. */
		function gpsDrawMarker(fix)
		{
			if (gpsMarker === null)
			{
				const doc = $map[0];
				const ns = 'http://www.w3.org/2000/svg';
				const group = doc.createElementNS(ns, 'g');
				group.setAttribute('id', 'gps-marker');
				group.setAttribute('pointer-events', 'none');
				const halo = doc.createElementNS(ns, 'circle');
				halo.setAttribute('fill', '#1a73e8');
				halo.setAttribute('fill-opacity', '0.15');
				halo.setAttribute('stroke', '#1a73e8');
				halo.setAttribute('stroke-opacity', '0.5');
				halo.setAttribute('stroke-width', '0.01');
				const dot = doc.createElementNS(ns, 'circle');
				dot.setAttribute('fill', '#1a73e8');
				dot.setAttribute('stroke', '#ffffff');
				dot.setAttribute('stroke-width', '0.02');
				group.appendChild(halo);
				group.appendChild(dot);
				htmlPaths.appendChild(group);
				gpsMarker = { group, halo, dot };
			}
			const { x, y } = lonLatToXY(fix.lon, fix.lat);
			// A circle smaller than the dot could not be read; below that the accuracy
			// is simply "the dot", which is what a map dot means at this zoom anyway.
			const haloR = Math.max(GPS_DOT_R, accuracyRadius(fix.accuracy, fix.lat));
			const { dot, halo, group } = gpsMarker;
			dot.setAttribute('cx', x);
			dot.setAttribute('cy', y);
			dot.setAttribute('r', GPS_DOT_R);
			halo.setAttribute('cx', x);
			halo.setAttribute('cy', y);
			halo.setAttribute('r', haloR);
			htmlPaths.appendChild(group);
			return { x, y };
		}

		/**
		 * The nearest pin of the parish on screen, as the two parts of the status area.
		 *
		 * Returns `{ label, name }`, or null when there is nothing to name. The label
		 * ("nearest pin:") stays on the parish's line and the pin goes on its own line
		 * below it — see gpsStatus — because a long name and a long label on one line
		 * push each other off the row on a phone.
		 *
		 * It walks the pins the filters allow, which is the pairing worth having: with
		 * "only pins without pictures" on, the answer is the nearest place still to
		 * be photographed. No pin is highlighted — the filters own visibility, and a
		 * highlight would undo the view the user chose.
		 */
		function gpsNearestText(fix, parish)
		{
			const current = clicked.length > 0 ? clicked[clicked.length - 1] : undefined;
			if (current === undefined || String(current.Element.Id) !== parish.id.slice('relation/'.length))
				return null;
			const here = lonLatToXY(fix.lon, fix.lat);
			let best = null, bestMetres = Infinity;
			for (const pin of pinsForCurrentRegion().filter(pinIsVisible))
			{
				const tip = { x: Number(pin.X) + PIN_TIP_DX, y: Number(pin.Y) + PIN_TIP_DY };
				const metres = mapDistanceMetres(here, tip, fix.lat);
				if (metres < bestMetres)
				{
					bestMetres = metres;
					best = pin;
				}
			}
			if (best === null)
				return null;
			const label = onlyPinsWithoutImages ? 'nearest pin without a picture' : 'nearest pin';
			const distance = bestMetres < 10 ? 'under 10 m' : `${Math.round(bestMetres)} m`;
			return { label, name: `${best.Name} (${distance})` };
		}

		/**
		 * Act on a fix: draw the dot, answer which parish it is in, and move the view
		 * there on the first Locate, on every Locate press, and on a parish change while
		 * Follow is on.
		 */
		async function gpsApplyFix(fix)
		{
			gpsFix = fix;
			gpsDrawMarker(fix);
			const force = gpsForceNext;
			gpsForceNext = false;
			gpsStatus('You are here — matching against the parish outlines…');
			let parish = null;
			let at = null;
			try
			{
				at = lonLatToXY(fix.lon, fix.lat);
				parish = await gpsParishAt(at.x, at.y);
			}
			catch (error)
			{
				console.error('[gps] parish lookup failed', error);
				gpsStatus('You are here, but the parish outlines could not be loaded.');
				return;
			}
			// Say WHERE the fix landed and how precise it is. There are two very
			// different reasons to be outside: the position is somewhere else in the
			// country (a desktop's network location can be a city away) or it is close
			// but the parish has no pins, and the frame is only fitted where pins exist.
			// Without the numbers neither is distinguishable.
			const where = `${fix.lat.toFixed(4)}, ${fix.lon.toFixed(4)} ±${Math.round(fix.accuracy)} m`;
			if (parish === null)
			{
				gpsParishId = '';
				console.log(`[gps] fix ${where} -> map ${at.x.toFixed(1)},${at.y.toFixed(1)}: outside the mapped parishes`);
				gpsStatus(`You are here (${where}) — outside the mapped parishes. The frame is fitted around Cascais and Sintra.`);
				return;
			}
			// One line per parish change, not per fix: a watch can deliver fixes every
			// second, and this is the line that makes a phone test readable.
			if (parish.id !== gpsParishId)
				console.log(`[gps] fix ${where} -> ${parish.name}`);
			// Name the parish the moment it is known, before the click chain runs: the
			// chain can take a second or two (the first one also loads the plane), and
			// the name is the answer that was asked for. The nearest pin is appended
			// once the view has actually moved.
			gpsStatus(parish.name);
			if (gpsNavigating)
				return;
			// The first fix opens the view, and so does every Locate press; after that
			// only Follow does, so a walk through three parishes does not yank the map
			// away three times.
			const shouldOpen = force === true
				|| (parish.id !== gpsParishId && (gpsParishId === '' || gpsFollow));
			if (shouldOpen)
			{
				gpsNavigating = true;
				try
				{
					await gpsOpenParish(parish);
					gpsParishId = parish.id;
				}
				catch (error)
				{
					console.error('[gps] could not open', parish.name, error);
					gpsStatus(`${parish.name} found, but the map could not be opened — press Locate again.`);
					return;
				}
				finally
				{
					gpsNavigating = false;
				}
			}
			const nearest = gpsNearestText(fix, parish);
			gpsStatus(nearest === null ? parish.name : `${parish.name} · ${nearest.label}:`,
				nearest === null ? '' : nearest.name);
		}

		function gpsWatchFailed(error)
		{
			const reasons = { 1: 'permission denied', 2: 'position unavailable', 3: 'timed out' };
			gpsStatus(`Location unavailable: ${reasons[error.code] || error.message || 'unknown error'}`);
			console.warn('[gps]', error);
			// Only a denied permission is permanent. A timeout or an "unavailable" is
			// often transient (the provider was restarting, e.g. after a location
			// override), and a later fix from the same watch is worth keeping: press
			// Locate again to restart it and ask for a fresh reading.
			if (gpsWatch !== null && error.code === 1)
			{
				navigator.geolocation.clearWatch(gpsWatch);
				gpsWatch = null;
			}
		}

		function gpsOnPosition(position)
		{
			gpsApplyFix({
				lat: position.coords.latitude,
				lon: position.coords.longitude,
				accuracy: position.coords.accuracy,
			});
		}

		$('#locate').on('click', function()
		{
			if (navigator.geolocation === undefined)
			{
				gpsStatus('This browser has no geolocation.');
				return;
			}
			// Browsers expose navigator.geolocation on a plain-http page and then deny
			// every request, which reads as "permission denied" when the real answer is
			// "this page is not a secure context". Say the useful thing instead.
			if (window.isSecureContext === false)
			{
				gpsStatus('Location needs a secure page: https, or localhost / 127.0.0.1. This address is plain http.');
				return;
			}
			// Locate means "where am I now", so restart the watch: maximumAge 0 asks for
			// a fresh reading, which also picks up a DevTools location override that
			// changed while the old watch was quiet. One request, not two: running
			// getCurrentPosition alongside the watch made the two race, and a transient
			// POSITION_UNAVAILABLE on either one reported "Location unavailable" while
			// the other had just delivered a perfectly good fix.
			gpsForceNext = true;
			if (gpsWatch !== null)
				navigator.geolocation.clearWatch(gpsWatch);
			gpsStatus('Locating…');
			gpsWatch = navigator.geolocation.watchPosition(gpsOnPosition, gpsWatchFailed,
				{ enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
		});

		$('#gps-follow').on('click', function()
		{
			gpsFollow = !gpsFollow;
			gpsFollowLabel();
			try { window.localStorage.setItem(GPS_FOLLOW_KEY, gpsFollow ? '1' : '0'); }
			catch (e) { /* storage can be blocked; the toggle still works this session */ }
			if (gpsFollow && gpsFix !== null && !gpsNavigating)
				gpsApplyFix(gpsFix);
		});

		gpsFollowLabel();
		if (navigator.geolocation === undefined)
			$('#locate, #gps-follow').prop('disabled', true)
				.attr('title', 'This browser has no geolocation');
		else if (window.isSecureContext === false)
			$('#locate').attr('title', 'Location needs https or localhost — this page is plain http');

		$('#back').on('click', function()
		{
			if(clicked.length > 1)
			{
				let glob = clicked.at(-1);
				$(container).text('');
				pinClicked = false
				let pinsToHide = loadedPins.filter(el => el.Element_Id === glob.Element.Id && dAttr(el.Path) !== '');
				pinsToHide.forEach((pinToHide) => 
				{
					$(pinToHide.Path).hide();
					$(pinToHide.Img).hide();
				});
				glob.Children.forEach((child, index) => { hidePath(child.Path); });
				let par = clicked.at(-2);
				par.Children.forEach((child) =>
				{
					showPath(child.Path, child.D);
				});
				if(par.Parents !== undefined && parseInt(par.Element.AdminLevel_Child) !== 2)
				{
					par.Parents.forEach((pt2) =>
					{
						pt2.Children.forEach((child2) =>
						{
							showPath(child2.Path, child2.D)
						});
					});
				}
				if(parseInt(glob.Element.AdminLevel_Child) > 1)
				{
					showPath(par.Path, par.D);
					zoomOnElement(par, a.target.contentDocument);
					hidePath(par.Path);
					span.innerHTML = par.Element.Name_Child;
				}
				else
				{
					$map[0].children[0].setAttribute(`viewBox`, `0 0 ${mapWidth} ${mapHeight}`);
					span.innerHTML = glob.Parents[0].Element.Name_Child;
				}
				clicked.splice(clicked.indexOf(glob), 1);
			}
			else
			{
				resetZoom($map[0]);
			}
		});
		
		/**
		 * Load the geometry for the children of globEl, using the split files in
		 * AuxFiles/<CC>/geom/ when they exist. Returns true if it took over the load.
		 *
		 * WHY THIS EXISTS
		 * ---------------
		 * The map used to download and parse ONE file per country containing every
		 * element at every admin level — 66.64 MB for Brazil, whatever the user was
		 * looking at. Every element is drawn exactly once, so the file never needed
		 * duplicating, only splitting. tools/build-geometry.mjs packs each element's
		 * geometry into ~128 KB files plus an index saying which file holds which
		 * element, so a click now fetches only what it is about to draw: Brazil's
		 * first view is 2.19 MB instead of 66.64 MB, and drilling deeper is about
		 * 14 KB per click rather than another whole-country download.
		 *
		 * KEYED BY RELATION ID
		 * --------------------
		 * The split files are keyed by id, so this path does no ChildrenIndexes
		 * position arithmetic at all — the fragility described in DATA-FORMAT.md
		 * section 3 simply does not apply to it. The geometry itself is byte-identical
		 * to the original; only the fetch pattern differs.
		 *
		 * Countries under 4 MB were not split, so this returns false for them and the
		 * caller falls through to the original single-file path, unchanged.
		 *
		 * The return value is synchronous on purpose: the decision "is this country
		 * split?" is settled by whether geom/index.json exists, and the caller needs
		 * that answer immediately to know which path to take.
		 */
		function loadSplitGeometry(globEl, loadFallback)
		{
			if(parseInt(globEl.Element.AdminLevel_Child) < 2)
			{
				loadFallback();
				return;
			}
			if(countryCode === '' || countryCode === 'undefined')
			{
				loadFallback();
				return;
			}

			// Which records are the children being drawn, and where their geometry
			// comes from, DEPENDS ON THE LEVEL — this is the trap that DATA-FORMAT.md
			// section 3 documents:
			//
			//   level 1 (a continent): ChildrenIndexes index the MANIFEST, and the
			//     geometry (each country's outline) is in Continents+Countries.txt
			//   level 2+ (a country):  ChildrenIndexes index the COUNTRY FILE — for
			//     Brasil they are 6990, 7499, ... against a 225-record manifest — and
			//     the geometry is in the country's own files
			//
			// childrenElements as built by the caller is correct only for level 1.
			// See Earth.js:761, which resolves level-2 children against jsonCountry.
			// Resolving them here is what makes the split path work for a country
			// click; using childrenElements directly yields undefined entries.
			let childrenToDraw = childrenElements;
			if(parseInt(globEl.Element.AdminLevel_Child) >= 2)
			{
				// Keyed by relation id, so the plane does not matter at all.
				const byId = {};
				for(let i = 0; i < jsonCountry.length; i++)
					byId[jsonCountry[i].Id_Child] = jsonCountry[i];
				childrenToDraw = (globEl.Element.Children || '').split(', ')
					.map(id => byId[id])
					.filter(el => el !== undefined);

				// Keep the whole country hierarchy addressable for findCountryCode, which
				// otherwise has to walk `global` - and `global` only ever holds elements
				// that have been drawn. An intermediate level that was skipped is absent
				// from it, which broke the walk and threw at findCountryCode's recursion.
				countryElementById = byId;
			}

			// Buckets already parsed, per country. This is the cache for the split
			// path, and it is keyed by country so switching countries can never mix
			// data. Each bucket is fetched at most once per country for the whole
			// session, so going back and re-entering costs nothing.
			if(loadedBuckets[countryCode] === undefined)
				loadedBuckets[countryCode] = { files: {}, geom: {}, index: undefined };
			const cache = loadedBuckets[countryCode];

			// The index itself is worth caching too: it is 0.9-2.1 MB for a large
			// country, and without this every re-entry re-downloaded it.
			//
			// "No geom folder" is cached as `false` for the same reason. 165 of the
			// 214 countries were never split, because they are under 4 MB, so most
			// loads used to begin by requesting a file that does not exist. The 404
			// was handled - it is how "not split" is detected - but it is a wasted
			// round trip and it fills the console with red. Remembering the answer
			// means each country asks at most once per session.
			if(cache.index === false)
			{
				loadFallback();
				return;
			}

			const indexPromise = (cache.index !== undefined)
				? Promise.resolve(cache.index)
				: fetch(`${txt1}${countryCode}/geom/index.json`)
					.then(response => response.ok ? response.json() : false);

			indexPromise
			.then(index =>
			{
				if(index === null || index === undefined || index === false || index.elements === undefined)
				{
					cache.index = false;
					loadFallback();
					return;
				}
				cache.index = index;

				// Only the buckets not already in memory, each fetched at most once.
				const files = [...new Set(
					childrenToDraw.map(el => index.elements[el.Id_Child]).filter(name => name !== undefined)
				)].filter(name => cache.files[name] === undefined);

				return Promise.all(files.map(name =>
					fetchGeometryText(`${txt1}${countryCode}/geom/${name}`)
				))
				.then(texts =>
				{
					for(let i = 0; i < files.length; i++)
					{
						cache.files[files[i]] = true;
						const bucketLines = texts[i].split('\n');
						for(let k = 0; k < bucketLines.length; k++)
						{
							if(bucketLines[k] === '')
								continue;
							const cut = bucketLines[k].lastIndexOf(':');
							if(cut <= 0)
								continue;
							// Stored form is "<geometry>:<numeric id>"; the lookups below use
							// Id_Child, which is "relation/<numeric id>". Normalise to the
							// Id_Child form so both halves agree.
							const rawId = bucketLines[k].slice(cut + 1).trim();
							const key = rawId.startsWith('relation/') ? rawId : 'relation/' + rawId;
							cache.geom[key] = bucketLines[k].slice(0, cut);
						}
					}
					renderChildrenFromGeometry(globEl, childrenToDraw, id => cache.geom[id]);
				});
			})
			.catch(error => { console.error(error); loadFallback(); });
		}

		/**
		 * The shared tail once the geometry for the children is in hand: create the
		 * paths, register them, and update the UI. Mirrors the legacy path exactly,
		 * but looks geometry up by relation id rather than array position.
		 */
		function renderChildrenFromGeometry(globEl, childrenToDraw, geometryOf)
		{
			start = now();
			const fragment = document.createDocumentFragment();

			for(let i = 0; i < childrenToDraw.length; i++)
			{
				const foundChild = childrenToDraw[i];
				if(foundChild === undefined)
				{
					console.warn(`renderChildrenFromGeometry: childrenToDraw[${i}] is undefined`
						+ ` (length ${childrenToDraw.length}, AdminLevel ${globEl.Element.AdminLevel_Child},`
						+ ` Children="${globEl.Element.Children}")`);
					continue;
				}
				const d = geometryOf(foundChild.Id_Child);
				if(d === undefined)
					continue;

				if(binarySearch(loaded, foundChild.Id) !== -1)
					continue;
				const newPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
				newPath.setAttributeNS(null, "d", d);
				newPath.setAttributeNS(null, "id", foundChild.Id_Child);
				newPath.setAttributeNS(null, "transform", `scale(${resizeVar}, ${resizeVar})`);
				applyStyle(foundChild, newPath);
				fragment.appendChild(newPath);
			}
			htmlPaths.append(fragment);
			end = now();
			printStats(`Finished creating Paths for ${globEl.Element.Name_Child}!`);

			// This path does not rebuild a full country row set, so the position-based
			// cache must not be re-enabled for it: TxtData is left undefined on purpose,
			// and the cached branch requires it precisely so this path cannot be taken
			// there. jsonCountry is still cached, which is what the split loader wants.
			if(parseInt(globEl.Element.AdminLevel_Child) === 2)
			{
				[txtLoaded.CC, txtLoaded.Id, txtLoaded.Name, txtLoaded.TxtData] = [globEl.Element.CountryCode_Child, globEl.Element.Id, globEl.Element.Name_Child, undefined];
				[jsonLoaded.CC, jsonLoaded.Id, jsonLoaded.JsonData, jsonLoaded.Name] = [txtLoaded.CC, txtLoaded.Id, jsonCountry, txtLoaded.Name];
			}

			// C's geometry is keyed by relation id, which sidesteps the two index
			// planes entirely - that is the main reason the split path is immune to the
			// DATA-FORMAT.md section 3.1b trap.
			//
			// guardMissingGeometry is FALSE here on purpose, to keep this refactor
			// behaviour-preserving. C's FIRST loop above skips a child whose geometry is
			// undefined, but this second loop does not, so a child with no geometry row
			// reaches addEvListener with a null path and throws - latent defect F8,
			// demonstrated by the `latent` suite. Setting this to true would FIX F8; that
			// is a behaviour change and belongs in its own commit, not in a mechanical
			// consolidation.
			// No loadedList: the original kept `childrenImported` only to drive its
			// progress bar and never read it afterwards, so the caller needs no list -
			// registerChildren tracks that internally.
			registerChildren(globEl, childrenToDraw,
				(g, child) => cache.geom[child.Id_Child],
				{ worldZOrder: true, loadPins: true, guardMissingGeometry: false });
		}

		$.getJSON(`${txt1}${txt7}${txt4}`, function($json)
		{
			globalJson = $json;
			$('#back').hide();
			globalJson.filter(el => emptyCountries.find(el2 => el2 === el.CountryCode_Child) === undefined).forEach((element, index) =>
			{		
				let path = pathsAsValues.find((path) =>
				{
					// Skip missing entries rather than dereferencing them.
					if(path === null || path === undefined || path.id === undefined)
						return false;
					return path.id === element.Id_Child;
				});
				if(path !== undefined)
				{
					global.push({ Element: element, Path: path, D: path.attributes[0].value, Parents: undefined, Children: []});
					applyStyle(element, path);
					if(parseInt(element.AdminLevel_Child) < 0)
						hidePath(path);
				}
			});
			global.forEach((element, index) =>
			{		
				addEvListener(element.Path, index);
			});
		});
	});

	/**
	 * The offline shell (PWA).
	 *
	 * Registered here, outside the SVG load handler: the document itself has to open
	 * with no connection, and the service worker is what serves it then. The app is
	 * online-first — sw.js asks the network first and falls back to its cache — so a
	 * refresh never quietly serves last month's bundle, which this project has already
	 * paid for twice.
	 *
	 * A new worker activates immediately (skipWaiting + clients.claim in sw.js). If it
	 * replaced one that was already controlling the page, the app says so and offers a
	 * reload; that is the visible half of the update path.
	 */
	if ('serviceWorker' in navigator)
	{
		const hadController = navigator.serviceWorker.controller !== null;
		navigator.serviceWorker.addEventListener('controllerchange', () =>
		{
			if (!hadController)
				return; // first install: nothing to refresh
			console.log('[mappu] a new service worker took over; reload to run it');
			const hint = document.getElementById('update-hint');
			const reload = document.getElementById('reload');
			if (hint !== null)
				hint.hidden = false;
			if (reload !== null)
			{
				reload.hidden = false;
				reload.addEventListener('click', () => window.location.reload());
			}
		});
		navigator.serviceWorker.register('sw.js', { scope: './' })
			.then(() => console.log('[mappu] offline shell registered'))
			.catch(error => console.warn('[mappu] offline shell not registered', error));
	}
})
