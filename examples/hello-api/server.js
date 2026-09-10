import http from "node:http";

const port = Number(process.env.PORT || 3000);

const server = http.createServer((req, res) => {
  const body = JSON.stringify({
    ok: true,
    path: req.url,
    time: new Date().toISOString(),
    message: "hello from Dockyard",
  });
  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});

server.listen(port, "0.0.0.0", () => {
  console.log(`hello-api listening on ${port}`);
});
