const http = require('http');
const server = http.createServer((req, res) => {
  console.log('Request:', req.url);
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('OK');
});
server.listen(3000, '127.0.0.1', () => console.log('Listening on 127.0.0.1:3000'));
server.on('error', (err) => console.error('Error:', err));
setInterval(() => console.log('Heartbeat'), 5000);