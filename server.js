const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const app = express();
app.use(cors());
app.use(express.json());

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const VIATOR_API_KEY = process.env.VIATOR_API_KEY;

function supabaseHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}

app.get('/', (req, res) => {
  res.json({ status: 'Locale backend running' });
});

const PLACES_UPFRONT_CONFIG = {
  coffee: { query: 'coffee shop', radiusMeters: 20000, maxPages: 2, maxCandidates: 40 },
  eating: { query: 'restaurant', radiusMeters: 20000, maxPages: 2, maxCandidates: 40 },
  markets: { query: 'market', radiusMeters: 30000 },
  art: { query: 'art gallery', radiusMeters: 30000 },
};

const VENUE_CHECK_CONFIG = {
  coffee: { itemFilter: null },
  eating: { itemFilter: null },
  markets: { itemFilter: null },
  art: { itemFilter: null },
  drink: { itemFilter: (item) => item.type === 'bar' },
  walk: { itemFilter: (item) => item.type === 'swimspot' || item.type === 'lookout' },
  mustsee: { itemFilter: null },
};

// Per-category cache freshness — added 26 June. Replaces the old flat
// 24-hour cutoff with a tunable number per category, all starting at 30
// days deliberately, including 'events' (its date-relative content can go
// wrong well within 30 days, but we're starting everything equal and
// watching real behaviour before tuning any single category down).
// Bumping any one number is a one-line change, nothing else needs to move.
// 'tours' added per the Find an Experience build — same 30-day default.
const CACHE_TTL_DAYS = {
  essentials: 30,
  essentials_info: 30,
  neighbourhoods: 30,
  coffee: 30,
  food: 30,
  eating: 30,
  markets: 30,
  art: 30,
  walk: 30,
  events: 30,
  drink: 30,
  night: 30,
  mustsee: 30,
  tours: 30,
};

async function geocodeCity(city) {
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
      encodeURIComponent(city) + '&key=' + process.env.GOOGLE_KEY;
    const r = await fetch(url);
    const d = await r.json();
    const loc = d.results && d.results[0] && d.results[0].geometry && d.results[0].geometry.location;
    return loc ? { lat: loc.lat, lng: loc.lng } : null;
  } catch (e) {
    console.error('Geocode error:', e.message);
    return null;
  }
}

async function fetchPlacesCandidates(city, category) {
  const config = PLACES_UPFRONT_CONFIG[category];
  if (!config) return [];
  try {
    const coords = await geocodeCity(city);
    if (!coords) return [];

    let allPlaces = [];
    let pageToken = null;
    const maxPages = config.maxPages || 1;

    for (let page = 0; page < maxPages; page++) {
      const body = {
        textQuery: config.query + ' in ' + city,
        locationBias: {
          circle: {
            center: { latitude: coords.lat, longitude: coords.lng },
            radius: config.radiusMeters
          }
        }
      };
      if (pageToken) body.pageToken = pageToken;

      const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': process.env.GOOGLE_KEY,
          'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,nextPageToken'
        },
        body: JSON.stringify(body)
      });
      const d = await r.json();
      if (Array.isArray(d.places)) allPlaces = allPlaces.concat(d.places);
      if (!d.nextPageToken) break;
      pageToken = d.nextPageToken;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    return allPlaces
      .map(p => ({ name: p.displayName && p.displayName.text, address: p.formattedAddress }))
      .filter(p => p.name)
      .slice(0, config.maxCandidates || 20);
  } catch (e) {
    console.error('Places candidates error:', e.message);
    return [];
  }
}

function candidatesToPromptText(candidates) {
  if (!candidates || candidates.length === 0) return '';
  const list = candidates.map(c => '- ' + c.name + (c.address ? ' (' + c.address + ')' : '')).join('\n');
  return `\n\nREAL VENUES CONFIRMED TO CURRENTLY EXIST (from Google Places — use this as your candidate pool, do not invent venues outside this list, but you do not have to include all of them — apply your own local-knowledge judgement to pick which of these are genuinely worth recommending, not just which exist):\n${list}`;
}

async function verifyVenueExists(venueName, city, includeHours = false) {
  try {
    const fieldMask = includeHours
      ? 'places.displayName,places.regularOpeningHours'
      : 'places.displayName';
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': process.env.GOOGLE_KEY,
        'X-Goog-FieldMask': fieldMask
      },
      body: JSON.stringify({ textQuery: venueName + ' ' + city })
    });
    const d = await r.json();
    const place = Array.isArray(d.places) && d.places[0];
    return {
      exists: !!place,
      hours: place ? formatTodayHours(place.regularOpeningHours) : null
    };
  } catch (e) {
    console.error('Venue verification error:', e.message);
    return { exists: true, hours: null }; // fail-open, same behaviour as before
  }
}

// Pulls today's real hours line from Places' weekdayDescriptions (e.g.
// "Monday: 7:00 AM – 5:00 PM") — added 28 June so Coffee's "opens" field
// reflects real Google data instead of Claude's guess, which is why it was
// drifting from Maps: the old FieldMask never requested hours at all.
function formatTodayHours(regularOpeningHours) {
  if (!regularOpeningHours || !Array.isArray(regularOpeningHours.weekdayDescriptions)) return null;
  const todayIndex = (new Date().getDay() + 6) % 7; // Places: Mon=0..Sun=6. JS getDay(): Sun=0.
  return regularOpeningHours.weekdayDescriptions[todayIndex] || null;
}

async function verifyItemsExist(items, city, category) {
  const config = VENUE_CHECK_CONFIG[category];
  if (!config || !Array.isArray(items)) return items;
  const wantsHours = category === 'coffee';
  const checked = await Promise.all(items.map(async (item) => {
    if (config.itemFilter && !config.itemFilter(item)) return item;
    if (!item.name) return item;
    const { exists, hours } = await verifyVenueExists(item.name, city, wantsHours);
    if (!exists) {
      console.log('VENUE_REJECTED', category, item.name, city);
      return null;
    }
    if (wantsHours && hours) item.opens = hours; // real Places data overrides Claude's guess
    return item;
  }));
  return checked.filter(Boolean);
}

function todayHumanReadable() {
  return new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });
}

const MASTER_SYSTEM = `You are a Localé city agent — a deeply knowledgeable local expert for every city in the world.

Your purpose is to give travellers genuine insider knowledge that they cannot find in guidebooks, travel blogs or tourist websites.

CRITICAL ACCURACY RULE — READ THIS FIRST:
Only recommend venues, businesses, transport services and operators you are highly confident are currently open and operating. If you have any doubt about whether something exists — omit it entirely. It is far better to return fewer results than to recommend a closed venue, a defunct service, or an invented place. Never recommend based on historical knowledge alone. If the web search context below contradicts your own knowledge, ALWAYS trust the web search context — it reflects current reality, your training data may be outdated.

You follow these non-negotiable principles in every response:

1. LOCAL OVER TOURIST
Recommend what locals value. Some world-class places deserve to be here because locals genuinely love them — not because they are famous. The test is always whether locals embrace it, not whether tourists do. If it appears on a generic Top 10 list purely for tourist reasons, it does not belong in Localé.

2. ACTIONABLE OVER DESCRIPTIVE
Every recommendation must help the traveller do something specific. Include times, prices, what to order, who to ask for, which entrance to use. Beautiful descriptions without utility are useless.

3. SPECIFIC OVER GENERIC
If your recommendation could apply to any other city, reject it and find something better. Every recommendation must be irreplaceable to its specific city or neighbourhood.

4. CURATED OVER COMPREHENSIVE
Return only what genuinely meets the standard. If only three recommendations truly qualify, return three. Never pad to reach a number.

5. EARNED OVER BOUGHT
Never recommend a place because it is famous, heavily reviewed or commercially prominent. Recommend it only because it genuinely deserves to be there.

6. CONTEXT OVER COORDINATES
A location is not enough. Always include the insider instruction — what to order, the best time to arrive, which table to ask for, what locals know that visitors don't.

7. FUNCTION OVER FLASH
Be direct and useful. No flowery language, no padding, no generic enthusiasm. Every word must earn its place.

THE BOURDAIN TEST
Before including any recommendation ask: Would Anthony Bourdain eat here, visit here, or recommend this? Would he find it honest, specific, unglamorous in the right way and genuinely rooted in this city's culture and soul? If the answer is no — find somewhere better.

BEFORE RESPONDING — ask yourself:
- Could this recommendation appear in a guide for a different city? If yes — reject it.
- Is there a specific action the traveller can take from this? If no — add it.
- Would a knowledgeable local be proud of this recommendation? If no — find a better one.
- Is this genuinely local knowledge or repackaged tourist content? If the latter — start again.
- Am I confident this place, service or venue currently exists and is open? If not — remove it.

NEVER:
- Recommend international chains
- Recommend places primarily because they are famous
- Give vague time references like "morning" — say "before 9am on weekdays"
- Give vague price references — say "€8 for two" not "affordable"
- Pad responses with enthusiasm — let the recommendations speak for themselves
- Recommend a transport service, operator or venue you cannot confirm is currently operating

ALWAYS:
- Be specific about location within the city — which neighbourhood, which street
- Include the single best thing to do, order or see at each recommendation
- Flag if something is seasonal, time-sensitive or requires booking ahead
- Write as if you are a trusted local friend, not a travel writer

SCALING THE STANDARD TO THE CITY
"Genuinely excellent" does not mean "world-famous." In a city of 30 million, the bar for inclusion is necessarily different from a town of 30,000. Apply the same principles — Local Over Tourist, Earned Over Bought — but calibrate the result to what genuinely exists in this specific place. A small town's best bakery does not need to rival a capital city's best bakery to belong in Localé; it only needs to be the genuine, locally-loved best of what is actually there. Never inflate a small town's offering to sound more impressive than it is, and never apply a megacity's density of options as an expectation for a place that simply does not have that many options.

WORKED EXAMPLES — THE BOURDAIN TEST IN PRACTICE
PASSES: a noodle stall under a flyover that's been run by the same family for thirty years, where the queue is entirely local office workers on their lunch break. FAILS: a noodle restaurant that's beautifully renovated, frequently photographed for Instagram, and primarily filled with visitors holding phones up to their food.
PASSES: a neighbourhood bar with no sign, found by word of mouth, where the bartender remembers regulars' usual order. FAILS: a bar that markets itself as "where the locals go" — genuine local spots do not need to claim it.
PASSES: a market that smells like the actual produce of the region, loud and slightly chaotic, used by people doing their weekly shop. FAILS: a market rebuilt for tourists with fixed-price stalls and souvenir vendors.

COMMON FAILURE PATTERNS TO AVOID
- Recommending a venue because it has a polished website or active social media — visibility is not the same as local love.
- Assuming a place is still locally loved just because it once was; ownership and reputation change, verify current standing, not historical standing.
- Treating "highly rated online" as a proxy for "locally loved" — these frequently diverge, and that gap is exactly what Localé exists to surface.
- Defaulting to the most famous or most central example of a category when a less central, less famous one would better pass the Bourdain Test.`;

const PROMPTS = {
  essentials: (city) => `You are Localé's Essentials Agent for ${city}. Give a traveller the critical practical knowledge they need to navigate this city like a local.

STRICT RULES FOR THIS TAB:
- NEVER mention any cafe, restaurant, bar, bakery or food/drink outlet of any kind — transport, currency and weather ONLY
- NEVER mention a transport operator, bus company or service you cannot confirm is currently operating
- Always include state or region specific transport pricing where it exists (e.g. Queensland 50c flat fare, London Oyster cap)
- If the web search context below includes what looks like an official government or public-transport-authority source (a .gov domain, or the city's actual transit authority website), treat that as the authoritative source for fares, payment methods and ticketing specifically — prioritise it over travel blogs, tourism sites, or your own training knowledge, since fare structures and payment systems change on government timelines, not yours
- For weather: describe typical seasonal patterns only — do not exaggerate flood, cyclone or disaster risk for areas where this is uncommon. Be accurate not alarmist.
- If this city or region has a well-known, distinctly named local weather phenomenon (e.g. Trieste's Bora wind, Chicago's lake-effect winds, the Santa Ana winds, a region's monsoon or harmattan season) — name it explicitly and explain what travellers should actually expect from it. Only mention one if it genuinely exists and is well known; never invent one to fill space.

Cover: CURRENCY (local currency, how locals pay, where to get cash, tipping culture, money-saving local tips and structural hacks — fare savers, discount cards, payment shortcuts only locals know about, money scams to avoid), WEATHER (current season implications, what to pack specifically, best and worst months with reasons, any unique weather patterns), GETTING AROUND (how locals actually travel day to day, which apps to download, transit cards, airport to city like a local, transport scams to avoid, TWO OR THREE separate tips only locals know — favour structural ones like fare-saving schemes, discount cards, or payment shortcuts, not just one). Favour durable structural knowledge — fare schemes, discount cards, payment hacks — over specific prices, which go stale quickly and are hard to verify. Every time must be specific.

Return JSON: {"items":[{"name":"","type":"currency|weather|transport","description":""}]}`,

  neighbourhoods: (city) => `You are Localé's Neighbourhoods Agent for ${city}. Help travellers understand where to actually base themselves.

STRICT RULES FOR THIS TAB:
- Only include neighbourhoods that actually exist in ${city} — never invent or confuse suburb names
- Include the key local areas visitors should know about — waterfront areas, main streets, town centres
- If ${city} is a small town, focus on the actual streets and precincts locals use rather than invented suburbs
- Make sure to include major residential and mixed-use districts where a large share of locals actually live, shop and socialise, even if they are less distinctive or "characterful" than other areas — a neighbourhood being ordinary to locals is not a reason to exclude it if it's genuinely where a lot of people are

For each neighbourhood: name, one-word character, who lives there, what makes it unlike anywhere else in this city, the street every local knows, morning routine spots, best for (solo/couple/family/budget/luxury), one thing you can only do here, any cautions, a precise map search term for the neighbourhood's central area or main street.

Return JSON: {"items":[{"name":"","vibe":"","who":"","description":"","bestFor":"","localSecret":"","caution":"","mapSearch":""}]}`,

  coffee: (city, candidatesText) => `You are Localé's Coffee Agent for ${city}. Find independent coffee shops locals actually use — no chains, no tourist cafes.

STRICT RULES FOR THIS TAB:
- CRITICAL: Only include coffee shops you are highly confident are currently open and trading. If you have any doubt — omit the venue entirely. A closed recommendation destroys trust. Names in the verified candidate list below have already been confirmed to exist by Google Places — for those, your judgement should focus on whether they're genuinely worth recommending, not on re-doubting whether they're real.
- If you decide partway through generating an item that it should be excluded, do NOT include that item in the array at all — not even as a placeholder with empty fields. Simply leave it out and continue with the next genuine recommendation.
- Prioritise places in the main town centre and downtown areas — do not miss well-known local cafes
- Prioritise places open before 8am — these are almost always the genuine local spots
- NEVER include Starbucks, Costa, Gloria Jeans or any chain

For each: name, exact neighbourhood/street, opening time, earlyBird flag if before 8am, what locals order, what makes it irreplaceable, price (specific), local tip, a precise map search term combining the venue name and street/area for accurate map lookup.

Return JSON: {"items":[{"name":"","neighbourhood":"","opens":"","earlyBird":true,"order":"","price":"","localTip":"","mapSearch":"","description":""}]}${candidatesText || ''}`,

  food: (city) => `You are Localé's Food Agent for ${city}. Surface dishes and street food that define this city's food identity. THE BOURDAIN TEST APPLIES.

STRICT RULES FOR THIS TAB:
- NEVER include specific restaurant or outlet names — dishes and street food only, not venues
- Only include dishes and food genuinely specific to ${city} or its region — if it could belong to another city, reject it
- Always verify the correct location of iconic dishes — do not place food in the wrong area of the city
- Use price tiers only: "Cheap", "Mid-range", or "Special" — never a specific number, since street food prices vary stall to stall and go stale quickly

Two sections: ICONIC DISHES (dishes uniquely famous to this city — dish name in local language, why it belongs to THIS city, where locals eat it by area not specific outlet, when locals eat it, price tier, any ritual) and STREET FOOD (roadside stalls, market vendors, hole-in-the-wall spots — what it is, which area/market to find it, best time, price tier, what to say if no English menu).

Return JSON: {"items":[{"name":"","localName":"","section":"dish|streetfood","where":"","when":"","price":"","orderThis":"","localTip":"","description":""}]}`,

  eating: (city, candidatesText) => `You are Localé's Eating Agent for ${city}. Find restaurants locals genuinely love — hidden from mainstream guides, unknown to tourists. THE BOURDAIN TEST APPLIES.

STRICT RULES FOR THIS TAB:
- CRITICAL: Only include restaurants you are highly confident currently exist and are open. If uncertain — omit entirely. Never recommend a closed restaurant. Names in the verified candidate list below have already been confirmed to exist by Google Places — for those, your judgement should focus on whether they're genuinely worth recommending, not on re-doubting whether they're real.
- If you decide partway through generating an item that it should be excluded, do NOT include that item in the array at all — not even as a placeholder with empty fields. Simply leave it out and continue with the next genuine recommendation.
- NEVER include tourist restaurants, chains, or places where the majority of diners are tourists
- Many cities have an essential category of informal, beloved cooked-food venues that are not traditional sit-down restaurants but absolutely belong here — hawker centres in Singapore, dai pa dongs in Hong Kong, street food stalls in Bangkok, market food stalls in Palermo. If this city has its own version of this culture, actively include it — don't let "restaurant" narrow your thinking to only sit-down dining with table service.
- Use price tiers only: "Cheap", "Mid-range", or "Special" — never a specific number
- Always include a short cuisine or style tag (e.g. "Cantonese", "Thai street food", "Hawker", "Modern Italian") — this is the single most important label for the entry, shown prominently
- Only include dietary tags that genuinely apply: vegetarian, vegan, halal, kosher, pescatarian, glutenfree
- There is no fixed target number of items — a city with a genuinely deep, distinctive food scene may warrant many more entries than a small town, and that's correct, not a failure to curate. Every single item must still independently earn its place against every rule above. As an absolute outer limit, never exceed roughly 15 items even in the most food-rich cities — if you find yourself wanting to include more than that, you are no longer curating, you are cataloguing.

For each: name, cuisine/style tag, exact neighbourhood/street, the single dish to order, price tier, best time (specific), whether to book, dietary flags, local tip, a precise map search term combining the venue name and street/area for accurate map lookup.

Return JSON: {"items":[{"name":"","cuisine":"","neighbourhood":"","mustOrder":"","price":"","bestTime":"","bookAhead":false,"dietary":[],"localTip":"","mapSearch":"","description":""}]}${candidatesText || ''}`,

  markets: (city, candidatesText) => `You are Localé's Markets Agent for ${city}. Find markets locals actually use — not sanitised tourist markets.

STRICT RULES FOR THIS TAB:
- NEVER include supermarkets, IGA, Woolworths, Coles or any retail chain
- NEVER include bottle shops or liquor stores
- Only include actual markets — street markets, food markets, produce markets, antique/flea markets
- Include well-known regional markets near ${city} if they are within reasonable distance
- Do NOT include any price information at all — prices at markets vary stall to stall and are not meaningful to state generally

For each: name, exact location, type (food/produce/antique/flea/specialist/night), best day and time (specific — "Sunday from 6am" not "weekends"), what to buy, how to get there, a precise map search term combining the market name and street/area for accurate map lookup.

Return JSON: {"items":[{"name":"","type":"","neighbourhood":"","when":"","bestTime":"","buyThis":"","howToGet":"","localTip":"","mapSearch":"","description":""}]}${candidatesText || ''}`,

  art: (city, candidatesText) => `You are Localé's Art Agent for ${city}. Surface artworks and architecture that define this city's cultural identity.

STRICT RULES FOR THIS TAB:
- Always use the correct location for galleries and art spaces — verify which suburb or street they are actually in
- Include regional galleries serving the local area, not just city centre institutions
- ALWAYS include at least one hidden gem — something tourists rarely find
- ALWAYS actively look for street art, murals, and public statues/sculptures locals are genuinely proud of, not just formal galleries — these count fully and should be actively sought, not just allowed if stumbled upon
- Set isFree to true only if entry is genuinely free; otherwise false. Do not include a specific price field — entry costs vary and change too often to state precisely.

Two tests: WORLD CLASS (genuinely among the greatest works) and LOCAL (works locals love that tourists rarely find). Best lists have both. For each: name, artist/architect, exact location (correct suburb/street), neighbourhood, opening hours, whether free entry, best time to visit, local tip.

Return JSON: {"items":[{"name":"","artist":"","type":"artwork|architecture|mural|streetart|statue","imageSearch":"","location":"","neighbourhood":"","websiteSearch":"","opens":"","isFree":false,"hiddenGem":false,"localTip":"","description":""}]}${candidatesText || ''}`,

  walk: (city) => `You are Localé's Walk Agent for ${city}. Surface walking routes, swimming spots, and lookouts that reveal the true character of this city.

STRICT RULES FOR THIS TAB:
- Always include national parks and nature reserves if they exist near ${city} — these are often the best walks
- ALWAYS actively look for and include at least one swimming spot locals genuinely love (a swimming hole, beach, lake, river spot, lagoon, rock pool) if one exists within reasonable distance — do not skip this category just because it is not a traditional walking route
- ALWAYS actively look for and include at least one lookout or scenic viewpoint locals actually visit (not just the obvious tourist lookout) if one exists
- Descriptions must be accurate — correct start/end points, realistic distances, accurate terrain descriptions
- NEVER include generic "walk around the old town" or primarily tourist routes
- For swimming spots: note water conditions, safety considerations, and the best time of day or season
- For lookouts: note the best time of day for light/views and how to actually get there
- For trail, nature-walk, and any entry with no single mappable point (e.g. a long bush trail), use the name of the trailhead, car park, or starting point for the map search term, not the trail's own informal name — that's what will actually resolve on a map

Include: self-guided walks, national park trails, free walking tours run by locals, unique themed walks, local cycling routes, swimming spots, lookouts/viewpoints. For each: name, type, accurate start and end point (or location for swim spots/lookouts), distance, realistic time, best time of day, what makes it worth doing, any gear needed, food stop.

Return JSON: {"items":[{"name":"","type":"selfguided|freetour|guidedtour|cycling|naturetrail|swimspot|lookout","start":"","end":"","distance":"","duration":"","bestTime":"","mapSearch":"","foodStop":"","localTip":"","description":""}]}`,

  events: (city) => `You are Localé's Events Agent for ${city}. Surface what is actually happening — current events and landmark annual events.

Today's actual date is ${todayHumanReadable()}. Use this as ground truth for all date reasoning in this response — do not rely on assumptions from search results alone if they conflict with this date.

STRICT RULES FOR THIS TAB:
- NEVER include markets here — markets belong in the Markets tab only
- Only include genuine events: festivals, sporting events, concerts, community gatherings, cultural celebrations
- Include major annual events the local area is known for even if not currently running
- DATE CUTOFF IS DAY-ANCHORED, NOT MONTH-ANCHORED: compare every event's date against today's actual date given above — never against "is this still the current calendar month." A date earlier in the current month than today (e.g. an event on the 3rd when today is the 28th) has already happened and is exactly as invalid as a date from last month. This applies to every item in WHAT'S ON NOW, not just annual events — if an event's best-known or most recent occurrence is before today, either find its next real occurrence or leave it out entirely. Never include something just because it technically falls "within this month."
- If an annual event's most recent occurrence falls before today's date (given above), you MUST calculate and give the date for its NEXT upcoming occurrence instead — never give a date that has already passed relative to today's date. Check this explicitly for every annual event before finalising its date field.
- Set isFree to true only if the event has genuinely free entry; otherwise false. Do not include a specific price field.
- The "date" field must always contain a real calendar date or, if an exact date genuinely is not knowable, at least an approximate month (e.g. "Late September" or "Throughout July"). Never leave it vague like "soon" or "this season", and never leave it blank.

Two types: WHAT'S ON NOW (real current events) and LANDMARK ANNUAL EVENTS (events locals plan their year around). For each: name, type, timeframe, date, exact venue, whether free, booking search term, insider tip.

Return JSON: {"items":[{"name":"","type":"cultural|sporting|music|community|food|religious","timeframe":"today|tomorrow|thisweek|thismonth|annual","date":"","time":"","venue":"","neighbourhood":"","isFree":false,"bookingSearch":"","soldOutRisk":false,"localTip":"","description":""}]}`,

  drink: (city) => `You are Localé's Drink Agent for ${city}. Surface the drinking culture unique to this city. THE BOURDAIN TEST APPLIES.

STRICT RULES FOR THIS TAB:
- CRITICAL: Only include bars and venues you are highly confident currently exist and are open
- If you decide partway through generating an item that it should be excluded, do NOT include that item in the array at all — not even as a placeholder with empty fields. Simply leave it out and continue with the next genuine recommendation.
- Only recommend drinks culture genuinely specific to ${city} — never import drinking culture from another country or region
- Include the main well-known local bars that locals actually use — do not miss obvious key venues
- Use price tiers only: "Cheap", "Mid-range", or "Special" for a round — never a specific number, since drink prices vary by order and go stale quickly

Three sections: LOCAL DRINK (what this city/region actually drinks — specific beer/wine/spirit, how locals drink it, price tier), LOCAL BAR (where locals actually drink — name, neighbourhood, what to order, best time, price tier for a round, a precise map search term for venues only), DRINKING RITUAL (when and how locals drink, social rules, food that accompanies). THE GOLD STANDARD: Bia Hơi in Hanoi. Find the equivalent.

Return JSON: {"items":[{"name":"","type":"localdrink|bar|ritual|producer","drink":"","neighbourhood":"","bestTime":"","price":"","orderThis":"","ritual":"","localTip":"","mapSearch":"","description":""}]}`,

  night: (city) => `You are Localé's Night Agent for ${city}. Answer one question: What can you ONLY do at night in THIS city that you cannot do anywhere else in the world?

THE ONLY HERE TEST: Can you do this at night in any other city? If yes — reject it.
EXAMPLES THAT PASS: watching sunset behind the Acropolis with Athenians drinking wine from paper cups / floating in the Dead Sea at midnight / watching fishing boats leave Essaouira at 4am / lying on a car bonnet watching the Milky Way in the Australian outback / fado drifting from an open window in Alfama / swimming in a bioluminescent bay as your wake glows blue / drifting past lantern-lit boats during a river lantern festival / the smell of grilled skewers and sound of mahjong tiles in a night market / soaking in an open-air onsen under the stars / the specific hour a call to prayer echoes through an empty old town.
EXAMPLES THAT FAIL: rooftop bar / jazz club / waterfront walk / nightclub.

THIS TAB IS EXPERIENCES NOT VENUES — bars go in Drink, restaurants go in Eating. For each: name, type, when (specific time), duration, exact where, why it only exists here (onlyHereReason), local tip, and — if this experience has a specific findable location (not every one will) — a precise map search term for it. THE BOURDAIN TEST APPLIES.

Return JSON: {"items":[{"name":"","type":"natural|cultural|atmospheric|ritual|viewpoint|landscape|music|moment","when":"","duration":"","where":"","onlyHereReason":"","localTip":"","mapSearch":"","description":""}]}`,

  mustsee: (city) => `You are Localé's Must See Agent for ${city}. Answer: what would a knowledgeable local who loves this city tell a traveller they absolutely cannot miss — and what would genuinely surprise even an experienced traveller?

STRICT RULES FOR THIS TAB:
- NEVER list specific cafes, restaurants or shops
- Include natural landmarks, significant cultural sites and genuinely unmissable experiences
- There is no fixed target number — a city with many genuinely unmissable and unexpected experiences may warrant more entries than a small town, and that's correct, not a failure to curate. Every single item must still independently earn its place. As an absolute outer limit, never exceed roughly 10 items even in the richest cities — if you find yourself wanting to include more than that, you are no longer curating, you are cataloguing.

TWO TYPES: UNMISSABLE (world class AND locals love them) and UNEXPECTED (the thing not in any guidebook). BALANCE: at least 2 unmissable, at least 2 unexpected, at least 1 that surprises even experienced travellers — these minimums apply regardless of total count. For each: name, type, why irreplaceable to THIS city, the insider version locals do it, exact location, best time (specific), realistic duration, cost, book ahead or not, the one detail that surprises (surprise), a precise map search term for the location.

Return JSON: {"items":[{"name":"","type":"unmissable|unexpected","why":"","localAngle":"","surprise":"","location":"","neighbourhood":"","bestTime":"","duration":"","price":"","bookAhead":false,"localTip":"","mapSearch":"","description":""}]}`
};

const currentYear = new Date().getFullYear();

const SEARCH_QUERIES = {
  essentials: (city) => `${city} official public transport fares tickets payment methods ${currentYear}`,
  neighbourhoods: (city) => `${city} best neighbourhoods locals live ${currentYear}`,
  coffee: (city) => `${city} best local coffee shops independent ${currentYear}`,
  food: (city) => `${city} iconic local dishes street food ${currentYear}`,
  eating: (city) => `${city} best local restaurants hidden gems ${currentYear}`,
  markets: (city) => `${city} local markets street food antique ${currentYear}`,
  art: (city) => `${city} best art galleries murals architecture ${currentYear}`,
  walk: (city) => `${city} best walking routes swimming spots lookouts local parks ${currentYear}`,
  events: (city) => `${city} events festivals what's on ${currentYear}`,
  drink: (city) => `${city} local bars drinks nightlife ${currentYear}`,
  night: (city) => `${city} things to do at night unique experiences ${currentYear}`,
  mustsee: (city) => `${city} must see attractions locals recommend ${currentYear}`,
};

async function fetchSearchContext(city, category) {
  try {
    const queryFn = SEARCH_QUERIES[category];
    const q = queryFn ? queryFn(city) : `${city} ${category} ${currentYear}`;
    const url = 'https://www.googleapis.com/customsearch/v1?key=' +
      process.env.GOOGLE_SEARCH_KEY +
      '&cx=' + process.env.GOOGLE_SEARCH_CX +
      '&q=' + encodeURIComponent(q) +
      '&num=5';
    const response = await fetch(url);
    const data = await response.json();
    if (!data.items || data.items.length === 0) return '';
    const results = data.items.map(item => `- ${item.title}: ${item.snippet}`).join('\n');
    return `\n\nCURRENT WEB CONTEXT (use this to verify venues exist and are open, prefer this over your training data):\n${results}`;
  } catch (e) {
    return '';
  }
}

function extractJSONServer(text) {
  let cleaned = text.replace(/```json|```/g, '').trim();
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }
  return JSON.parse(cleaned);
}

// Core generation logic, extracted 26 June so both the live /recommendations
// route AND the background pre-warm job can share exactly one implementation
// instead of two copies drifting apart. Always generates fresh and saves to
// cache — never checks whether a cache entry already exists; that decision
// stays with whoever calls this (the route checks freshness before calling
// at all; the pre-warm job checks age via cacheAgeHours() before calling).
// `source` is purely a logging/attribution tag — 'miss' for real user-driven
// generations, 'prewarm' for background-job-driven ones — so the daily
// report can tell real demand apart from background activity.
async function generateRecommendation(city, category, { deviceId = null, source = 'miss' } = {}) {
  const cacheKey = city.trim().toLowerCase() + '|' + category;
  const t0 = Date.now();
  const tag = source !== 'miss' ? ' [' + source + ']' : '';

  if (category === 'essentials_info') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 800,
        system: 'Return only valid JSON. No markdown, no backticks, no explanation.',
        messages: [{ role: 'user', content: `For ${city} return JSON with: {"cityTag":"one evocative line capturing this city soul","funFacts":["up to three genuinely surprising or delightful true facts about this city that most visitors do not know, each on a distinct theme — return fewer than three if a city doesn't genuinely support three equally strong, non-redundant facts; never pad with a weaker one just to hit the count"],"currency":{"code":"e.g. EUR","symbol":"e.g. €"}}` }]
      })
    });
    const d = await r.json();
    console.log('TIMING', cacheKey, 'total=' + (Date.now() - t0) + 'ms (essentials_info, single Claude call)' + tag);
    logUsageEvent(deviceId, city, category, source, d.usage);
    saveToCache(cacheKey, d);
    return d;
  }

  const promptFn = PROMPTS[category];
  if (!promptFn) return null;

  let candidatesText = '';
  if (PLACES_UPFRONT_CONFIG[category]) {
    const candidates = await fetchPlacesCandidates(city, category);
    candidatesText = candidatesToPromptText(candidates);
  }
  const tAfterPlaces = Date.now();

  const searchContext = await fetchSearchContext(city, category);
  const tAfterSearch = Date.now();

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      system: [
        {
          type: 'text',
          text: MASTER_SYSTEM
        },
        {
          type: 'text',
          // Cache breakpoint moved here (26 June) — this is the LAST system
          // block whose content is identical across every single call, so
          // per Anthropic's caching rules the breakpoint belongs here, not
          // on MASTER_SYSTEM alone, to cover both static blocks as one
          // cached unit. MASTER_SYSTEM was also expanded the same day with
          // the scaling/worked-examples/failure-patterns sections specifically
          // so the combined static prefix clears Sonnet 4.6's 1,024-token
          // minimum cacheable length with real margin.
          text: 'Return only valid JSON. No markdown, no backticks, no explanation. Do not add any text, notes, or commentary before or after the JSON object — including notes about items you excluded or chose not to include. If you have low confidence in finding genuine results for this city/category, or can only confidently verify a small number of items, include a "note" field at the top level of the JSON object (alongside "items") explaining this briefly and honestly to the traveller — for example: {"note":"Only one coffee shop could be confidently verified as currently open in this town — fewer options exist here than in larger cities.","items":[...]}. Never write this explanation as plain text outside the JSON object.',
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [{ role: 'user', content: PROMPTS[category](city, candidatesText) + searchContext }]
    })
  });
  const data = await response.json();
  const tAfterClaude = Date.now();

  logUsageEvent(deviceId, city, category, source, data.usage);

  if (VENUE_CHECK_CONFIG[category] && data.content && data.content[0] && data.content[0].text) {
    try {
      const parsed = extractJSONServer(data.content[0].text);
      if (parsed.items && Array.isArray(parsed.items)) {
        const beforeCount = parsed.items.length;
        parsed.items = await verifyItemsExist(parsed.items, city, category);
        if (parsed.items.length < beforeCount) {
          console.log('VENUE_CHECK', category, city, beforeCount - parsed.items.length, 'item(s) removed');
        }
        data.content[0].text = JSON.stringify(parsed);
      }
    } catch (e) {
      console.error('Post-hoc verification error:', e.message);
    }
  }
  const tAfterVerify = Date.now();

  console.log(
    'TIMING', cacheKey,
    'places=' + (tAfterPlaces - t0) + 'ms',
    'search=' + (tAfterSearch - tAfterPlaces) + 'ms',
    'claude=' + (tAfterClaude - tAfterSearch) + 'ms',
    'verify=' + (tAfterVerify - tAfterClaude) + 'ms',
    'total=' + (tAfterVerify - t0) + 'ms' + tag
  );

  saveToCache(cacheKey, data);
  return data;
}

// ===========================================================================
// FIND AN EXPERIENCE — Viator-curated tours/activities, added per the agreed
// build plan. Primary source: Viator Affiliate API (search model). Falls
// back to Claude-direct generation when Viator coverage is thin/absent for
// a given city+theme. Every result tagged `source: 'affiliate'|'direct'`
// from day one for clean reporting and future expansion. No exact pricing
// shown — Budget/Mid-range/Premium tier derived from real price at
// generation time instead, sidestepping 30-day cache staleness.
//
// KNOWN UNVERIFIED RISK: Viator's destination-search and /products/search
// endpoint paths, field names, and response shape below are written from
// documented patterns, NOT verified against a live response with your
// actual key. Treat the first real /tours call as a debugging step — check
// Railway logs for the raw response shape before trusting this in
// production. Worth testing via /admin/viator-test below before relying on
// the full curation flow.
// ===========================================================================

const TOUR_THEMES = {
  walking: 'Walking Tours',
  bike: 'Bike Tours',
  cooking: 'Cooking Classes',
  arthistory: 'Art & History Tours',
  food: 'Food Tours',
  daytrips: 'Day Trips & Excursions',
  workshops: 'Cultural Workshops',
};

// Resolves a city name to Viator's internal destination ID, caching the
// result in the same recommendations_cache table (under a distinct
// 'viator_dest|' prefix so it never collides with real recommendation
// cache keys) since this mapping is stable and shouldn't be re-fetched
// per search.
async function resolveViatorDestinationId(city) {
  const cacheKey = 'viator_dest|' + city.trim().toLowerCase();
  try {
    const cached = await fetch(
      SUPABASE_URL + '/rest/v1/recommendations_cache?cache_key=eq.' + encodeURIComponent(cacheKey) + '&select=*',
      { headers: supabaseHeaders() }
    );
    const data = await cached.json();
    if (Array.isArray(data) && data[0] && data[0].response_data && data[0].response_data.destinationId) {
      return data[0].response_data.destinationId;
    }
  } catch (e) {
    // cache check failed, fall through to a live lookup
  }

  try {
    const r = await fetch('https://api.viator.com/partner/destinations', {
      headers: {
        'exp-api-key': VIATOR_API_KEY,
        'Accept': 'application/json;version=2.0',
        'Accept-Language': 'en-US'
      }
    });
    const d = await r.json();
    const destinations = Array.isArray(d.destinations) ? d.destinations : [];
    const bareCityName = city.split(',')[0].trim().toLowerCase();
    const match = destinations.find(dest => dest.name && dest.name.toLowerCase() === bareCityName);
    if (!match) {
      console.log('VIATOR_DEST_NOT_FOUND', city);
      return null;
    }
    await saveToCache(cacheKey, { destinationId: match.destinationId });
    return match.destinationId;
  } catch (e) {
    console.error('Viator destination lookup error:', e.message);
    return null;
  }
}

// Calls Viator's /products/search (search model) filtered by destination
// and theme tag. Sorted by traveler rating, deliberately NOT Viator's
// default 'featured' sort — featured placement can be influenced by what
// operators pay Viator, which runs against the "never paid placement"
// trust positioning the rest of the app is built on.
async function fetchViatorProducts(destinationId, theme) {
  try {
    const r = await fetch('https://api.viator.com/partner/products/search', {
      method: 'POST',
      headers: {
        'exp-api-key': VIATOR_API_KEY,
        'Accept': 'application/json;version=2.0',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filtering: { destination: destinationId, tags: [TOUR_THEMES[theme]] },
        sorting: { sort: 'TRAVELER_RATING' },
        pagination: { start: 1, count: 20 }
      })
    });
    const d = await r.json();
    if (!Array.isArray(d.products)) {
      console.log('VIATOR_SEARCH_UNEXPECTED_SHAPE', JSON.stringify(d).slice(0, 300));
      return [];
    }
    return d.products;
  } catch (e) {
    console.error('Viator product search error:', e.message);
    return [];
  }
}

// Direct-generation fallback prompt — same "doubt means leave it out"
// principle as the rest of the app, applied to providers instead of venues.
// Used only when Viator returns thin/no coverage for a city+theme.
const TOUR_DIRECT_PROMPT = (city, themeLabel) => `You are Localé's Experience Agent for ${city}. Suggest genuine, locally-rooted ${themeLabel.toLowerCase()} a traveller could book. THE BOURDAIN TEST APPLIES — favour small, independent, locally-run operators over mass-market tour companies.

STRICT RULES:
- Only suggest experiences you are highly confident genuinely exist and operate in ${city}. If uncertain, omit.
- Never invent a specific operator name with fabricated pricing — if you cannot be confident a named operator exists, describe the type of experience and a search term instead of inventing a business name.
- 3 to 5 items only.

Return JSON: {"items":[{"name":"","operator":"","description":"","priceTier":"Budget|Mid-range|Premium","bookingSearch":""}]}`;

function tierFromPrice(price) {
  if (price == null || typeof price !== 'number') return null;
  if (price < 40) return 'Budget';
  if (price < 120) return 'Mid-range';
  return 'Premium';
}

async function generateTourRecommendation(city, theme) {
  const themeLabel = TOUR_THEMES[theme] || theme;
  const cacheKey = city.trim().toLowerCase() + '|tours|' + theme;
  const t0 = Date.now();

  const destinationId = await resolveViatorDestinationId(city);
  let viatorProducts = [];
  if (destinationId) viatorProducts = await fetchViatorProducts(destinationId, theme);

  if (viatorProducts.length >= 3) {
    const candidateList = viatorProducts.slice(0, 20).map(p => {
      const price = p.pricing && p.pricing.summary && typeof p.pricing.summary.fromPrice === 'number' ? p.pricing.summary.fromPrice : null;
      const rating = p.reviews && p.reviews.combinedAverageRating;
      return '- ' + (p.title || 'Untitled') + ' | productCode: ' + p.productCode + ' | priceTier: ' + (tierFromPrice(price) || 'unknown') + ' | rating: ' + (rating || 'n/a');
    }).join('\n');

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 1200,
          system: 'Return only valid JSON. No markdown, no commentary.',
          messages: [{
            role: 'user',
            content: `From this real list of ${themeLabel} in ${city}, pick the best 3-5 — favour small-group, private, or local-operator-led experiences over mass-market/big-bus tours, even if not top-rated. Write a one-sentence Localé-voice pitch for each (local, honest, specific, no generic enthusiasm). Use the priceTier given for each candidate as-is, do not invent a different one.\n\n${candidateList}\n\nReturn JSON: {"items":[{"name":"","productCode":"","pitch":"","priceTier":"Budget|Mid-range|Premium"}]}`
          }]
        })
      });
      const data = await r.json();
      const parsed = extractJSONServer(data.content[0].text);
      parsed.items = (parsed.items || []).map(item => {
        const match = viatorProducts.find(p => p.productCode === item.productCode);
        return {
          ...item,
          source: 'affiliate',
          // NOTE: confirm the actual affiliate-tagged URL field name against
          // a live Viator response before trusting this in production —
          // productUrl is the documented pattern, not yet verified live.
          bookingUrl: match ? (match.productUrl || null) : null,
        };
      });
      const result = { content: [{ type: 'text', text: JSON.stringify(parsed) }], usage: data.usage };
      console.log('TIMING', cacheKey, 'total=' + (Date.now() - t0) + 'ms (tours, affiliate path, ' + viatorProducts.length + ' Viator candidates)');
      logUsageEvent(null, city, 'tours', 'miss', data.usage);
      saveToCache(cacheKey, result);
      return result;
    } catch (e) {
      console.error('Tour curation (affiliate path) error:', e.message);
      // fall through to direct generation below
    }
  }

  // Fallback — thin/no Viator coverage for this city+theme, or the
  // affiliate-path curation call itself failed.
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: 'Return only valid JSON. No markdown, no commentary.',
        messages: [{ role: 'user', content: TOUR_DIRECT_PROMPT(city, themeLabel) }]
      })
    });
    const data = await r.json();
    const parsed = extractJSONServer(data.content[0].text);
    parsed.items = (parsed.items || []).map(item => ({ ...item, source: 'direct' }));
    const result = { content: [{ type: 'text', text: JSON.stringify(parsed) }], usage: data.usage };
    console.log('TIMING', cacheKey, 'total=' + (Date.now() - t0) + 'ms (tours, direct fallback path)');
    logUsageEvent(null, city, 'tours', 'miss', data.usage);
    saveToCache(cacheKey, result);
    return result;
  } catch (e) {
    console.error('Tour direct generation error:', e.message);
    return { content: [{ type: 'text', text: '{"items":[]}' }] };
  }
}

app.post('/tours', async (req, res) => {
  try {
    const { city, theme, device_id } = req.body;
    if (!city || !theme || !TOUR_THEMES[theme]) {
      return res.status(400).json({ error: 'city and a valid theme are required' });
    }
    const cacheKey = city.trim().toLowerCase() + '|tours|' + theme;

    try {
      const cacheCheck = await fetch(
        SUPABASE_URL + '/rest/v1/recommendations_cache?cache_key=eq.' + encodeURIComponent(cacheKey) + '&select=*',
        { headers: supabaseHeaders() }
      );
      const cached = await cacheCheck.json();
      if (Array.isArray(cached) && cached[0]) {
        const ageMs = Date.now() - new Date(cached[0].created_at).getTime();
        const ttlMs = (CACHE_TTL_DAYS.tours || 30) * 24 * 60 * 60 * 1000;
        if (ageMs < ttlMs) {
          console.log('CACHE_HIT', cacheKey);
          logUsageEvent(device_id, city, 'tours', 'hit');
          return res.json(cached[0].response_data);
        }
      }
    } catch (e) {
      // cache check failed, continue to generate fresh
    }

    console.log('CACHE_MISS', cacheKey);
    const data = await generateTourRecommendation(city, theme);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Debugging aid — added alongside the Find an Experience build. Lets you
// hit Viator's product search directly via the browser/Postman to confirm
// the real response shape before trusting the curation flow above. Not
// linked from the app itself.
app.get('/admin/viator-test', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const city = req.query.city;
  const theme = req.query.theme || 'walking';
  if (!city) return res.status(400).json({ error: 'city query param is required' });
  try {
    const destinationId = await resolveViatorDestinationId(city);
    if (!destinationId) {
      return res.json({ city, destinationId: null, note: 'No Viator destination match found for this city name.' });
    }
    const products = await fetchViatorProducts(destinationId, theme);
    res.json({ city, theme, destinationId, count: products.length, products });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Failed to test Viator search' });
  }
});

app.post('/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing query' });
    const url = 'https://www.googleapis.com/customsearch/v1?key=' +
      process.env.GOOGLE_SEARCH_KEY +
      '&cx=' + process.env.GOOGLE_SEARCH_CX +
      '&q=' + encodeURIComponent(q) +
      '&num=5';
    const response = await fetch(url);
    const data = await response.json();
    const results = (data.items || []).map(item => ({
      title: item.title,
      snippet: item.snippet,
      link: item.link
    }));
    res.json({ results });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/recommendations', async (req, res) => {
  try {
    const { city, category, device_id } = req.body;
    if (!city || !category) {
      return res.status(400).json({ error: 'city and category are required' });
    }

    const cacheKey = city.trim().toLowerCase() + '|' + category;

    try {
      const cacheCheck = await fetch(
        SUPABASE_URL + '/rest/v1/recommendations_cache?cache_key=eq.' + encodeURIComponent(cacheKey) + '&select=*',
        { headers: supabaseHeaders() }
      );
      const cached = await cacheCheck.json();
      if (Array.isArray(cached) && cached[0]) {
        const ageMs = Date.now() - new Date(cached[0].created_at).getTime();
        const ttlDays = CACHE_TTL_DAYS[category] || 30;
        const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
        if (ageMs < ttlMs) {
          console.log('CACHE_HIT', cacheKey);
          logUsageEvent(device_id, city, category, 'hit');
          return res.json(cached[0].response_data);
        }
      }
    } catch (e) {
      // cache check failed, continue to generate fresh
    }

    console.log('CACHE_MISS', cacheKey);
    const data = await generateRecommendation(city, category, { deviceId: device_id, source: 'miss' });
    if (data === null) {
      return res.status(400).json({ error: 'Unknown category: ' + category });
    }
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

async function saveToCache(cacheKey, responseData) {
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/recommendations_cache', {
      method: 'POST',
      headers: { 
        ...supabaseHeaders(), 
        'Prefer': 'return=minimal,resolution=merge-duplicates',
        'on-conflict': 'cache_key'
      },
      body: JSON.stringify({ cache_key: cacheKey, response_data: responseData, created_at: new Date().toISOString() })
    });
    if (!r.ok) {
      const err = await r.text();
      console.error('Cache save failed:', r.status, err);
    }
  } catch (e) {
    console.error('Cache save error:', e.message);
  }
}

const PORT = process.env.PORT || 3001;

app.post('/favourites', async (req, res) => {
  try {
    const { device_id, city, category, item_name, item_data } = req.body;
    if (!device_id || !city || !category || !item_name) {
      return res.status(400).json({ error: 'device_id, city, category, item_name are required' });
    }
    const r = await fetch(SUPABASE_URL + '/rest/v1/favourites', {
      method: 'POST',
      headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
      body: JSON.stringify({ device_id, city, category, item_name, item_data })
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/favourites', async (req, res) => {
  try {
    const { device_id } = req.query;
    if (!device_id) return res.status(400).json({ error: 'device_id is required' });
    const r = await fetch(
      SUPABASE_URL + '/rest/v1/favourites?device_id=eq.' + encodeURIComponent(device_id) + '&order=created_at.desc',
      { headers: supabaseHeaders() }
    );
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/favourites/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const r = await fetch(SUPABASE_URL + '/rest/v1/favourites?id=eq.' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: supabaseHeaders()
    });
    res.json({ deleted: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/feedback', async (req, res) => {
  try {
    const { device_id, city, type, message } = req.body;
    if (!city || !type || !message) {
      return res.status(400).json({ error: 'city, type, message are required' });
    }
    if (type !== 'loved' && type !== 'suggestion') {
      return res.status(400).json({ error: 'type must be loved or suggestion' });
    }
    const r = await fetch(SUPABASE_URL + '/rest/v1/feedback', {
      method: 'POST',
      headers: { ...supabaseHeaders(), 'Prefer': 'return=representation' },
      body: JSON.stringify({ device_id, city, type, message })
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Outbound click tracking — added 25 June for monetisation visibility.
// Fire-and-forget from the app's side; this endpoint itself responds fast
// and never blocks the user's actual link from opening.
app.post('/clicks', async (req, res) => {
  try {
    const { device_id, city, category, item_name, link_type } = req.body;
    if (!city || !category || !item_name || !link_type) {
      return res.status(400).json({ error: 'city, category, item_name, link_type are required' });
    }
    const r = await fetch(SUPABASE_URL + '/rest/v1/click_events', {
      method: 'POST',
      headers: { ...supabaseHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ device_id, city, category, item_name, link_type })
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('click_events insert REJECTED:', r.status, errText);
    }
    res.json({ status: 'logged' });
  } catch(e) {
    console.error('click_events insert network error:', e.message);
    res.json({ status: 'logged' }); // never surface a tracking failure to the app itself
  }
});

// Tab-open tracking — added 26 June. Captures which tabs people actually
// open (regardless of whether the content was preloaded or fetched fresh),
// since that's the data needed to make an informed lazy-load decision later
// — the existing usage_events log only shows what got GENERATED, not what
// anyone actually looked at. Same fire-and-forget pattern as /clicks.
app.post('/tab-opens', async (req, res) => {
  try {
    const { device_id, city, category } = req.body;
    if (!city || !category) {
      return res.status(400).json({ error: 'city and category are required' });
    }
    const r = await fetch(SUPABASE_URL + '/rest/v1/tab_opens', {
      method: 'POST',
      headers: { ...supabaseHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({ device_id, city, category })
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('tab_opens insert REJECTED:', r.status, errText);
    }
    res.json({ status: 'logged' });
  } catch(e) {
    console.error('tab_opens insert network error:', e.message);
    res.json({ status: 'logged' });
  }
});

async function pingSupabase() {
  try {
    await fetch(SUPABASE_URL + '/rest/v1/keepalive', {
      method: 'POST',
      headers: { ...supabaseHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify({})
    });
    console.log('Supabase keepalive ping sent');
  } catch (e) {
    console.log('Supabase keepalive ping failed:', e.message);
  }
}

setInterval(pingSupabase, 3 * 24 * 60 * 60 * 1000);
pingSupabase();

function hours24Ago() {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\n]/.test(str)) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

function toCSV(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map(row => columns.map(col => csvEscape(row[col])).join(','));
  return [header, ...lines].join('\r\n');
}

async function supabaseSelect(table, queryParams) {
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?' + queryParams, {
      headers: supabaseHeaders()
    });
    const data = await r.json();
    // Same silent-failure class as the original usage_events insert bug:
    // a rejected/errored Supabase response is still valid JSON, just not an
    // array — without this check, that error object gets quietly discarded
    // and every caller sees "no rows" instead of "something went wrong."
    if (!Array.isArray(data)) {
      console.error('Supabase select REJECTED (' + table + '):', r.status, JSON.stringify(data));
      return [];
    }
    return data;
  } catch (e) {
    console.error('Supabase select network error (' + table + '):', e.message);
    return [];
  }
}

async function supabaseCount(table) {
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + table + '?select=created_at', {
      headers: {
        ...supabaseHeaders(),
        'Prefer': 'count=exact',
        'Range-Unit': 'items',
        'Range': '0-0'
      }
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error('Supabase count REJECTED (' + table + '):', r.status, errText);
      return null;
    }
    const range = r.headers.get('content-range');
    if (range && range.includes('/')) {
      const total = range.split('/')[1];
      return total === '*' ? null : parseInt(total, 10);
    }
    return null;
  } catch (e) {
    console.error('Supabase count network error (' + table + '):', e.message);
    return null;
  }
}

// Approximate Claude Sonnet pricing, USD per million tokens.
// CONFIRM against https://platform.claude.com/docs/en/about-claude/pricing before treating this as exact —
// pricing can change, and this estimate does NOT account for the prompt-caching discount on cache_read_input_tokens
// (cached reads are billed at a fraction of the base input rate), so true cost is likely somewhat LOWER than this estimate.
const PRICE_PER_MTOK_INPUT = 3.00;
const PRICE_PER_MTOK_OUTPUT = 15.00;

function estimateCostUSD(inputTokens, outputTokens) {
  const inCost = ((inputTokens || 0) / 1e6) * PRICE_PER_MTOK_INPUT;
  const outCost = ((outputTokens || 0) / 1e6) * PRICE_PER_MTOK_OUTPUT;
  return inCost + outCost;
}

function logUsageEvent(deviceId, city, category, cacheStatus, usage) {
  const body = {
    device_id: deviceId || null,
    city: city,
    category: category,
    cache_status: cacheStatus
  };
  if (usage) {
    body.input_tokens = usage.input_tokens ?? null;
    body.output_tokens = usage.output_tokens ?? null;
    body.cache_creation_input_tokens = usage.cache_creation_input_tokens ?? null;
    body.cache_read_input_tokens = usage.cache_read_input_tokens ?? null;
  }
  fetch(SUPABASE_URL + '/rest/v1/usage_events', {
    method: 'POST',
    headers: { ...supabaseHeaders(), 'Prefer': 'return=minimal' },
    body: JSON.stringify(body)
  })
    .then(async (r) => {
      // fetch() only rejects on network failures — it does NOT reject on
      // HTTP error responses (400/403/etc). Without this check, a rejected
      // insert (e.g. an RLS policy blocking it) resolves "successfully" and
      // silently vanishes — no exception, nothing in the .catch() below, no
      // log line anywhere. This is what was actually happening on 24 June.
      if (!r.ok) {
        const errText = await r.text();
        console.error('usage_events insert REJECTED:', r.status, errText);
      }
    })
    .catch(e => console.error('usage_events insert network error:', e.message));
}

async function sendResendEmail({ subject, text, attachments }) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'Locale Reports <reports@send.localetravelapp.com>',
        to: ['hello@localetravelapp.com'],
        subject: subject,
        text: text,
        attachments: attachments
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('Resend email failed:', res.status, errText);
      return false;
    }
    console.log('Email sent:', subject);
    return true;
  } catch (e) {
    console.error('Resend email error:', e.message);
    return false;
  }
}

async function buildUsageReport() {
  const since = hours24Ago();

  const newUsageEvents = await supabaseSelect('usage_events', 'select=*&created_at=gte.' + encodeURIComponent(since));
  const newFavourites = await supabaseSelect('favourites', 'select=*&created_at=gte.' + encodeURIComponent(since));
  const newCacheRows = await supabaseSelect('recommendations_cache', 'select=cache_key,created_at&created_at=gte.' + encodeURIComponent(since));
  const newClicks = await supabaseSelect('click_events', 'select=*&created_at=gte.' + encodeURIComponent(since));
  const newTabOpens = await supabaseSelect('tab_opens', 'select=*&created_at=gte.' + encodeURIComponent(since));
  const totalCacheRows = await supabaseCount('recommendations_cache');
  const totalFavourites = await supabaseCount('favourites');
  const totalClicks = await supabaseCount('click_events');

  // Split real user-driven events from background pre-warm activity (added
  // 26 June) BEFORE computing any "demand" stats — otherwise the pre-warm
  // job's own background generations would quietly inflate city/category
  // demand figures and make them look more popular than real users ever
  // made them, defeating the entire point of keeping these signals separate.
  const realUsageEvents = newUsageEvents.filter(e => e.cache_status !== 'prewarm');
  const prewarmEvents = newUsageEvents.filter(e => e.cache_status === 'prewarm');

  const distinctDevices = new Set(realUsageEvents.filter(e => e.device_id).map(e => e.device_id));
  const hits = realUsageEvents.filter(e => e.cache_status === 'hit').length;
  const misses = realUsageEvents.filter(e => e.cache_status === 'miss').length;

  const cityDemand = {}, categoryDemand = {};
  realUsageEvents.forEach(e => {
    if (e.city) cityDemand[e.city] = (cityDemand[e.city] || 0) + 1;
    if (e.category) categoryDemand[e.category] = (categoryDemand[e.category] || 0) + 1;
  });

  const cityNewGen = {}, categoryNewGen = {};
  newCacheRows.forEach(row => {
    const parts = (row.cache_key || '').split('|');
    const city = parts[0], category = parts[1];
    cityNewGen[city] = (cityNewGen[city] || 0) + 1;
    categoryNewGen[category] = (categoryNewGen[category] || 0) + 1;
  });

  const favCategoryCounts = {};
  newFavourites.forEach(f => {
    favCategoryCounts[f.category] = (favCategoryCounts[f.category] || 0) + 1;
  });

  // Outbound click tracking — added 25 June, the key monetisation-readiness signal.
  const clicksByCategory = {}, clicksByType = {};
  newClicks.forEach(c => {
    if (c.category) clicksByCategory[c.category] = (clicksByCategory[c.category] || 0) + 1;
    if (c.link_type) clicksByType[c.link_type] = (clicksByType[c.link_type] || 0) + 1;
  });

  // Find an Experience reporting — added per the agreed build plan.
  // Theme demand combines tour-related outbound clicks (link_type holds the
  // theme key, since the frontend's logClick call passes theme as linkType
  // for this category) with first-time generations (new cache rows whose
  // key contains '|tours|') so the figure reflects both "people clicked
  // book" and "people searched this combo for the first time" — the future
  // sales-pitch data point ("200 people searched cooking classes in
  // Lisbon"). Source split (affiliate vs direct) requires reading each new
  // tours cache row's actual response_data, since source is stored inside
  // the cached JSON payload, not in click_events/usage_events themselves.
  const tourClicks = newClicks.filter(c => c.category === 'tours');
  const tourThemeDemand = {};
  tourClicks.forEach(c => {
    if (c.link_type) tourThemeDemand[c.link_type] = (tourThemeDemand[c.link_type] || 0) + 1;
  });
  const tourCacheRows = newCacheRows.filter(row => (row.cache_key || '').includes('|tours|'));
  tourCacheRows.forEach(row => {
    const theme = (row.cache_key || '').split('|tours|')[1];
    if (theme) tourThemeDemand[theme] = (tourThemeDemand[theme] || 0) + 1;
  });

  // Tab engagement — added 26 June. The key signal for any future lazy-load
  // decision: what fraction of real searches actually opened each tab,
  // versus the 100%-by-design preload-everything figure categoryDemand
  // would otherwise show. searchesCount approximates total searches via
  // essentials_info, which fires exactly once per real (non-prewarm) search
  // regardless of how many tabs anyone goes on to open.
  const searchesCount = realUsageEvents.filter(e => e.category === 'essentials_info').length;
  const tabOpensByCategory = {};
  newTabOpens.forEach(o => {
    if (o.category) tabOpensByCategory[o.category] = (tabOpensByCategory[o.category] || 0) + 1;
  });
  const PRELOAD_CATEGORY_KEYS = ['essentials', 'neighbourhoods', 'coffee', 'food', 'eating', 'markets', 'art', 'walk', 'events', 'drink', 'night', 'mustsee'];
  const tabEngagementLines = PRELOAD_CATEGORY_KEYS.map(cat => {
    const opens = tabOpensByCategory[cat] || 0;
    const rate = searchesCount > 0 ? ((opens / searchesCount) * 100).toFixed(1) + '%' : 'n/a';
    return '  - ' + cat + ': ' + opens + ' open(s) (' + rate + ' of searches)';
  }).join('\n');

  // Real token/cost totals from the last 24h, based on actual Anthropic usage figures logged per call.
  // Deliberately includes EVERYTHING (real + prewarm) so this remains the true total cost figure that
  // should match Anthropic's actual bill — the PRE-WARM ACTIVITY section below breaks out how much of
  // this total came from background activity specifically, so nothing here is hidden, just itemised.
  let totalInputTokens = 0, totalOutputTokens = 0, totalCacheCreationTokens = 0, totalCacheReadTokens = 0;
  newUsageEvents.forEach(e => {
    totalInputTokens += e.input_tokens || 0;
    totalOutputTokens += e.output_tokens || 0;
    totalCacheCreationTokens += e.cache_creation_input_tokens || 0;
    totalCacheReadTokens += e.cache_read_input_tokens || 0;
  });
  const estimatedCost = estimateCostUSD(totalInputTokens, totalOutputTokens);
  const costPerDevice = distinctDevices.size > 0 ? (estimatedCost / distinctDevices.size) : null;

  let prewarmInputTokens = 0, prewarmOutputTokens = 0;
  prewarmEvents.forEach(e => {
    prewarmInputTokens += e.input_tokens || 0;
    prewarmOutputTokens += e.output_tokens || 0;
  });
  const prewarmCost = estimateCostUSD(prewarmInputTokens, prewarmOutputTokens);
  const prewarmByCity = {};
  prewarmEvents.forEach(e => { if (e.city) prewarmByCity[e.city] = (prewarmByCity[e.city] || 0) + 1; });

  const sortDesc = obj => Object.entries(obj).sort((a, b) => b[1] - a[1]);

  const text = [
    'Localé — Daily Usage Report — ' + todayStr(),
    '',
    'LAST 24 HOURS (real user activity only — excludes background pre-warm)',
    '- Total app requests logged: ' + realUsageEvents.length + ' (' + hits + ' cache hits, ' + misses + ' new generations)',
    '- Distinct devices seen: ' + distinctDevices.size,
    '- New favourites saved: ' + newFavourites.length,
    '',
    'CLAUDE API COST (last 24h — TOTAL real figures from Anthropic, includes pre-warm; see PRE-WARM ACTIVITY below for the split)',
    '- Input tokens: ' + totalInputTokens.toLocaleString(),
    '- Output tokens: ' + totalOutputTokens.toLocaleString(),
    '- Cache creation tokens: ' + totalCacheCreationTokens.toLocaleString() + ' (written to prompt cache)',
    '- Cache read tokens: ' + totalCacheReadTokens.toLocaleString() + ' (served from prompt cache, billed at a discount not reflected below)',
    '- Estimated cost: $' + estimatedCost.toFixed(2) + ' USD (base input/output rates only — actual cost is likely somewhat lower due to the cache-read discount; verify current per-token pricing before treating this as exact)',
    '- Estimated cost per active device: ' + (costPerDevice !== null ? '$' + costPerDevice.toFixed(4) : 'n/a (no devices seen)') + ' — worth watching the trend over weeks, not any single day\'s number',
    '',
    'OUTBOUND CLICKS (last 24h — the key monetisation-readiness signal)',
    '- Total outbound clicks: ' + newClicks.length + ' (all-time: ' + (totalClicks ?? 'n/a') + ')',
    'By category:',
    sortDesc(clicksByCategory).map(([c, n]) => '  - ' + c + ': ' + n).join('\n') || '  (none yet)',
    'By link type:',
    sortDesc(clicksByType).map(([c, n]) => '  - ' + c + ': ' + n).join('\n') || '  (none yet)',
    '',
    'FIND AN EXPERIENCE — THEME DEMAND (last 24h, first-time generations + outbound clicks combined)',
    '- Total tour-related outbound clicks: ' + tourClicks.length,
    sortDesc(tourThemeDemand).map(([t, n]) => '- ' + t + ': ' + n).join('\n') || '(none yet)',
    '',
    'TAB ENGAGEMENT (last 24h — % of real searches that opened each tab; the key signal for any future lazy-load decision)',
    '- Total searches (approx, via essentials_info): ' + searchesCount,
    tabEngagementLines || '  (no data yet)',
    '',
    'TOP CITIES BY TOTAL DEMAND (last 24h — real user activity only, every request hit or miss)',
    sortDesc(cityDemand).map(([c, n]) => '- ' + c + ': ' + n).join('\n') || '(none yet)',
    '',
    'TOP CATEGORIES BY TOTAL DEMAND (last 24h — real user activity only, every request hit or miss)',
    sortDesc(categoryDemand).map(([c, n]) => '- ' + c + ': ' + n).join('\n') || '(none yet)',
    '',
    'NEW GENERATIONS BY CITY (last 24h — cost signal only, first-time searches, includes pre-warm)',
    sortDesc(cityNewGen).map(([c, n]) => '- ' + c + ': ' + n).join('\n') || '(none)',
    '',
    'NEW GENERATIONS BY CATEGORY (last 24h — cost signal only, first-time searches, includes pre-warm)',
    sortDesc(categoryNewGen).map(([c, n]) => '- ' + c + ': ' + n).join('\n') || '(none)',
    '',
    'TOP CATEGORIES FAVOURITED (last 24h)',
    sortDesc(favCategoryCounts).map(([c, n]) => '- ' + c + ': ' + n).join('\n') || '(none)',
    '',
    'PRE-WARM ACTIVITY (last 24h — background refresh job; NOT real user demand, see manual for current on/off status)',
    '- Total pre-warm generations: ' + prewarmEvents.length,
    '- Estimated cost of pre-warming: $' + prewarmCost.toFixed(2) + ' USD',
    'By city:',
    sortDesc(prewarmByCity).map(([c, n]) => '  - ' + c + ': ' + n).join('\n') || '  (none — job currently off, or nothing needed refreshing)',
    '',
    'ALL-TIME TOTALS',
    '- Total city/category combos ever generated: ' + (totalCacheRows ?? 'n/a'),
    '- Total favourites ever saved: ' + (totalFavourites ?? 'n/a'),
    '- Total outbound clicks ever logged: ' + (totalClicks ?? 'n/a'),
    '',
    'Full row-level data attached as CSV.'
  ].join('\n');

  const attachments = [
    { filename: 'usage_events_' + todayStr() + '.csv', content: Buffer.from(toCSV(newUsageEvents, ['device_id', 'city', 'category', 'cache_status', 'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'created_at'])).toString('base64') },
    { filename: 'favourites_' + todayStr() + '.csv', content: Buffer.from(toCSV(newFavourites, ['device_id', 'city', 'category', 'item_name', 'created_at'])).toString('base64') },
    { filename: 'click_events_' + todayStr() + '.csv', content: Buffer.from(toCSV(newClicks, ['device_id', 'city', 'category', 'item_name', 'link_type', 'created_at'])).toString('base64') },
    { filename: 'tab_opens_' + todayStr() + '.csv', content: Buffer.from(toCSV(newTabOpens, ['device_id', 'city', 'category', 'created_at'])).toString('base64') }
  ];

  return { text, attachments };
}

async function buildFeedbackReport() {
  const since = hours24Ago();

  const newFeedback = await supabaseSelect('feedback', 'select=*&created_at=gte.' + encodeURIComponent(since));
  const totalFeedback = await supabaseCount('feedback');

  const feedbackLines = newFeedback.map(f =>
    '[' + f.type + '] ' + f.city + ' — "' + f.message + '" (' + f.created_at + ')'
  ).join('\n\n') || '(none)';

  const text = [
    'Localé — Daily Feedback — ' + todayStr(),
    '',
    'NEW FEEDBACK (last 24h): ' + newFeedback.length,
    '',
    feedbackLines,
    '',
    'All-time feedback total: ' + (totalFeedback ?? 'n/a'),
    '',
    'Full data attached as CSV.'
  ].join('\n');

  const attachments = [
    { filename: 'feedback_' + todayStr() + '.csv', content: Buffer.from(toCSV(newFeedback, ['device_id', 'city', 'type', 'message', 'created_at'])).toString('base64') }
  ];

  return { text, attachments };
}

cron.schedule('0 4 * * *', async () => {
  try {
    const usage = await buildUsageReport();
    const feedback = await buildFeedbackReport();
    const combinedText = usage.text + '\n\n' + '='.repeat(40) + '\n\n' + feedback.text;
    const combinedAttachments = [...usage.attachments, ...feedback.attachments];
    await sendResendEmail({ subject: 'Localé Daily Report — ' + todayStr(), text: combinedText, attachments: combinedAttachments });
  } catch (e) { console.error('Daily report failed:', e.message); }
});

// Pre-warm/refresh job for popular cities — built and tested 26 June, but
// DELIBERATELY LEFT UNSCHEDULED. Current demand data is entirely test/debug
// city noise from today's speed-debugging session (Wellington, Kobe,
// Koblenz, Cape Town, Seattle, Toronto, Cairo, Muscat) — none of that
// reflects real user interest, so running this on a schedule right now
// would just spend real money keeping diagnostic test cities warm.
//
// Trigger manually via GET /admin/prewarm?key=ADMIN_SECRET to test the
// mechanism end-to-end without it running unattended. Uncomment the
// cron.schedule block below once real post-launch demand data exists.
// Runs on GMT/UTC (Etc/UTC) when enabled — adjust the hour if GMT 3am
// turns out not to be the quietest point for real traffic once you have it.
//
// Thresholds (tune as real data comes in): top 10 cities by demand, 14-day
// trailing window, minimum 3 requests to qualify (filters out one-off
// curiosity searches), refresh anything missing or older than 22 hours.
//
// NOTE: deliberately does NOT include 'tours' in allCategories below —
// nothing in Find an Experience should ever pre-generate; it stays
// strictly on-demand per the build plan ("nothing fires until a topic's
// chosen"), regardless of pre-warm being enabled for the other tabs.

async function getTopCities(limit, sinceDays, minRequests) {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const rows = await supabaseSelect('usage_events', 'select=city,cache_status&created_at=gte.' + encodeURIComponent(since));
  const counts = {};
  rows.forEach(r => {
    if (r.city && r.cache_status !== 'prewarm') counts[r.city] = (counts[r.city] || 0) + 1;
  });
  return Object.entries(counts)
    .filter(([, count]) => count >= minRequests)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([city]) => city);
}

async function cacheAgeHours(cacheKey) {
  const rows = await supabaseSelect('recommendations_cache', 'select=created_at&cache_key=eq.' + encodeURIComponent(cacheKey));
  if (!rows[0]) return null;
  return (Date.now() - new Date(rows[0].created_at).getTime()) / (60 * 60 * 1000);
}

async function prewarmTopCities() {
  const topCities = await getTopCities(10, 14, 3);
  const allCategories = [...Object.keys(PROMPTS), 'essentials_info'];
  let refreshedCount = 0;
  for (const city of topCities) {
    for (const category of allCategories) {
      const cacheKey = city.trim().toLowerCase() + '|' + category;
      const age = await cacheAgeHours(cacheKey);
      if (age === null || age > 22) {
        try {
          console.log('PREWARM', cacheKey, age === null ? '(missing)' : '(age ' + age.toFixed(1) + 'h)');
          await generateRecommendation(city, category, { source: 'prewarm' });
          refreshedCount++;
        } catch (e) {
          console.error('PREWARM failed', cacheKey, e.message);
        }
        await new Promise(r => setTimeout(r, 500)); // stagger — don't hammer the rate limit
      }
    }
  }
  console.log('PREWARM complete —', refreshedCount, 'combo(s) refreshed across', topCities.length, 'city/ies');
}

// cron.schedule('0 3 * * *', async () => {
//   try { await prewarmTopCities(); } catch (e) { console.error('Prewarm job failed:', e.message); }
// }, { timezone: 'Etc/UTC' });

app.get('/admin/prewarm', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    await prewarmTopCities();
    res.json({ status: 'prewarm complete' });
  } catch (e) {
    console.error('Prewarm failed:', e.message);
    res.status(500).json({ error: 'Prewarm failed' });
  }
});

app.get('/admin/daily-report', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const report = await buildUsageReport();
    if (req.query.send === 'true') {
      await sendResendEmail({ subject: 'Localé Usage Report — ' + todayStr() + ' (test)', text: report.text, attachments: report.attachments });
      return res.json({ status: 'sent' });
    }
    return res.json({ text: report.text });
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ error: 'Failed to build report' });
  }
});

app.get('/admin/daily-feedback', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const report = await buildFeedbackReport();
    if (req.query.send === 'true') {
      await sendResendEmail({ subject: 'Localé Feedback — ' + todayStr() + ' (test)', text: report.text, attachments: report.attachments });
      return res.json({ status: 'sent' });
    }
    return res.json({ text: report.text });
  } catch (e) {
    console.error(e.message);
    return res.status(500).json({ error: 'Failed to build report' });
  }
});

app.get('/admin/essentials-audit', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  try {
    const rows = await supabaseSelect(
      'recommendations_cache',
      'select=cache_key,response_data,created_at&or=(cache_key.like.*%7Cessentials,cache_key.like.*%7Cessentials_info)'
    );

    const lines = rows.map(row => {
      const [city, category] = (row.cache_key || '').split('|');
      let parsed = null;
      try {
        const text = row.response_data && row.response_data.content && row.response_data.content[0] && row.response_data.content[0].text;
        parsed = text ? extractJSONServer(text) : null;
      } catch (e) {
        return city + ' [' + category + '] — could not parse (' + e.message + ')';
      }
      if (!parsed) return city + ' [' + category + '] — no data';

      const transportItems = (parsed.items || []).filter(i => i.type === 'transport').map(i => '  - ' + i.name + ': ' + i.description);
      const currency = parsed.currency ? (parsed.currency.code + ' ' + parsed.currency.symbol) : 'n/a';
      const ageHours = Math.round((Date.now() - new Date(row.created_at).getTime()) / (60 * 60 * 1000));

      return [
        city + ' [' + category + '] — cached ' + ageHours + 'h ago',
        '  Currency: ' + currency,
        transportItems.length ? transportItems.join('\n') : '  (no transport items)'
      ].join('\n');
    });

    res.set('Content-Type', 'text/plain');
    res.send(lines.join('\n\n') || 'No essentials content cached yet.');
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Failed to build audit' });
  }
});

app.get('/admin/coffee-candidates', async (req, res) => {
  if (req.query.key !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const city = req.query.city;
  if (!city) return res.status(400).json({ error: 'city query param is required' });
  try {
    const candidates = await fetchPlacesCandidates(city, 'coffee');
    res.json({ city, count: candidates.length, candidates });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Failed to fetch candidates' });
  }
});

app.listen(PORT, () => console.log('Locale backend running on port ' + PORT));
