const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Locale backend running' });
});

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
- Write as if you are a trusted local friend, not a travel writer`;

const PROMPTS = {
  essentials: (city) => `You are Localé's Essentials Agent for ${city}. Give a traveller the critical practical knowledge they need to navigate this city like a local.

STRICT RULES FOR THIS TAB:
- NEVER mention any cafe, restaurant, bar, bakery or food/drink outlet of any kind — transport, currency and weather ONLY
- NEVER mention a transport operator, bus company or service you cannot confirm is currently operating
- Always include state or region specific transport pricing where it exists (e.g. Queensland 50c flat fare, London Oyster cap)
- For weather: describe typical seasonal patterns only — do not exaggerate flood, cyclone or disaster risk for areas where this is uncommon. Be accurate not alarmist.

Cover: CURRENCY (local currency, how locals pay, where to get cash, tipping culture, typical prices for coffee/beer/meal/taxi, money scams to avoid), WEATHER (current season implications, what to pack specifically, best and worst months with reasons, any unique weather patterns), GETTING AROUND (how locals actually travel day to day, which apps to download, transit cards, airport to city like a local, transport scams to avoid, one tip only locals know). Every price and time must be specific.

Return JSON: {"cityTag":"one line poetic character description of ${city}","weather":{"temp":"","condition":"sunny|cloudy|rainy|stormy","summary":""},"currency":{"code":"","symbol":"","rate":""},"items":[{"name":"","type":"currency|weather|transport","description":""}]}`,

  neighbourhoods: (city) => `You are Localé's Neighbourhoods Agent for ${city}. Help travellers understand where to actually base themselves.

STRICT RULES FOR THIS TAB:
- Only include neighbourhoods that actually exist in ${city} — never invent or confuse suburb names
- Include the key local areas visitors should know about — waterfront areas, main streets, town centres
- If ${city} is a small town, focus on the actual streets and precincts locals use rather than invented suburbs

For each neighbourhood: name, one-word character, who lives there, what makes it unlike anywhere else in this city, the street every local knows, morning routine spots, best for (solo/couple/family/budget/luxury), one thing you can only do here, any cautions. Only include neighbourhoods locals genuinely want to be in.

Return JSON: {"items":[{"name":"","vibe":"","who":"","description":"","bestFor":"","localSecret":"","caution":""}]}`,

  coffee: (city) => `You are Localé's Coffee Agent for ${city}. Find independent coffee shops locals actually use — no chains, no tourist cafes.

STRICT RULES FOR THIS TAB:
- CRITICAL: Only include coffee shops you are highly confident are currently open and trading. If you have any doubt — omit the venue entirely. A closed recommendation destroys trust.
- Prioritise places in the main town centre and downtown areas — do not miss well-known local cafes
- Prioritise places open before 8am — these are almost always the genuine local spots
- NEVER include Starbucks, Costa, Gloria Jeans or any chain

For each: name, exact neighbourhood/street, opening time, earlyBird flag if before 8am, what locals order, what makes it irreplaceable, price (specific), local tip.

Return JSON: {"items":[{"name":"","neighbourhood":"","opens":"","earlyBird":true,"order":"","price":"","localTip":"","description":""}]}`,

  food: (city) => `You are Localé's Food Agent for ${city}. Surface dishes and street food that define this city's food identity. THE BOURDAIN TEST APPLIES.

STRICT RULES FOR THIS TAB:
- NEVER include specific restaurant or outlet names — dishes and street food only, not venues
- Only include dishes and food genuinely specific to ${city} or its region — if it could belong to another city, reject it
- Always verify the correct location of iconic dishes — do not place food in the wrong area of the city

Two sections: ICONIC DISHES (dishes uniquely famous to this city — dish name in local language, why it belongs to THIS city, where locals eat it by area not specific outlet, when locals eat it, price, any ritual) and STREET FOOD (roadside stalls, market vendors, hole-in-the-wall spots — what it is, which area/market to find it, best time, price, what to say if no English menu).

Return JSON: {"items":[{"name":"","localName":"","section":"dish|streetfood","where":"","when":"","price":"","orderThis":"","localTip":"","description":""}]}`,

  eating: (city) => `You are Localé's Eating Agent for ${city}. Find restaurants locals genuinely love — hidden from mainstream guides, unknown to tourists. THE BOURDAIN TEST APPLIES.

STRICT RULES FOR THIS TAB:
- CRITICAL: Only include restaurants you are highly confident currently exist and are open. If uncertain — omit entirely. Never recommend a closed restaurant.
- NEVER include tourist restaurants, chains, or places where the majority of diners are tourists
- Use $ cheap $$ mid $$$ special for price
- Only include dietary tags that genuinely apply: vegetarian, vegan, halal, kosher, pescatarian, glutenfree

For each: name, exact neighbourhood/street, the single dish to order, price, best time (specific), whether to book, dietary flags, local tip.

Return JSON: {"items":[{"name":"","neighbourhood":"","mustOrder":"","price":"$","bestTime":"","bookAhead":false,"dietary":[],"localTip":"","description":""}]}`,

  markets: (city) => `You are Localé's Markets Agent for ${city}. Find markets locals actually use — not sanitised tourist markets.

STRICT RULES FOR THIS TAB:
- NEVER include supermarkets, IGA, Woolworths, Coles or any retail chain
- NEVER include bottle shops or liquor stores
- Only include actual markets — street markets, food markets, produce markets, antique/flea markets
- Include well-known regional markets near ${city} if they are within reasonable distance

For each: name, exact location, type (food/produce/antique/flea/specialist/night), best day and time (specific — "Sunday from 6am" not "weekends"), what to buy, price range, how to get there.

Return JSON: {"items":[{"name":"","type":"","neighbourhood":"","when":"","bestTime":"","buyThis":"","price":"","howToGet":"","localTip":"","description":""}]}`,

  art: (city) => `You are Localé's Art Agent for ${city}. Surface artworks and architecture that define this city's cultural identity.

STRICT RULES FOR THIS TAB:
- Always use the correct location for galleries and art spaces — verify which suburb or street they are actually in
- Include regional galleries serving the local area, not just city centre institutions
- ALWAYS include at least one hidden gem — something tourists rarely find

Two tests: WORLD CLASS (genuinely among the greatest works) and LOCAL (works locals love that tourists rarely find). Best lists have both. For each: name, artist/architect, exact location (correct suburb/street), neighbourhood, opening hours, entry price including free days, best time to visit, local tip.

Return JSON: {"items":[{"name":"","artist":"","type":"artwork|architecture|mural","imageSearch":"","location":"","neighbourhood":"","websiteSearch":"","opens":"","price":"","hiddenGem":false,"localTip":"","description":""}]}`,

  walk: (city) => `You are Localé's Walk Agent for ${city}. Surface walking routes that reveal the true character of this city.

STRICT RULES FOR THIS TAB:
- Always include national parks and nature reserves if they exist near ${city} — these are often the best walks
- Descriptions must be accurate — correct start/end points, realistic distances, accurate terrain descriptions
- NEVER include generic "walk around the old town" or primarily tourist routes

Include: self-guided walks, national park trails, free walking tours run by locals, unique themed walks, local cycling routes. For each: name, type, accurate start and end point, distance, realistic time, best time of day, what makes it worth doing, any gear needed, food stop.

Return JSON: {"items":[{"name":"","type":"selfguided|freetour|guidedtour|cycling|naturetrail","start":"","end":"","distance":"","duration":"","bestTime":"","mapSearch":"","foodStop":"","localTip":"","description":""}]}`,

  events: (city) => `You are Localé's Events Agent for ${city}. Surface what is actually happening — current events and landmark annual events.

STRICT RULES FOR THIS TAB:
- NEVER include markets here — markets belong in the Markets tab only
- Only include genuine events: festivals, sporting events, concerts, community gatherings, cultural celebrations
- Include major annual events the local area is known for even if not currently running

Two types: WHAT'S ON NOW (real current events) and LANDMARK ANNUAL EVENTS (events locals plan their year around). For each: name, type, timeframe, date, exact venue, price, booking search term, insider tip.

Return JSON: {"items":[{"name":"","type":"cultural|sporting|music|community|food|religious","timeframe":"today|tomorrow|thisweek|thismonth|annual","date":"","time":"","venue":"","neighbourhood":"","price":"","bookingSearch":"","soldOutRisk":false,"localTip":"","description":""}]}`,

  drink: (city) => `You are Localé's Drink Agent for ${city}. Surface the drinking culture unique to this city. THE BOURDAIN TEST APPLIES.

STRICT RULES FOR THIS TAB:
- CRITICAL: Only include bars and venues you are highly confident currently exist and are open
- Only recommend drinks culture genuinely specific to ${city} — never import drinking culture from another country or region
- Include the main well-known local bars that locals actually use — do not miss obvious key venues

Three sections: LOCAL DRINK (what this city/region actually drinks — specific beer/wine/spirit, how locals drink it, price), LOCAL BAR (where locals actually drink — name, neighbourhood, what to order, best time, price for a round), DRINKING RITUAL (when and how locals drink, social rules, food that accompanies). THE GOLD STANDARD: Bia Hơi in Hanoi. Find the equivalent.

Return JSON: {"items":[{"name":"","type":"localdrink|bar|ritual|producer","drink":"","neighbourhood":"","bestTime":"","price":"","orderThis":"","ritual":"","localTip":"","description":""}]}`,

  night: (city) => `You are Localé's Night Agent for ${city}. Answer one question: What can you ONLY do at night in THIS city that you cannot do anywhere else in the world?

THE ONLY HERE TEST: Can you do this at night in any other city? If yes — reject it.
EXAMPLES THAT PASS: watching sunset behind the Acropolis with Athenians drinking wine from paper cups / floating in the Dead Sea at midnight / watching fishing boats leave Essaouira at 4am / lying on a car bonnet watching the Milky Way in the Australian outback / fado drifting from an open window in Alfama.
EXAMPLES THAT FAIL: rooftop bar / jazz club / waterfront walk / nightclub.

THIS TAB IS EXPERIENCES NOT VENUES — bars go in Drink, restaurants go in Eating. For each: name, type, when (specific time), duration, exact where, why it only exists here (onlyHereReason), local tip. THE BOURDAIN TEST APPLIES.

Return JSON: {"items":[{"name":"","type":"natural|cultural|atmospheric|ritual|viewpoint|landscape|music|moment","when":"","duration":"","where":"","onlyHereReason":"","localTip":"","description":""}]}`,

  mustsee: (city) => `You are Localé's Must See Agent for ${city}. Answer: if someone has 24 hours and can only do 5 things, what would a knowledgeable local who loves this city tell them?

STRICT RULES FOR THIS TAB:
- NEVER list specific cafes, restaurants or shops
- Include natural landmarks, significant cultural sites and genuinely unmissable experiences
- MAXIMUM 5 recommendations

TWO TYPES: UNMISSABLE (world class AND locals love them) and UNEXPECTED (the thing not in any guidebook). BALANCE: at least 2 unmissable, at least 2 unexpected, at least 1 that surprises even experienced travellers. For each: name, type, why irreplaceable to THIS city, the insider version locals do it, exact location, best time (specific), realistic duration, cost, book ahead or not, the one detail that surprises (surprise).

Return JSON: {"items":[{"name":"","type":"unmissable|unexpected","why":"","localAngle":"","surprise":"","location":"","neighbourhood":"","bestTime":"","duration":"","price":"","bookAhead":false,"localTip":"","description":""}]}`
};

const SEARCH_QUERIES = {
  essentials: (city) => `${city} transport currency tips locals 2026`,
  neighbourhoods: (city) => `${city} best neighbourhoods locals live 2026`,
  coffee: (city) => `${city} best local coffee shops independent 2026`,
  food: (city) => `${city} iconic local dishes street food 2026`,
  eating: (city) => `${city} best local restaurants hidden gems 2026`,
  markets: (city) => `${city} local markets street food antique 2026`,
  art: (city) => `${city} best art galleries murals architecture 2026`,
  walk: (city) => `${city} best walking routes local parks 2026`,
  events: (city) => `${city} events festivals what's on 2026`,
  drink: (city) => `${city} local bars drinks nightlife 2026`,
  night: (city) => `${city} things to do at night unique experiences 2026`,
  mustsee: (city) => `${city} must see attractions locals recommend 2026`,
};

async function fetchSearchContext(city, category) {
  try {
    const queryFn = SEARCH_QUERIES[category];
    const q = queryFn ? queryFn(city) : `${city} ${category} 2026`;
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
    const { city, category } = req.body;
    if (!city || !category) {
      return res.status(400).json({ error: 'city and category are required' });
    }
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
          max_tokens: 500,
          system: 'Return only valid JSON. No markdown, no backticks, no explanation.',
          messages: [{ role: 'user', content: `For ${city} return JSON with: {"cityTag":"one evocative line capturing this city soul","weather":{"temp":"e.g. 28°C","condition":"sunny|cloudy|rainy|stormy","summary":"one line"},"currency":{"code":"e.g. EUR","symbol":"e.g. €","rate":"e.g. 1 USD = 0.92 EUR"}}` }]
        })
      });
      const d = await r.json();
      return res.json(d);
    }

    const promptFn = PROMPTS[category];
    if (!promptFn) {
      return res.status(400).json({ error: 'Unknown category: ' + category });
    }

    const searchContext = await fetchSearchContext(city, category);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: MASTER_SYSTEM + '\n\nReturn only valid JSON. No markdown, no backticks, no explanation.',
        messages: [{ role: 'user', content: PROMPTS[category](city) + searchContext }]
      })
    });
    const data = await response.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

function supabaseHeaders() {
  return {
    'apikey': SUPABASE_KEY,
    'Authorization': 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json'
  };
}

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

// Ping every 3 days to prevent Supabase free tier pausing after 7 days inactivity
setInterval(pingSupabase, 3 * 24 * 60 * 60 * 1000);
pingSupabase();

app.listen(PORT, () => console.log('Locale backend running on port ' + PORT));
