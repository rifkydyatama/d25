const express = require('express');
const app = express();

app.get('/', (req, res) => {
  res.send('Home page works!');
});

app.get('/x', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

app.listen(3000, () => {
  console.log('Test server running on port 3000');
});