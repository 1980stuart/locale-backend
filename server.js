const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'Locale backend running' });
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log('Locale backend running on port ' + PORT));
